package ar.pariz.portal;

import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Puerto serie por USB (cable OTG) sin librerías externas.
 * Chips: Silicon Labs CP210x (Heltec, T-Beam), WCH CH340/CH341, y USB-CDC estándar
 * (ESP32-S3 nativo, RAK4631/nRF52, CH9102). Se abre a 8N1 con DTR y RTS activos, igual que la app oficial.
 */
class UsbSerial {
    static final String ACTION_PERM = "ar.pariz.portal.USB_PERMISSION";
    final MainActivity act;
    final UsbManager um;
    final Map<String, Port> open = new HashMap<String, Port>();
    PendingReq pending;

    static class PendingReq { int id; UsbDevice dev; }

    UsbSerial(MainActivity a) {
        act = a;
        um = (UsbManager) a.getSystemService(Context.USB_SERVICE);
        IntentFilter fp = new IntentFilter(ACTION_PERM);
        IntentFilter fs = new IntentFilter();
        fs.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        fs.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        if (Build.VERSION.SDK_INT >= 33) {
            a.registerReceiver(permRx, fp, 4 /* RECEIVER_NOT_EXPORTED */);
            a.registerReceiver(sysRx, fs, 2 /* RECEIVER_EXPORTED */);
        } else {
            a.registerReceiver(permRx, fp);
            a.registerReceiver(sysRx, fs);
        }
    }

