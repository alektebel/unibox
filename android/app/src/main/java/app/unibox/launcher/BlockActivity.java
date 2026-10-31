package app.unibox.launcher;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Shown over an app that isn't allowed now. Native on purpose: it must work offline.
 * Getting through costs a wait (that only runs while you look at it) plus a reason;
 * both the pass and the reason are reported to the server.
 */
public class BlockActivity extends Activity {

    private static final int BG = 0xFFF4F3EE, TEXT = 0xFF1E2620, MUTED = 0xFF6B7068, ACCENT = 0xFF3F6B4C,
        DARK = 0xFF26392B, DIV = 0xFFE6E4DD;

    private final Handler tick = new Handler(Looper.getMainLooper());
    private String pkg, windowKey, appName;
    private int waitSeconds, passMinutes, left;
    private boolean counting;
    /** YouTube caught in a browser: letting it through goes back to that browser, not the app. */
    private String returnTo;
    private EditText reason;
    private Button open;

    static Intent intent(Context ctx, String pkg, Policy.Block b) {
        return new Intent(ctx, BlockActivity.class)
            .putExtra("pkg", pkg)
            .putExtra("key", b.windowKey)
            .putExtra("title", b.title)
            .putExtra("kind", b.kind)
            .putExtra("until", b.until)
            .putExtra("hard", b.hard)
            .putExtra("wait", b.waitSeconds)
            .putExtra("pass", b.passMinutes)
            .putExtra("noPass", b.noPass);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        build(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        build(intent);
    }

    private void build(Intent in) {
        pkg = in.getStringExtra("pkg");
        windowKey = in.getStringExtra("key");
        waitSeconds = in.getIntExtra("wait", 60);
        passMinutes = in.getIntExtra("pass", 10);
        appName = in.getStringExtra("name") != null ? in.getStringExtra("name") : label(pkg);
        returnTo = in.getStringExtra("returnTo");
        String kind = in.getStringExtra("kind");
        String title = in.getStringExtra("title");
        long until = in.getLongExtra("until", 0);
        String hhmm = until > 0 ? new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(until)) : "";
        counting = false;
        tick.removeCallbacksAndMessages(null);

        String kicker, head, sub;
        switch (kind == null ? "" : kind) {
            case "session":
            case "plan":
            case "focus":
                kicker = "AHORA TOCA";
                head = title;
                sub = appName + " espera hasta las " + hhmm + ".";
                break;
            case "work":
                kicker = "HORARIO DE TRABAJO";
                head = appName + " vuelve a las " + hhmm + ".";
                sub = "Hasta entonces, sin feeds ni navegador.";
                break;
            case "doom":
                kicker = "BASTA DE SCROLL";
                head = title;
                sub = "Los feeds vuelven a las " + hhmm + ". Sal a hacer otra cosa.";
                break;
            case "bad":
                kicker = "ESTO NO";
                head = title == null || title.isEmpty() ? "Apuestas, no." : title;
                sub = appName + " no se abre. Queda apuntado.";
                break;
            case "budget":
                kicker = "POR HOY, YA";
                head = title;
                sub = appName + " vuelve mañana.";
                break;
            case "night":
                kicker = "A DORMIR";
                head = "Mañana sigue.";
                sub = appName + " vuelve a las " + hhmm + ".";
                break;
            default:
                kicker = "UN MOMENTO";
                head = "¿Seguro que ahora " + appName + "?";
                sub = "Cuesta " + waitSeconds + " segundos y un motivo. Queda apuntado.";
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        root.addView(text(kicker, 12, ACCENT, true, 0.16f));
        TextView h = text(head, 30, TEXT, false, -0.02f);
        h.setPadding(0, dp(10), 0, dp(8));
        root.addView(h);
        TextView subView = text(sub, 15, MUTED, false, 0);
        root.addView(subView);

        Button back = button("Volver a Unibox", true);
        back.setOnClickListener(v -> goHome());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(32);
        root.addView(back, lp);

        LinearLayout need = new LinearLayout(this);
        need.setOrientation(LinearLayout.VERTICAL);
        need.setVisibility(View.GONE);

        Button ask = button("Necesito " + appName, false);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp2.topMargin = dp(10);
        root.addView(ask, lp2);
        if ("budget".equals(kind) || "bad".equals(kind) || "doom".equals(kind)) ask.setVisibility(View.GONE);
        if (in.getBooleanExtra("noPass", false) && !"budget".equals(kind) && !"bad".equals(kind) && !"doom".equals(kind)) {
            ask.setVisibility(View.GONE);
            sub = appName + (hhmm.isEmpty() ? " no se abre ahora." : " no se abre hasta las " + hhmm + ".");
            subView.setText(sub);
        }
        ask.setOnClickListener(v -> {
            ask.setVisibility(View.GONE);
            need.setVisibility(View.VISIBLE);
            reason.requestFocus();
            startCountdown();
        });

        reason = new EditText(this);
        reason.setHint("¿Para qué?");
        reason.setTextColor(TEXT);
        reason.setHintTextColor(MUTED);
        reason.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        reason.setBackground(rounded(Color.WHITE, DIV));
        reason.setPadding(dp(14), dp(12), dp(14), dp(12));
        reason.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            public void onTextChanged(CharSequence s, int a, int b, int c) {}
            public void afterTextChanged(Editable s) { updateOpen(); }
        });
        LinearLayout.LayoutParams lp3 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp3.topMargin = dp(24);
        need.addView(reason, lp3);

