package app.unibox.launcher;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Time on the phone, from Android's own usage records (nothing leaves the phone): today's total,
 * the top apps, the last week, a daily limit you set, and the alerts that go with it
 * (at 75 % of the limit, at the limit, then every extra hour; and the doomscrolling ones).
 */
final class ScreenTime {

    static final String CHANNEL = "pantalla";
    private static final String PREFS = "unibox_screen";
    private static final int DEFAULT_LIMIT = 240;
    private static final long DAY = 86_400_000L;

    private ScreenTime() {}

    static int limit(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("limit", DEFAULT_LIMIT);
    }

    static void setLimit(Context ctx, int minutes) {
        int m = Math.max(30, Math.min(720, minutes));
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("limit", m).apply();
    }

    private static long midnight(long t) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(t);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    /** Foreground minutes per app between two instants (the launcher and system screens don't count). */
    private static List<Object[]> perApp(Context ctx, long from, long to) {
        List<Object[]> out = new ArrayList<>();
        try {
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            Map<String, UsageStats> m = usm.queryAndAggregateUsageStats(from, to);
            for (Map.Entry<String, UsageStats> e : m.entrySet()) {
                String pkg = e.getKey();
                long ms = e.getValue().getTotalTimeInForeground();
                if (ms < 60_000 || pkg.equals(ctx.getPackageName()) || !Policy.isLaunchable(ctx, pkg)) continue;
                out.add(new Object[] {pkg, (int) (ms / 60_000L)});
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    static int totalToday(Context ctx, long now) {
        int t = 0;
        for (Object[] a : perApp(ctx, midnight(now), now)) t += (Integer) a[1];
        return t;
    }

    private static String label(Context ctx, String pkg) {
        try {
            return ctx.getPackageManager().getApplicationLabel(ctx.getPackageManager().getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    /** {total, limit, apps:[{pkg,label,min}] (top 6), days:[{date,min}] (the last 7, oldest first)}. */
    static String json(Context ctx, long now) {
        try {
            List<Object[]> apps = perApp(ctx, midnight(now), now);
            Collections.sort(apps, (a, b) -> (Integer) b[1] - (Integer) a[1]);
            int total = 0;
            JSONArray top = new JSONArray();
            for (int i = 0; i < apps.size(); i++) {
                total += (Integer) apps.get(i)[1];
                if (i < 6) {
                    top.put(new JSONObject().put("pkg", apps.get(i)[0]).put("label", label(ctx, (String) apps.get(i)[0])).put("min", apps.get(i)[1]));
                }
            }
            JSONArray days = new JSONArray();
            long today = midnight(now);
            for (int d = 6; d >= 0; d--) {
                long from = midnight(today - d * DAY + DAY / 2);
                long to = d == 0 ? now : Math.min(now, midnight(from + DAY + DAY / 2));
                int t = 0;
                for (Object[] a : perApp(ctx, from, to)) t += (Integer) a[1];
                days.put(new JSONObject().put("date", from).put("min", t));
            }
            return new JSONObject().put("total", total).put("limit", limit(ctx)).put("apps", top).put("days", days).toString();
        } catch (Exception e) {
            return "";
        }
    }

    // --- alerts -----------------------------------------------------------------

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Tiempo de pantalla", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Avisos de tiempo de pantalla y de scroll sin fin");
        nm.createNotificationChannel(ch);
    }

    static void alert(Context ctx, int id, String title, String body) {
        if (Build.VERSION.SDK_INT >= 33
            && ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(ctx);
        PendingIntent open = PendingIntent.getActivity(ctx, id,
            new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("open", "pantalla"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder n = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_unibox)
            .setColor(0xFF3F6B4C)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH);
        NotificationManagerCompat.from(ctx).notify(id, n.build());
    }

    private static final int ID_LIMIT = 7101, ID_DOOM = 7102;

    static void doomWarning(Context ctx, String app, int minutes) {
        alert(ctx, ID_DOOM, "Llevas " + minutes + " min haciendo scroll en " + app,
            "Es scroll sin fin. Suelta el móvil un momento; si sigues, " + app + " se cierra un rato.");
    }

    static void doomClosed(Context ctx, String app, int cooldownMinutes) {
        alert(ctx, ID_DOOM, "Scroll sin fin en " + app,
            "Lo he cerrado " + cooldownMinutes + " min. Levántate, bebe agua, mira por la ventana.");
    }

    private static final String fmt(int min) {
        return (min / 60) + " h" + (min % 60 == 0 ? "" : " " + (min % 60) + " min");
    }

    /** Called about once a minute while the screen is on: says so when today's total crosses a line. */
    static void check(Context ctx, long now) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long day = midnight(now);
        int lim = limit(ctx);
        int total = totalToday(ctx, now);
        // levels: 1 = 75 % of the limit, 2 = the limit, 3.. = each extra hour past it
        int level = total >= lim ? 2 + (total - lim) / 60 : total * 4 >= lim * 3 ? 1 : 0;
        int seen = p.getLong("day", 0) == day ? p.getInt("level", 0) : 0;
        if (level <= seen) return;
        p.edit().putLong("day", day).putInt("level", level).apply();
        if (level == 1) {
            alert(ctx, ID_LIMIT, "Llevas " + fmt(total) + " de pantalla hoy", "Tu límite es " + fmt(lim) + ". Te queda " + fmt(lim - total) + ".");
        } else if (level == 2) {
            alert(ctx, ID_LIMIT, "Has llegado a tu límite: " + fmt(total), "Hoy ya está. Lo que quede, que sea corto.");
        } else {
            alert(ctx, ID_LIMIT, fmt(total) + " de pantalla hoy", "Llevas " + fmt(total - lim) + " por encima de tu límite de " + fmt(lim) + ".");
        }
    }
}
