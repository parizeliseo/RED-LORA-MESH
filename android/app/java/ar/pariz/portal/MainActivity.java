package ar.pariz.portal;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Pantalla principal: muestra el portal y le da Bluetooth, USB, archivos, impresión y el puente MQTT. */
public class MainActivity extends Activity {
    static final String TAG = "PARIZ";
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST + "/";
    static final int REQ_FILE = 10, REQ_PERM = 11, REQ_BT_ON = 12;

    WebView web;
    Handler ui;
    BleManager ble;
    UsbSerial usb;
    NetBridge net;
    ValueCallback<Uri[]> fileCb;
    PermCallback pendingPerm;
    Runnable pendingBtOn;
    final List<WebView> printViews = new ArrayList<WebView>();
    volatile boolean visible = true;
    volatile String pendingConv;
    LocationManager lm;
    LocationListener gpsL;

    interface PermCallback { void done(boolean ok); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        ui = new Handler(Looper.getMainLooper());
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0b1220"));
        w.setNavigationBarColor(Color.parseColor("#0b1220"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b1220"));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); /* el nodo por WiFi y el puente MQTT local usan http/ws */
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportMultipleWindows(false);

        ble = new BleManager(this);
        usb = new UsbSerial(this);
        net = new NetBridge(this);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
                try {
                    InputStream in = getAssets().open("www" + path);
                    return new WebResourceResponse(mime(path), "utf-8", in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openUrl(u.toString());
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                String[] acc = p.getAcceptTypes();
                List<String> mimes = new ArrayList<String>();
                if (acc != null) for (String a : acc) for (String x : a.split(",")) { x = x.trim(); if (x.contains("/")) mimes.add(x); }
                if (!mimes.isEmpty() && acc != null && mimes.size() == countParts(acc)) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(Intent.createChooser(i, "Elegir archivo"), REQ_FILE); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest r) { /* cámara para leer códigos QR de canales */
                ui.post(new Runnable() { public void run() {
                    boolean cam = false;
                    for (String x : r.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(x)) cam = true;
                    if (!cam || r.getOrigin() == null || !HOST.equals(r.getOrigin().getHost())) { r.deny(); return; }
                    withPerms(new String[]{Manifest.permission.CAMERA}, new PermCallback() { public void done(boolean ok) {
                        if (ok) r.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE}); else { r.deny(); toastJs("Sin permiso de cámara", "err"); }
                    } });
                } });
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "js: " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.loadUrl(ORIGIN + "index.html");

        WsBridge.startOnce(); /* puente MQTT integrado en ws://127.0.0.1:9001 */
        askNotifications();
        KeepAliveService.update(this, "Abierto · sin nodo conectado");
        handleUsbIntent(getIntent());
        takeConvIntent(getIntent());
    }

    static int countParts(String[] acc) { int n = 0; for (String a : acc) for (String x : a.split(",")) if (!x.trim().isEmpty()) n++; return n; }

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    @Override
    protected void onNewIntent(Intent i) { super.onNewIntent(i); handleUsbIntent(i); if (takeConvIntent(i)) ev("open-conv", pendingConv); }

    /* aviso tocado: se abre la conversación correspondiente */
    boolean takeConvIntent(Intent i) {
        String c = i == null ? null : i.getStringExtra("conv");
        if (c == null) return false;
        pendingConv = c; Notifier.clear(this, c);
        return true;
    }

    @Override protected void onStart() { super.onStart(); visible = true; ev("app-visible", "1"); }
    @Override protected void onStop() { visible = false; ev("app-visible", "0"); super.onStop(); }

    /* ── GPS del celular: la posición se manda al nodo desde el portal ── */
    void gpsStart(final long minMs, final float minM) {
        withPerms(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, new PermCallback() { public void done(boolean ok) {
            if (!ok) { ev("gps-err", "Sin permiso de ubicación"); return; }
            gpsStop();
            lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            gpsL = new LocationListener() {
                public void onLocationChanged(Location l) { sendFix(l); }
                public void onStatusChanged(String p, int s, Bundle e) {}
                public void onProviderEnabled(String p) {}
                public void onProviderDisabled(String p) { if (LocationManager.GPS_PROVIDER.equals(p)) ev("gps-err", "El GPS del celular está apagado"); }
            };
            boolean any = false;
            try {
                for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                    if (!lm.getAllProviders().contains(p)) continue;
                    lm.requestLocationUpdates(p, minMs, minM, gpsL, Looper.getMainLooper()); any = true;
                    Location last = lm.getLastKnownLocation(p);
                    if (last != null && System.currentTimeMillis() - last.getTime() < 120000) sendFix(last);
                }
            } catch (SecurityException e) { ev("gps-err", "Sin permiso de ubicación"); return; }
            if (!any) { ev("gps-err", "El celular no tiene GPS"); return; }
            if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) ev("gps-err", "El GPS del celular está apagado: activá Ubicación");
            ev("gps-on", "1");
            KeepAliveService.location = true; KeepAliveService.update(MainActivity.this, KeepAliveService.text);
        } });
    }
    void gpsStop() {
        if (lm != null && gpsL != null) try { lm.removeUpdates(gpsL); } catch (Exception e) {}
        gpsL = null;
        if (KeepAliveService.location) { KeepAliveService.location = false; KeepAliveService.update(this, KeepAliveService.text); }
    }
    void sendFix(Location l) {
        try {
            JSONObject o = new JSONObject();
            o.put("lat", l.getLatitude()); o.put("lon", l.getLongitude());
            if (l.hasAltitude()) o.put("alt", l.getAltitude());
            if (l.hasAccuracy()) o.put("acc", l.getAccuracy());
            if (l.hasSpeed()) o.put("spd", l.getSpeed());
            if (l.hasBearing()) o.put("brg", l.getBearing());
            o.put("t", l.getTime()); o.put("src", l.getProvider());
            ev("gps", o.toString());
        } catch (Exception e) {}
    }

