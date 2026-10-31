package app.unibox.launcher;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Device administrator with no powers of its own: while it's active, Android won't uninstall
 * Unibox. Turning it off goes through a screen the blocker locks behind the guardian's code.
 */
public class Admin extends DeviceAdminReceiver {
    @Override
    public CharSequence onDisableRequested(Context ctx, Intent intent) {
        return "Unibox deja de protegerse. Solo con el código de tu guardián.";
    }
}
