package ch.duartesantos.opengym;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 悬浮窗倒计时（休息时贴在屏幕上，不依赖通知栏）。
 *
 * 只在用户授予"显示在其他应用上层"（SYSTEM_ALERT_WINDOW）后出现；没授权就静默跳过，
 * 通知栏那条照旧。由 RestTimerService 驱动：休息开始时 show()，每秒 update()，结束/跳过时 hide()。
 *
 * 视图全部代码构建，不引 XML：一个圆角卡片 = 小标题 + 大倒计时 + 一条进度条。
 * 可拖动，点一下回到 App。
 */
public class RestOverlay {
    private static WindowManager wm;
    private static View card;
    private static TextView timeView;
    private static TextView labelView;
    private static View bar;
    private static WindowManager.LayoutParams lp;
    private static int lastAccent = 0xFF30D158;
    private static long lastTotalMs = 60_000;

    /** 权限是否已授予（Android 6 以下没有这个权限，视为可用）。 */
    public static boolean canDraw(Context ctx) {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                return Settings.canDrawOverlays(ctx);
            } catch (Exception e) {
                return false;
            }
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

    /** 显示或更新。leftMs/totalMs 决定倒计时数字和进度条长度。 */
    public static void show(Context ctx, String title, long leftMs, long totalMs, int accent, int ink) {
        if (!canDraw(ctx)) return;
        lastAccent = accent;
        lastTotalMs = totalMs > 0 ? totalMs : lastTotalMs;
        try {
            if (card == null) build(ctx);
            long left = Math.max(0, leftMs);
            int secs = (int) ((left + 999) / 1000);
            timeView.setText(String.format(java.util.Locale.US, "%d:%02d", secs / 60, secs % 60));
            labelView.setText(title == null || title.isEmpty() ? "Rest" : title);
            float frac = lastTotalMs > 0 ? Math.min(1f, (float) left / lastTotalMs) : 0f;
            View barFill = card.findViewById(BAR_FILL_ID);
            if (barFill != null) {
                View track = card.findViewById(BAR_TRACK_ID);
                int trackW = track == null ? dp(ctx, 160) : track.getWidth();
                if (trackW <= 0) trackW = dp(ctx, 160);
                barFill.getLayoutParams().width = Math.max(2, (int) (trackW * frac));
                barFill.requestLayout();
            }
            wm.updateViewLayout(card, lp);
        } catch (Exception e) {
            hide();
        }
    }

    private static final int BAR_TRACK_ID = 0x0F0F0001;
    private static final int BAR_FILL_ID = 0x0F0F0002;

    private static void build(Context ctx) {
        LinearLayout root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(ctx, 18), dp(ctx, 12), dp(ctx, 18), dp(ctx, 12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF20C0E12);
        bg.setCornerRadius(dp(ctx, 20));
        bg.setStroke(dp(ctx, 1), 0x33FFFFFF);
        root.setBackground(bg);

        labelView = new TextView(ctx);
        labelView.setTextColor(0xFF9AA0A6);
        labelView.setTextSize(12);
        root.addView(labelView);

        timeView = new TextView(ctx);
        timeView.setTextColor(lastAccent);
        timeView.setTextSize(34);
        timeView.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
        root.addView(timeView);

        LinearLayout track = new LinearLayout(ctx);
        track.setId(BAR_TRACK_ID);
        track.setBackgroundColor(0x22FFFFFF);
        LinearLayout.LayoutParams trackLp = new LinearLayout.LayoutParams(dp(ctx, 160), dp(ctx, 4));
        trackLp.topMargin = dp(ctx, 6);
        track.setLayoutParams(trackLp);

        bar = new View(ctx);
        bar.setId(BAR_FILL_ID);
        bar.setBackgroundColor(lastAccent);
        bar.setLayoutParams(new LinearLayout.LayoutParams(dp(ctx, 160), dp(ctx, 4)));
        track.addView(bar);
        root.addView(track);

        card = root;
        wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                android.graphics.PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        lp.y = dp(ctx, 60);

        // 拖动移动位置，点一下回到 App
        final Context appCtx = ctx.getApplicationContext();
        card.setOnTouchListener(new View.OnTouchListener() {
            private int startX, startY;
            private float downX, downY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = lp.x;
                        startY = lp.y;
                        downX = e.getRawX();
                        downY = e.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = (int) (e.getRawX() - downX);
                        int dy = (int) (e.getRawY() - downY);
                        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                        lp.x = startX + dx;
                        lp.y = startY + dy;
                        try { wm.updateViewLayout(card, lp); } catch (Exception ignored) { }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) {
                            try {
                                Intent open = new Intent(appCtx, MainActivity.class);
                                open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                                appCtx.startActivity(open);
                            } catch (Exception ignored) { }
                        }
                        return true;
                }
                return false;
            }
        });

        wm.addView(card, lp);
    }

    /** 休息结束或跳过时移除。 */
    public static void hide() {
        try {
            if (wm != null && card != null) wm.removeView(card);
        } catch (Exception ignored) { }
        card = null;
        timeView = null;
        labelView = null;
        bar = null;
        wm = null;
    }
}
