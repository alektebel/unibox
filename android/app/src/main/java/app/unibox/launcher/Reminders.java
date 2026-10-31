package app.unibox.launcher;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Phone reminders without a push service: the server sends the coming week as JSON
 * (mobilePayload().reminders), and each one becomes an AlarmManager alarm that
 * ReminderReceiver turns into a notification. Every launch replaces the whole set;
 * the last set is kept so a reboot can restore it.
 */
final class Reminders {

    static final String CHANNEL = "recordatorios";
    private static final String PREFS = "unibox_reminders";

    private Reminders() {}

    static void schedule(Context ctx, String json) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (json == null || json.equals(prefs.getString("json", null))) return;
        prefs.edit().putString("json", json).apply();
        apply(ctx, json);
    }

    /** After a reboot alarms are gone: put the last set back. */
    static void restore(Context ctx) {
        String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("json", null);
        if (json != null) apply(ctx, json);
    }

    private static void apply(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        for (String key : prefs.getStringSet("keys", new HashSet<>())) {
            am.cancel(pending(ctx, key, null, null, null));
        }
        Set<String> keys = new HashSet<>();
        long now = System.currentTimeMillis();
        try {
            JSONArray list = new JSONArray(json);
            for (int i = 0; i < list.length(); i++) {
                JSONObject r = list.getJSONObject(i);
                long at = r.getLong("at");
                if (at <= now) continue;
                String key = r.getString("key");
                PendingIntent pi = pending(ctx, key, r.optString("title"), r.optString("body"), r.optString("open", null));
                // Exact where allowed (USE_EXACT_ALARM is granted to sideloaded apps on 13+);
                // otherwise Android may shift it by a few minutes in doze, which is fine for a reminder.
                if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
                keys.add(key);
            }
        } catch (Exception ignored) {
        }
        prefs.edit().putStringSet("keys", keys).apply();
    }

    private static PendingIntent pending(Context ctx, String key, String title, String body, String open) {
        Intent i = new Intent(ctx, ReminderReceiver.class)
            .setAction("app.unibox.launcher.REMINDER")
            .putExtra("key", key);
        if (title != null) i.putExtra("title", title);
        if (body != null) i.putExtra("body", body);
        if (open != null) i.putExtra("open", open);
        return PendingIntent.getBroadcast(ctx, key.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Recordatorios", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Sesiones de tus metas, ejercicio, tu agenda y el resumen de la mañana");
        nm.createNotificationChannel(ch);
    }
}
