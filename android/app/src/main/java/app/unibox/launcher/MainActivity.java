package app.unibox.launcher;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Thin wrapper: hosts the unibox web UI and receives Android shares.
 *
 * The first-run launcher stores the backend URL/token in SharedPreferences via
 * the UniboxNative JS bridge; shares are forwarded to /api/capture[/file].
 */
public class MainActivity extends BridgeActivity {

    private static final String PREFS = "unibox_native";
    // set by a notification tap; the page takes it when it's ready (takeOpen) or is told now
    private volatile String pendingOpen;

    public class NativeBridge {
        @JavascriptInterface
        public void saveServer(String url, String token) {
            getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString("url", url == null ? "" : url.trim())
                .putString("token", token == null ? "" : token.trim())
                .apply();
        }

        /** Links and Google sign-in belong in the browser (Google refuses sign-in inside apps). */
        @JavascriptInterface
        public void openExternal(String url) {
            if (url == null || !url.matches("(?i)^https?://.+")) return;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Throwable ignored) {
            }
        }

        /** Holding an app in the drawer: Android's own uninstall confirmation (the guardian's code covers Unibox itself). */
        @JavascriptInterface
        public void uninstallApp(String pkg) {
            if (pkg == null || !pkg.matches("[A-Za-z0-9_.]+")) return;
            try {
                startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Throwable ignored) {
            }
        }

        /** Last night's sleep, estimated on the phone: {start, end, minutes} or "". */
        @JavascriptInterface
        public String sleepLast() {
            return Sleep.last(getApplicationContext(), System.currentTimeMillis());
        }

        /** Today's screen time, the top apps and the last week, from the phone's own records. */
        @JavascriptInterface
        public String screenToday() {
            return ScreenTime.json(getApplicationContext(), System.currentTimeMillis());
        }

        /** The last n days, one record each: screen minutes, pickups, first/last use, late use, doomscroll episodes, top apps. */
        @JavascriptInterface
        public String dayStats(int n) {
            return DayStats.json(getApplicationContext(), System.currentTimeMillis(), Math.max(1, Math.min(30, n)));
        }

        @JavascriptInterface
        public void setScreenLimit(int minutes) {
            ScreenTime.setLimit(getApplicationContext(), minutes);
        }

        /** The server's app policy, cached for the blocker (Policy.java). */
        @JavascriptInterface
        public void setPolicy(String json) {
            Policy.save(getApplicationContext(), json);
        }

        /** Launchable apps for the home screen, with whether they'd be blocked right now. */
        @JavascriptInterface
        public String listApps() {
            JSONArray out = new JSONArray();
            long now = System.currentTimeMillis();
            for (String[] app : installedApps()) {
                try {
                    out.put(new JSONObject()
                        .put("pkg", app[0])
                        .put("label", app[1])
                        .put("blocked", Policy.decide(getApplicationContext(), app[0], now) != null)
                        .put("unread", NotifListener.badge(app[0]))
                        .put("quiet", NotifListener.quiet(app[0])));
                } catch (Exception ignored) {
                }
            }
            return out.toString();
        }

