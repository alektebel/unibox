package app.unibox.launcher;

import android.app.Notification;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Which apps have something waiting: messaging apps only belong on the home screen when
 * they do. Notification access is granted once over adb. A feed's notifications are removed
 * while the feed can't be opened.
 */
public class NotifListener extends NotificationListenerService {

    static final Set<String> MESSAGING = new HashSet<>(Arrays.asList(
        "com.whatsapp", "org.telegram.messenger", "com.discord", "com.google.android.apps.messaging",
        "com.facebook.orca", "com.Slack", "com.microsoft.teams", "com.google.android.gm"));

    /** Where a count is worth showing on the home screen: messages, and missed calls. */
    static final Set<String> BADGED = new HashSet<>(Arrays.asList(
        "com.google.android.dialer", "com.android.contacts", "com.android.incallui", "com.callapp.contacts"));

    static int badge(String pkg) {
        return MESSAGING.contains(pkg) || BADGED.contains(pkg) ? count(pkg) : 0;
    }

    private static volatile boolean connected;
    private static volatile Map<String, Integer> unread = new HashMap<>();

    /** Messaging app with nothing waiting; unknown (no access) counts as not quiet. */
    static boolean quiet(String pkg) {
        return connected && MESSAGING.contains(pkg) && count(pkg) == 0;
    }

    static int count(String pkg) {
        Integer n = unread.get(pkg);
        return n == null ? 0 : n;
    }

    @Override
    public void onListenerConnected() {
        connected = true;
        try {
            for (StatusBarNotification s : getActiveNotifications()) shut(s);
        } catch (Exception ignored) {
        }
        rebuild();
    }

    @Override
    public void onListenerDisconnected() {
        connected = false;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (shut(sbn)) return;
        rebuild();
    }

    /**
     * A feed's notification while the feed can't be opened (work, a block, the plan, the day's
     * budget, a doomscroll cooldown) is a way in through the side: it goes. Messaging stays.
     */
    private boolean shut(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        if (MESSAGING.contains(pkg) || !Policy.isFeed(this, pkg)) return false;
        Policy.Block b = Policy.decideFor(this, pkg, System.currentTimeMillis());
        if (b == null || !b.noPass) return false;
        try {
            cancelNotification(sbn.getKey());
        } catch (Exception ignored) {
        }
        return true;
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        rebuild();
    }

    private void rebuild() {
        Map<String, Integer> out = new HashMap<>();
        try {
            for (StatusBarNotification s : getActiveNotifications()) {
                Notification n = s.getNotification();
                // ongoing (calls, music) and group summaries aren't messages waiting
                if (s.isOngoing() || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
                out.merge(s.getPackageName(), 1, Integer::sum);
            }
        } catch (Exception ignored) {
        }
        unread = out;
    }
}