        open = button("", false);
        open.setOnClickListener(v -> letThrough());
        LinearLayout.LayoutParams lp4 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp4.topMargin = dp(10);
        need.addView(open, lp4);
        root.addView(need);

        setContentView(root);
        left = waitSeconds;
        updateOpen();
    }

    private void startCountdown() {
        counting = true;
        tick.removeCallbacksAndMessages(null);
        tick.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!counting || left <= 0) return;
                left--;
                updateOpen();
                if (left > 0) tick.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private void updateOpen() {
        if (open == null) return;
        boolean ready = left <= 0 && reason.getText().toString().trim().length() >= 3;
        open.setEnabled(ready);
        open.setAlpha(ready ? 1f : 0.5f);
        open.setText(left > 0 ? "Espera " + left + " s" : ready ? "Abrir " + appName + " " + passMinutes + " min" : "Escribe para qué");
    }

    private void letThrough() {
        Policy.grantPass(this, pkg, passMinutes, reason.getText().toString().trim(), windowKey);
        Intent launch = getPackageManager().getLaunchIntentForPackage(returnTo != null ? returnTo : pkg);
        if (launch != null) startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    private void goHome() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    @Override
    public void onBackPressed() {
        goHome();
    }

    /** The wait only counts while you're looking at it: leaving starts it over. */
    @Override
    protected void onPause() {
        super.onPause();
        if (counting) {
            counting = false;
            tick.removeCallbacksAndMessages(null);
            left = waitSeconds;
            updateOpen();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (open != null && reason != null && open.getParent() != null
            && ((View) open.getParent()).getVisibility() == View.VISIBLE && left > 0) {
            startCountdown();
        }
    }

    private String label(String p) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(p, 0)).toString();
        } catch (Exception e) {
            return p;
        }
    }

    private TextView text(String s, int sp, int color, boolean mono, float spacing) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (mono) t.setTypeface(Typeface.MONOSPACE);
        t.setLetterSpacing(spacing);
        return t;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(primary ? Color.WHITE : ACCENT);
        b.setBackground(primary ? rounded(DARK, DARK) : rounded(Color.TRANSPARENT, DIV));
        b.setStateListAnimator(null);
        return b;
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(12));
        g.setStroke(dp(1), stroke);
        return g;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
