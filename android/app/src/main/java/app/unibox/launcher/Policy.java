package app.unibox.launcher;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Scanner;
import java.util.Set;

/**
 * The server's app policy (src/policy.ts), cached on the phone so blocking holds offline.
 * Decides, for a package at a moment, whether it opens or costs friction; exits granted
 * after the wait are passes that last a few minutes and are reported back.
 */
final class Policy {

    private static final String PREFS = "unibox_policy";
    private static final long REFRESH_MS = 15 * 60_000L;

    /** What stands between you and an app right now; null means it just opens. */
    static final class Block {
        String windowKey;
        String title;
        String kind;
        long until;
        boolean hard;
        int waitSeconds;
        int passMinutes;
        /** a feed while you should be working or on your plan: no way through until the window ends */
        boolean noPass;
    }

    private static JSONObject cached;
    private static long lastFetch;
    private static Set<String> launchable;

    private Policy() {}

    static void save(Context ctx, String json) {
        try {
            JSONObject p = new JSONObject(json);
            if (!p.has("windows")) return;
            cached = p;
            prefs(ctx).edit().putString("json", json).apply();
        } catch (Exception ignored) {
        }
    }

    /** The guardian code's fingerprint, from the server (kept with the policy, so it holds offline). */
    static String guardHash(Context ctx) {
        JSONObject p = current(ctx);
        return p == null ? "" : p.optString("guardHash", "");
    }

    static JSONObject cached(Context ctx) {
        return current(ctx);
    }

    private static JSONObject current(Context ctx) {
        if (cached == null) {
            try {
                String json = prefs(ctx).getString("json", null);
                if (json != null) cached = new JSONObject(json);
            } catch (Exception ignored) {
            }
        }
        return cached;
    }

    static Block decide(Context ctx, String pkg, long now) {
        // system dialogs, share sheets, keyboards: only apps you can open from a launcher are blocked
        if (pkg == null || !isLaunchable(ctx, pkg)) return null;
        return decideFor(ctx, pkg, now);
    }

    /** The same decision for something that isn't an app on the phone: YouTube watched in a browser counts as the YouTube app. */
    static Block decideFor(Context ctx, String pkg, long now) {
        if (pkg == null || pkg.equals(ctx.getPackageName())) return null;
        JSONObject p = current(ctx);
        // nothing from the server yet: never lock someone out on a guess
        if (p == null) return null;
        if (contains(p.optJSONArray("essentials"), pkg)) return null;
        // betting apps, and Tor (it goes around every filter): never
        if (BAD_APP.matcher(pkg).find() || TOR.contains(pkg)) {
            Block b = block(p, "guard:bad", TOR.contains(pkg) ? "Tor se salta tus filtros." : "", "bad", 0, true);
            b.noPass = true;
            return b;
        }
        // closed at any hour: no wait, no reason
        if (contains(p.optJSONArray("closed"), pkg)) {
            Block b = block(p, "guard:closed", "Instagram está cerrado.", "bad", 0, true);
            b.noPass = true;
            return b;
        }
        // open freely (to post), only scrolling is limited: blocked only after a doomscroll
        if (contains(p.optJSONArray("scrollOnly"), pkg)) {
            long cool = prefs(ctx).getLong("cooldown", 0);
            if (cool <= now) return null;
            Block b = block(p, "guard:doom", "Llevas un buen rato haciendo scroll.", "doom", cool, false);
            b.noPass = true;
            return b;
        }
        boolean game = isGame(ctx, pkg);
        boolean feed = contains(p.optJSONArray("distractions"), pkg) || game;
        boolean onPass = prefs(ctx).getLong("pass:" + pkg, 0) > now;
        long cool = prefs(ctx).getLong("cooldown", 0);
        if (feed && !game && cool > now) {
            Block b = block(p, "guard:doom", "Llevas un buen rato haciendo scroll.", "doom", cool, false);
            b.noPass = true;
            return b;
        }

        JSONObject w = activeWindow(p, now);
        if (w != null) {
            boolean listed = contains(w.optJSONArray("list"), pkg);
            boolean blocked = "allow".equals(w.optString("mode")) ? !listed : listed;
            // feeds and games have no pass in work, blocks and the plan (a pass from before doesn't
            // carry into them either); other apps (the bank, a game with your kid) still go through
            // with a wait and a reason
            boolean noPass = feed && !"night".equals(w.optString("kind"));
            if ((blocked || (game && !listed)) && (noPass || !onPass)) {
                Block b = block(p, w.optString("key"), w.optString("title"), w.optString("kind"), w.optLong("end"), w.optBoolean("hard"));
                b.noPass = noPass;
                return b;
            }
        }
        if (onPass || !feed) return null;
        // free time: a wait and a reason, within the day's budget
        Block b = block(p, "distraction", "", "distraction", 0, false);
        if (game) {
            int budget = p.optInt("gameBudgetMinutes", 45);
            if (AppUsage.gameMinutesToday(ctx, now) >= budget) {
                b.kind = "budget";
                b.title = "Hoy ya has jugado tus " + budget + " min.";
                b.until = tomorrow(now);
                b.noPass = true;
            }
        } else {
            int budget = p.optInt("feedBudgetMinutes", 30);
            if (spentToday(ctx, now) + b.passMinutes > budget) {
                b.kind = "budget";
                b.title = "Hoy ya has gastado tus " + budget + " min de feeds.";
                b.until = tomorrow(now);
                b.noPass = true;
            }
        }
        return b;
    }

