package ar.pariz.portal;

import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ParcelUuid;
import android.util.Base64;
import android.widget.ArrayAdapter;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Bluetooth LE para el portal: búsqueda del nodo, conexión GATT y lecturas/escrituras en fila
 * (Android admite una sola operación GATT a la vez).
 */
class BleManager {
    static final UUID MESH_SVC = UUID.fromString("6ba1b218-15a8-461f-9fa8-5dcae273eafd");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    final MainActivity act;
    final Handler h;
    final SharedPreferences prefs;
    final Map<String, Conn> conns = new HashMap<String, Conn>();

    BleManager(MainActivity a) {
        act = a;
        HandlerThread t = new HandlerThread("ble");
        t.start();
        h = new Handler(t.getLooper());
        prefs = a.getSharedPreferences("ble", Context.MODE_PRIVATE);
        IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(bondRx, f, 2 /* RECEIVER_EXPORTED */);
        else a.registerReceiver(bondRx, f);
    }

    BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    /* ── selección del nodo ── */
    void request(final int id) {
        final BluetoothAdapter ad = adapter();
        if (ad == null) { act.cb(id, false, "NotSupportedError|Este teléfono no tiene Bluetooth"); return; }
        act.withPerms(act.blePerms(), new MainActivity.PermCallback() { public void done(boolean ok) {
            if (!ok) { act.cb(id, false, "NotAllowedError|Sin permiso de Bluetooth. Habilitalo en Ajustes → Apps → OPEN SOURCE PARIZ → Permisos."); return; }
            if (!ad.isEnabled()) {
                act.askBtOn(new Runnable() { public void run() {
                    if (!ad.isEnabled()) act.cb(id, false, "NotFoundError|El Bluetooth está apagado");
                    else scanDialog(id, ad);
                } });
                return;
            }
            if (Build.VERSION.SDK_INT < 31 && !locationOn())
                act.toastJs("Activá la Ubicación del teléfono: Android 11 o anterior la exige para buscar equipos Bluetooth.", "err");
            scanDialog(id, ad);
        } });
    }

    boolean locationOn() {
        try {
            LocationManager lm = (LocationManager) act.getSystemService(Context.LOCATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) { return true; }
    }

    static class Found { String addr, name; int rssi; boolean mesh; }

    void scanDialog(final int id, final BluetoothAdapter ad) {
        final LinkedHashMap<String, Found> found = new LinkedHashMap<String, Found>();
        final List<String> labels = new ArrayList<String>();
        final List<String> addrs = new ArrayList<String>();
        final ArrayAdapter<String> list = new ArrayAdapter<String>(act, android.R.layout.simple_list_item_1, labels);
        final boolean[] all = {false}, finished = {false};
        final BluetoothLeScanner sc = ad.getBluetoothLeScanner();

        /* los nodos ya emparejados aparecen enseguida, aunque no estén anunciándose */
        try {
            for (BluetoothDevice d : ad.getBondedDevices()) {
                if (d.getType() == BluetoothDevice.DEVICE_TYPE_CLASSIC) continue;
                Found f = new Found(); f.addr = d.getAddress(); f.name = d.getName(); f.rssi = 0; f.mesh = looksMesh(f.name);
                if (f.mesh) found.put(f.addr, f);
            }
        } catch (SecurityException e) {}

        final Runnable refresh = new Runnable() { public void run() {
            labels.clear(); addrs.clear();
            for (Found f : found.values()) {
                if (!all[0] && !f.mesh) continue;
                labels.add((f.name != null && !f.name.isEmpty() ? disp(f.name) : "(sin nombre)") + "\n" + f.addr + (f.rssi != 0 ? "   ·   " + f.rssi + " dBm" : "   ·   emparejado"));
                addrs.add(f.addr);
            }
            list.notifyDataSetChanged();
        } };
        refresh.run();

        final ScanCallback scb = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult r) { add(r); }
            @Override public void onBatchScanResults(List<ScanResult> rs) { for (ScanResult r : rs) add(r); }
            void add(ScanResult r) {
                BluetoothDevice d = r.getDevice();
                Found f = found.get(d.getAddress());
                if (f == null) { f = new Found(); f.addr = d.getAddress(); found.put(f.addr, f); }
                ScanRecord rec = r.getScanRecord();
                String nm = rec != null ? rec.getDeviceName() : null;
                try { if (nm == null) nm = d.getName(); } catch (SecurityException e) {}
                if (nm != null) f.name = nm;
                f.rssi = r.getRssi();
                boolean svc = false;
                if (rec != null && rec.getServiceUuids() != null) for (ParcelUuid u : rec.getServiceUuids()) if (MESH_SVC.equals(u.getUuid())) svc = true;
                f.mesh = f.mesh || svc || looksMesh(f.name);
                act.ui.post(refresh);
            }
        };