    void handleUsbIntent(Intent i) {
        if (i != null && "android.hardware.usb.action.USB_DEVICE_ATTACHED".equals(i.getAction()))
            toastJs("Se conectó un equipo por USB. Tocá “USB (cable)” para usarlo.", "ok");
    }

    void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 99);
    }

    /* ── permisos ── */
    void withPerms(String[] perms, PermCallback cb) {
        List<String> miss = new ArrayList<String>();
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) miss.add(p);
        if (miss.isEmpty()) { cb.done(true); return; }
        pendingPerm = cb;
        requestPermissions(miss.toArray(new String[0]), REQ_PERM);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code != REQ_PERM) return;
        boolean ok = res.length > 0;
        for (int r : res) if (r != PackageManager.PERMISSION_GRANTED) ok = false;
        PermCallback cb = pendingPerm; pendingPerm = null;
        if (cb != null) cb.done(ok);
    }

    String[] blePerms() {
        if (Build.VERSION.SDK_INT >= 31) return new String[]{"android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"};
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    void askBtOn(Runnable after) {
        pendingBtOn = after;
        try { startActivityForResult(new Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_BT_ON); }
        catch (Exception e) { pendingBtOn = null; after.run(); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCb; fileCb = null;
            if (cb == null) return;
            Uri[] out = null;
            if (res == RESULT_OK && data != null) {
                ClipData cd = data.getClipData();
                if (cd != null) { out = new Uri[cd.getItemCount()]; for (int i = 0; i < out.length; i++) out[i] = cd.getItemAt(i).getUri(); }
                else if (data.getData() != null) out = new Uri[]{data.getData()};
            }
            cb.onReceiveValue(out);
        } else if (req == REQ_BT_ON) {
            Runnable r = pendingBtOn; pendingBtOn = null;
            if (r != null) r.run();
        }
    }

    /* ── comunicación con el portal ── */
    void cb(int id, boolean ok, String data) {
        final String js = "window.__AB&&__AB.cb(" + id + "," + ok + "," + JSONObject.quote(data == null ? "" : data) + ")";
        ui.post(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(js, null); } });
    }

    void ev(String type, String... args) {
        StringBuilder sb = new StringBuilder("window.__AB&&__AB.ev(").append(JSONObject.quote(type));
        for (String a : args) sb.append(',').append(JSONObject.quote(a == null ? "" : a));
        final String js = sb.append(')').toString();
        ui.post(new Runnable() { public void run() { if (web != null) web.evaluateJavascript(js, null); } });
    }

    void toastJs(String msg, String kind) { ev("toast", msg, kind); }

    void openUrl(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
        catch (Exception e) { Toast.makeText(this, "No hay una app para abrir el enlace", Toast.LENGTH_LONG).show(); }
    }

    /* Guarda un archivo exportado en Descargas/OPEN SOURCE PARIZ y ofrece abrirlo o compartirlo. */
    void saveFile(final String name, final String mime, final byte[] data) {
        try {
            Uri uri;
            String where;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/OPEN SOURCE PARIZ");
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("no se pudo crear el archivo");
                OutputStream os = cr.openOutputStream(uri);
                os.write(data); os.close();
                where = "Descargas/OPEN SOURCE PARIZ/" + name;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "OPEN SOURCE PARIZ");
                dir.mkdirs();
                File f = new File(dir, name);
                FileOutputStream fo = new FileOutputStream(f); fo.write(data); fo.close();
                uri = null;
                where = f.getAbsolutePath();
            }
            final Uri fu = uri;
            final String msg = where;
            ui.post(new Runnable() { public void run() { savedDialog(name, mime, fu, msg); } });
        } catch (Exception e) {
            toastJs("No se pudo guardar el archivo: " + e.getMessage(), "err");
        }
    }

    void savedDialog(String name, final String mime, final Uri uri, String where) {
        AlertDialog.Builder b = new AlertDialog.Builder(this).setTitle("Archivo guardado").setMessage(where).setNegativeButton("Cerrar", null);
        if (uri != null) {
            b.setPositiveButton("Abrir", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivity(i); } catch (Exception e) { Toast.makeText(MainActivity.this, "No hay una app para abrir este tipo de archivo", Toast.LENGTH_LONG).show(); }
            } });
            b.setNeutralButton("Compartir", new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int w) {
                Intent i = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivity(Intent.createChooser(i, "Compartir")); } catch (Exception e) {}
            } });
        }
        b.show();
    }

    /* Imprime (o guarda como PDF) un documento HTML usando el servicio de impresión de Android. */
    void printHtml(final String html, final String job) {
        ui.post(new Runnable() { public void run() {
            final WebView pw = new WebView(MainActivity.this);
            pw.getSettings().setJavaScriptEnabled(false);
            printViews.add(pw);
            pw.setWebViewClient(new WebViewClient() {
                boolean done = false;
                @Override
                public void onPageFinished(WebView v, String url) {
                    if (done) return; done = true;
                    PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    String name = job.replaceAll("[^\\p{L}\\p{N} ._-]", "_");
                    PrintDocumentAdapter ad = v.createPrintDocumentAdapter(name);
                    pm.print(name, ad, new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    ui.postDelayed(new Runnable() { public void run() { printViews.remove(pw); } }, 600000);
                }
            });
            pw.loadDataWithBaseURL(ORIGIN, html, "text/html", "utf-8", null);
        } });
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        moveTaskToBack(true); /* no se cierra: sigue conectado al nodo en segundo plano */
    }

    @Override
    protected void onDestroy() {
        try { ble.closeAll(); } catch (Exception e) {}
        try { usb.closeAll(); } catch (Exception e) {}
        gpsStop();
        if (web != null) { web.destroy(); web = null; }
        KeepAliveService.stop(this);
        super.onDestroy();
    }

    /** Lo que el portal puede pedirle al teléfono (window.AndroidBridge). */
    class Bridge {
        @JavascriptInterface public String version() { return "1.3"; }
        @JavascriptInterface public void log(String m) { Log.i(TAG, m); }

        /* Bluetooth */
        @JavascriptInterface public void bleRequest(final int id, final String opts) { ui.post(new Runnable() { public void run() { ble.request(id); } }); }
        @JavascriptInterface public void bleKnown(int id) { cb(id, true, ble.known()); }
        @JavascriptInterface public void bleConnect(final int id, final String addr) { ui.post(new Runnable() { public void run() { ble.connect(id, addr); } }); }
        @JavascriptInterface public void bleDisconnect(String addr) { ble.disconnect(addr); }
        @JavascriptInterface public void bleForget(String addr) { ble.forget(addr); }
        @JavascriptInterface public void bleRead(int id, String addr, String svc, String chr) { ble.read(id, addr, svc, chr); }
        @JavascriptInterface public void bleWrite(int id, String addr, String svc, String chr, String b64) { ble.write(id, addr, svc, chr, Base64.decode(b64, Base64.NO_WRAP)); }
        @JavascriptInterface public void bleNotify(int id, String addr, String svc, String chr, boolean on) { ble.notify(id, addr, svc, chr, on); }

        /* USB */
        @JavascriptInterface public String usbList() { return usb.list(); }
        @JavascriptInterface public void usbRequest(final int id, String opts) { ui.post(new Runnable() { public void run() { usb.request(id); } }); }
        @JavascriptInterface public void usbOpen(int id, String dev, int baud) { usb.open(id, dev, baud); }
        @JavascriptInterface public void usbWrite(int id, String dev, String b64) { usb.write(id, dev, Base64.decode(b64, Base64.NO_WRAP)); }
        @JavascriptInterface public void usbClose(int id, String dev) { usb.close(dev); cb(id, true, ""); }

        /* red: el teléfono habla con el nodo, sin las trabas del visor web */
        @JavascriptInterface public void netProbe(int id, String host, int port, int ms) { net.probe(id, host, port, ms); }
        @JavascriptInterface public void netHttp(int id, String url, String method, String bodyB64, int ms) { net.http(id, url, method, bodyB64, ms); }

        /* archivos, impresión y otros */
        @JavascriptInterface public void saveFile(String name, String mime, String b64) { saveFile2(name, mime, b64); }
        @JavascriptInterface public void printHtml(String html, String job) { MainActivity.this.printHtml(html, job); }
        @JavascriptInterface public void openUrl(final String url) { ui.post(new Runnable() { public void run() { MainActivity.this.openUrl(url); } }); }
        @JavascriptInterface public void copyText(final String t) {
            ui.post(new Runnable() { public void run() {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("OPEN SOURCE PARIZ", t));
            } });
        }
        @JavascriptInterface public void setStatus(String t) { KeepAliveService.update(MainActivity.this, t); }

        /* avisos del celular y visibilidad */
        @JavascriptInterface public boolean isVisible() { return visible; }
        @JavascriptInterface public void notify(String kind, String conv, String title, String text) { Notifier.show(MainActivity.this, kind, conv, title, text); }
        @JavascriptInterface public void clearNotif(String conv) { Notifier.clear(MainActivity.this, conv); }
        @JavascriptInterface public String takeConv() { String c = pendingConv; pendingConv = null; return c == null ? "" : c; }

        /* GPS del celular */
        @JavascriptInterface public void gpsStart(final int minSec, final int minM) { ui.post(new Runnable() { public void run() { MainActivity.this.gpsStart(Math.max(1, minSec) * 1000L, Math.max(0, minM)); } }); }
        @JavascriptInterface public void gpsStop() { ui.post(new Runnable() { public void run() { MainActivity.this.gpsStop(); } }); }
    }

    void saveFile2(String name, String mime, String b64) {
        final byte[] data = Base64.decode(b64, Base64.NO_WRAP);
        final String n = name.replaceAll("[\\\\/:*?\"<>|]", "_"), m = mime;
        if (Build.VERSION.SDK_INT < 29) {
            ui.post(new Runnable() { public void run() {
                withPerms(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, new PermCallback() { public void done(boolean ok) {
                    if (ok) saveFile(n, m, data); else toastJs("Sin permiso para guardar en Descargas", "err");
                } });
            } });
        } else saveFile(n, m, data);
    }
}