    private static Block block(JSONObject p, String key, String title, String kind, long until, boolean hard) {
        Block b = new Block();
        b.windowKey = key;
        b.title = title;
        b.kind = kind;
        b.until = until;
        b.hard = hard;
        b.waitSeconds = hard ? p.optInt("hardFrictionSeconds", 300) : p.optInt("frictionSeconds", 60);
        b.passMinutes = p.optInt("passMinutes", 10);
        return b;
    }

    private static long tomorrow(long now) {
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.setTimeInMillis(now);
        c.add(java.util.Calendar.DAY_OF_YEAR, 1);
        c.set(java.util.Calendar.HOUR_OF_DAY, 0);
        c.set(java.util.Calendar.MINUTE, 0);
        c.set(java.util.Calendar.SECOND, 0);
        return c.getTimeInMillis();
    }

    private static String today(long now) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.ROOT).format(new java.util.Date(now));
    }

    /** Feed minutes let through today (passes add up; the web versions count too). */
    static int spentToday(Context ctx, long now) {
        return prefs(ctx).getInt("spent:" + today(now), 0);
    }

    private static final java.util.Map<String, Boolean> games = new java.util.HashMap<>();

    /** Apps that say they're games (Play Store category), whatever their name. */
    static boolean isGame(Context ctx, String pkg) {
        Boolean g = games.get(pkg);
        if (g != null) return g;
        boolean out = false;
        try {
            android.content.pm.ApplicationInfo ai = ctx.getPackageManager().getApplicationInfo(pkg, 0);
            out = ai.category == android.content.pm.ApplicationInfo.CATEGORY_GAME
                || (ai.flags & android.content.pm.ApplicationInfo.FLAG_IS_GAME) != 0;
        } catch (Exception ignored) {
        }
        games.put(pkg, out);
        return out;
    }

    /** Same ranking as activeWindow() on the server: focus > session > plan > night > work. */
    static JSONObject activeWindow(JSONObject p, long now) {
        JSONArray ws = p.optJSONArray("windows");
        if (ws == null) return null;
        JSONObject best = null;
        int bestRank = 99;
        for (int i = 0; i < ws.length(); i++) {
            JSONObject w = ws.optJSONObject(i);
            if (w == null || w.optLong("start") > now || now >= w.optLong("end")) continue;
            int r = rank(w.optString("kind"));
            if (r < bestRank) {
                best = w;
                bestRank = r;
            }
        }
        return best;
    }

    /** Inside a window of this kind right now, whatever else is on top of it. */
    static boolean within(JSONObject p, String kind, long now) {
        JSONArray ws = p.optJSONArray("windows");
        if (ws == null) return false;
        for (int i = 0; i < ws.length(); i++) {
            JSONObject w = ws.optJSONObject(i);
            if (w != null && kind.equals(w.optString("kind")) && w.optLong("start") <= now && now < w.optLong("end")) return true;
        }
        return false;
    }

    private static int rank(String kind) {
        switch (kind) {
            case "focus": return 0;
            case "session": return 1;
            case "plan": return 2;
            case "night": return 3;
            case "work": return 4;
            default: return 9;
        }
    }

    /** A feed or a game (the server's list, or the Play Store's "game" category). */
    static boolean isFeed(Context ctx, String pkg) {
        JSONObject p = current(ctx);
        return p != null && (contains(p.optJSONArray("distractions"), pkg) || contains(p.optJSONArray("scrollOnly"), pkg)) && !isGame(ctx, pkg);
    }

    /** Doomscrolling caught: every feed closes for a while, whatever passes there were. */
    static void coolDown(Context ctx, int minutes, String what) {
        long until = System.currentTimeMillis() + minutes * 60_000L;
        SharedPreferences.Editor e = prefs(ctx).edit().putLong("cooldown", until);
        // passes don't outlast it
        for (String k : prefs(ctx).getAll().keySet()) if (k.startsWith("pass:")) e.remove(k);
        e.apply();
        report(ctx, "", what, "guard:doom");
    }

    /** When a pass for this app ends (0: none running). */
    static long passUntil(Context ctx, String pkg) {
        long until = prefs(ctx).getLong("pass:" + pkg, 0);
        return until > System.currentTimeMillis() ? until : 0;
    }

    /** Something the guard stopped on its own: reported like an exit, so the day's review sees it. */
    static void report(Context ctx, String pkg, String what, String windowKey) {
        SharedPreferences prefs = prefs(ctx);
        try {
            JSONArray pending = new JSONArray(prefs.getString("pending", "[]"));
            pending.put(new JSONObject().put("pkg", pkg).put("reason", what).put("window", windowKey).put("at", System.currentTimeMillis()));
            prefs.edit().putString("pending", pending.toString()).apply();
        } catch (Exception ignored) {
        }
        new Thread(() -> flush(ctx)).start();
    }

    private static final java.util.Set<String> TOR = new java.util.HashSet<>(java.util.Arrays.asList(
        "org.torproject.torbrowser", "org.torproject.torbrowser_alpha", "org.torproject.android", "info.guardianproject.orfox"));

    private static final java.util.regex.Pattern BAD_APP = java.util.regex.Pattern.compile(
        "(^|\\.)(bet365|codere|sportium|bwin|luckia|williamhill|pokerstars|betfair|888|marathonbet|betway|retabet|kirolbet|stake|1xbet|leovegas|casumo|betsson|winamax|unibet|casino[a-z]*|apuestas?)(\\.|$)",
        java.util.regex.Pattern.CASE_INSENSITIVE);

    static void grantPass(Context ctx, String pkg, int minutes, String reason, String windowKey) {
        long now = System.currentTimeMillis();
        SharedPreferences prefs = prefs(ctx);
        prefs.edit().putLong("pass:" + pkg, now + minutes * 60_000L).apply();
        JSONObject p = current(ctx);
        if (p != null && contains(p.optJSONArray("distractions"), pkg) && !isGame(ctx, pkg)) {
            prefs.edit().putInt("spent:" + today(now), spentToday(ctx, now) + minutes).apply();
        }
        try {
            JSONArray pending = new JSONArray(prefs.getString("pending", "[]"));
            pending.put(new JSONObject().put("pkg", pkg).put("reason", reason).put("window", windowKey).put("at", now));
            prefs.edit().putString("pending", pending.toString()).apply();
        } catch (Exception ignored) {
        }
        new Thread(() -> flush(ctx)).start();
    }

    /** Fetch a fresh copy (at most every 15 minutes unless forced) and report queued exits. */
    static void refresh(Context ctx, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastFetch < REFRESH_MS) return;
        lastFetch = now;
        new Thread(() -> {
            flush(ctx);
            try {
                String body = request(ctx, "GET", "/api/policy", null);
                if (body != null) save(ctx, body);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private static synchronized void flush(Context ctx) {
        SharedPreferences prefs = prefs(ctx);
        try {
            JSONArray pending = new JSONArray(prefs.getString("pending", "[]"));
            JSONArray left = new JSONArray();
            for (int i = 0; i < pending.length(); i++) {
                JSONObject e = pending.getJSONObject(i);
                if (request(ctx, "POST", "/api/policy/exit", e.toString()) == null) left.put(e);
            }
            prefs.edit().putString("pending", left.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private static String request(Context ctx, String method, String path, String json) {
        SharedPreferences server = ctx.getSharedPreferences("unibox_native", Context.MODE_PRIVATE);
        String base = server.getString("url", "");
        String token = server.getString("token", "");
        if (base == null || base.trim().isEmpty()) return null;
        try {
            String url = base.trim().replaceAll("/+$", "") + path
                + (token == null || token.isEmpty() ? "" : "?token=" + URLEncoder.encode(token, "UTF-8"));
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            if (json != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                conn.disconnect();
                return null;
            }
            try (InputStream in = conn.getInputStream(); Scanner s = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
                return s.hasNext() ? s.next() : "";
            } finally {
                conn.disconnect();
            }
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isLaunchable(Context ctx, String pkg) {
        if (launchable == null) reloadLaunchable(ctx);
        return launchable.contains(pkg);
    }

    static synchronized void reloadLaunchable(Context ctx) {
        Set<String> out = new HashSet<>();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = ctx.getPackageManager().queryIntentActivities(main, PackageManager.MATCH_ALL);
        for (ResolveInfo r : apps) out.add(r.activityInfo.packageName);
        launchable = out;
    }

    private static boolean contains(JSONArray a, String v) {
        if (a == null) return false;
        for (int i = 0; i < a.length(); i++) {
            if (v.equals(a.optString(i))) return true;
        }
        return false;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
