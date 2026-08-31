package com.gelodesu.nmaxdash;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;

/**
 * Reads the notification shade so the dash can show a message without the
 * rider reaching for the phone.
 *
 * Nothing here leaves the device and nothing is written to storage: the
 * service hands each notification straight to the activity, which passes it to
 * the page, which keeps it in memory until the ride ends. Notification access
 * sees every app on the phone, which is why this is off until the rider grants
 * it in Android's own settings screen — an app cannot award it to itself.
 *
 * Three filters do the work that an app picker would otherwise have to. The
 * ongoing flag drops media players, navigation and foreground services; the
 * group-summary flag drops the "3 new messages" duplicate Android posts
 * alongside the real ones; and importance drops the promotional banners, which
 * ship on low-importance channels while messages and calls do not. What
 * survives is roughly what would have been worth stopping for.
 */
public class NoteService extends NotificationListenerService {

    /** Where a notification goes once it has passed the filters. */
    public interface Sink { void onNote(String json); }

    /* Set while the dash is in front of the rider, cleared when it is not.
       A notification posted with no dash on screen has nowhere useful to go. */
    private static volatile Sink sink;

    public static void setSink(Sink s) { sink = s; }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        Sink out = sink;
        if (out == null || sbn == null) return;
        try {
            Notification n = sbn.getNotification();
            if (n == null) return;
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
            if (quiet(sbn)) return;

            Bundle x = n.extras;
            if (x == null) return;
            String title = text(x.get(Notification.EXTRA_TITLE));
            String body = text(x.get(Notification.EXTRA_TEXT));
            if (body.length() == 0) body = text(x.get(Notification.EXTRA_BIG_TEXT));
            if (title.length() == 0 && body.length() == 0) return;

            String pkg = sbn.getPackageName();
            if (pkg == null || pkg.equals(getPackageName())) return;   // never our own

            JSONObject o = new JSONObject();
            o.put("app", label(pkg));
            o.put("pkg", pkg);
            o.put("title", title);
            o.put("body", body);
            out.onNote(o.toString());
        } catch (Exception e) {
            /* A malformed notification is not worth taking the service down for. */
        }
    }

    /** True for channels the system already considers non-urgent. */
    private boolean quiet(StatusBarNotification sbn) {
        if (Build.VERSION.SDK_INT < 24) return false;
        try {
            RankingMap map = getCurrentRanking();
            if (map == null) return false;
            Ranking r = new Ranking();
            if (!map.getRanking(sbn.getKey(), r)) return false;
            return r.getImportance() < NotificationManager.IMPORTANCE_DEFAULT;
        } catch (Exception e) {
            return false;                       // rank unavailable: let it through
        }
    }

    /** The app's name as the rider knows it, falling back to the package. */
    private String label(String pkg) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence l = pm.getApplicationLabel(ai);
            if (l != null && l.length() > 0) return l.toString();
        } catch (Exception e) { /* uninstalled between post and read */ }
        int dot = pkg.lastIndexOf('.');
        return dot >= 0 && dot < pkg.length() - 1 ? pkg.substring(dot + 1) : pkg;
    }

    private static String text(Object o) {
        return o == null ? "" : o.toString().trim();
    }
}
