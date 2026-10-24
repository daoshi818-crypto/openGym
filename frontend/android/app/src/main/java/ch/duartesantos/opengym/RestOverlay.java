package ch.duartesantos.opengym;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 悬浮窗休息卡片（贴在屏幕上，不依赖通知栏）。
 *
 * 只在用户授予"显示在其他应用上层"后出现；没授权就静默跳过，通知栏那条照旧。
 * 由 RestTimerService 驱动：休息开始 show()，每秒 update()，结束/跳过 hide()。
 *
 * 两种样式（Settings → 悬浮窗样式，S.overlayStyle）：
 *   'card'  = 紧凑信息条：左侧倒计时，右侧下一组处方，底部细进度线；可展开控制
 *   'ring'  = 圆形进度环（保留原样式）
 *
 * 数据规则：
 *   - 训练摘要由 JS 以 rest-context.js 计算后下发（sid/restId/下一组身份与处方），
 *     原生不猜下一组；拿不到摘要就显示"返回训练查看"。
 *   - 内容更新（setContext）只改文本与进度，不重排闹钟、不改截止时间。
 *   - 点击主体回 App；右侧箭头只负责展开/收起；暂停/±15/跳过走与通知相同的服务命令，
 *     并带上 restId，旧休息的命令不会影响新一轮。
 *   - 拖动位置持久保存，并在旋转/分屏/字体变化后重新约束在可用区域内。
 */
public class RestOverlay {
    private static final String PREFS = "opengym_overlay";
    private static final String PREF_X = "x";
    private static final String PREF_Y = "y";
    private static final int BAR_TRACK_ID = 0x0F0F0001;
    private static final int BAR_FILL_ID = 0x0F0F0002;

    private static WindowManager wm;
    private static View card;
    private static TextView timeView;
    private static TextView nextTitle;
    private static TextView nextLine;
    private static TextView fullName;
    private static TextView fullRx;
    private static TextView fullEffort;
    private static TextView expandBtn;
    private static LinearLayout expanded;
    private static View barFill;
    private static RingDrawable ring;
    private static WindowManager.LayoutParams lp;
    private static int lastAccent = 0xFF30D158;
    private static int lastInk = 0xFF000000;
    private static long lastTotalMs = 60_000;
    private static String style = "card";
    private static boolean appInFront = false;
    private static boolean isExpanded = false;
    private static String restId = "";
    private static String contextJson = "";
    private static Context appCtx;
    private static boolean configRegistered = false;

    private static final android.content.ComponentCallbacks CONFIG = new android.content.ComponentCallbacks() {
        @Override public void onConfigurationChanged(Configuration newConfig) {
            if (card == null) return;
            // Font scale / orientation / split screen: rebuild so text re-measures, then clamp
            // the saved position into the new usable area.
            rebuild();
        }
        @Override public void onLowMemory() { }
    };

    /** 权限是否已授予（Android 6 以下没有这个权限，视为可用）。 */
    public static boolean canDraw(Context ctx) {
        if (Build.VERSION.SDK_INT >= 23) {
            try { return Settings.canDrawOverlays(ctx); } catch (Exception e) { return false; }
        }
        return true;
    }

    /** 跳系统设置页让用户授权。 */
    public static void requestPermission(Context ctx) {
        if (Build.VERSION.SDK_INT < 23) return;
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
            i.setData(android.net.Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) { /* 有些 ROM 没有这个页面 */ }
    }

