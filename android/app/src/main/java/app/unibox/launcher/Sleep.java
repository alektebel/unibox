package app.unibox.launcher;

import android.app.AlarmManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

/**
 * An estimate of last night's sleep, worked out on the phone and kept there: you fell asleep when
 * you stopped touching it, and woke when you picked it up again or when your alarm went off,
 * whichever came first. Only the screen's on/off history and your next alarm are read.
 */
final class Sleep {

    private static final long MIN_USE = 20_000L;       // a screen-on shorter than this is a notification, not you
    private static final long MIN_SLEEP = 3 * 3_600_000L;
    private static final String PREFS = "unibox_sleep";

    private Sleep() {}

    /** The alarm that's set, remembered so that after it rings we still know when it was. */
    static void noteAlarm(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            AlarmManager.AlarmClockInfo a = am == null ? null : am.getNextAlarmClock();
            if (a == null) return;
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String seen = p.getString("alarms", "");
            String t = String.valueOf(a.getTriggerTime());
            if (("," + seen + ",").contains("," + t + ",")) return;
            String[] parts = seen.isEmpty() ? new String[0] : seen.split(",");
            StringBuilder out = new StringBuilder();
            for (int i = Math.max(0, parts.length - 5); i < parts.length; i++) out.append(parts[i]).append(',');
            p.edit().putString("alarms", out + t).apply();
        } catch (Throwable ignored) {
        }
    }

    private static long alarmIn(Context ctx, long from, long to) {
        String seen = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("alarms", "");
        long best = 0;
        for (String s : seen.split(",")) {
            try {
                long t = Long.parseLong(s);
                if (t > from && t < to && (best == 0 || t < best)) best = t;
            } catch (NumberFormatException ignored) {
            }
        }
        return best;
    }

    /** {start, end, minutes} for the night that just ended, or "" when there's no clear one. */
    static String last(Context ctx, long now) {
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return "";
        long from = now - 26 * 3_600_000L;
        // screen sessions you actually used
        List<long[]> uses = new ArrayList<>();
        try {
            UsageEvents ev = usm.queryEvents(from, now);
            UsageEvents.Event e = new UsageEvents.Event();
            long on = 0;
            while (ev.hasNextEvent()) {
                ev.getNextEvent(e);
                if (e.getEventType() == 15) on = e.getTimeStamp();             // SCREEN_INTERACTIVE
                else if (e.getEventType() == 16 && on > 0) {                   // SCREEN_NON_INTERACTIVE
                    if (e.getTimeStamp() - on >= MIN_USE) uses.add(new long[]{on, e.getTimeStamp()});
                    on = 0;
                }
            }
            if (on > 0 && now - on >= MIN_USE) uses.add(new long[]{on, now});
        } catch (Throwable t) {
            return "";
        }
        if (uses.isEmpty()) return "";
        // the longest stretch without using it, starting in the evening or night
        long bestStart = 0, bestEnd = 0;
        for (int i = 0; i + 1 < uses.size(); i++) {
            long a = uses.get(i)[1], b = uses.get(i + 1)[0];
            Calendar c = Calendar.getInstance();
            c.setTimeInMillis(a);
            int h = c.get(Calendar.HOUR_OF_DAY);
            if (h >= 9 && h < 20) continue;
            if (b - a >= MIN_SLEEP && b - a > bestEnd - bestStart) { bestStart = a; bestEnd = b; }
        }
        if (bestStart == 0) return "";
        long alarm = alarmIn(ctx, bestStart, bestEnd);
        long end = alarm > 0 ? alarm : bestEnd;
        try {
            return new JSONObject().put("start", bestStart).put("end", end).put("minutes", (end - bestStart) / 60_000L).toString();
        } catch (Throwable t) {
            return "";
        }
    }
}
