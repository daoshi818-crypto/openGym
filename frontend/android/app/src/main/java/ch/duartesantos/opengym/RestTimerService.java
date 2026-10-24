package ch.duartesantos.opengym;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Foreground while a rest is running. Reposts one clock and one bar every second, and
 * applies the same controls as the in-app timer: pause, −15s, +15s, skip.
 */
public class RestTimerService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long endsAt;
    private long totalMs;
    private long pausedLeft;
    private boolean paused;
    private boolean running;
    private String pauseLabel = "Pause";
    private String resumeLabel = "Resume";
    private String minusLabel = "\u2212 15s";
    private String plusLabel = "+ 15s";
    private String skipLabel = "Skip";
    private String overlayTitle = "Rest";
    private String restId = "";
    private String contextJson = "";
    private int accent = 0xFF30D158;
    private int ink = 0xFF000000;
    private PowerManager.WakeLock cpu;
    private static Snapshot snapshot = new Snapshot(false, "", 0, 0, 0, false, 0);
    private final java.util.ArrayDeque<String> seenRequests = new java.util.ArrayDeque<>();
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running || paused || endsAt <= 0) return;
            long left = endsAt - System.currentTimeMillis();
            if (left <= 0) {
                reachEnd();
                return;
            }
            show();
            // Next on the clock's next whole second, so the last run lands on the end itself.
            handler.postDelayed(this, ((left - 1) % 1000) + 1);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (RestAlert.ACTION_ACCENT.equals(action)) {
            if (!running) {
                // Only this start: a countdown asked for right behind it must still come up.
                stopSelf(startId);
                return START_NOT_STICKY;
            }
            accent = intent.getIntExtra("accent", accent);
            ink = intent.getIntExtra("ink", ink);
            RestAlert.setAccentColor(accent, ink);
            show();
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_CONTEXT.equals(action)) {
            // 只更新训练摘要：不碰 endsAt、totalMs、闹钟与暂停状态。
            if (running && matchesRest(intent)) {
                contextJson = intent.getStringExtra("context") == null ? contextJson : intent.getStringExtra("context");
                publish();
                show();
            }
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_HOLD.equals(action)) {
            if (running) hold(intent.getLongExtra("leftMs", 0), intent.getLongExtra("totalMs", 0));
            else stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_SKIP.equals(action)) {
            if (running && !acceptCommand(intent)) return START_NOT_STICKY;
            finishSkip();
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_PAUSE.equals(action)) {
            if (running && acceptCommand(intent)) togglePause();
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_MINUS.equals(action)) {
            if (running && acceptCommand(intent)) nudge(-15_000);
            return START_NOT_STICKY;
        }
        if (RestAlert.ACTION_PLUS.equals(action)) {
            if (running && acceptCommand(intent)) nudge(15_000);
            return START_NOT_STICKY;
        }
        long nextEnd = intent == null ? 0 : intent.getLongExtra("endsAt", 0);
        if (nextEnd <= System.currentTimeMillis()) {
            stopForegroundCompat();
            stopSelf();
            return START_NOT_STICKY;
        }
        endsAt = nextEnd;
        long passed = intent.getLongExtra("totalMs", 0);
        totalMs = passed > 0 ? passed : Math.max(1000, endsAt - System.currentTimeMillis());
        paused = false;
        running = true;
        holdCpuUntilEnd();
        pauseLabel = text(intent, "pause", pauseLabel);
        resumeLabel = text(intent, "resume", resumeLabel);
        minusLabel = text(intent, "minus", minusLabel);
        plusLabel = text(intent, "plus", plusLabel);
        skipLabel = text(intent, "skip", skipLabel);
        overlayTitle = text(intent, "title", overlayTitle);
        restId = text(intent, "restId", restId);
        contextJson = text(intent, "context", contextJson);
        if (intent != null && intent.hasExtra("accent")) accent = intent.getIntExtra("accent", accent);
        if (intent != null && intent.hasExtra("ink")) ink = intent.getIntExtra("ink", ink);
        handler.removeCallbacks(tick);
        publish();
        tick.run();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        snapshot = new Snapshot(false, restId, 0, 0, 0, false, System.currentTimeMillis());
        handler.removeCallbacks(tick);
        releaseCpu();
        endsAt = 0;
        RestOverlay.hide();
        stopForegroundCompat();
        super.onDestroy();
    }

    private void togglePause() {
        if (!paused) {
            pausedLeft = Math.max(0, endsAt - System.currentTimeMillis());
            paused = true;
            handler.removeCallbacks(tick);
            releaseCpu();
            RestAlert.cancelAlarmOnly(this, RestAlert.NOTIFICATION_ID);
        } else {
            endsAt = System.currentTimeMillis() + pausedLeft;
            paused = false;
            holdCpuUntilEnd();
            RestAlert.updateAlarm(this, endsAt);
            handler.removeCallbacks(tick);
            tick.run();
        }
        show();
        emit("pause");
    }

    /**
     * Paused in the app. The clock stops at the time the app holds, so the two read the same,
     * and the button offers Resume. No event goes back: the app made this change. The plugin
     * has already called off the alarm.
     */
    private void hold(long leftMs, long total) {
        if (leftMs <= 0) return;
        paused = true;
        pausedLeft = leftMs;
        if (total > 0) totalMs = total;
        handler.removeCallbacks(tick);
        releaseCpu();
        show();
    }

    private void nudge(long deltaMs) {
        long now = System.currentTimeMillis();
        // endsAt may already be in the past when +15 lands on the last second.
        // Adding the delta to that old deadline would leave the clock stuck.
        long left = paused ? pausedLeft : Math.max(0, endsAt - now);
        long adjusted = Math.min(900_000L, left + deltaMs);
        totalMs = Math.max(adjusted, Math.min(900_000L, totalMs + adjusted - left));
        left = adjusted;
        if (left <= 0) {
            finishSkip();
            return;
        }
        if (paused) pausedLeft = left;
        else {
            endsAt = now + left;
            holdCpuUntilEnd();
            RestAlert.updateAlarm(this, endsAt);
            handler.removeCallbacks(tick);
            handler.post(tick);
        }
        show();
        emit("adjust");
    }

    /**
     * The end, reached by this countdown. The alert (or, with the app on screen, just the end of
     * this card) comes from RestAlert, which stops this service once it is up. The CPU stays held
     * until then: letting go here could let the phone sleep before that alert holds its own.
     */
    private void reachEnd() {
        running = false;
        snapshot = new Snapshot(false, restId, endsAt, totalMs, 0, false, System.currentTimeMillis());
        RestOverlay.hide();
        RestAlert.fireFromCountdown(getApplicationContext(), endsAt);
    }

    /**
     * Keeps the CPU running until the end, and ten seconds past it. With the screen off a phone
     * otherwise sleeps through this countdown's last second, and the only thing left to wake it
     * is the alarm, which without the exact-alarm permission comes late. Released on pause,
     * on skip and when the service stops after the end, so a held rest costs nothing.
     */
    private void holdCpuUntilEnd() {
        try {
            if (cpu == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "opengym:rest-countdown");
                cpu.setReferenceCounted(false);
            }
            cpu.acquire(Math.max(0, endsAt - System.currentTimeMillis()) + 10_000);
        } catch (Exception ignored) { /* the alarm is still set */ }
    }

    private void releaseCpu() {
        try {
            if (cpu != null && cpu.isHeld()) cpu.release();
        } catch (Exception ignored) { /* already released by its timeout */ }
    }

    private void finishSkip() {
        running = false;
        snapshot = new Snapshot(false, restId, endsAt, totalMs, 0, false, System.currentTimeMillis());
        RestOverlay.hide();
        handler.removeCallbacks(tick);
        releaseCpu();
        RestAlert.cancelAlarmOnly(this, RestAlert.NOTIFICATION_ID);
        RestAlertPlugin.emit("skip", 0, 0, 0, false);
        stopForegroundCompat();
        stopSelf();
    }

    private void emit(String type) {
        long left = paused ? pausedLeft : Math.max(0, endsAt - System.currentTimeMillis());
        RestAlertPlugin.emit(type, endsAt, totalMs, left, paused);
        publish();
    }

    /** 命令属于当前这轮休息，且这条 requestId 没执行过；空 restId/requestId 兼容旧调用。 */
    private boolean acceptCommand(Intent intent) {
        if (!matchesRest(intent)) return false;
        String rid = intent == null ? null : intent.getStringExtra("requestId");
        if (rid == null || rid.isEmpty()) return true;
        if (seenRequests.contains(rid)) return false;
        seenRequests.addLast(rid);
        while (seenRequests.size() > 32) seenRequests.removeFirst();
        return true;
    }

    /** 命令是否属于当前这一轮休息；空 restId 兼容旧调用。 */
    private boolean matchesRest(Intent intent) {
        String want = intent == null ? null : intent.getStringExtra("restId");
        return want == null || want.isEmpty() || want.equals(restId);
    }

    /** 当前/最近一轮休息的原生状态，供 APP 回前台时裁决旧 WebView 计时。 */
    private void publish() {
        long left = paused ? pausedLeft : Math.max(0, endsAt - System.currentTimeMillis());
        snapshot = new Snapshot(running && (paused || left > 0), restId, endsAt, totalMs, left, paused, System.currentTimeMillis());
    }

    public static Snapshot snapshot() { return snapshot; }

    public static final class Snapshot {
        public final boolean active;
        public final String restId;
        public final long endsAt;
        public final long totalMs;
        public final long leftMs;
        public final boolean paused;
        public final long at;
        Snapshot(boolean active, String restId, long endsAt, long totalMs, long leftMs, boolean paused, long at) {
            this.active = active; this.restId = restId; this.endsAt = endsAt; this.totalMs = totalMs;
            this.leftMs = leftMs; this.paused = paused; this.at = at;
        }
    }

    private void show() {
        try {
            long left = paused ? pausedLeft : Math.max(0, endsAt - System.currentTimeMillis());
            Notification n = RestAlert.countdownNotification(
                    this, left, totalMs, paused, pauseLabel, resumeLabel, minusLabel, plusLabel, skipLabel, accent, ink);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(RestAlert.COUNTDOWN_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(RestAlert.COUNTDOWN_ID, n);
            }
            // 悬浮窗倒计时：授权了才出现，没授权这里静默跳过（通知栏那条照旧）
            RestOverlay.show(this, overlayTitle, left, totalMs, accent, ink, restId, contextJson);
        } catch (Exception e) {
            stopSelf();
        }
    }

    private static String text(Intent intent, String key, String fallback) {
        if (intent == null) return fallback;
        String v = intent.getStringExtra(key);
        return v == null || v.isEmpty() ? fallback : v;
    }

    @SuppressWarnings("deprecation")
    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
    }
}
