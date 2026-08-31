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
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;

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
    private static final int REQ_PERMS = 1;
    /** Set when a scan arrived before the Bluetooth grant existed. */
    private boolean scanAfterGrant = false;

    private WebView web;
    private final Bridge bridge = new Bridge();

    /** The page reports which pane it is showing so the system back gesture
        can return to the dash instead of walking WebView history. Swiping in
        from the left edge is the back gesture on a gesture-nav phone, which is
        exactly the swipe a rider makes to get out of the logs. */
    public class Bridge {
        private volatile int page = 0;
        @JavascriptInterface public void setPage(int p) { page = p; }
        @JavascriptInterface public void btScan() {
            main.post(new Runnable() { public void run() { doScan(); } });
        }
        @JavascriptInterface public void btStopScan() {
            main.post(new Runnable() { public void run() { stopScan(); } });
        }
        @JavascriptInterface public void btConnect(final String addr) {
            main.post(new Runnable() { public void run() { doConnect(addr, "le"); } });
        }
        /* Kept separate from btConnect so an APK and a page of different ages
           still talk: the page feature-tests this before using it. */
        @JavascriptInterface public void btConnect2(final String addr, final String kind) {
            main.post(new Runnable() { public void run() { doConnect(addr, kind); } });
        }
        @JavascriptInterface public void btDisconnect() {
            main.post(new Runnable() { public void run() {
                closeGatt(); closeSpp(false); js("state", "disconnected");
            } });
        }
        @JavascriptInterface public void btWrite(final String s) {
            main.post(new Runnable() { public void run() { doWrite(s); } });
        }
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
                // Only the dash gets the rider's position. Any other origin
                // that finds its way into this WebView is refused.
                boolean ours = origin != null && origin.startsWith("https://" + SITE);
                cb.invoke(origin, ours, false);
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
        askForPermissions();
        web.loadUrl(START);
    }

    /** True when the link has been handed to another app. */
    private boolean route(String url) {
        if (url == null) return false;
        boolean http = url.startsWith("http://") || url.startsWith("https://");
        // Compare the actual host — a substring match would let
        // evil.example/nmaxdash.gelodesu2.workers.dev stay inside the shell.
        String host = "";
        try { host = Uri.parse(url).getHost(); } catch (Exception e) { /* leave empty */ }
        if (host == null) host = "";
        if (http && (host.equals(SITE) || host.equals("accounts.spotify.com"))) {
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

    /** Everything the dash needs from the system on this Android version. */
    private String[] wanted() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT };
        }
        return new String[]{
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION };
    }

    private boolean granted(String perm) {
        return Build.VERSION.SDK_INT < 23
            || checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    /** Asks for whatever is still missing, one permission at a time.
        Testing them as a group is wrong on an upgrade: an install that already
        holds location would never be asked for the Bluetooth pair the dongle
        needs, and the scan would come back empty with nothing on screen to
        say why. */
    private void askForPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        ArrayList<String> missing = new ArrayList<String>();
        for (String p : wanted()) if (!granted(p)) missing.add(p);
        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[missing.size()]), REQ_PERMS);
        }
    }

    private boolean btAllowed() {
        return Build.VERSION.SDK_INT < 31
            || (granted(Manifest.permission.BLUETOOTH_SCAN)
             && granted(Manifest.permission.BLUETOOTH_CONNECT));
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req != REQ_PERMS) return;
        if (scanAfterGrant) {
            scanAfterGrant = false;
            if (btAllowed()) doScan();
            // A second refusal, or a standing "don't ask again", lands here
            // with no dialog shown, so say where the switch lives.
            else js("state", "error:allow Nearby devices in app settings");
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

    /* ------------------------------------------------------------
       Bluetooth LE bridge.

       WebView has no Web Bluetooth, so the page drives the dongle through
       these methods and hears back through window.__nmaxBt(type, data) —
       the same callback the page's other transports use. The ELM327 dialect
       lives entirely in JS; this layer only moves bytes.
       ------------------------------------------------------------ */
    private final Handler main = new Handler(Looper.getMainLooper());
    private BluetoothAdapter btAdapter;
    private ScanCallback scanCb;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic txChar;

    /* Classic Bluetooth serial, for the non-BLE half of the dongle market. */
    private static final UUID SPP =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    /* Written by the reader thread, read by the writer — both off the main
       thread, so neither may cache a stale reference. */
    private volatile BluetoothSocket spp;
    private volatile OutputStream sppOut;
    /* One thread for writes, so commands reach the dongle in the order the
       page sent them. The reader gets its own: it blocks for the whole
       session, and would starve every write if they shared this queue. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private void js(final String type, final String data) {
        main.post(new Runnable() {
            public void run() {
                if (web != null) {
                    web.evaluateJavascript("window.__nmaxBt&&window.__nmaxBt("
                        + JSONObject.quote(type) + "," + JSONObject.quote(data) + ")", null);
                }
            }
        });
    }

    private BluetoothAdapter adapter() {
        if (btAdapter == null) {
            BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
            if (bm != null) btAdapter = bm.getAdapter();
        }
        return btAdapter;
    }

    private void doScan() {
        if (!btAllowed()) {          // resumes in onRequestPermissionsResult
            scanAfterGrant = true;
            askForPermissions();
            return;
        }
        try {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { js("state", "error:bluetooth off"); return; }
            stopScan();
            scanCb = new ScanCallback() {
                @Override public void onScanResult(int cbType, ScanResult r) {
                    BluetoothDevice d = r.getDevice();
                    String name = null;
                    try { name = d.getName(); } catch (SecurityException e) { /* no perm */ }
                    js("scan", (name == null ? "" : name) + "|" + d.getAddress() + "|le");
                }
            };
            listBonded();
            a.getBluetoothLeScanner().startScan(scanCb);
            main.postDelayed(new Runnable() { public void run() { stopScan(); } }, 15000);
        } catch (SecurityException e) {
            js("state", "error:permission");
        }
    }

    /** Paired classic dongles, which a BLE scan will never show. Vgate sells
        the iCar2 in both a BLE and a Bluetooth-serial flavour under nearly the
        same name, so list whichever one is actually in the rider's hand.
        A classic dongle has to be paired in system settings first — that is
        what putting it in this list depends on. */
    private void listBonded() {
        try {
            BluetoothAdapter a = adapter();
            if (a == null) return;
            for (BluetoothDevice d : a.getBondedDevices()) {
                String name = null;
                try { name = d.getName(); } catch (SecurityException e) { /* no perm */ }
                if (name == null) name = "";
                if (!looksLikeDongle(d, name)) continue;
                js("scan", name + "|" + d.getAddress() + "|spp");
            }
        } catch (SecurityException e) { /* the LE path reports the same denial */ }
    }

    private boolean looksLikeDongle(BluetoothDevice d, String name) {
        String n = name.toLowerCase();
        if (n.contains("obd") || n.contains("elm") || n.contains("icar")
         || n.contains("vlink") || n.contains("vgate") || n.contains("viecar")
         || n.contains("konnwei") || n.contains("scan")) return true;
        BluetoothClass c = null;
        try { c = d.getBluetoothClass(); } catch (SecurityException e) { /* no perm */ }
        if (c == null) return false;
        // Headphones, phones, laptops and watches are not dongles. Cheap
        // serial adapters declare no class at all, which is the tell.
        int major = c.getMajorDeviceClass();
        return major == BluetoothClass.Device.Major.MISC
            || major == BluetoothClass.Device.Major.UNCATEGORIZED;
    }

    private void stopScan() {
        try {
            if (scanCb != null && adapter() != null && adapter().getBluetoothLeScanner() != null) {
                adapter().getBluetoothLeScanner().stopScan(scanCb);
            }
        } catch (Exception e) { /* already stopped */ }
        scanCb = null;
    }

    private void doConnect(String addr, String kind) {
        if ("spp".equals(kind)) { doConnectSpp(addr); return; }
        try {
            stopScan();
            closeGatt();
            closeSpp(false);
            BluetoothDevice dev = adapter().getRemoteDevice(addr);
            gatt = dev.connectGatt(this, false, new BluetoothGattCallback() {
                @Override public void onConnectionStateChange(BluetoothGatt g, int st, int newState) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) g.discoverServices();
                    else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        js("state", "disconnected");
                        try { g.close(); } catch (Exception e) { }
                        if (g == gatt) { gatt = null; txChar = null; }
                    }
                }
                @Override public void onServicesDiscovered(BluetoothGatt g, int st) {
                    pickUart(g);
                }
                @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
                    byte[] v = c.getValue();
                    if (v != null) js("rx", new String(v, StandardCharsets.ISO_8859_1));
                }
            }, BluetoothDevice.TRANSPORT_LE);
        } catch (Exception e) {
            js("state", "error:" + e.getMessage());
        }
    }

    /* Every BLE ELM327 clone invents its own UART: FFF0, FFE0, Nordic NUS…
       Rather than a lookup table of clones, take any service offering one
       notifying and one writable characteristic, preferring the well-known
       UUIDs when several qualify. */
    private void pickUart(BluetoothGatt g) {
        BluetoothGattCharacteristic bestN = null, bestW = null;
        boolean bestKnown = false;
        for (BluetoothGattService svc : g.getServices()) {
            String su = svc.getUuid().toString().toLowerCase();
            boolean known = su.startsWith("0000fff0") || su.startsWith("0000ffe0")
                         || su.startsWith("6e400001") || su.startsWith("000018f0");
            BluetoothGattCharacteristic n = null, w = null;
            for (BluetoothGattCharacteristic c : svc.getCharacteristics()) {
                int p = c.getProperties();
                if (n == null && (p & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) n = c;
                if (w == null && (p & (BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) w = c;
            }
            if (n != null && w != null && (bestN == null || (known && !bestKnown))) {
                bestN = n; bestW = w; bestKnown = known;
            }
        }
        if (bestN == null) { js("state", "error:no UART service"); return; }
        txChar = bestW;
        g.setCharacteristicNotification(bestN, true);
        BluetoothGattDescriptor d = bestN.getDescriptor(
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
        if (d != null) {
            d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            g.writeDescriptor(d);
        }
        js("state", "connected");
    }

    /** Bluetooth serial: a socket and a reader thread, feeding the same rx
        events the BLE notifications produce. Everything above this line —
        the ELM327 dialect, the queue, the PID probe — is unchanged by which
        of the two got us the bytes. */
    private void doConnectSpp(final String addr) {
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled()) { js("state", "error:bluetooth off"); return; }
        stopScan();
        closeGatt();
        closeSpp(false);
        final BluetoothDevice dev;
        try {
            dev = adapter().getRemoteDevice(addr);
        } catch (Exception e) { js("state", "error:" + brief(e)); return; }

        new Thread(new Runnable() { public void run() {
            BluetoothSocket s = null;
            try {
                try { adapter().cancelDiscovery(); } catch (Exception e) { /* fine */ }
                s = dev.createRfcommSocketToServiceRecord(SPP);
                s.connect();                       // blocks; hence this thread
            } catch (Exception e) {
                try { if (s != null) s.close(); } catch (Exception e2) { /* gone */ }
                js("state", "error:" + brief(e));
                return;
            }
            spp = s;
            try { sppOut = s.getOutputStream(); } catch (Exception e) { /* read-only? */ }
            js("state", "connected");
            byte[] buf = new byte[256];
            try {
                InputStream in = s.getInputStream();
                int n;
                while ((n = in.read(buf)) > 0) {
                    js("rx", new String(buf, 0, n, StandardCharsets.ISO_8859_1));
                }
            } catch (Exception e) { /* closed here, or the dongle went away */ }
            closeSpp(true);
        }}, "spp-reader").start();
    }

    private void closeSpp(boolean announce) {
        BluetoothSocket s = spp;
        spp = null;
        sppOut = null;
        if (s == null) return;                 // already torn down; stay quiet
        try { s.close(); } catch (Exception e) { /* nothing left to do */ }
        if (announce) js("state", "disconnected");
    }

    private static String brief(Exception e) {
        String m = e.getMessage();
        return m == null || m.length() == 0 ? e.getClass().getSimpleName() : m;
    }

    private void doWrite(String s) {
        if (spp != null) {
            final byte[] b = s.getBytes(StandardCharsets.ISO_8859_1);
            io.execute(new Runnable() { public void run() {
                try { OutputStream o = sppOut; if (o != null) { o.write(b); o.flush(); } }
                catch (Exception e) { /* dropped write surfaces as a JS timeout */ }
            }});
            return;
        }
        try {
            if (gatt == null || txChar == null) return;
            txChar.setValue(s.getBytes(StandardCharsets.ISO_8859_1));
            if ((txChar.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
                txChar.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            }
            gatt.writeCharacteristic(txChar);
        } catch (Exception e) { /* dropped write surfaces as a JS timeout */ }
    }

    private void closeGatt() {
        try { if (gatt != null) gatt.close(); } catch (Exception e) { }
        gatt = null;
        txChar = null;
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
