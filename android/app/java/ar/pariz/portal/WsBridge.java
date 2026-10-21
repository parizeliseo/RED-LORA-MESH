package ar.pariz.portal;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Puente MQTT integrado (equivale a puente-mqtt.py de la PC).
 * Escucha solo en el propio teléfono, en ws://127.0.0.1:9001/<servidor>/<puerto>/<tls|tcp>,
 * y pasa los datos, sin tocarlos, a ese servidor MQTT por TCP o TLS. Así el portal llega también
 * a los servidores que no ofrecen WebSocket (por ejemplo el oficial de la red).
 */
public class WsBridge {
    static final int PORT = 9001;
    static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    static final Charset L1 = Charset.forName("ISO-8859-1");
    static volatile boolean started;

    public static synchronized void startOnce() {
        if (started) return;
        started = true;
        Thread t = new Thread(new Runnable() { public void run() { serve(); } }, "ws-bridge");
        t.setDaemon(true);
        t.start();
    }

    static void serve() {
        ServerSocket ss;
        try {
            ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 50);
        } catch (IOException e) { started = false; return; }
        while (true) {
            try {
                final Socket s = ss.accept();
                Thread t = new Thread(new Runnable() { public void run() { handle(s); } }, "ws-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) { /* sigue escuchando */ }
        }
    }

    /* solo puertos MQTT habituales */
    static boolean portOk(int p) { return p == 1883 || p == 8883 || p == 8884 || p == 8886; }

    static void http(OutputStream o, String code, String body) throws IOException {
        byte[] b = body.getBytes("UTF-8");
        o.write(("HTTP/1.1 " + code + "\r\nContent-Type: text/plain; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: " + b.length + "\r\nConnection: close\r\n\r\n").getBytes(L1));
        o.write(b);
        o.flush();
    }

    static void handle(Socket s) {
        Socket up = null;
        try {
            s.setTcpNoDelay(true);
            s.setSoTimeout(15000);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            ByteArrayOutputStream hb = new ByteArrayOutputStream();
            int c, st = 0;
            while ((c = in.read()) >= 0) {
                hb.write(c);
                st = (c == '\r' && (st == 0 || st == 2)) ? st + 1 : (c == '\n' && (st == 1 || st == 3)) ? st + 1 : 0;
                if (st == 4) break;
                if (hb.size() > 8192) { s.close(); return; }
            }
            String[] lines = new String(hb.toByteArray(), L1).split("\r\n");
            String[] first = lines[0].split(" ");
            String path = first.length > 1 ? first[1] : "/";
            Map<String, String> hdr = new HashMap<String, String>();
            for (int i = 1; i < lines.length; i++) { int k = lines[i].indexOf(':'); if (k > 0) hdr.put(lines[i].substring(0, k).trim().toLowerCase(Locale.ROOT), lines[i].substring(k + 1).trim()); }
            String key = hdr.get("sec-websocket-key");
            if (key == null) { http(out, "200 OK", "Puente MQTT integrado funcionando"); s.close(); return; }

            String[] p = path.split("\\?")[0].split("/");
            java.util.List<String> parts = new java.util.ArrayList<String>();
            for (String x : p) if (!x.isEmpty()) parts.add(x);
            String host = parts.size() > 0 ? parts.get(0).toLowerCase(Locale.ROOT) : "mqtt.meshtastic.org";
            int port = 8883;
            try { if (parts.size() > 1) port = Integer.parseInt(parts.get(1)); } catch (NumberFormatException e) { http(out, "400 Bad Request", "Ruta inválida"); s.close(); return; }
            boolean tls = parts.size() > 2 ? parts.get(2).equalsIgnoreCase("tls") : port != 1883;
            if (!portOk(port) || !host.matches("[a-z0-9.-]+")) { http(out, "403 Forbidden", "Destino no permitido"); s.close(); return; }

            /* primero se abre el servidor; si falla, el portal prueba otra vía */
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(host, port), 12000);
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
                ssl.startHandshake();
                HostnameVerifier hv = HttpsURLConnection.getDefaultHostnameVerifier();
                if (!hv.verify(host, ssl.getSession())) { ssl.close(); throw new IOException("certificado inválido para " + host); }
                up = ssl;
            } else up = raw;
            up.setTcpNoDelay(true);

            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            String acc = android.util.Base64.encodeToString(sha.digest((key + GUID).getBytes(L1)), android.util.Base64.NO_WRAP);
            String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n";
            String proto = hdr.get("sec-websocket-protocol");
            if (proto != null && proto.toLowerCase(Locale.ROOT).contains("mqtt")) resp += "Sec-WebSocket-Protocol: mqtt\r\n";
            out.write((resp + "\r\n").getBytes(L1));
            out.flush();
            s.setSoTimeout(0);

            final Socket fs = s, fu = up;
            final OutputStream wsOut = out;
            final InputStream upIn = up.getInputStream();
            Thread down = new Thread(new Runnable() { public void run() {
                byte[] buf = new byte[16384];
                try {
                    int n;
                    while ((n = upIn.read(buf)) > 0) synchronized (wsOut) { frame(wsOut, 2, buf, n); }
                } catch (IOException e) {}
                closeQ(fs); closeQ(fu);
            } }, "ws-down");
            down.setDaemon(true);
            down.start();

            DataInputStream din = new DataInputStream(in);
            OutputStream upOut = up.getOutputStream();
            while (true) {
                int b0 = din.readUnsignedByte(), b1 = din.readUnsignedByte();
                int op = b0 & 0x0F;
                long len = b1 & 0x7F;
                if (len == 126) len = din.readUnsignedShort();
                else if (len == 127) len = din.readLong();
                byte[] mask = null;
                if ((b1 & 0x80) != 0) { mask = new byte[4]; din.readFully(mask); }
                if (len > 4 * 1024 * 1024) break;
                byte[] data = new byte[(int) len];
                din.readFully(data);
                if (mask != null) for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
                if (op == 0 || op == 1 || op == 2) { upOut.write(data); upOut.flush(); }
                else if (op == 9) synchronized (wsOut) { frame(wsOut, 10, data, data.length); }
                else if (op == 8) { synchronized (wsOut) { frame(wsOut, 8, new byte[0], 0); } break; }
            }
        } catch (Exception e) {
            if (up == null) { try { http(s.getOutputStream(), "502 Bad Gateway", "No se pudo llegar al servidor"); } catch (Exception e2) {} }
        }
        closeQ(s); closeQ(up);
    }

    static void frame(OutputStream o, int op, byte[] d, int n) throws IOException {
        if (n < 126) o.write(new byte[]{(byte) (0x80 | op), (byte) n});
        else if (n < 65536) o.write(new byte[]{(byte) (0x80 | op), 126, (byte) (n >> 8), (byte) n});
        else { o.write(new byte[]{(byte) (0x80 | op), 127, 0, 0, 0, 0, (byte) (n >> 24), (byte) (n >> 16), (byte) (n >> 8), (byte) n}); }
        o.write(d, 0, n);
        o.flush();
    }

    static void closeQ(Socket s) { try { if (s != null) s.close(); } catch (Exception e) {} }
}