        final AlertDialog dlg = new AlertDialog.Builder(act)
            .setTitle("Elegí el nodo (buscando…)")
            .setAdapter(list, new DialogInterface.OnClickListener() { public void onClick(DialogInterface d, int which) {
                if (which < 0 || which >= addrs.size()) return;
                finished[0] = true;
                String a = addrs.get(which);
                Found f = found.get(a);
                remember(a, f != null ? f.name : null);
                stopScan(sc, scb);
                JSONObject o = new JSONObject();
                try { o.put("id", a); o.put("name", f != null && f.name != null ? disp(f.name) : ""); } catch (Exception e) {}
                act.cb(id, true, o.toString());
            } })
            .setNegativeButton("Cancelar", null)
            .setNeutralButton("Mostrar todos", null)
            .create();
        dlg.setOnShowListener(new DialogInterface.OnShowListener() { public void onShow(DialogInterface d) {
            dlg.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(new android.view.View.OnClickListener() { public void onClick(android.view.View v) {
                all[0] = !all[0];
                ((android.widget.Button) v).setText(all[0] ? "Solo nodos" : "Mostrar todos");
                refresh.run();
            } });
        } });
        dlg.setOnDismissListener(new DialogInterface.OnDismissListener() { public void onDismiss(DialogInterface d) {
            stopScan(sc, scb);
            if (!finished[0]) act.cb(id, false, "NotFoundError|Cancelado");
        } });
        dlg.show();
        try {
            ScanSettings st = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            if (sc != null) sc.startScan(null, st, scb);
        } catch (SecurityException e) {
            act.toastJs("Falta el permiso para buscar equipos Bluetooth", "err");
        }
        act.ui.postDelayed(new Runnable() { public void run() {
            stopScan(sc, scb);
            if (dlg.isShowing()) dlg.setTitle(addrs.isEmpty() ? "No se encontraron nodos" : "Elegí el nodo");
        } }, 25000);
    }

    static String disp(String n) { return n == null ? null : n.replaceAll("(?i)meshtastic", "LoRa Mesh"); }

    static boolean looksMesh(String n) {
        if (n == null) return false;
        String l = n.toLowerCase();
        return l.contains("mesh") || n.matches(".*_[0-9a-fA-F]{4}$");
    }

    void stopScan(BluetoothLeScanner sc, ScanCallback cb) { try { if (sc != null) sc.stopScan(cb); } catch (Exception e) {} }

    void remember(String addr, String name) {
        try {
            JSONObject o = new JSONObject(prefs.getString("known", "{}"));
            o.put(addr, name == null ? "" : name);
            prefs.edit().putString("known", o.toString()).apply();
        } catch (Exception e) {}
    }

    void forget(String addr) {
        try {
            JSONObject o = new JSONObject(prefs.getString("known", "{}"));
            o.remove(addr);
            prefs.edit().putString("known", o.toString()).apply();
        } catch (Exception e) {}
    }

    String known() {
        JSONArray a = new JSONArray();
        try {
            JSONObject o = new JSONObject(prefs.getString("known", "{}"));
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) { String k = it.next(); JSONObject d = new JSONObject(); d.put("id", k); d.put("name", disp(o.optString(k))); a.put(d); }
        } catch (Exception e) {}
        return a.toString();
    }

    /* ── conexión y operaciones ── */
    static class Op {
        int id; int kind; UUID svc, chr; byte[] data; boolean on; int tries;
        static final int READ = 1, WRITE = 2, NOTIFY = 3;
    }

    class Conn extends BluetoothGattCallback {
        final String addr;
        BluetoothGatt gatt;
        int connectId = -1;
        boolean ready, closing, retried;
        final ArrayDeque<Op> q = new ArrayDeque<Op>();
        Op cur;
        Runnable opTimeout, connTimeout;

        Conn(String a) { addr = a; }

        void start(int id) {
            connectId = id;
            BluetoothAdapter ad = adapter();
            if (ad == null) { fail("NotSupportedError|Sin Bluetooth"); return; }
            final BluetoothDevice d = ad.getRemoteDevice(addr);
            try { gatt = d.connectGatt(act, false, this, BluetoothDevice.TRANSPORT_LE); }
            catch (SecurityException e) { fail("NotAllowedError|Sin permiso de Bluetooth"); return; }
            connTimeout = new Runnable() { public void run() { if (connectId >= 0) { fail("NetworkError|El nodo no respondió. Acercate, revisá que tenga el Bluetooth activado y que no esté conectado a otro celular."); closeGatt(); } } };
            h.postDelayed(connTimeout, 25000);
        }

        void fail(String msg) { if (connectId >= 0) { act.cb(connectId, false, msg); connectId = -1; } }

        @Override
        public void onConnectionStateChange(final BluetoothGatt g, final int status, final int st) {
            h.post(new Runnable() { public void run() {
                if (st == BluetoothProfile.STATE_CONNECTED) {
                    h.postDelayed(new Runnable() { public void run() { try { g.discoverServices(); } catch (SecurityException e) {} } }, 400);
                } else if (st == BluetoothProfile.STATE_DISCONNECTED) {
                    boolean wasReady = ready;
                    ready = false;
                    failAll("NetworkError|Se cortó la conexión Bluetooth");
                    if (connectId >= 0 && status == 133 && !retried) { /* error genérico de Android: se reintenta una vez */
                        retried = true; closeGatt();
                        final int id = connectId;
                        h.postDelayed(new Runnable() { public void run() { start(id); } }, 700);
                        return;
                    }
                    fail("NetworkError|No se pudo conectar (código " + status + "). Probá de nuevo; si el nodo pide PIN, es el que muestra su pantalla.");
                    closeGatt();
                    synchronized (conns) { if (conns.get(addr) == Conn.this) conns.remove(addr); }
                    if (wasReady && !closing) act.ev("ble-disc", addr);
                }
            } });
        }

        @Override
        public void onServicesDiscovered(final BluetoothGatt g, int status) {
            h.post(new Runnable() { public void run() {
                boolean asked = false;
                try { asked = g.requestMtu(512); } catch (SecurityException e) {}
                if (!asked) finishConnect(g);
                else h.postDelayed(new Runnable() { public void run() { if (connectId >= 0) finishConnect(g); } }, 3000);
            } });
        }

        @Override
        public void onMtuChanged(final BluetoothGatt g, int mtu, int status) {
            h.post(new Runnable() { public void run() { if (connectId >= 0) finishConnect(g); } });
        }

        void finishConnect(BluetoothGatt g) {
            if (connectId < 0) return;
            h.removeCallbacks(connTimeout);
            try { g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH); } catch (Exception e) {}
            JSONArray svcs = new JSONArray();
            try {
                for (BluetoothGattService s : g.getServices()) {
                    JSONObject so = new JSONObject();
                    so.put("uuid", s.getUuid().toString());
                    JSONArray cs = new JSONArray();
                    for (BluetoothGattCharacteristic c : s.getCharacteristics()) cs.put(c.getUuid().toString());
                    so.put("chars", cs);
                    svcs.put(so);
                }
            } catch (Exception e) {}
            ready = true;
            JSONObject o = new JSONObject();
            try { o.put("services", svcs); } catch (Exception e) {}
            int id = connectId; connectId = -1;
            act.cb(id, true, o.toString());
        }

        void enqueue(Op op) { q.add(op); next(); }

        void next() {
            if (cur != null || q.isEmpty()) return;
            cur = q.poll();
            if (!ready || gatt == null) { done(false, "NetworkError|No hay conexión con el nodo"); return; }
            BluetoothGattService s = gatt.getService(cur.svc);
            BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(cur.chr);
            if (c == null) { done(false, "NotFoundError|Característica inexistente"); return; }
            boolean ok;
            try {
                if (cur.kind == Op.READ) ok = gatt.readCharacteristic(c);
                else if (cur.kind == Op.WRITE) {
                    c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                    c.setValue(cur.data);
                    ok = gatt.writeCharacteristic(c);
                } else {
                    gatt.setCharacteristicNotification(c, cur.on);
                    BluetoothGattDescriptor d = c.getDescriptor(CCCD);
                    if (d == null) { done(true, ""); return; }
                    boolean ind = (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0;
                    d.setValue(cur.on ? (ind ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                    ok = gatt.writeDescriptor(d);
                }
            } catch (SecurityException e) { ok = false; }
            if (!ok) {
                if (cur.tries++ < 3) { final Op again = cur; cur = null; q.addFirst(again); h.postDelayed(new Runnable() { public void run() { next(); } }, 150); return; }
                done(false, "NetworkError|El teléfono rechazó la operación Bluetooth");
                return;
            }
            final Op mine = cur;
            opTimeout = new Runnable() { public void run() { if (cur == mine) done(false, "TimeoutError|El nodo no respondió a tiempo"); } };
            h.postDelayed(opTimeout, 12000);
        }

        void done(boolean ok, String data) {
            Op o = cur; cur = null;
            if (opTimeout != null) h.removeCallbacks(opTimeout);
            if (o != null) act.cb(o.id, ok, data);
            h.post(new Runnable() { public void run() { next(); } });
        }

        /* Si el nodo exige emparejamiento, se empareja y se repite la operación. */
        boolean authProblem(int status) {
            if (status != 5 && status != 15 && status != 137) return false;
            try {
                BluetoothDevice d = gatt.getDevice();
                if (d.getBondState() == BluetoothDevice.BOND_NONE) {
                    act.toastJs("El nodo pide emparejar: ingresá el PIN que muestra su pantalla (si no tiene pantalla suele ser 123456).", "");
                    d.createBond();
                }
            } catch (SecurityException e) {}
            if (cur != null && cur.tries++ < 2) {
                final Op again = cur; cur = null;
                if (opTimeout != null) h.removeCallbacks(opTimeout);
                q.addFirst(again);
                h.postDelayed(new Runnable() { public void run() { next(); } }, 4000);
                return true;
            }
            return false;
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            final byte[] v = c.getValue();
            final int st = status;
            h.post(new Runnable() { public void run() { afterRead(st, v); } });
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            final byte[] v = value;
            final int st = status;
            h.post(new Runnable() { public void run() { afterRead(st, v); } });
        }

        void afterRead(int st, byte[] v) {
            if (st == BluetoothGatt.GATT_SUCCESS) done(true, Base64.encodeToString(v == null ? new byte[0] : v, Base64.NO_WRAP));
            else if (!authProblem(st)) done(false, "NetworkError|Error de lectura (" + st + ")");
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, final int status) {
            h.post(new Runnable() { public void run() {
                if (status == BluetoothGatt.GATT_SUCCESS) done(true, "");
                else if (!authProblem(status)) done(false, "NetworkError|Error de escritura (" + status + ")");
            } });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, final int status) {
            h.post(new Runnable() { public void run() {
                if (status == BluetoothGatt.GATT_SUCCESS) done(true, "");
                else if (!authProblem(status)) done(false, "NetworkError|No se pudieron activar los avisos (" + status + ")");
            } });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            act.ev("ble-notify", addr, c.getUuid().toString(), Base64.encodeToString(c.getValue() == null ? new byte[0] : c.getValue(), Base64.NO_WRAP));
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            act.ev("ble-notify", addr, c.getUuid().toString(), Base64.encodeToString(value == null ? new byte[0] : value, Base64.NO_WRAP));
        }

        void failAll(String msg) {
            if (cur != null) { act.cb(cur.id, false, msg); cur = null; }
            while (!q.isEmpty()) act.cb(q.poll().id, false, msg);
        }

        void closeGatt() {
            try { if (gatt != null) { gatt.disconnect(); gatt.close(); } } catch (Exception e) {}
            gatt = null; ready = false;
        }
    }

    final BroadcastReceiver bondRx = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            int st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);
            if (st == BluetoothDevice.BOND_BONDED) act.toastJs("Nodo emparejado", "ok");
        }
    };

    Conn get(String addr) { synchronized (conns) { return conns.get(addr); } }

    void connect(final int id, final String addr) {
        act.withPerms(act.blePerms(), new MainActivity.PermCallback() { public void done(boolean ok) {
            if (!ok) { act.cb(id, false, "NotAllowedError|Sin permiso de Bluetooth"); return; }
            h.post(new Runnable() { public void run() {
                Conn old;
                synchronized (conns) { old = conns.remove(addr); }
                if (old != null) { old.closing = true; old.closeGatt(); }
                Conn c = new Conn(addr);
                synchronized (conns) { conns.put(addr, c); }
                remember(addr, null);
                c.start(id);
            } });
        } });
    }

    void disconnect(final String addr) {
        h.post(new Runnable() { public void run() {
            Conn c;
            synchronized (conns) { c = conns.remove(addr); }
            if (c != null) { c.closing = true; c.failAll("NetworkError|Desconectado"); c.closeGatt(); }
        } });
    }

    void op(final int id, final String addr, final int kind, final String svc, final String chr, final byte[] data, final boolean on) {
        h.post(new Runnable() { public void run() {
            Conn c = get(addr);
            if (c == null) { act.cb(id, false, "NetworkError|No hay conexión con el nodo"); return; }
            Op o = new Op(); o.id = id; o.kind = kind; o.svc = UUID.fromString(svc); o.chr = UUID.fromString(chr); o.data = data; o.on = on;
            c.enqueue(o);
        } });
    }

    void read(int id, String a, String s, String c) { op(id, a, Op.READ, s, c, null, false); }
    void write(int id, String a, String s, String c, byte[] d) { op(id, a, Op.WRITE, s, c, d, false); }
    void notify(int id, String a, String s, String c, boolean on) { op(id, a, Op.NOTIFY, s, c, null, on); }

    void closeAll() {
        synchronized (conns) { for (Conn c : conns.values()) { c.closing = true; c.closeGatt(); } conns.clear(); }
        try { act.unregisterReceiver(bondRx); } catch (Exception e) {}
    }
}
