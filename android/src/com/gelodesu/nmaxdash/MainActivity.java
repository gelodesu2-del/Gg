package com.gelodesu.nmaxdash;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * A WebView shell around the hosted dash.
 *
 * The point of the shell is the things a browser tab will not do: no address
 * bar taking the top of the screen, no system status bar over the speed, the
 * screen held awake, and the orientation pinned so a stop at the lights does
 * not spin the cluster into portrait.
 *
 * Two rules matter in shouldOverrideUrlLoading. Anything that is not the dash
 * itself — an sms: link from crash detection, a viber: link, a maps route —
 * leaves for the app that owns it. Spotify's login is the exception that must
 * stay inside, because the OAuth redirect has to land back on this WebView to
 * complete.
 */
public class MainActivity extends Activity {

    private static final String SITE = "nmaxdash.gelodesu2.workers.dev";
    private static final String START = "https://" + SITE + "/";
    private static final int REQ_LOCATION = 1;

    private WebView web;
    private final Bridge bridge = new Bridge();

    /** The page reports which pane it is showing so the system back gesture
        can return to the dash instead of walking WebView history. Swiping in
        from the left edge is the back gesture on a gesture-nav phone, which is
        exactly the swipe a rider makes to get out of the logs. */
    public static class Bridge {
        private volatile int page = 0;
        @JavascriptInterface public void setPage(int p) { page = p; }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Draw behind the cutout rather than letting the system letterbox the
        // dash away from a curved edge.
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // A WebView reports display-mode: browser, so the page cannot tell it
        // apart from a tab and would reserve room for a status bar that
        // immersive mode has already hidden. Say so explicitly instead.
        s.setUserAgentString(s.getUserAgentString() + " NMAXDashShell/1.0");
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);

        web.setBackgroundColor(0xFF040507);
        web.addJavascriptInterface(bridge, "NMAXShell");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                                                           GeolocationPermissions.Callback cb) {
                // The only page loaded here is the dash, and Android has
                // already gated this behind the runtime permission below.
                cb.invoke(origin, true, false);
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return route(url);
            }
        });

        setContentView(web);
        immersive();
        askForLocation();
        web.loadUrl(START);
    }

    /** True when the link has been handed to another app. */
    private boolean route(String url) {
        if (url == null) return false;
        boolean http = url.startsWith("http://") || url.startsWith("https://");
        if (http && (url.contains(SITE) || url.contains("accounts.spotify.com"))) {
            return false;                       // the dash, or a login on its way back
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (Exception e) {
            return false;                       // nothing installed to take it
        }
    }

    private void askForLocation() {
        if (Build.VERSION.SDK_INT < 23) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQ_LOCATION);
        }
    }

    /** Hides the status and navigation bars, and puts them back if a swipe
        brings them up. */
    private void immersive() {
        web.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
          | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
          | View.SYSTEM_UI_FLAG_FULLSCREEN
          | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) immersive();
    }

    @Override
    public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        if (bridge.page != 0) {
            web.evaluateJavascript("window.__nmaxGoto && window.__nmaxGoto(0)", null);
            return;                         // consumed: back means "leave the logs"
        }
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); if (web != null) { web.onResume(); immersive(); } }
}