    private static int dp(Context ctx, int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics());
    }

    private static GradientDrawable rounded(int color, int radiusDp, Context ctx) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(ctx, radiusDp));
        return d;
    }

    private static GradientDrawable circle(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setShape(GradientDrawable.OVAL);
        return d;
    }

    private static GradientDrawable accentWash(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.argb(36, Color.red(color), Color.green(color), Color.blue(color)));
        d.setCornerRadius(1000);
        return d;
    }

    private static GradientDrawable progressFill(Context ctx, int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(ctx, 4));
        return d;
    }

    /** 设置页切换样式时调用：正在显示的悬浮窗按新样式重建。 */
    public static void setStyle(Context ctx, String s) {
        style = "ring".equals(s) ? "ring" : "card";
        if (card != null) rebuild();
    }

    /** app 前后台变化：回前台收起；回到后台等 service 下一秒的 show() 带最新时间。 */
    public static void setAppInFront(boolean front) {
        appInFront = front;
        if (front) hide();
    }

    /** 休息开始/每秒刷新。title 用于圆环样式；卡片样式的内容来自 contextJson。 */
    public static void show(Context ctx, String title, long leftMs, long totalMs, int accent, int ink, String id, String context) {
        if (!canDraw(ctx)) return;
        if (appInFront) return;                 // 页内已有计时器，不在前台重复贴
        lastAccent = accent;
        lastInk = ink;
        lastTotalMs = totalMs > 0 ? totalMs : lastTotalMs;
        if (id != null) restId = id;
        if (context != null) contextJson = context;
        try {
            if (card == null) build(ctx);
            if (card == null) return;
            long left = Math.max(0, leftMs);
            int secs = (int) ((left + 999) / 1000);
            String clock = String.format(java.util.Locale.US, "%d:%02d", secs / 60, secs % 60);
            timeView.setText(clock);
            applyContext(ctx, title);
            if ("ring".equals(style)) {
                timeView.setTextColor(lastAccent);
                if (ring != null) ring.setFillColor(lastAccent);
            } else {
                timeView.setTextColor(Color.WHITE);
                if (barFill != null) barFill.setBackground(progressFill(ctx, lastAccent));
            }
            float frac = lastTotalMs > 0 ? Math.min(1f, (float) left / lastTotalMs) : 0f;
            if (ring != null) ring.setLevel((int) (frac * 10000f));
            View track = card.findViewById(BAR_TRACK_ID);
            if (barFill != null) {
                int trackW = track == null ? dp(ctx, 200) : track.getWidth();
                if (trackW <= 0) trackW = dp(ctx, 200);
                barFill.getLayoutParams().width = Math.max(2, (int) (trackW * frac));
                barFill.requestLayout();
            }
            wm.updateViewLayout(card, lp);
        } catch (Exception e) {
            hide();
        }
    }

    /** 只更新训练摘要：不重排闹钟、不改 endsAt、不重置休息。restId 不匹配直接忽略。 */
    public static void setContext(Context ctx, String id, String context) {
        if (id == null || id.isEmpty() || context == null) return;
        if (restId != null && !restId.isEmpty() && !restId.equals(id)) return;   // 旧休息的摘要
        restId = id;
        contextJson = context;
        if (card != null) {
            try { applyContext(ctx, ""); wm.updateViewLayout(card, lp); } catch (Exception ignored) { }
        }
    }

    private static String field(JSONObject o, String key, String fallback) {
        if (o == null) return fallback;
        String v = o.optString(key, "");
        return v == null || v.isEmpty() ? fallback : v;
    }

    private static String prescription(JSONObject set) {
        if (set == null) return "";
        String unit = set.optString("unit", "kg");
        String weight = set.optString("weight", "");
        String seconds = set.optString("seconds", "");
        String reps = set.optString("reps", "");
        StringBuilder sb = new StringBuilder();
        sb.append("第").append(set.optInt("setNumber", 0)).append("/").append(set.optInt("totalSets", 0)).append("组");
        String load = "";
        try {
            double w = Double.parseDouble(weight);
            if (w > 0) load = (Math.rint(w) == w ? String.valueOf((long) w) : weight) + unit;
        } catch (Exception ignored) { }
        String amount = "";
        try {
            double s = Double.parseDouble(seconds);
            if (s > 0) amount = (Math.rint(s) == s ? String.valueOf((long) s) : seconds) + "秒";
        } catch (Exception ignored) { }
        if (amount.isEmpty() && reps != null && !reps.isEmpty()) amount = reps + "次";
        if (!load.isEmpty() || !amount.isEmpty()) sb.append(" · ").append(load).append(load.isEmpty() || amount.isEmpty() ? "" : " × ").append(amount);
        return sb.toString();
    }

    private static void applyContext(Context ctx, String title) {
        JSONObject root = null;
        try { if (contextJson != null && !contextJson.isEmpty()) root = new JSONObject(contextJson); } catch (Exception ignored) { }
        JSONObject next = root == null ? null : root.optJSONObject("next");
        JSONObject completed = root == null ? null : root.optJSONObject("completed");
        String name = next == null ? "" : next.optString("name", "");
        if (nextTitle != null && nextLine != null) {
            if (!name.isEmpty()) {
                nextTitle.setText("下一组 · " + name);
                nextLine.setText(prescription(next));
            } else {
                // 没有可信的下一组：不编造，指回 App。
                nextTitle.setText(root == null ? "休息中" : "下一组待确认");
                nextLine.setText("返回训练查看");
            }
        }
        if (fullName != null) {
            fullName.setText(name.isEmpty() ? "返回训练查看" : name);
            fullRx.setText(next == null ? "" : prescription(next));
            String effort = completed == null ? "" : completed.optString("effort", "");
            fullEffort.setVisibility(effort.isEmpty() ? View.GONE : View.VISIBLE);
            if (!effort.isEmpty()) fullEffort.setText("刚完成：" + effort);
        }
        if (timeView != null && "ring".equals(style)) timeView.setTextColor(lastAccent);
    }

    private static void rebuild() {
        if (card == null || appCtx == null) return;
        try { wm.removeView(card); } catch (Exception ignored) { }
        card = null; wm = null;
        build(appCtx);
    }

    /** 圆形进度环：setLevel 控制扫过的弧长，颜色跟随 accent。 */
    private static class RingDrawable extends Drawable {
        private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        RingDrawable(int accent) {
            track.setStyle(Paint.Style.STROKE);
            fill.setStyle(Paint.Style.STROKE);
            fill.setColor(accent);
            fill.setStrokeCap(Paint.Cap.ROUND);
        }
        void setWidths(float w, float trackPx, float fillPx) { track.setStrokeWidth(trackPx); fill.setStrokeWidth(fillPx); }
        void setTrackColor(int c) { track.setColor(c); }
        void setFillColor(int c) { fill.setColor(c); }
        @Override public void draw(Canvas canvas) {
            Rect b = getBounds();
            float cx = b.exactCenterX(), cy = b.exactCenterY();
            float r = Math.min(b.width(), b.height()) / 2f - fill.getStrokeWidth() / 2f - 2f;
            canvas.drawArc(cx - r, cy - r, cx + r, cy + r, -90f, 360f, false, track);
            float sweep = 360f * (getLevel() / 10000f);
            if (sweep > 0.5f) canvas.drawArc(cx - r, cy - r, cx + r, cy + r, -90f, sweep, false, fill);
        }
        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(ColorFilter cf) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    private static TextView text(Context ctx, String value, float sp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(value);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setMaxLines(4);
        if (bold) t.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD));
        return t;
    }

    private static void sendCommand(Context ctx, String action) {
        try {
            Intent i = new Intent(ctx, RestTimerService.class);
            i.setAction(action);
            i.putExtra("restId", restId);
            // 每条命令一个 requestId：服务只执行一次，重复投递不会把 +15 算两遍。
            i.putExtra("requestId", System.currentTimeMillis() + ":" + System.nanoTime());
            ctx.startService(i);
        } catch (Exception ignored) { /* service gone */ }
    }

    private static LinearLayout.LayoutParams rowParams(Context ctx, float weight) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(ctx, 44), weight);
        p.setMarginEnd(dp(ctx, 6));
        return p;
    }

    private static TextView overlayButton(Context ctx, String label, int bg, int fg) {
        TextView b = new TextView(ctx);
        b.setText(label);
        b.setTextSize(13);
        b.setTextColor(fg);
        b.setGravity(Gravity.CENTER);
        b.setBackground(rounded(bg, 12, ctx));
        b.setClickable(true);
        b.setFocusable(true);
        b.setMinHeight(dp(ctx, 44));
        return b;
    }

    private static void build(Context ctx) {
        appCtx = ctx.getApplicationContext();
        boolean isRing = "ring".equals(style);
        View root;
        if (isRing) {
            FrameLayout frame = new FrameLayout(ctx);
            int size = dp(ctx, 92);
            ring = new RingDrawable(lastAccent);
            ring.setWidths(0, dp(ctx, 4), dp(ctx, 6));
            ring.setTrackColor(0x33FFFFFF);
            ring.setFillColor(lastAccent);
            View ringView = new View(ctx);
            ringView.setBackground(ring);
            frame.addView(ringView, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));

            LinearLayout center = new LinearLayout(ctx);
            center.setOrientation(LinearLayout.VERTICAL);
            center.setGravity(Gravity.CENTER);
            timeView = new TextView(ctx);
            timeView.setTextColor(lastAccent);
            timeView.setTextSize(24);
            timeView.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            center.addView(timeView);
            TextView label = new TextView(ctx);
            label.setTextColor(0xFF9AA0A6);
            label.setTextSize(10);
            label.setText("休息");
            center.addView(label);
            frame.addView(center, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xE60C0E12);
            bg.setShape(GradientDrawable.OVAL);
            bg.setStroke(dp(ctx, 1), 0x33FFFFFF);
            frame.setPadding(dp(ctx, 8), dp(ctx, 8), dp(ctx, 8), dp(ctx, 8));
            frame.setBackground(bg);
            root = frame;
            nextTitle = null; nextLine = null;
        } else {
            // ---- 紧凑信息条：左倒计时 / 右下一组 / 底部细进度线 ----
            LinearLayout bar = new LinearLayout(ctx);
            bar.setOrientation(LinearLayout.VERTICAL);
            bar.setBackground(rounded(0xF21C1C1E, 18, ctx));
            bar.setPadding(dp(ctx, 14), dp(ctx, 10), dp(ctx, 8), 0);

            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);

            timeView = text(ctx, "0:00", 28, Color.WHITE, true);
            timeView.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            timeView.setMinWidth(dp(ctx, 74));
            row.addView(timeView, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            LinearLayout copy = new LinearLayout(ctx);
            copy.setOrientation(LinearLayout.VERTICAL);
            copy.setPadding(dp(ctx, 10), 0, 0, 0);
            nextTitle = text(ctx, "下一组", 14, Color.WHITE, true);
            nextTitle.setSingleLine(true);
            nextTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            nextLine = text(ctx, "返回训练查看", 12, 0xFFB0B6BA, false);
            nextLine.setSingleLine(true);
            nextLine.setEllipsize(android.text.TextUtils.TruncateAt.END);
            copy.addView(nextTitle);
            copy.addView(nextLine);
            LinearLayout.LayoutParams copyLp = new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            row.addView(copy, copyLp);

            // 展开/收起用文字，不用任何箭头符号。
            expandBtn = text(ctx, "展开", 12, 0xFF8A9094, false);
            expandBtn.setGravity(Gravity.CENTER);
            expandBtn.setMinWidth(dp(ctx, 44));
            expandBtn.setMinHeight(dp(ctx, 48));
            expandBtn.setClickable(true);
            expandBtn.setFocusable(true);
            row.addView(expandBtn, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, dp(ctx, 48)));
            bar.addView(row);

            // 细进度线：2dp，颜色跟 accent，宽度随剩余时间
            LinearLayout track = new LinearLayout(ctx);
            track.setId(BAR_TRACK_ID);
            track.setBackground(rounded(0x22FFFFFF, 4, ctx));
            LinearLayout.LayoutParams trackLp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(ctx, 2));
            trackLp.topMargin = dp(ctx, 8);
            trackLp.bottomMargin = 0;
            track.setLayoutParams(trackLp);
            barFill = new View(ctx);
            barFill.setId(BAR_FILL_ID);
            barFill.setBackground(progressFill(ctx, lastAccent));
            barFill.setLayoutParams(new LinearLayout.LayoutParams(dp(ctx, 200), dp(ctx, 2)));
            track.addView(barFill);
            bar.addView(track);

            // ---- 展开区：完整动作名/处方/刚完成组强度 + 两行大按钮 ----
            expanded = new LinearLayout(ctx);
            expanded.setOrientation(LinearLayout.VERTICAL);
            expanded.setPadding(dp(ctx, 14), dp(ctx, 10), dp(ctx, 14), dp(ctx, 10));
            expanded.setVisibility(View.GONE);

            fullName = text(ctx, "", 14, Color.WHITE, true);
            fullName.setMaxLines(2);
            fullRx = text(ctx, "", 13, 0xFFB0B6BA, false);
            fullRx.setMaxLines(2);
            fullEffort = text(ctx, "", 12, lastAccent, false);
            fullEffort.setMaxLines(2);
            expanded.addView(fullName);
            expanded.addView(fullRx);
            expanded.addView(fullEffort);

            LinearLayout ctl1 = new LinearLayout(ctx);
            ctl1.setOrientation(LinearLayout.HORIZONTAL);
            ctl1.setPadding(0, dp(ctx, 8), 0, 0);
            TextView pause = overlayButton(ctx, "暂停", 0xFF2A3236, 0xFFFFFFFF);
            TextView skip = overlayButton(ctx, "跳过", 0xFF2A3236, 0xFFFFFFFF);
            pause.setOnClickListener(v -> sendCommand(appCtx, RestAlert.ACTION_PAUSE));
            skip.setOnClickListener(v -> sendCommand(appCtx, RestAlert.ACTION_SKIP));
            ctl1.addView(pause, rowParams(ctx, 1f));
            LinearLayout.LayoutParams skipLp = rowParams(ctx, 1f);
            skipLp.setMarginEnd(0);
            ctl1.addView(skip, skipLp);
            expanded.addView(ctl1);

            LinearLayout ctl2 = new LinearLayout(ctx);
            ctl2.setOrientation(LinearLayout.HORIZONTAL);
            ctl2.setPadding(0, dp(ctx, 6), 0, 0);
            TextView minus = overlayButton(ctx, "− 15秒", 0xFF2A3236, 0xFFFFFFFF);
            TextView plus = overlayButton(ctx, "+ 15秒", 0xFF2A3236, 0xFFFFFFFF);
            minus.setOnClickListener(v -> sendCommand(appCtx, RestAlert.ACTION_MINUS));
            plus.setOnClickListener(v -> sendCommand(appCtx, RestAlert.ACTION_PLUS));
            ctl2.addView(minus, rowParams(ctx, 1f));
            LinearLayout.LayoutParams plusLp = rowParams(ctx, 1f);
            plusLp.setMarginEnd(0);
            ctl2.addView(plus, plusLp);
            expanded.addView(ctl2);

            bar.addView(expanded);

            expandBtn.setOnClickListener(v -> {
                isExpanded = !isExpanded;
                expanded.setVisibility(isExpanded ? View.VISIBLE : View.GONE);
                expandBtn.setText(isExpanded ? "收起" : "展开");
                // A bigger card may now hang off the bottom edge; re-clamp after layout.
                v.post(RestOverlay::clampPosition);
            });

            root = bar;
            nextTitle.setText("下一组");
            nextLine.setText("返回训练查看");
        }

        card = root;
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        lp.x = prefs.getInt(PREF_X, dp(ctx, 16));
        lp.y = prefs.getInt(PREF_Y, dp(ctx, 60));

        // 拖动移动位置，点一下回到 App（按钮与展开箭头有自己的点击处理，不会触发这里）
        final Context appContext = ctx.getApplicationContext();
        card.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float downX, downY;
            private boolean moved;
            @Override public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = lp.x; startY = lp.y;
                        downX = e.getRawX(); downY = e.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) (e.getRawX() - downX);
                        int dy = (int) (e.getRawY() - downY);
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                        lp.x = startX + dx; lp.y = startY + dy;
                        clamp();
                        try { wm.updateViewLayout(card, lp); } catch (Exception ignored) { }
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved) openApp(appContext);
                        else prefs.edit().putInt(PREF_X, lp.x).putInt(PREF_Y, lp.y).apply();
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        if (moved) prefs.edit().putInt(PREF_X, lp.x).putInt(PREF_Y, lp.y).apply();
                        return true;
                }
                return false;
            }
        });

        try {
            wm.addView(card, lp);
            appCtx.getApplicationContext().registerComponentCallbacks(CONFIG);
        } catch (Exception e) {
            card = null;
        }
        card.post(RestOverlay::clampPosition);
    }

    private static void openApp(Context ctx) {
        try {
            Intent open = new Intent(ctx, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            ctx.startActivity(open);
        } catch (Exception ignored) { }
    }

    /** Keep the card inside the usable window: no screen edges, no status/navigation bars. */
    private static void clampPosition() {
        if (card == null || wm == null) return;
        clamp();
        try { wm.updateViewLayout(card, lp); } catch (Exception ignored) { }
    }

    private static void clamp() {
        if (card == null || wm == null) return;
        int[] size = usableSize();
        int w = Math.max(card.getWidth(), card.getMeasuredWidth());
        int h = Math.max(card.getHeight(), card.getMeasuredHeight());
        if (w <= 0) w = dp(appCtx, 240);
        if (h <= 0) h = dp(appCtx, 80);
        int maxX = Math.max(0, size[0] - w);
        int maxY = Math.max(0, size[1] - h);
        lp.x = Math.max(0, Math.min(lp.x, maxX));
        lp.y = Math.max(0, Math.min(lp.y, maxY));
    }

    private static int[] usableSize() {
        int w, h;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                android.view.WindowMetrics m = wm.getCurrentWindowMetrics();
                Rect b = m.getBounds();
                WindowInsets in = m.getWindowInsets();
                android.graphics.Insets bars = in.getInsetsIgnoringVisibility(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                w = b.width() - bars.left - bars.right;
                h = b.height() - bars.top - bars.bottom;
            } else {
                android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
                wm.getDefaultDisplay().getMetrics(dm);
                w = dm.widthPixels;
                h = dm.heightPixels;
            }
        } catch (Exception e) {
            w = dp(appCtx, 320);
            h = dp(appCtx, 640);
        }
        return new int[] { Math.max(dp(appCtx, 160), w), Math.max(dp(appCtx, 120), h) };
    }

    /** 休息结束或跳过时移除（只影响本轮显示；闹钟与服务由 RestAlert 负责）。 */
    public static void hide() {
        try {
            if (wm != null && card != null) wm.removeView(card);
        } catch (Exception ignored) { }
        try { if (appCtx != null && configRegistered) appCtx.getApplicationContext().unregisterComponentCallbacks(CONFIG); } catch (Exception ignored) { }
        configRegistered = false;
        card = null;
        timeView = null;
        nextTitle = null;
        nextLine = null;
        fullName = null;
        fullRx = null;
        fullEffort = null;
        expandBtn = null;
        expanded = null;
        ring = null;
        barFill = null;
        wm = null;
    }
}
