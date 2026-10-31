package app.unibox.launcher;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * The guardian's code: uninstalling Unibox, turning off its protection, its blocker or its place as
 * the home screen asks for a code someone else keeps. The right code opens 15 minutes.
 */
public class GuardActivity extends Activity {

    static final long OPEN_MS = 15 * 60_000L;

    static boolean open(Context ctx) {
        return ctx.getSharedPreferences("unibox_native", MODE_PRIVATE).getLong("guard_until", 0) > System.currentTimeMillis();
    }

    static String sha256(String s) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : h) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        int pad = dp(28);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setBackgroundColor(0xFFF4F3EE);
        root.setPadding(pad, pad, pad, pad);

        TextView k = new TextView(this);
        k.setText("PROTEGIDO");
        k.setTextColor(0xFF3F6B4C);
        k.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        k.setLetterSpacing(0.16f);
        root.addView(k);
        TextView h = new TextView(this);
        h.setText("Esto necesita el código de tu guardián.");
        h.setTextColor(0xFF1E2620);
        h.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        h.setPadding(0, dp(10), 0, dp(8));
        root.addView(h);
        TextView sub = new TextView(this);
        sub.setText("Desinstalar Unibox, quitarle la protección, el bloqueo o el inicio. Con el código tienes 15 minutos.");
        sub.setTextColor(0xFF6B6F68);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        root.addView(sub);

        EditText code = new EditText(this);
        code.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        code.setHint("Código");
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0xFFDCDAD2);
        code.setBackground(bg);
        code.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(28);
        root.addView(code, lp);

        TextView err = new TextView(this);
        err.setTextColor(0xFFA03A2C);
        err.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        err.setPadding(0, dp(8), 0, 0);
        root.addView(err);

        Button ok = new Button(this);
        ok.setText("Abrir 15 minutos");
        ok.setAllCaps(false);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp2.topMargin = dp(16);
        root.addView(ok, lp2);
        Button back = new Button(this);
        back.setText("Volver a Unibox");
        back.setAllCaps(false);
        root.addView(back, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52)));

        ok.setOnClickListener(v -> {
            String want = Policy.guardHash(this);
            String got = code.getText().toString().trim();
            if (want.isEmpty() || !sha256(got).equals(want)) {
                err.setText(want.isEmpty() ? "Aún no hay código configurado." : "No es el código.");
                code.setText("");
                return;
            }
            getSharedPreferences("unibox_native", MODE_PRIVATE).edit().putLong("guard_until", System.currentTimeMillis() + OPEN_MS).apply();
            Policy.report(this, getPackageName(), "código del guardián usado", "guard:code");
            finish();
        });
        back.setOnClickListener(v -> goHome());
        setContentView(root);
    }

    private void goHome() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    @Override
    public void onBackPressed() {
        goHome();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
