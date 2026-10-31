package app.unibox.launcher;

import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;

/**
 * The day-by-day history, from Android's own usage records (nothing leaves the phone): per day the
 * screen-on minutes, how many times the phone was picked up, the first and last use, the use late at
 * night, the doomscrolling episodes the blocker closed, and the top apps. Android keeps screen events
 * for about a week; older days only have their app totals ("events": false).
 */
final class DayStats {

    private static final long DAY = 86_400_000L;
    private static final long MIN_SESSION = 20_000L;

    private DayStats() {}

    private static final class Day {
        long date;
        int screenMs, pickups, lateEveMs, lateEarlyMs;
        long first, last;
        boolean events;
    }

    static String json(Context ctx, long now, int n) {
        try {
            long today = ScreenTime.midnight(now);
            long from = ScreenTime.midnight(today - (n - 1) * DAY + DAY / 2);
            Day[] days = new Day[n];
            for (int i = 0; i < n; i++) {
                days[i] = new Day();
                days[i].date = ScreenTime.midnight(from + i * DAY + DAY / 2);
            }
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            UsageEvents ev = usm.queryEvents(from, now);
            UsageEvents.Event e = new UsageEvents.Event();
            long on = 0;
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e);
                int t = e.getEventType();
                if (t == 15) {
                    on = e.getTimeStamp();
                } else if (t == 16 && on != 0) {
                    addSession(days, on, e.getTimeStamp());
                    on = 0;
                }
            }
            if (on != 0) addSession(days, on, now);
            JSONArray out = new JSONArray();
            for (int i = 0; i < n; i++) {
                Day d = days[i];
                long end = i == n - 1 ? now : d.date + DAY;
                List<Object[]> apps = ScreenTime.perApp(ctx, d.date, Math.min(end, now));
                Collections.sort(apps, (a, b) -> (Integer) b[1] - (Integer) a[1]);
                int total = 0;
                for (Object[] a : apps) total += (Integer) a[1];
                JSONArray top = new JSONArray();
                for (int k = 0; k < Math.min(3, apps.size()); k++) {
                    top.put(new JSONObject().put("label", ScreenTime.label(ctx, (String) apps.get(k)[0])).put("min", apps.get(k)[1]));
                }
                out.put(new JSONObject()
                    .put("date", d.date)
                    .put("min", total)
                    .put("screenMin", d.screenMs / 60_000)
                    .put("pickups", d.pickups)
                    .put("first", d.first)
                    .put("last", d.last)
                    .put("lateEve", d.lateEveMs / 60_000)
                    .put("lateEarly", d.lateEarlyMs / 60_000)
                    .put("doom", ScreenTime.doomOn(ctx, d.date))
                    .put("events", d.events)
                    .put("top", top));
            }
            return out.toString();
        } catch (Exception ex) {
            return "[]";
        }
    }

    private static void addSession(Day[] days, long start, long end) {
        if (end - start < MIN_SESSION) return;
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(start);
        int hour = c.get(Calendar.HOUR_OF_DAY);
        long mid = ScreenTime.midnight(start);
        for (Day d : days) {
            if (d.date != mid) continue;
            d.events = true;
            d.screenMs += (int) (end - start);
            d.pickups++;
            // the first use is the first one after 05:00; the last, the last that ended before the next night's 05:00
            if (hour >= 5 && (d.first == 0 || start < d.first)) d.first = start;
            if (hour >= 5 && end > d.last) d.last = end;
            if (hour >= 23) d.lateEveMs += (int) (end - start);
            if (hour < 5) d.lateEarlyMs += (int) (end - start);
            return;
        }
    }
}