        /** Where the phone is, as far as Wi-Fi says: the network's name (needs location), charging. */
        @JavascriptInterface
        public String context() {
            JSONObject o = new JSONObject();
            try {
                String ssid = null;
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                    android.net.wifi.WifiInfo info = wm == null ? null : wm.getConnectionInfo();
                    if (info != null && info.getNetworkId() != -1) {
                        String raw = info.getSSID();
                        if (raw != null && !raw.contains("unknown ssid")) ssid = raw.replaceAll("^\"|\"$", "");
                    }
                }
                android.content.Intent batt = registerReceiver(null, new android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                int plugged = batt == null ? 0 : batt.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0);
                o.put("net", ssid == null ? "none" : ssid).put("ssid", ssid == null ? "" : ssid).put("charging", plugged != 0);
            } catch (Exception ignored) {
            }
            return o.toString();
        }

        /** A screen a notification asked to open ("chat"), handed over once. */
        @JavascriptInterface
        public String takeOpen() {
            String v = pendingOpen;
            pendingOpen = null;
            return v == null ? "" : v;
        }

        /** Open the clock (alarms) when the home screen's clock is tapped. */
        @JavascriptInterface
        public void openClock() {
            try {
                startActivity(new Intent(android.provider.AlarmClock.ACTION_SHOW_ALARMS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Throwable e) {
                Intent i = getPackageManager().getLaunchIntentForPackage("com.android.deskclock");
                if (i != null) startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
        }

        /** Status and navigation bars in the screen's own colour (dark at night). */
        @JavascriptInterface
        public void setBars(String color, boolean darkIcons) {
            runOnUiThread(() -> {
                try {
                    int c = android.graphics.Color.parseColor(color);
                    getWindow().setStatusBarColor(c);
                    getWindow().setNavigationBarColor(c);
                    androidx.core.view.WindowInsetsControllerCompat bars =
                        androidx.core.view.WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                    bars.setAppearanceLightStatusBars(darkIcons);
                    bars.setAppearanceLightNavigationBars(darkIcons);
                } catch (Throwable ignored) {
                }
            });
        }

        /** The apps you tend to use at this hour that are allowed right now, best first. */
        @JavascriptInterface
        public String suggestApps(int n) {
            PackageManager pm = getPackageManager();
            long now = System.currentTimeMillis();
            JSONArray out = new JSONArray();
            // messages waiting go first; a messaging app with none doesn't show at all
            List<String> order = new ArrayList<>();
            for (String pkg : NotifListener.MESSAGING) if (NotifListener.count(pkg) > 0) order.add(pkg);
            for (String pkg : AppUsage.ranked(getApplicationContext(), now)) if (!order.contains(pkg)) order.add(pkg);
            for (String pkg : order) {
                if (out.length() >= n) break;
                if (NotifListener.quiet(pkg)) continue;
                if (pkg.equals(getPackageName()) || !Policy.isLaunchable(getApplicationContext(), pkg)) continue;
                if (pm.resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(pkg), 0) != null) continue;
                if (Policy.decide(getApplicationContext(), pkg, now) != null) continue;
                try {
                    out.put(new JSONObject().put("pkg", pkg).put("label", label(pkg))
                        .put("unread", NotifListener.badge(pkg)));
                } catch (Exception ignored) {
                }
            }
            return out.toString();
        }

        /** Open an app from the home screen; one that isn't allowed now gets the block screen. */
        @JavascriptInterface
        public void launchApp(String pkg) {
            Policy.Block b = Policy.decide(getApplicationContext(), pkg, System.currentTimeMillis());
            Intent i = b != null
                ? BlockActivity.intent(MainActivity.this, pkg, b)
                : getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return;
            try {
                startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Throwable ignored) {
            }
        }

        /** Whether the blocker (accessibility service) is switched on. */
        @JavascriptInterface
        public boolean blockerOn() {
            return blockerEnabled();
        }

        @JavascriptInterface
        public void openBlockerSettings() {
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }

        /** The coming week of reminders, as JSON from the server; replaces what was scheduled. */
        @JavascriptInterface
        public void scheduleReminders(String json) {
            askForNotifications();
            Reminders.schedule(getApplicationContext(), json);
        }
    }

    // pkg → label of every launchable app; rebuilt when apps are installed or removed
    private static volatile List<String[]> apps;

    private List<String[]> installedApps() {
        List<String[]> list = apps;
        if (list != null) return list;
        PackageManager pm = getPackageManager();
        List<String[]> out = new ArrayList<>();
        for (ResolveInfo r : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(getPackageName())) continue;
            out.add(new String[] { pkg, r.loadLabel(pm).toString() });
        }
        apps = out;
        Policy.reloadLaunchable(getApplicationContext());
        return out;
    }

    private String label(String pkg) {
        for (String[] a : installedApps()) if (a[0].equals(pkg)) return a[1];
        return pkg;
    }

    private final android.content.BroadcastReceiver packagesChanged = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context c, Intent i) {
            apps = null;
            ShortsGuard.reset();
        }
    };

    /** Android 13+ needs the user's yes once before any notification shows. */
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (prefs.getBoolean("asked_notifications", false)) return;
        prefs.edit().putBoolean("asked_notifications", true).apply();
        runOnUiThread(() -> requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1));
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            this.bridge.getWebView().addJavascriptInterface(new NativeBridge(), "UniboxNative");
            // the launcher has no scroll bars (the page hides its own; these are the WebView's)
            this.bridge.getWebView().setVerticalScrollBarEnabled(false);
            this.bridge.getWebView().setHorizontalScrollBarEnabled(false);
        } catch (Throwable ignored) {
        }
        handleShare(getIntent());
        pendingOpen = getIntent() == null ? null : getIntent().getStringExtra("open");
        android.content.IntentFilter f = new android.content.IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED);
        f.addAction(Intent.ACTION_PACKAGE_REMOVED);
        f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        registerReceiver(packagesChanged, f);
        AppUsage.onUpdate = () -> runOnUiThread(() -> {
            try {
                this.bridge.getWebView().evaluateJavascript("window.mAppsChanged && mAppsChanged()", null);
            } catch (Throwable ignored) {
            }
        });
        // warm the caches off the UI thread so the first home screen is quick
        new Thread(() -> {
            installedApps();
            AppUsage.ranked(getApplicationContext(), System.currentTimeMillis());
        }).start();
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(packagesChanged);
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // a notification: open what it points to (the page may already be showing)
        String open = intent.getStringExtra("open");
        if (open != null) {
            pendingOpen = open;
            try {
                this.bridge.getWebView().evaluateJavascript("window.mOpenFromNative && mOpenFromNative()", null);
            } catch (Throwable ignored) {
            }
            return;
        }
        // the home button while Unibox is already showing: back to Hoy
        if (Intent.ACTION_MAIN.equals(intent.getAction()) && intent.hasCategory(Intent.CATEGORY_HOME)) {
            try {
                this.bridge.getWebView().evaluateJavascript("window.mHomePressed && mHomePressed()", null);
            } catch (Throwable ignored) {
            }
            return;
        }
        handleShare(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        ensureBlocker();
        Policy.refresh(getApplicationContext(), false);
    }

    private boolean blockerEnabled() {
        String on = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        ComponentName me = new ComponentName(this, BlockerService.class);
        return on != null && (on.contains(me.flattenToString()) || on.contains(me.flattenToShortString()));
    }

    /**
     * Android drops an accessibility service when its app is force-stopped (HyperOS does that
     * when clearing recents). With WRITE_SECURE_SETTINGS, granted over adb, put it back.
     */
    /**
     * Adult sites are filtered for the whole phone, every app and browser, by a family DNS
     * (Cloudflare's). Only when no private DNS of your own is set; you can turn it off in
     * Ajustes → Conexión y compartir → DNS privado.
     */
    private static final String FAMILY_DNS = "family.cloudflare-dns.com";
    private void ensureFamilyDns() {
        if (checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != PackageManager.PERMISSION_GRANTED) return;
        try {
            android.content.SharedPreferences prefs = getSharedPreferences("unibox_native", MODE_PRIVATE);
            String mode = Settings.Global.getString(getContentResolver(), "private_dns_mode");
            // set once; if you change it afterwards, it's yours
            if (prefs.getBoolean("family_dns_set", false) || "hostname".equals(mode)) return;
            Settings.Global.putString(getContentResolver(), "private_dns_specifier", FAMILY_DNS);
            Settings.Global.putString(getContentResolver(), "private_dns_mode", "hostname");
            prefs.edit().putBoolean("family_dns_set", true).apply();
        } catch (Throwable ignored) {
        }
    }

    private void ensureBlocker() {
        ensureFamilyDns();
        if (blockerEnabled() || checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") != PackageManager.PERMISSION_GRANTED) return;
        try {
            String on = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            String me = new ComponentName(this, BlockerService.class).flattenToString();
            Settings.Secure.putString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                on == null || on.isEmpty() ? me : on + ":" + me);
            Settings.Secure.putInt(getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        } catch (Throwable ignored) {
        }
    }

    /** As the home screen, back has nowhere to go: stay on Unibox. */
    @Override
    public void onBackPressed() {
        try {
            this.bridge.getWebView().evaluateJavascript("window.mBackPressed && mBackPressed()", null);
        } catch (Throwable ignored) {
        }
    }

    private void handleShare(Intent intent) {
        if (intent == null) return;
        final String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String base = prefs.getString("url", "");
        final String token = prefs.getString("token", "");
        if (base == null || base.trim().isEmpty()) {
            Toast.makeText(this, "Abre Unibox una vez y vuelve a compartir", Toast.LENGTH_LONG).show();
            return;
        }
        final String server = base.trim().replaceAll("/+$", "");
        final String sharedText = join(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT));
        final ArrayList<Uri> streams = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) streams.add(uri);
        } else {
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null) streams.addAll(uris);
        }

        new Thread(() -> {
            int sent = 0;
            try {
                if (sharedText != null && !sharedText.trim().isEmpty() && postJson(server, token, sharedText)) sent++;
                for (Uri uri : streams) {
                    if (postFile(server, token, uri)) sent++;
                }
            } catch (Throwable ignored) {
            }
            final int n = sent;
            runOnUiThread(() -> Toast.makeText(
                this,
                n > 0 ? (n == 1 ? "Guardado en Unibox" : "Guardadas " + n + " cosas en Unibox") : "No llego a Unibox",
                Toast.LENGTH_SHORT).show());
        }).start();
    }

    private boolean postJson(String server, String token, String text) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(server + "/api/capture" + qs(token)).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(20000);
        byte[] body = ("{\"text\":" + jsonString(text) + "}").getBytes(StandardCharsets.UTF_8);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body);
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        return code >= 200 && code < 300;
    }

    private boolean postFile(String server, String token, Uri uri) throws Exception {
        String name = displayName(uri);
        HttpURLConnection conn = (HttpURLConnection) new URL(
            server + "/api/capture/file?name=" + enc(name) + qsAmp(token)
        ).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/octet-stream");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(60000);
        ContentResolver resolver = getContentResolver();
        try (InputStream in = resolver.openInputStream(uri); OutputStream os = conn.getOutputStream()) {
            if (in == null) return false;
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) > 0) os.write(buf, 0, read);
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        return code >= 200 && code < 300;
    }

    private String displayName(Uri uri) {
        String fallback = "shared-" + System.currentTimeMillis();
        try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String value = cursor.getString(idx);
                    if (value != null && !value.isEmpty()) return value;
                }
            }
        } catch (Throwable ignored) {
        }
        String last = uri.getLastPathSegment();
        return last == null || last.isEmpty() ? fallback : last;
    }

    private static String join(String subject, String text) {
        StringBuilder sb = new StringBuilder();
        if (subject != null && !subject.trim().isEmpty()) sb.append(subject.trim());
        if (text != null && !text.trim().isEmpty()) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(text.trim());
        }
        return sb.toString();
    }

    private static String enc(String value) throws Exception {
        return URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }

    private static String qs(String token) throws Exception {
        return token == null || token.isEmpty() ? "" : "?token=" + enc(token);
    }

    private static String qsAmp(String token) throws Exception {
        return token == null || token.isEmpty() ? "" : "&token=" + enc(token);
    }

    private static String jsonString(String value) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
