package app.unibox.launcher;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Rect;
import android.net.Uri;
import android.view.accessibility.AccessibilityNodeInfo;
import android.util.Log;
import android.widget.Toast;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Betting and adult pages (and searches for them) are never on either: back, and it's noted.
 * YouTube Shorts are never on, in any browser or in the Google app: when the page on screen
 * is a Short (its address in the bar, a link to one in view, or Google's upright in-place
 * player), go back and say why. Any other YouTube video there counts as opening the YouTube
 * app, so it follows the plan the same way (Policy.decideFor).
 * Blocking apps alone doesn't reach them: browsers are open outside work and blocks.
 */
final class ShortsGuard {

    private static final Pattern SHORTS = Pattern.compile("(^|[/.\\s])youtube\\.com/shorts(/|\\b)", Pattern.CASE_INSENSITIVE);
    // a feed's site in the address bar counts as opening its app (same plan, same waits)
    private static final Pattern SITE = Pattern.compile("^(https?://)?([a-z0-9-]+\\.)*([a-z0-9-]+\\.[a-z]+)(/|$|\\?)", Pattern.CASE_INSENSITIVE);
    private static final Map<String, String> SITES = new HashMap<>();
    static final String YOUTUBE = "com.google.android.youtube";
    // never, at any hour: betting and adult sites, and searches for them
    private static final Pattern BAD_SITE = Pattern.compile(
        "(^|[/.])(bet365|codere|sportium|bwin|luckia|williamhill|pokerstars|betfair|888sport|888casino|marathonbet|betway|retabet|kirolbet|"
        + "interwetten|stake|1xbet|leovegas|casumo|betsson|winamax|paf|unibet|"
        + "pornhub|xvideos|xnxx|xhamster|redtube|youporn|onlyfans|chaturbate|stripchat|spankbang|eporner|brazzers|fansly|motherless|rule34)\\.[a-z.]+",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern BAD_SEARCH = Pattern.compile(
        "\\b(apuestas?|apostar|casas? de apuestas|cuotas (de )?(apuestas|partido)|casino( online)?|ruleta online|tragaperras|poker online|"
        + "bet365|codere|sportium|porno?|xxx|nsfw|onlyfans|hentai|nudes)\\b",
        Pattern.CASE_INSENSITIVE);
    private static final String[] SEARCH_BOXES = { "googleapp_srp_search_box_text", "googleapp_search_box", "search_box_text" };
    static {
        SITES.put("youtube.com", YOUTUBE);
        SITES.put("youtu.be", YOUTUBE);
        SITES.put("instagram.com", "com.instagram.android");
        SITES.put("x.com", "com.twitter.android");
        SITES.put("twitter.com", "com.twitter.android");
        SITES.put("tiktok.com", "com.zhiliaoapp.musically");
        SITES.put("reddit.com", "com.reddit.frontpage");
        SITES.put("netflix.com", "com.netflix.mediaclient");
        SITES.put("twitch.tv", "tv.twitch.android.app");
    }
    // where browsers keep the address: Chromium (Chrome, Brave, Kiwi, Edge…), Gecko (Firefox, Tor)
    private static final String[] URL_BARS = { "url_bar", "mozac_browser_toolbar_url_view", "url", "search_box_text", "location_bar_edit_text" };
    private static final int MAX_NODES = 400;
    // the Google app's results are one deep web page: look further into it
    private static final int MAX_NODES_GOOGLE = 2500;
    private static final String GOOGLE = "com.google.android.googlequicksearchbox";
    private static final long CHECK_MS = 700;

    private static Set<String> browsers;
    private static final Map<String, Long> lastCheck = new HashMap<>();
    private static long lastBack, lastBlock;
    /** the feed app whose site is in the address bar, from the last look */
    private static String seenSite;
    private static final Map<String, String> NAMES = new HashMap<>();
    static {
        NAMES.put(YOUTUBE, "YouTube");
        NAMES.put("com.instagram.android", "Instagram");
        NAMES.put("com.twitter.android", "X");
        NAMES.put("com.zhiliaoapp.musically", "TikTok");
        NAMES.put("com.reddit.frontpage", "Reddit");
        NAMES.put("com.netflix.mediaclient", "Netflix");
        NAMES.put("tv.twitch.android.app", "Twitch");
    }
    private static final int NOTHING = 0, VIDEO = 1, SHORTS_ON = 2, BAD = 3;
    private static String badWhat = "", lastReported = "";
    private static long lastReportAt;

    private ShortsGuard() {}

    /** Every app that opens web links, plus the Google app (its results play Shorts in place). */
    static synchronized Set<String> browsers(Context ctx) {
        if (browsers != null) return browsers;
        Set<String> out = new HashSet<>();
        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
        List<ResolveInfo> rs = ctx.getPackageManager().queryIntentActivities(web, PackageManager.MATCH_ALL);
        for (ResolveInfo r : rs) out.add(r.activityInfo.packageName);
        out.add(GOOGLE);
        out.remove(ctx.getPackageName());
        browsers = out;
        return out;
    }

    static synchronized void reset() { browsers = null; }

    private static final Map<String, Boolean> feedSite = new HashMap<>();


    /** The browser's last look found a feed's site (or YouTube) in its address bar. */
    static boolean onFeedSite(String pkg) {
        return Boolean.TRUE.equals(feedSite.get(pkg));
    }

    /** Called on window changes; cheap unless the app is a browser showing something new. */
    static void check(AccessibilityService svc, String pkg, boolean stateChanged) {
        if (!browsers(svc).contains(pkg)) return;
        long now = System.currentTimeMillis();
        Long last = lastCheck.get(pkg);
        if (!stateChanged && last != null && now - last < CHECK_MS) return;
        lastCheck.put(pkg, now);
        AccessibilityNodeInfo root = svc.getRootInActiveWindow();
        if (root == null) return;
        int seen;
        try {
            seen = look(root, pkg);
        } finally {
            root.recycle();
        }
        feedSite.put(pkg, seen == VIDEO || seen == SHORTS_ON || seenSite != null);
        if (seen == BAD) {
            if (now - lastBack < 1000) return;
            lastBack = now;
            Log.i("UniboxShorts", "bad page in " + pkg + ": " + badWhat);
            svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
            Toast.makeText(svc, "Esto no. Queda apuntado.", Toast.LENGTH_SHORT).show();
            // one note per thing, not one per bounce
            if (!badWhat.equals(lastReported) || now - lastReportAt > 60_000) Policy.report(svc, pkg, "auto: " + badWhat, "guard:bad");
            lastReported = badWhat;
            lastReportAt = now;
            return;
        }
        if (seen == VIDEO || seenSite != null) {
            // a feed on the web follows the plan like its app: open when it's time for it,
            // a wait and a reason in free time, blocked while you should be focusing
            String as = seenSite != null ? seenSite : YOUTUBE;
            Policy.Block b = Policy.decideFor(svc, as, now);
            if (b == null) {
                long until = Policy.passUntil(svc, as);
                if (until > 0 && svc instanceof BlockerService) ((BlockerService) svc).recheckAt(until);
                return;
            }
            if (now - lastBlock < 3000) return;
            lastBlock = now;
            Log.i("UniboxShorts", as + " in " + pkg + " → " + b.kind);
            svc.startActivity(BlockActivity.intent(svc, as, b).putExtra("returnTo", pkg).putExtra("name", NAMES.getOrDefault(as, "esta web"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
            return;
        }
        if (seen != SHORTS_ON) return;
        // one back per second: a back that lands on another Short is caught on the next check
        if (now - lastBack < 1000) return;
        lastBack = now;
        Log.i("UniboxShorts", "back from Shorts in " + pkg);
        svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
        Toast.makeText(svc, "Shorts no, tampoco en el navegador.", Toast.LENGTH_SHORT).show();
    }

    static boolean isShorts(CharSequence s) {
        return s != null && SHORTS.matcher(s).find();
    }

    /** What's on screen: a Short, some other YouTube video, or neither. */
    /** A betting or adult site, or a search for one ("apuestas", "casino", "porno"…). */
    static String bad(CharSequence text) {
        if (text == null) return null;
        String t = text.toString();
        java.util.regex.Matcher m = BAD_SITE.matcher(t);
        if (m.find()) return m.group(2).toLowerCase();
        // searches: the q= of a search address, or the search box itself
        String q = t;
        int i = t.indexOf("q=");
        if (i >= 0 && t.contains("search")) {
            try { q = java.net.URLDecoder.decode(t.substring(i + 2).split("&")[0], "UTF-8"); } catch (Exception ignored) {}
        } else if (t.contains("/") || t.contains(".")) {
            return null;
        }
        m = BAD_SEARCH.matcher(q);
        return m.find() ? "busca «" + m.group(1).toLowerCase() + "»" : null;
    }

    private static int look(AccessibilityNodeInfo root, String pkg) {
        seenSite = null;
        for (String id : SEARCH_BOXES) {
            List<AccessibilityNodeInfo> boxes = root.findAccessibilityNodeInfosByViewId(pkg + ":id/" + id);
            if (boxes == null) continue;
            String hit = null;
            for (AccessibilityNodeInfo b : boxes) {
                if (hit == null) hit = bad(b.getText());
                b.recycle();
            }
            if (hit != null) { badWhat = hit; return BAD; }
        }
        boolean barFound = false;
        for (String id : URL_BARS) {
            List<AccessibilityNodeInfo> bars = root.findAccessibilityNodeInfosByViewId(pkg + ":id/" + id);
            if (bars == null) continue;
            int level = NOTHING;
            for (AccessibilityNodeInfo b : bars) {
                barFound = true;
                CharSequence t = b.getText();
                String hit = bad(t);
                if (hit != null) { badWhat = hit; level = BAD; }
                else if (level == BAD) { /* keep it */ }
                else if (isShorts(t) || isShorts(b.getContentDescription())) level = SHORTS_ON;
                else if (t != null) {
                    java.util.regex.Matcher m = SITE.matcher(t.toString().trim());
                    String app = m.find() ? SITES.get(m.group(3).toLowerCase()) : null;
                    if (YOUTUBE.equals(app)) level = Math.max(level, VIDEO);
                    else if (app != null) seenSite = app;
                }
                b.recycle();
            }
            if (level != NOTHING || seenSite != null) return level;
        }
        // the address is the answer when there is one
        if (barFound) return NOTHING;
        // no known address bar (custom tabs, the Google app): look at what's on screen
        boolean google = GOOGLE.equals(pkg);
        int max = google ? MAX_NODES_GOOGLE : MAX_NODES;
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(AccessibilityNodeInfo.obtain(root));
        int seen = 0;
        int level = NOTHING;
        Rect r = new Rect();
        while (!queue.isEmpty()) {
            AccessibilityNodeInfo n = queue.poll();
            if (level != SHORTS_ON && seen++ < max) {
                if (isShorts(n.getText()) || isShorts(n.getContentDescription())) level = SHORTS_ON;
                // Google plays YouTube in place, in YouTube's own player: a Short is the one standing
                // upright (a normal video is 16:9, much lower than it is wide)
                else if (google && "movie_player".equals(n.getViewIdResourceName())) {
                    n.getBoundsInScreen(r);
                    level = r.width() > 0 && r.height() >= r.width() * 0.9 ? SHORTS_ON : VIDEO;
                }
                for (int i = 0; i < n.getChildCount() && level != SHORTS_ON; i++) {
                    AccessibilityNodeInfo c = n.getChild(i);
                    if (c != null) queue.add(c);
                }
            }
            n.recycle();
        }
        return level;
    }
}
