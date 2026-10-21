package ar.pariz.portal;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Acceso a la red hecho por Android, no por el visor web.
 *
 * Hace falta porque la página del portal se sirve desde una dirección https interna y, desde ahí,
 * el visor web pone trabas para hablarle a equipos de la red local por http. Pidiéndolo al teléfono
 * esas trabas no existen: además se puede probar un puerto de verdad (conexión TCP), en vez de
 * adivinar con consultas web, así que buscar el nodo en la red es mucho más rápido y seguro.
 */
public class NetBridge {
    final MainActivity act;
    final ExecutorService pool = Executors.newFixedThreadPool(16);

    NetBridge(MainActivity a) { act = a; }

    /** ¿Es una dirección de red privada? Solo ahí se acepta un certificado propio del nodo. */
    static boolean privada(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        if (host.equals("localhost") || host.startsWith("127.")) return true;
        if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
        if (host.startsWith("172.")) {
            try { int b = Integer.parseInt(host.split("\\.")[1]); return b >= 16 && b <= 31; } catch (Exception e) { return false; }
        }
        return host.endsWith(".local");
    }

    /** ¿Hay algo escuchando en ese puerto? Conexión TCP real, con tope de tiempo. */
    public void probe(final int id, final String host, final int port, final int ms) {
        pool.execute(new Runnable() { public void run() {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(host, port), Math.max(200, ms));
                act.cb(id, true, "abierto");
            } catch (java.net.SocketTimeoutException e) {
                act.cb(id, false, "timeout|no respondió a tiempo"); /* filtrado o lento: se reintenta con más paciencia */
            } catch (Exception e) {
                act.cb(id, false, "cerrado|" + e.getClass().getSimpleName());
            } finally { try { s.close(); } catch (Exception e) {} }
        } });
    }

    /** Pedido HTTP completo. Devuelve {"status":200,"body":"<base64>"} o un error. */
    public void http(final int id, final String url, final String method, final String bodyB64, final int ms) {
        pool.execute(new Runnable() { public void run() {
            HttpURLConnection c = null;
            try {
                URL u = new URL(url);
                if (!"http".equals(u.getProtocol()) && !"https".equals(u.getProtocol())) throw new IOException("solo http o https");
                c = (HttpURLConnection) u.openConnection();
                if (c instanceof HttpsURLConnection && privada(u.getHost())) relajarTls((HttpsURLConnection) c);
                c.setConnectTimeout(Math.max(200, ms));
                c.setReadTimeout(Math.max(200, ms));
                c.setRequestMethod(method == null ? "GET" : method);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("Accept", "application/x-protobuf");
                if (bodyB64 != null && bodyB64.length() > 0) {
                    byte[] body = Base64.decode(bodyB64, Base64.NO_WRAP);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(body.length);
                    c.setRequestProperty("Content-Type", "application/x-protobuf");
                    OutputStream os = c.getOutputStream(); os.write(body); os.flush(); os.close();
                }
                int st = c.getResponseCode();
                InputStream in = st >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] buf = new byte[8192]; int n;
                    while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > 4 * 1024 * 1024) break; }
                    in.close();
                }
                JSONObject o = new JSONObject();
                o.put("status", st);
                o.put("body", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                act.cb(id, true, o.toString());
            } catch (java.net.SocketTimeoutException e) {
                act.cb(id, false, "timeout|se agotó el tiempo de espera");
            } catch (Exception e) {
                act.cb(id, false, "red|" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            } finally { if (c != null) try { c.disconnect(); } catch (Exception e) {} }
        } });
    }

    /* El nodo usa un certificado propio (no lo firma nadie). Se acepta solo en direcciones de red
       privada, que son las del propio equipo del usuario; nunca en internet. */
    static void relajarTls(HttpsURLConnection c) {
        try {
            TrustManager[] tm = new TrustManager[]{ new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] x, String a) {}
                public void checkServerTrusted(X509Certificate[] x, String a) {}
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            } };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, tm, new java.security.SecureRandom());
            c.setSSLSocketFactory((SSLSocketFactory) sc.getSocketFactory());
            c.setHostnameVerifier(new HostnameVerifier() { public boolean verify(String h, SSLSession s) { return privada(h); } });
        } catch (Exception e) { /* si falla se usa la verificación normal */ }
    }
}
