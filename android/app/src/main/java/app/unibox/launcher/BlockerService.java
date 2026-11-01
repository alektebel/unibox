package app.unibox.launcher;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;

import java.util.HashSet;
import java.util.Set;

/**
 * Watches which app comes to the front and, when the policy says it isn't time for it,
 * puts the block screen over it. Covers every way in: launcher, notifications, recents, links.
 * In browsers it also reads the page address, so YouTube Shorts can't come back through the web.
 */
public class BlockerService extends AccessibilityService {

    private final Set<String> keyboards = new HashSet<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** the app in front, as far as window changes tell */
    private String front;

    @Override
    protected void onServiceConnected() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) {
            for (InputMethodInfo i : imm.getEnabledInputMethodList()) keyboards.add(i.getPackageName());
        }
        Policy.reloadLaunchable(this);
        ShortsGuard.reset();
        Policy.refresh(this, true);
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, 2000);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(watchdog);
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getPackageName() == null) return;
        String pkg = event.getPackageName().toString();
        if (keyboards.contains(pkg)) return;
        int type = event.getEventType();
        boolean state = type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        // uninstalling Unibox, or turning off what protects it, asks for the guardian's code
        // the uninstall dialog, whoever shows it (settings, the home screen, a store): at once, no matter the package
        CharSequence cls = event.getClassName();
        boolean uninstall = state && cls != null && cls.toString().toLowerCase(java.util.Locale.ROOT).contains("ninstall");
        if ((GUARDED.contains(pkg) || uninstall) && guard(pkg)) return;
        // Shorts in a browser or the Google app: never, whatever the time
        ShortsGuard.check(this, pkg, state);
        long now = System.currentTimeMillis();
        // apps report scrolling; Chrome's web pages don't (there, passes and the day's budget are the limit)
        if (type == AccessibilityEvent.TYPE_VIEW_SCROLLED) onScroll(pkg, now);
        if (!state) {
            // coming back from recents doesn't always say "new window": anything happening in an
            // app other than the one we think is in front means it's in front now
            if (pkg.equals(front) || !Policy.isLaunchable(this, pkg) || now - lastSwitchCheck < 1500) return;
            lastSwitchCheck = now;
            AccessibilityNodeInfo root = getRootInActiveWindow();
            String active = root != null && root.getPackageName() != null ? root.getPackageName().toString() : null;
            if (root != null) root.recycle();
            if (!pkg.equals(active)) return;
        }
        front = pkg;
        Policy.refresh(this, false);
        enforce(pkg);
    }

    private long lastSwitchCheck;

    // where Unibox can be uninstalled, stopped, emptied, or switched off as blocker or home
    private static final java.util.Set<String> GUARDED = new java.util.HashSet<>(java.util.Arrays.asList(
        "com.android.settings", "com.miui.securitycenter", "com.google.android.packageinstaller", "com.android.packageinstaller",
        "com.miui.packageinstaller", "com.google.android.permissioncontroller", "com.android.permissioncontroller",
        "com.miui.home", "com.android.vending", "com.xiaomi.market", "com.miui.appmanager"));
    private static final java.util.regex.Pattern RISKY = java.util.regex.Pattern.compile(
        "desinstalar|forzar (detenci[oó]n|cierre)|borrar (datos|almacenamiento)|eliminar datos|desactivar|administrador|accesibilidad|uninstall|force stop|clear (data|storage)|deactivate|device admin",
        java.util.regex.Pattern.CASE_INSENSITIVE);
    private static final java.util.regex.Pattern HOME_CHOICE = java.util.regex.Pattern.compile(
        "aplicaci[oó]n de inicio|pantalla de inicio predeterminada|launcher predeterminado|default home|home app",
        java.util.regex.Pattern.CASE_INSENSITIVE);
    private long lastGuard;

    /** A screen that could take Unibox away: back out of it and ask for the code. True if it did. */
    private boolean guard(String pkg) {
        if (GuardActivity.open(this) || Policy.guardHash(this).isEmpty()) return false;
        long now = System.currentTimeMillis();
        if (now - lastGuard < 400) return false;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        StringBuilder text = new StringBuilder();
        try {
            java.util.ArrayDeque<AccessibilityNodeInfo> q = new java.util.ArrayDeque<>();
            q.add(AccessibilityNodeInfo.obtain(root));
            int seen = 0;
            while (!q.isEmpty()) {
                AccessibilityNodeInfo n = q.poll();
                if (seen++ < 600) {
                    if (n.getText() != null) text.append(n.getText()).append('\n');
                    if (n.getContentDescription() != null) text.append(n.getContentDescription()).append('\n');
                    for (int i = 0; i < n.getChildCount(); i++) { AccessibilityNodeInfo c = n.getChild(i); if (c != null) q.add(c); }
                }
                n.recycle();
            }
        } finally {
            root.recycle();
        }
        String t = text.toString();
        boolean aboutUs = t.toLowerCase(java.util.Locale.ROOT).contains("unibox") && RISKY.matcher(t).find();
        if (!aboutUs && !HOME_CHOICE.matcher(t).find()) return false;
        lastGuard = now;
        // the code screen goes straight over it (nothing underneath can be tapped), then the screen
        // underneath is backed out of
        startActivity(new Intent(this, GuardActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        android.util.Log.i("UniboxGuard", "guarded screen in " + pkg);
        return true;
    }

    // Doomscrolling: minutes in a row with steady scrolling in a feed (Instagram, X, TikTok,
    // YouTube, Reddit… or their sites). Past DOOM_MINUTES, feeds close for a while, pass or not.
    private static final int DOOM_MINUTES = 4;
    private static final int SCROLLS_PER_MINUTE = 6;
    private static final int COOLDOWN_MINUTES = 45;
    private long minuteStart;
    private int thisMinute, steadyMinutes;

    private void onScroll(String pkg, long now) {
        if (!Policy.isFeed(this, pkg) && !ShortsGuard.onFeedSite(pkg)) return;
        if (now - minuteStart >= 60_000) {
            // the minute that just ended counts if it had steady scrolling and followed straight on
            boolean steady = minuteStart != 0 && now - minuteStart < 120_000 && thisMinute >= SCROLLS_PER_MINUTE;
            steadyMinutes = steady ? steadyMinutes + 1 : 0;
            if (steadyMinutes == 2) ScreenTime.doomWarning(this, label(pkg), 3);
            thisMinute = 0;
            minuteStart = now;
        }
        thisMinute++;
        if (steadyMinutes >= DOOM_MINUTES - 1 && thisMinute >= SCROLLS_PER_MINUTE) {
            steadyMinutes = 0;
            minuteStart = 0;
            ScreenTime.logDoom(this);
            ScreenTime.doomClosed(this, label(pkg), COOLDOWN_MINUTES);
            Policy.coolDown(this, COOLDOWN_MINUTES, "auto: " + DOOM_MINUTES + " min de scroll en " + label(pkg));
            enforce(pkg);
        }
    }

    private String label(String pkg) {
        try {
            return getPackageManager().getApplicationLabel(getPackageManager().getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    // Every two seconds with the screen on: whatever app windows are visible (full screen, split,
    // floating, picture-in-picture) get the same check as an app coming to the front. Catches
    // what window events miss: notifications opening an app, recents, widgets, floating windows.
    private long lastScreenCheck;
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            handler.postDelayed(this, 2000);
            bedtime();
            Sleep.noteAlarm(BlockerService.this);
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || !pm.isInteractive()) return;
            long t = System.currentTimeMillis();
            if (t - lastScreenCheck > 60_000) {
                lastScreenCheck = t;
                new Thread(() -> ScreenTime.check(BlockerService.this, t)).start();
            }
            try {
                for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                    if (w.getType() != android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION) continue;
                    AccessibilityNodeInfo root = w.getRoot();
                    if (root == null) continue;
                    CharSequence p = root.getPackageName();
                    root.recycle();
                    if (p == null) continue;
                    String pkg = p.toString();
                    if (pkg.equals(getPackageName()) || !Policy.isLaunchable(BlockerService.this, pkg)) continue;
                    if (w.isActive() || w.isInPictureInPictureMode() || !pkg.equals(front)) enforce(pkg);
                }
            } catch (Exception ignored) {
            }
        }
    };

    // Bedtime: from the night window on, the screen goes red (grayscale with a red layer on top:
    // no blue, little light) until morning, then back to how it was.
    private android.view.View red;

    private void bedtime() {
        org.json.JSONObject p = Policy.cached(this);
        boolean night = p != null && Policy.within(p, "night", System.currentTimeMillis());
        android.content.ContentResolver cr = getContentResolver();
        android.content.SharedPreferences prefs = getSharedPreferences("unibox_native", MODE_PRIVATE);
        // what's saved says whether the night look is on (the overlay dies with the process)
        boolean on = red != null || prefs.contains("dalt_on");
        if (night && red != null) return;
        if (!night && !on) return;
        try {
            if (night && !prefs.contains("dalt_on")) {
                // remember what was set, to put it back in the morning
                prefs.edit()
                    .putInt("dalt_on", android.provider.Settings.Secure.getInt(cr, "accessibility_display_daltonizer_enabled", 0))
                    .putInt("dalt", android.provider.Settings.Secure.getInt(cr, "accessibility_display_daltonizer", -1))
                    .apply();
                android.provider.Settings.Secure.putInt(cr, "accessibility_display_daltonizer", 0);
                android.provider.Settings.Secure.putInt(cr, "accessibility_display_daltonizer_enabled", 1);
            } else if (prefs.contains("dalt_on")) {
                android.provider.Settings.Secure.putInt(cr, "accessibility_display_daltonizer_enabled", prefs.getInt("dalt_on", 0));
                int d = prefs.getInt("dalt", -1);
                if (d >= 0) android.provider.Settings.Secure.putInt(cr, "accessibility_display_daltonizer", d);
                prefs.edit().remove("dalt_on").remove("dalt").apply();
            }
        } catch (Exception ignored) {
        }
        android.view.WindowManager wm = (android.view.WindowManager) getSystemService(WINDOW_SERVICE);
        try {
            if (night) {
                red = new android.view.View(this);
                red.setBackgroundColor(0xB3A00000);
                android.view.WindowManager.LayoutParams lp = new android.view.WindowManager.LayoutParams(
                    android.view.WindowManager.LayoutParams.MATCH_PARENT, android.view.WindowManager.LayoutParams.MATCH_PARENT,
                    android.view.WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | android.view.WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | android.view.WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    android.graphics.PixelFormat.TRANSLUCENT);
                lp.height = getResources().getDisplayMetrics().heightPixels * 2;
                wm.addView(red, lp);
            } else if (red != null) {
                wm.removeView(red);
                red = null;
            }
        } catch (Exception e) {
            red = null;
        }
    }

    private final java.util.Map<String, Long> lastBlocked = new java.util.HashMap<>();

    /** Close a blocked app once it's behind the block screen, so recents or a floating window can't bring it back. */
    private void close(String pkg) {
        handler.postDelayed(() -> {
            try {
                android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
                if (am != null) am.killBackgroundProcesses(pkg);
            } catch (Exception ignored) {
            }
        }, 1500);
    }

    private void enforce(String pkg) {
        long now = System.currentTimeMillis();
        if (ShortsGuard.browsers(this).contains(pkg) && ShortsGuard.onFeedSite(pkg)) { ShortsGuard.check(this, pkg, true); return; }
        // a browser: read its address first, an AWS console page isn't blocked for being a browser
        if (ShortsGuard.browsers(this).contains(pkg)) {
            ShortsGuard.check(this, pkg, true);
            if (ShortsGuard.onOpenSite(pkg)) return;
        }
        Policy.Block b = Policy.decide(this, pkg, now);
        if (b == null) {
            // let through on a pass: when it runs out and you're still there, the block comes back
            long until = Policy.passUntil(this, pkg);
            if (until > 0) recheckAt(until);
            return;
        }
        // the watchdog sees a split or floating window every two seconds: one block screen, not a stream
        Long last = lastBlocked.get(pkg);
        if (last != null && now - last < 3000) return;
        lastBlocked.put(pkg, now);
        android.util.Log.i("UniboxBlock", pkg + " → " + b.kind + (b.noPass ? " (no pass)" : ""));
        startActivity(BlockActivity.intent(this, pkg, b).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        close(pkg);
    }

    /** Look at the app in front again at this time (a pass ending, a window starting). */
    private final java.util.Set<Long> rechecks = new java.util.HashSet<>();

    void recheckAt(long when) {
        // one look per moment, however many times it's asked for
        if (!rechecks.add(when)) return;
        handler.postDelayed(() -> {
            rechecks.remove(when);
            if (front == null || front.equals(getPackageName())) return;
            if (ShortsGuard.browsers(this).contains(front)) ShortsGuard.check(this, front, true);
            else enforce(front);
        }, Math.max(0, when - System.currentTimeMillis()) + 1000);
    }

    @Override
    public void onInterrupt() {}
}
