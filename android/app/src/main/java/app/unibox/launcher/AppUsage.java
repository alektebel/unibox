package app.unibox.launcher;

import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Which apps you tend to open at this time: Android's own usage history (last four weeks),
 * weighted by how close each opening was to the current hour and whether it was the same
 * kind of day (weekday or weekend). Needs usage access, granted once over adb.
 */
final class AppUsage {

    private static final long WINDOW_MS = 28L * 86_400_000L;
    private static final long CACHE_MS = 10 * 60_000L;

    private static volatile List<String> cached;
    private static long cachedAt;
    private static int cachedHour = -1;

    private AppUsage() {}

    private static volatile boolean computing;
    /** Told when a new ranking is ready, so the home screen can redraw with it. */
    static volatile Runnable onUpdate;

    /**
     * The last ranking, never blocking the caller: when it's stale it's recomputed on a
     * background thread (four weeks of events take a while on the phone) and the next
     * call gets the new one.
     */
    static List<String> ranked(Context ctx, long now) {
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        // after a restart, start from the last ranking we had instead of an empty home screen
        if (cached == null) {
            String saved = ctx.getSharedPreferences("unibox_usage", Context.MODE_PRIVATE).getString("ranked", "");
            if (!saved.isEmpty()) cached = new ArrayList<>(java.util.Arrays.asList(saved.split(",")));
        }
        boolean stale = cached == null || now - cachedAt > CACHE_MS || hour != cachedHour;
        if (stale && !computing) {
            computing = true;
            Context app = ctx.getApplicationContext();
            new Thread(() -> {
                try {
                    compute(app, System.currentTimeMillis());
                } finally {
                    computing = false;
                }
                Runnable r = onUpdate;
                if (r != null) r.run();
            }).start();
        }
        return cached == null ? new ArrayList<>() : cached;
    }

    /** Minutes on screen in games since midnight (from the phone's own usage records). */
    static int gameMinutesToday(Context ctx, long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        long total = 0;
        try {
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            Map<String, android.app.usage.UsageStats> m = usm.queryAndAggregateUsageStats(c.getTimeInMillis(), now);
            for (Map.Entry<String, android.app.usage.UsageStats> e : m.entrySet()) {
                if (Policy.isGame(ctx, e.getKey())) total += e.getValue().getTotalTimeInForeground();
            }
        } catch (Exception ignored) {
        }
        return (int) (total / 60_000L);
    }

    private static void compute(Context ctx, long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        int hour = c.get(Calendar.HOUR_OF_DAY);
        boolean weekend = isWeekend(c);
        Map<String, Double> score = new HashMap<>();
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        try {
            UsageEvents events = usm.queryEvents(now - WINDOW_MS, now);
            UsageEvents.Event e = new UsageEvents.Event();
            Calendar t = Calendar.getInstance();
            String last = null;
            while (events.hasNextEvent()) {
                events.getNextEvent(e);
                if (e.getEventType() != UsageEvents.Event.ACTIVITY_RESUMED) continue;
                String pkg = e.getPackageName();
                // one opening, not every screen inside the same app
                if (pkg.equals(last)) continue;
                last = pkg;
                t.setTimeInMillis(e.getTimeStamp());
                int d = Math.abs(t.get(Calendar.HOUR_OF_DAY) - hour);
                d = Math.min(d, 24 - d);
                double w = d == 0 ? 1.0 : d == 1 ? 0.5 : d == 2 ? 0.15 : 0.02;
                if (isWeekend(t) == weekend) w *= 1.5;
                // recent weeks count more
                w *= 1.0 - 0.5 * (now - e.getTimeStamp()) / (double) WINDOW_MS;
                score.merge(pkg, w, Double::sum);
            }
        } catch (Exception ignored) {
        }
        List<String> out = new ArrayList<>(score.keySet());
        out.sort((a, b) -> Double.compare(score.get(b), score.get(a)));
        cached = out;
        cachedAt = now;
        cachedHour = hour;
        ctx.getSharedPreferences("unibox_usage", Context.MODE_PRIVATE).edit()
            .putString("ranked", String.join(",", out.subList(0, Math.min(40, out.size())))).apply();
    }

    private static boolean isWeekend(Calendar c) {
        int dow = c.get(Calendar.DAY_OF_WEEK);
        return dow == Calendar.SATURDAY || dow == Calendar.SUNDAY;
    }
}
