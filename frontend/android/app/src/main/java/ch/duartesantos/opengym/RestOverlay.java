package ch.duartesantos.opengym;

import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 悬浮窗倒计时（休息时贴在屏幕上，不依赖通知栏）。
 *
 * 只在用户授予"显示在其他应用上层"（SYSTEM_ALERT_WINDOW）后出现；没授权就静默跳过，
 * 通知栏那条照旧。由 RestTimerService 驱动：休息开始时 show()，每秒 update()，结束/跳过时 hide()。
 *
 * 两种样式（Settings → 悬浮窗样式，S.overlayStyle）：
 *   'card'  = 圆角卡片：小标题 + 大倒计时 + 线性进度条（原样式）
 *   'ring'  = 圆形进度环：环内大倒计时，环按剩余时间走
 *
 * 通用规则：
 *   - app 在前台时从不显示（RestAlertPlugin.inFront），离开 app 才出现——页内本来就有计时器；
 *   - 颜色跟随 app 主题（accent/ink 由 JS 每次下发）；
 *   - 可拖动，点一下回到 App。
 */
public class RestOverlay {
    private static WindowManager wm;
    private static View card;
    private static TextView timeView;
    private static TextView labelView;
    private static TextView nextView;
    private static RingDrawable ring;
    private static View bar;
    private static WindowManager.LayoutParams lp;
    private static int lastAccent = 0xFF30D158;
    private static int lastInk = 0xFF000000;
    private static long lastTotalMs = 60_000;
    private static String style = "card";
    private static boolean appInFront = false;

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

    /** 设置页切换样式时调用：正在显示的悬浮窗按新样式重建。 */
    public static void setStyle(Context ctx, String s) {
        style = "ring".equals(s) ? "ring" : "card";
        boolean showing = card != null;
        if (showing) hide();
        // 重建交给下一次 show()（计时器每秒都会调）。
    }

    /** app 前后台变化时由 RestAlertPlugin 通知；回前台就收起悬浮窗。 */
    public static void setAppInFront(boolean front) {
        appInFront = front;
        if (front && card != null) {
            try { wm.removeView(card); } catch (Exception ignored) { }
            card = null;
            timeView = null;
            labelView = null;
            nextView = null;
            ring = null;
            bar = null;
            wm = null;
        }
        // 离开前台不主动显示：等 RestTimerService 下一秒的 show() 带着最新时间来。
    }

    /** 显示或更新。leftMs/totalMs 决定倒计时数字和进度；next 附加"下一组"提示（可空）。 */
    public static void show(Context ctx, String title, long leftMs, long totalMs, int accent, int ink) {
        if (!canDraw(ctx)) return;
        if (appInFront) return; // app 在前台时不贴悬浮窗，页内已有计时器
        lastAccent = accent;
        lastInk = ink;
        lastTotalMs = totalMs > 0 ? totalMs : lastTotalMs;
        try {
            if (card == null) build(ctx, title);
            long left = Math.max(0, leftMs);
            int secs = (int) ((left + 999) / 1000);
            timeView.setText(String.format(java.util.Locale.US, "%d:%02d", secs / 60, secs % 60));
            labelView.setText(title == null || title.isEmpty() ? "Rest" : title);
            float frac = lastTotalMs > 0 ? Math.min(1f, (float) left / lastTotalMs) : 0f;
            if (ring != null) {
                ring.setLevel((int) (frac * 10000f));
            }
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

        void setWidths(float w, float trackPx, float fillPx) {
            track.setStrokeWidth(trackPx);
            fill.setStrokeWidth(fillPx);
        }

        void setTrackColor(int c) { track.setColor(c); }
        void setFillColor(int c) { fill.setColor(c); }

        @Override
        public void draw(Canvas canvas) {
            android.graphics.Rect b = getBounds();
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

    private static void build(Context ctx, String title) {
        boolean isRing = "ring".equals(style);
        View root;
        if (isRing) {
            // 圆形进度环：环内大倒计时，环外没有文字（通知栏里有完整信息）
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
            labelView = new TextView(ctx);
            labelView.setTextColor(0xFF9AA0A6);
            labelView.setTextSize(10);
            labelView.setText(title == null || title.isEmpty() ? "Rest" : title);
            center.addView(labelView);
            frame.addView(center, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xE60C0E12);
            bg.setShape(GradientDrawable.OVAL);
            bg.setStroke(dp(ctx, 1), 0x33FFFFFF);
            frame.setPadding(dp(ctx, 8), dp(ctx, 8), dp(ctx, 8), dp(ctx, 8));
            frame.setBackground(bg);
            root = frame;
        } else {
            // 卡片样式：小标题 + 大倒计时 + 线性进度条（原样式）
            LinearLayout linear = new LinearLayout(ctx);
            linear.setOrientation(LinearLayout.VERTICAL);
            linear.setGravity(Gravity.CENTER_HORIZONTAL);
            linear.setPadding(dp(ctx, 18), dp(ctx, 12), dp(ctx, 18), dp(ctx, 12));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xF20C0E12);
            bg.setCornerRadius(dp(ctx, 20));
            bg.setStroke(dp(ctx, 1), 0x33FFFFFF);
            linear.setBackground(bg);

            labelView = new TextView(ctx);
            labelView.setTextColor(0xFF9AA0A6);
            labelView.setTextSize(12);
            linear.addView(labelView);

            timeView = new TextView(ctx);
            timeView.setTextColor(lastAccent);
            timeView.setTextSize(34);
            timeView.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            linear.addView(timeView);

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
            linear.addView(track);
            root = linear;
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
        nextView = null;
        ring = null;
        bar = null;
        wm = null;
    }
}
