/* OPEN SOURCE PARIZ · capa de compatibilidad para la app de Android.
   El visor web de Android no trae Bluetooth web ni USB web. Este archivo los reproduce
   (navigator.bluetooth y navigator.serial) usando el puente nativo AndroidBridge, para que
   el portal funcione igual que en Chrome de escritorio. */
(function () {
  "use strict";
  var AB = window.AndroidBridge;
  if (!AB) return;
  window.__isAndroidApp = true;

  var pend = new Map(), seq = 1;
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (res, rej) {
      var id = seq++;
      pend.set(id, { res: res, rej: rej });
      try { AB[fn].apply(AB, [id].concat(args)); } catch (e) { pend.delete(id); rej(e); }
    });
  }
  function b64e(u8) { var s = ""; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function b64d(s) { var b = atob(s || ""), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function toU8(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Uint8Array(buf);
  }
  function mkErr(name, msg) { var e = new Error(msg || name); e.name = name; return e; }
  var norm = function (u) { return String(u).toLowerCase(); };

  /* ── Bluetooth LE ── */
  var bleDevs = new Map();
  function BleChar(dev, svc, uuid) { this._dev = dev; this.service = svc; this.uuid = uuid; this.value = null; this._et = new EventTarget(); }
  BleChar.prototype.addEventListener = function (t, f, o) { this._et.addEventListener(t, f, o); };
  BleChar.prototype.removeEventListener = function (t, f, o) { this._et.removeEventListener(t, f, o); };
  BleChar.prototype.dispatchEvent = function (e) { return this._et.dispatchEvent(e); };
  BleChar.prototype.readValue = function () {
    var self = this;
    return call("bleRead", this._dev.id, this.service.uuid, this.uuid).then(function (b) { var u = b64d(b); self.value = new DataView(u.buffer); return self.value; });
  };
  BleChar.prototype.writeValue = function (buf) { return call("bleWrite", this._dev.id, this.service.uuid, this.uuid, b64e(toU8(buf))).then(function () {}); };
  BleChar.prototype.writeValueWithResponse = BleChar.prototype.writeValue;
  BleChar.prototype.writeValueWithoutResponse = BleChar.prototype.writeValue;
  BleChar.prototype.startNotifications = function () {
    var self = this;
    return call("bleNotify", this._dev.id, this.service.uuid, this.uuid, true).then(function () { self._dev._notif.set(self.uuid, self); return self; });
  };
  BleChar.prototype.stopNotifications = function () {
    var self = this; self._dev._notif.delete(self.uuid);
    return call("bleNotify", this._dev.id, this.service.uuid, this.uuid, false).then(function () { return self; }, function () { return self; });
  };

  function BleService(dev, uuid, chars) { this.device = dev; this.uuid = uuid; this.isPrimary = true; this._chars = chars; this._c = new Map(); }
  BleService.prototype.getCharacteristic = function (u) {
    u = norm(u);
    if (this._chars.indexOf(u) < 0) return Promise.reject(mkErr("NotFoundError", "El nodo no tiene la característica " + u));
    if (!this._c.has(u)) this._c.set(u, new BleChar(this.device, this, u));
    return Promise.resolve(this._c.get(u));
  };

  function BleGatt(dev) { this.device = dev; this.connected = false; this._svcs = []; }
  BleGatt.prototype.connect = function () {
    var self = this;
    return call("bleConnect", this.device.id).then(function (r) {
      var o = JSON.parse(r || "{}"); self._svcs = o.services || []; self.connected = true; return self;
    });
  };
  BleGatt.prototype.disconnect = function () { this.connected = false; try { AB.bleDisconnect(this.device.id); } catch (e) {} };
  BleGatt.prototype.getPrimaryService = function (u) {
    u = norm(u);
    var s = this._svcs.filter(function (x) { return x.uuid === u; })[0];
    if (!s) return Promise.reject(mkErr("NotFoundError", "El equipo no tiene el servicio de la red LoRa Mesh. ¿Es un nodo LoRa Mesh?"));
    return Promise.resolve(new BleService(this.device, u, s.chars));
  };

  function BleDevice(id, name) { this.id = id; this.name = name || ""; this.gatt = new BleGatt(this); this._notif = new Map(); this._et = new EventTarget(); }
  BleDevice.prototype.addEventListener = function (t, f, o) { this._et.addEventListener(t, f, o); };
  BleDevice.prototype.removeEventListener = function (t, f, o) { this._et.removeEventListener(t, f, o); };
  BleDevice.prototype.dispatchEvent = function (e) { return this._et.dispatchEvent(e); };
  BleDevice.prototype.forget = function () { try { AB.bleForget(this.id); } catch (e) {} bleDevs.delete(this.id); return Promise.resolve(); };
  function devFor(id, name) { name = String(name || "").replace(/meshtastic/gi, "LoRa Mesh"); var d = bleDevs.get(id); if (!d) { d = new BleDevice(id, name); bleDevs.set(id, d); } else if (name) d.name = name; return d; }

  var bluetooth = {
    requestDevice: function (opts) {
      return call("bleRequest", JSON.stringify(opts || {})).then(function (r) { var o = JSON.parse(r); return devFor(o.id, o.name); });
    },
    getDevices: function () {
      return call("bleKnown").then(function (r) { return JSON.parse(r || "[]").map(function (o) { return devFor(o.id, o.name); }); });
    },
    getAvailability: function () { return Promise.resolve(true); },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  try { Object.defineProperty(navigator, "bluetooth", { value: bluetooth, configurable: true }); } catch (e) {}

  /* ── USB (cable OTG) ── */
  var ports = new Map();
  var serial = new EventTarget();
  function Port(info) {
    this._id = info.id; this._info = { usbVendorId: info.vid, usbProductId: info.pid }; this._name = info.name || "";
    this.readable = null; this.writable = null; this._ctrl = null; this._et = new EventTarget();
  }
  Port.prototype.addEventListener = function (t, f, o) { this._et.addEventListener(t, f, o); };
  Port.prototype.removeEventListener = function (t, f, o) { this._et.removeEventListener(t, f, o); };
  Port.prototype.dispatchEvent = function (e) { return this._et.dispatchEvent(e); };
  Port.prototype.getInfo = function () { return { usbVendorId: this._info.usbVendorId, usbProductId: this._info.usbProductId }; };
  Port.prototype.open = function (o) {
    var self = this;
    if (this.readable) return Promise.reject(mkErr("InvalidStateError", "El puerto ya está abierto"));
    return call("usbOpen", this._id, (o && o.baudRate) || 115200).then(function () {
      self.readable = new ReadableStream({ start: function (c) { self._ctrl = c; }, cancel: function () { self._ctrl = null; } });
      self.writable = new WritableStream({ write: function (chunk) { return call("usbWrite", self._id, b64e(toU8(chunk))).then(function () {}); } });
    });
  };
  Port.prototype.close = function () {
    var self = this, c = this._ctrl; this._ctrl = null;
    if (c) { try { c.close(); } catch (e) {} }
    this.readable = null; this.writable = null;
    return call("usbClose", this._id).then(function () {}, function () {});
  };
  Port.prototype.setSignals = function () { return Promise.resolve(); };
  Port.prototype.getSignals = function () { return Promise.resolve({ dataCarrierDetect: true, clearToSend: true, ringIndicator: false, dataSetReady: true }); };
  Port.prototype.forget = function () { return Promise.resolve(); };
  Port.prototype._data = function (u8) { if (this._ctrl) { try { this._ctrl.enqueue(u8); } catch (e) {} } };
  Port.prototype._gone = function () {
    var c = this._ctrl; this._ctrl = null;
    if (c) { try { c.close(); } catch (e) {} } /* el aviso de desconexión lo da el evento "disconnect" */
    this.readable = null; this.writable = null;
  };
  function portFor(info) { var p = ports.get(info.id); if (!p) { p = new Port(info); ports.set(info.id, p); } return p; }
  serial.requestPort = function (opts) { return call("usbRequest", JSON.stringify(opts || {})).then(function (r) { return portFor(JSON.parse(r)); }); };
  serial.getPorts = function () {
    try { return Promise.resolve(JSON.parse(AB.usbList() || "[]").filter(function (d) { return d.permitted; }).map(portFor)); }
    catch (e) { return Promise.resolve([]); }
  };
  try { Object.defineProperty(navigator, "serial", { value: serial, configurable: true }); } catch (e) {}

  /* ── portapapeles e impresión ── */
  try {
    var cw = function (t) { AB.copyText(String(t)); return Promise.resolve(); };
    if (navigator.clipboard) { try { navigator.clipboard.writeText = cw; } catch (e) {} }
    else Object.defineProperty(navigator, "clipboard", { value: { writeText: cw }, configurable: true });
  } catch (e) {}
  window.print = function () { AB.printHtml("<!doctype html>" + document.documentElement.outerHTML, document.title || "OPEN SOURCE PARIZ"); };

  /* ── red hecha por el teléfono: sin las trabas del visor web para la red local ── */
  if (AB.netProbe && AB.netHttp) {
    window.__nativeNet = {
      /* ¿hay algo escuchando en host:puerto? */
      probe: function (host, port, ms) {
        return call("netProbe", host, port, ms | 0).then(
          function () { return { ok: true }; },
          function (e) { return { ok: false, err: e && e.name === "timeout" ? "timeout" : "red" }; });
      },
      /* pedido HTTP completo; devuelve {status, body:Uint8Array} o tira un error con .kind */
      http: function (url, method, body, ms) {
        return call("netHttp", url, method || "GET", body ? b64e(toU8(body)) : "", ms | 0).then(function (t) {
          var o = JSON.parse(t || "{}");
          return { status: o.status, body: b64d(o.body || "") };
        }, function (e) {
          var err = new Error(e && e.message ? e.message : "error de red");
          err.kind = e && e.name === "timeout" ? "timeout" : "red";
          throw err;
        });
      },
    };
  }

  /* ── respuestas y eventos que llegan desde Android ── */
  window.__AB = {
    cb: function (id, ok, data) {
      var p = pend.get(id); if (!p) return; pend.delete(id);
      if (ok) p.res(data);
      else { var t = String(data || "Error|Error"), i = t.indexOf("|"); p.rej(mkErr(i > 0 ? t.slice(0, i) : "Error", i > 0 ? t.slice(i + 1) : t)); }
    },
    ev: function (type, a, b, c) {
      if (type === "ble-notify") {
        var d = bleDevs.get(a), ch = d && d._notif.get(b);
        if (ch) { var u = b64d(c); ch.value = new DataView(u.buffer); ch.dispatchEvent(new Event("characteristicvaluechanged")); }
      } else if (type === "ble-disc") {
        var dv = bleDevs.get(a);
        if (dv) { dv.gatt.connected = false; dv.dispatchEvent(new Event("gattserverdisconnected")); }
      } else if (type === "usb-data") {
        var p = ports.get(a); if (p) p._data(b64d(b));
      } else if (type === "usb-detach") {
        var pd = ports.get(a);
        if (pd) { pd._gone(); var ev = new Event("disconnect"); ev.port = pd; serial.dispatchEvent(ev); pd.dispatchEvent(new Event("disconnect")); }
      } else if (type === "usb-attach") {
        var ev2 = new Event("connect"); ev2.port = portFor(JSON.parse(a)); serial.dispatchEvent(ev2);
      } else if (type === "toast") {
        try { var box = document.getElementById("toasts"); if (box) { var t = document.createElement("div"); t.className = "toast " + (b || ""); t.textContent = a; box.appendChild(t); setTimeout(function () { t.remove(); }, 4800); } } catch (e) {}
      }
      else { /* avisos, GPS y visibilidad: los maneja el portal */
        if (type === "app-visible") window.__appHidden = a !== "1";
        try { window.dispatchEvent(new CustomEvent("ab:" + type, { detail: [a, b, c] })); } catch (e) {}
      }
    },
  };
  if (!(window.crypto && window.crypto.subtle)) { try { AB.log("Aviso: crypto.subtle no está disponible"); } catch (e) {} }
})();