    static String kind(UsbDevice d) {
        int v = d.getVendorId(), p = d.getProductId();
        if (v == 0x10C4) return "cp210x";
        if (v == 0x1A86 && (p == 0x7523 || p == 0x5523 || p == 0x7522)) return "ch34x";
        if (v == 0x0403) return "ftdi";
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            int c = d.getInterface(i).getInterfaceClass();
            if (c == UsbConstants.USB_CLASS_COMM || c == UsbConstants.USB_CLASS_CDC_DATA) return "cdc";
        }
        return "otro";
    }

    JSONObject info(UsbDevice d) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", d.getDeviceName()); o.put("vid", d.getVendorId()); o.put("pid", d.getProductId());
            String n = null; try { n = d.getProductName(); } catch (Exception e) {}
            o.put("name", n == null ? "" : n); o.put("kind", kind(d)); o.put("permitted", um.hasPermission(d));
        } catch (Exception e) {}
        return o;
    }

    String list() {
        JSONArray a = new JSONArray();
        for (UsbDevice d : um.getDeviceList().values()) a.put(info(d));
        return a.toString();
    }

    UsbDevice find(String id) {
        for (UsbDevice d : um.getDeviceList().values()) if (d.getDeviceName().equals(id)) return d;
        return null;
    }

    /* El portal pide elegir un equipo: si hay uno solo se usa ese; si hay varios se pregunta. */
    void request(final int id) {
        final List<UsbDevice> devs = new ArrayList<UsbDevice>(um.getDeviceList().values());
        if (devs.isEmpty()) { act.cb(id, false, "NotFoundError|No hay ningún equipo conectado por USB. Conectá el nodo con un cable de datos y un adaptador OTG."); return; }
        if (devs.size() == 1) { askPerm(id, devs.get(0)); return; }
        String[] names = new String[devs.size()];
        for (int i = 0; i < names.length; i++) {
            UsbDevice d = devs.get(i); String n = null; try { n = d.getProductName(); } catch (Exception e) {}
            names[i] = (n != null ? n : "Equipo USB") + String.format("  (%04X:%04X · %s)", d.getVendorId(), d.getProductId(), kind(d));
        }
        final boolean[] chosen = {false};
        new AlertDialog.Builder(act).setTitle("Elegí el equipo USB")
            .setItems(names, new DialogInterface.OnClickListener() { public void onClick(DialogInterface dd, int w) { chosen[0] = true; askPerm(id, devs.get(w)); } })
            .setOnDismissListener(new DialogInterface.OnDismissListener() { public void onDismiss(DialogInterface dd) { if (!chosen[0]) act.cb(id, false, "NotFoundError|Cancelado"); } })
            .show();
    }

    void askPerm(int id, UsbDevice d) {
        if (um.hasPermission(d)) { act.cb(id, true, info(d).toString()); return; }
        pending = new PendingReq(); pending.id = id; pending.dev = d;
        Intent i = new Intent(ACTION_PERM).setPackage(act.getPackageName());
        int fl = Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0;
        um.requestPermission(d, PendingIntent.getBroadcast(act, 0, i, fl));
    }

    final BroadcastReceiver permRx = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            PendingReq p = pending; pending = null;
            if (p == null) return;
            boolean ok = i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) || um.hasPermission(p.dev);
            if (ok) act.cb(p.id, true, info(p.dev).toString());
            else act.cb(p.id, false, "NotFoundError|No se dio permiso para usar el equipo USB");
        }
    };

    final BroadcastReceiver sysRx = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (d == null) return;
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(i.getAction())) {
                close(d.getDeviceName());
                act.ev("usb-detach", d.getDeviceName());
            } else act.ev("usb-attach", info(d).toString());
        }
    };

    /* ── un puerto abierto ── */
    class Port {
        final String id; final UsbDevice dev; final String kind;
        UsbDeviceConnection conn; UsbInterface ctl, data; UsbEndpoint in, out;
        volatile boolean running;
        Thread reader;

        Port(UsbDevice d) { dev = d; id = d.getDeviceName(); kind = kind(d); }

        void openPort(int baud) throws Exception {
            conn = um.openDevice(dev);
            if (conn == null) throw new Exception("No se pudo abrir (¿permiso USB?)");
            if (kind.equals("cdc")) {
                for (int i = 0; i < dev.getInterfaceCount(); i++) {
                    UsbInterface f = dev.getInterface(i);
                    if (f.getInterfaceClass() == UsbConstants.USB_CLASS_COMM && ctl == null) ctl = f;
                    if (f.getInterfaceClass() == UsbConstants.USB_CLASS_CDC_DATA && data == null) data = f;
                }
                if (data == null) data = dev.getInterface(dev.getInterfaceCount() - 1);
                if (ctl == null) ctl = dev.getInterface(0);
                if (!conn.claimInterface(ctl, true)) throw new Exception("No se pudo tomar la interfaz de control");
                if (data != ctl && !conn.claimInterface(data, true)) throw new Exception("No se pudo tomar la interfaz de datos");
            } else {
                data = dev.getInterface(0); ctl = data;
                if (!conn.claimInterface(data, true)) throw new Exception("No se pudo tomar la interfaz USB");
            }
            for (int i = 0; i < data.getEndpointCount(); i++) {
                UsbEndpoint e = data.getEndpoint(i);
                if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
                if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e; else out = e;
            }
            if (in == null || out == null) throw new Exception("El equipo no tiene canales de datos USB");

            if (kind.equals("cp210x")) cp210x(baud);
            else if (kind.equals("ch34x")) ch34x(baud);
            else if (kind.equals("cdc")) cdc(baud);
            else if (kind.equals("ftdi")) throw new Exception("Los adaptadores FTDI todavía no están soportados en la app");

            running = true;
            reader = new Thread(new Runnable() { public void run() { readLoop(); } }, "usb-read");
            reader.start();
        }

        int ctrl(int type, int req, int val, int idx, byte[] buf) {
            return conn.controlTransfer(type, req, val, idx, buf, buf == null ? 0 : buf.length, 1000);
        }

        void cp210x(int baud) throws Exception {
            int ifc = data.getId();
            if (ctrl(0x41, 0x00, 0x0001, ifc, null) < 0) throw new Exception("CP210x: no responde");   /* IFC_ENABLE */
            ctrl(0x41, 0x07, 0x0303, ifc, null);                                                      /* DTR y RTS activos */
            byte[] b = {(byte) baud, (byte) (baud >> 8), (byte) (baud >> 16), (byte) (baud >> 24)};
            ctrl(0x41, 0x1E, 0, ifc, b);                                                              /* velocidad */
            ctrl(0x41, 0x03, 0x0800, ifc, null);                                                      /* 8 bits, sin paridad, 1 stop */
        }

        void ch34x(int baud) {
            ctrl(0xC0, 0x5F, 0, 0, new byte[2]);
            ctrl(0x40, 0xA1, 0, 0, null);
            chBaud(baud);
            ctrl(0xC0, 0x95, 0x2518, 0, new byte[2]);
            ctrl(0x40, 0x9A, 0x2518, 0x00C3, null);   /* RX, TX y 8 bits */
            ctrl(0xC0, 0x95, 0x0706, 0, new byte[2]);
            ctrl(0x40, 0xA1, 0x501F, 0xD90A, null);
            chBaud(baud);
            ctrl(0x40, 0xA4, (~0x60) & 0xFFFF, 0, null); /* DTR y RTS activos (lógica inversa) */
        }

        void chBaud(int baud) {
            long factor, divisor;
            if (baud == 921600) { divisor = 7; factor = 0xF300; }
            else {
                factor = 1532620800L / baud; divisor = 3;
                while (factor > 0xFFF0 && divisor > 0) { factor >>= 3; divisor--; }
                factor = 0x10000 - factor;
            }
            divisor |= 0x0080;
            ctrl(0x40, 0x9A, 0x1312, (int) ((factor & 0xFF00) | divisor), null);
            ctrl(0x40, 0x9A, 0x0F2C, (int) (factor & 0xFF), null);
        }

        void cdc(int baud) {
            int ifc = ctl.getId();
            byte[] lc = {(byte) baud, (byte) (baud >> 8), (byte) (baud >> 16), (byte) (baud >> 24), 0, 0, 8};
            ctrl(0x21, 0x20, 0, ifc, lc);         /* SET_LINE_CODING */
            ctrl(0x21, 0x22, 0x0003, ifc, null);  /* SET_CONTROL_LINE_STATE: DTR y RTS */
        }

        void readLoop() {
            byte[] buf = new byte[Math.max(in.getMaxPacketSize(), 64) * 32];
            while (running) {
                int n;
                try { n = conn.bulkTransfer(in, buf, buf.length, 200); } catch (Exception e) { break; }
                if (n > 0) act.ev("usb-data", id, Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
            }
        }

        synchronized void write(byte[] d) throws Exception {
            int off = 0;
            while (off < d.length) {
                int len = Math.min(d.length - off, 16384);
                byte[] chunk = new byte[len];
                System.arraycopy(d, off, chunk, 0, len);
                int n = conn.bulkTransfer(out, chunk, len, 2000);
                if (n < 0) throw new Exception("No se pudo escribir en el USB");
                off += n;
            }
        }

        void closePort() {
            running = false;
            try { if (reader != null) reader.join(500); } catch (Exception e) {}
            try { if (data != null) conn.releaseInterface(data); } catch (Exception e) {}
            try { if (ctl != null && ctl != data) conn.releaseInterface(ctl); } catch (Exception e) {}
            try { if (conn != null) conn.close(); } catch (Exception e) {}
        }
    }

    void open(final int id, final String devId, final int baud) {
        new Thread(new Runnable() { public void run() {
            UsbDevice d = find(devId);
            if (d == null) { act.cb(id, false, "NotFoundError|El equipo USB ya no está conectado"); return; }
            if (!um.hasPermission(d)) { act.cb(id, false, "SecurityError|Falta el permiso USB"); return; }
            close(devId);
            Port p = new Port(d);
            try { p.openPort(baud); }
            catch (Exception e) { p.closePort(); act.cb(id, false, "NetworkError|" + e.getMessage()); return; }
            synchronized (open) { open.put(devId, p); }
            act.cb(id, true, "");
        } }).start();
    }

    void write(int id, String devId, byte[] d) {
        Port p; synchronized (open) { p = open.get(devId); }
        if (p == null) { act.cb(id, false, "NetworkError|El puerto USB no está abierto"); return; }
        try { p.write(d); act.cb(id, true, ""); }
        catch (Exception e) { act.cb(id, false, "NetworkError|" + e.getMessage()); }
    }

    void close(String devId) {
        Port p; synchronized (open) { p = open.remove(devId); }
        if (p != null) p.closePort();
    }

    void closeAll() {
        synchronized (open) { for (Port p : open.values()) p.closePort(); open.clear(); }
        try { act.unregisterReceiver(permRx); } catch (Exception e) {}
        try { act.unregisterReceiver(sysRx); } catch (Exception e) {}
    }
}
