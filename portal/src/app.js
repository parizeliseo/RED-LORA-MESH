import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { TransportHTTP } from "@meshtastic/transport-http";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { create, clone, toBinary, fromBinary, isFieldSet, toJson } from "@bufbuild/protobuf";
import * as NConfig from "./pb/config_pb.js";
import * as NModule from "./pb/module_config_pb.js";
import * as NAdmin from "./pb/admin_pb.js";
import * as NMesh from "./pb/mesh_pb.js";
import * as NChannel from "./pb/channel_pb.js";
import * as NApp from "./pb/apponly_pb.js";
import * as NClient from "./pb/clientonly_pb.js";
import * as NLocal from "./pb/localonly_pb.js";
import * as NPort from "./pb/portnums_pb.js";
import FIELD_META from "./meta.json";
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
const PORTAL_VER = "1.7", PORTAL_BUILD = "__BUILD__"; /* la fecha la pone build.mjs al compilar */
const IS_APP = typeof window !== "undefined" && !!window.AndroidBridge; /* app de Android: Bluetooth, USB, archivos e impresión los da el teléfono */
import ES_OFFICIAL from "./es_official.json";
import ES_FIELDS from "./es_fields.json";

/* ───────────────────────── utilidades ───────────────────────── */
const C = NConfig, M = NModule, Mesh = Protobuf.Mesh; // C y M usan los esquemas del firmware 2.8 (todos los campos nuevos)
const ST = Types.DeviceStatusEnum;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "string") n.style.cssText = v;
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const $ = (s, r = document) => r.querySelector(s);
const hex8 = (n) => (n >>> 0).toString(16).padStart(8, "0");
const nodeId = (n) => "!" + hex8(n);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastLast = { msg: "", t: 0 };
function toast(msg, kind = "") {
  const box = $("#toasts"), now = Date.now();
  if (msg === toastLast.msg && now - toastLast.t < 3000) return; /* no repetir el mismo aviso */
  toastLast = { msg, t: now };
  while (box.children.length >= 4) box.firstChild.remove(); /* no tapar la pantalla con una avalancha */
  const t = el("div", { class: "toast " + kind }, msg);
  box.append(t);
  setTimeout(() => t.classList.add("out"), 4200);
  setTimeout(() => t.remove(), 4800);
}
function ago(sec) {
  if (!sec) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
  if (d < 60) return "hace " + d + " s";
  if (d < 3600) return "hace " + Math.floor(d / 60) + " min";
  if (d < 86400) return "hace " + Math.floor(d / 3600) + " h";
  return "hace " + Math.floor(d / 86400) + " d";
}
/* Intl.DateTimeFormat es caro de crear: se arma uno solo por formato y se reutiliza. */
const DTF = {};
const dtf = (k, o) => (DTF[k] || (DTF[k] = new Intl.DateTimeFormat("es-AR", o)));
const dayKey = (d) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
const dayCache = new Map();
const hhmm = (ms) => dtf("hm", { hour: "2-digit", minute: "2-digit" }).format(ms);
const dayLbl = (ms) => { /* además se memoriza por día: en una lista larga hay miles de mensajes y pocos días */
  const k = dayKey(new Date(ms)); let v = dayCache.get(k);
  if (v === undefined) { v = dtf("day", { weekday: "short", day: "2-digit", month: "short" }).format(ms); if (dayCache.size > 400) dayCache.clear(); dayCache.set(k, v); }
  return v;
};
function b64(bytes) { let s = ""; bytes.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); }
function unb64(str) { const s = atob(str.trim()); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return unb64(s); }
function hav(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r);
  const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const COMPASS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const compass = (d) => COMPASS[Math.round(d / 45) % 8];
const fmtDist = (km) => (km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km");
const enumName = (E, n) => (E && E[n] !== undefined ? E[n] : String(n));
/* Por qué la malla rechazó o no pudo entregar un paquete, dicho en castellano.
   El firmware devuelve nombres como MAX_RETRANSMIT, que al usuario no le dicen nada. */
const RUTEO = {
  0: ["Entregado", "El destino confirmó que lo recibió."],
  1: ["Sin ruta al destino", "Ningún nodo conocido llega hasta ese nodo. Probá acercarte o sumar un repetidor."],
  2: ["El destino lo rechazó", "Llegó, pero el otro nodo contestó que no lo acepta."],
  3: ["Se agotó el tiempo", "Nadie contestó a tiempo. Suele ser alcance justo o la red muy cargada."],
  4: ["Sin interfaz de salida", "El nodo no tiene por dónde mandarlo: revisá que la radio esté habilitada."],
  5: ["Se acabaron los reintentos", "Se reintentó el máximo de veces y no hubo confirmación. Señal débil o destino apagado."],
  6: ["Canal desconocido", "El destino no tiene ese canal, o la clave no coincide."],
  7: ["Mensaje demasiado grande", "No entra en un paquete. Mandalo más corto."],
  8: ["El destino no respondió", "Se escuchó la red pero el nodo no contestó."],
  9: ["Límite de uso del aire", "La ley de la banda obliga a esperar. Probá de nuevo en un rato."],
  32: ["Pedido inválido", "El nodo no entendió el pedido."],
  33: ["Sin autorización", "Falta la clave de administración de ese nodo."],
  34: ["Falló el cifrado", "No se pudo cifrar o descifrar con la clave del destino."],
  35: ["Clave pública desconocida", "Todavía no se conoce la clave del destino: esperá a escucharlo una vez."],
  36: ["Sesión de administración vencida", "Volvé a conectarte al nodo y reintentá."],
  37: ["Clave pública no autorizada", "Ese nodo no acepta administración con esta clave."],
  38: ["Demasiados envíos seguidos", "El nodo está limitando el ritmo. Esperá unos segundos."],
  39: ["No se pudo enviar la clave pública", "El intercambio de claves con el destino falló."],
};
const ruteoTitulo = (n) => (RUTEO[n] ? RUTEO[n][0] : enumName(Mesh.Routing_Error, n));
const ruteoDetalle = (n) => (RUTEO[n] ? RUTEO[n][1] : "");
const ruteoTexto = (n) => (RUTEO[n] ? RUTEO[n][0] + ". " + RUTEO[n][1] : enumName(Mesh.Routing_Error, n));
/* Red de seguridad: un rechazo de la malla que nadie estaba esperando no debe
   quedar como un objeto suelto en la consola; se cuenta y se muestra. */
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev && ev.reason;
    if (!r || typeof r !== "object" || r.error === undefined) return;
    ev.preventDefault();
    try {
      toast("La malla no pudo entregar un pedido: " + ruteoTexto(r.error), "err");
      logEvent("err", r.id, "Pedido sin entregar: " + ruteoTexto(r.error));
    } catch (e) { /* si todavía no arrancó la interfaz, no pasa nada */ }
  });
}

/* ───────────────────────── estado ───────────────────────── */
const S = {
  view: "messages", sub: "radio.lora", conv: "ch0",
  status: ST.DeviceDisconnected, demo: false, device: null, transport: null,
  me: 0, nodes: new Map(), channels: Array(8).fill(null), cfg: {}, mod: {}, meta: null,
  msgs: [], logs: [], unread: {}, search: "", msgq: "", msgFoco: null, logPause: false,
  form: null, expectReboot: false, reconnecting: false,
  map: { cx: 0, cy: 0, mpp: 100, sel: null, fitted: false },
  pktInfo: new Map(), tele: new Map(), tracks: new Map(), neigh: new Map(), waypoints: new Map(), myInfo: null, metaObj: null,
};
const connected = () => S.demo || S.status >= ST.DeviceConnected;
const ready = () => S.demo || S.status === ST.DeviceConfigured;

/* ───────────────────────── nodos ───────────────────────── */
function pruneNodes(force) { /* saca de la libreta los nodos viejos que llegaron por Internet; nunca toca el tuyo, los favoritos ni los de radio */
  const c = opsCfg(), keep = (c.keepDays || 7) * 86400, max = c.maxNodes || 1500, now = Date.now() / 1000;
  if (!force && S.nodes.size <= max) return 0;
  const borrables = [], escribieron = new Set();
  for (const m of S.msgs) { escribieron.add(m.from); escribieron.add(m.to); }
  for (const n of S.nodes.values()) {
    if (n.num === S.me || S.favs.has(n.num) || !n.viaMqtt) continue;
    if (S.alerts.has(n.num) || escribieron.has(n.num)) continue;
    if (now - (n.lastHeard || 0) > keep) borrables.push(n);
  }
  borrables.sort((a, b) => (a.lastHeard || 0) - (b.lastHeard || 0));
  let sobra = force ? borrables.length : Math.max(borrables.length, S.nodes.size - max);
  let k = 0;
  for (const n of borrables) { if (k >= sobra) break; S.nodes.delete(n.num); S.tele.delete(n.num); S.tracks.delete(n.num); S.neigh.delete(n.num); k++; }
  if (k) { S.stPrev && [...S.stPrev.keys()].forEach((id) => !S.nodes.has(id) && S.stPrev.delete(id)); scheduleRefresh("nodes"); }
  return k;
}
setInterval(() => pruneNodes(false), 300000);
function upsertNode(num, patch = {}) {
  let n = S.nodes.get(num);
  if (!n) { n = { num, user: null, pos: null, lastHeard: 0, snr: null, rssi: null, hops: null }; S.nodes.set(num, n); }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) n[k] = v;
  scheduleRefresh("nodes");
  return n;
}
const maskName = (t) => (t || "").replace(/meshtastic/gi, "LoRa Mesh");
const nodeName = (n) => (n && n.user && n.user.longName) || "LoRa Mesh " + (n ? hex8(n.num).slice(-4) : "????");
const nodeShort = (n) => (n && n.user && n.user.shortName) || (n ? hex8(n.num).slice(-4) : "????");
const nameOf = (num) => nodeName(S.nodes.get(num) || { num });
/* El color del avatar sale del número del nodo, pero no todos los tonos admiten letras blancas:
   un amarillo claro con texto blanco no se lee. Se baja la luminosidad del tono lo justo para que
   el texto alcance el contraste que pide la norma, así todos los avatares pesan parecido a la vista. */
const _lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hslLum(h, s, l) {
  const k = (m) => (m + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (m) => l - a * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
  return 0.2126 * _lin(f(0)) + 0.7152 * _lin(f(8)) + 0.0722 * _lin(f(4));
}
const avBg = new Map();
function avatarBg(h) {
  if (avBg.has(h)) return avBg.get(h);
  let lo = 0.12, hi = 0.52;
  for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (1.05 / (hslLum(h, 0.55, m) + 0.05) >= 4.6) lo = m; else hi = m; }
  const v = `hsl(${h} 55% ${Math.round(lo * 100)}%)`;
  avBg.set(h, v); return v;
}
function avatar(n, size = 38) {
  const h = (n.num * 47) % 360;
  return el("div", { class: "avatar", style: `width:${size}px;height:${size}px;background:${avatarBg(h)};font-size:${size > 34 ? 11 : 9}px` }, nodeShort(n).slice(0, 4));
}
const mePos = () => { const n = S.nodes.get(S.me); return n && n.pos ? n.pos : null; };
function battText(b) {
  if (b == null) return "—";
  return b > 100 ? "Alimentado" : Math.round(b) + "%";
}

function cacheKey(k) { return `meshportal:${S.me}:${k}`; }
let saveT = 0, msgCap = 4000, lastSaveSig = "";
function persistSoon() {
  if (saveT) return; /* ya hay un guardado en camino: no se reinicia el reloj para que no se posponga para siempre */
  saveT = setTimeout(() => {
    saveT = 0;
    if (!S.me || S.demo) return;
    const sig = S.nodes.size + ":" + S.msgs.length + ":" + (S.msgs.length ? S.msgs[S.msgs.length - 1].id : 0) + ":" + (S.msgRev || 0);
    if (sig === lastSaveSig) return; /* nada nuevo que guardar */
    lastSaveSig = sig;
    try {
      const arr = [...S.nodes.values()].map(({ rawUser, ...r }) => r);
      localStorage.setItem(cacheKey("nodes"), JSON.stringify(arr));
      while (true) { /* si no entra se baja el tope y se recuerda, para no volver a intentar lo que ya falló */
        try { localStorage.setItem(cacheKey("msgs"), JSON.stringify(S.msgs.slice(-msgCap))); break; }
        catch (e) { if (msgCap <= 300) break; msgCap = Math.floor(msgCap / 3); }
      }
    } catch (e) { /* almacenamiento lleno o bloqueado */ }
  }, 5000);
}
function loadCache() {
  try {
    const nodes = JSON.parse(localStorage.getItem(cacheKey("nodes")) || "[]");
    for (const n of nodes) if (!S.nodes.has(n.num)) S.nodes.set(n.num, n);
    S.msgs = JSON.parse(localStorage.getItem(cacheKey("msgs")) || "[]");
    S.msgs.forEach((m) => { if (m.mine && m.st === "retry") { m.st = "fail"; m.why = (m.why ? m.why + " · " : "") + "reintentos interrumpidos"; } });
  } catch (e) { /* ignorar */ }
  loadTele();
}

/* ───────────────────────── conexión ───────────────────────── */
let chT = 0;
let configuredOnce = false;
function onConfigured(dev) {
  if (configuredOnce) return; configuredOnce = true;
  toast("Nodo configurado y listo", "ok"); try { dev.getMetadata?.(S.me); } catch (e) {}
  for (const k of ["deviceMetrics", "localStats", "environmentMetrics"]) requestTele(S.me, k, true);
  mqSubscribe(); mqFlush(); saveChCache();
}
function bindEvents(dev) {
  const ev = dev.events;
  ev.onDeviceStatus.subscribe((st) => {
    S.status = st;
    if (st === ST.DeviceConfigured) { onConfigured(dev); playEvent("link"); }
    if (st === ST.DeviceDisconnected) { if (!S.userDisc && !S.expectReboot) playEvent("link"); onDisconnected(); }
    scheduleRefresh("all");
  });
  ev.onMyNodeInfo.subscribe((m) => {
    S.me = m.myNodeNum; S.myInfo = msgToObj(Mesh.MyNodeInfoSchema, m); loadCache(); mqRestoreQueue(); upsertNode(S.me, {}); scheduleRefresh("all");
  });
  ev.onNodeInfoPacket.subscribe((ni) => {
    afterNodeInfo(ni);
    const p = ni.position;
    const dm = ni.deviceMetrics;
    upsertNode(ni.num, {
      user: ni.user ? { longName: maskName(ni.user.longName), shortName: ni.user.shortName, hwModel: ni.user.hwModel, role: ni.user.role, isLicensed: ni.user.isLicensed, id: ni.user.id } : undefined,
      rawUser: ni.user || undefined,
      pos: p && (p.latitudeI || p.longitudeI) ? { lat: p.latitudeI / 1e7, lon: p.longitudeI / 1e7, alt: p.altitude, time: p.time } : undefined,
      lastHeard: ni.lastHeard || undefined,
      snr: ni.snr || undefined,
      hops: ni.hopsAway,
      fav: ni.isFavorite,
      viaMqtt: ni.viaMqtt,
      battery: dm ? dm.batteryLevel : undefined,
      voltage: dm ? dm.voltage : undefined,
      chUtil: dm ? dm.channelUtilization : undefined,
      airTx: dm ? dm.airUtilTx : undefined,
      uptime: dm ? dm.uptimeSeconds : undefined,
    });
  });
  ev.onDeviceMetadataPacket.subscribe((m) => { S.meta = m.data; S.metaObj = msgToObj(Mesh.DeviceMetadataSchema, m.data); scheduleRefresh("side"); scheduleRefresh("tele"); });
  ev.onPositionPacket.subscribe((p) => {
    const d = p.data;
    if (d.latitudeI || d.longitudeI) {
      const lat = d.latitudeI / 1e7, lon = d.longitudeI / 1e7, t = p.rxTime.getTime();
      upsertNode(p.from, { pos: { lat, lon, alt: d.altitude, time: d.time || Math.floor(t / 1000) } });
      addTrackPoint(p.from, lat, lon, d.altitude, t);
      const o = msgToObj(Mesh.PositionSchema, d);
      for (const k of ["latitudeI", "longitudeI", "time", "timestamp", "timestampMillisAdjust", "seqNumber", "nextUpdate"]) delete o[k];
      recordTele(p.from, "pos", { lat, lon, ...o }, t);
    }
  });
  ev.onUserPacket.subscribe((p) => {
    upsertNode(p.from, { user: { longName: maskName(p.data.longName), shortName: p.data.shortName, hwModel: p.data.hwModel, role: p.data.role, id: p.data.id }, rawUser: p.data });
  });
  ev.onTelemetryPacket.subscribe((p) => {
    const v = p.data.variant; if (!v || !v.case) return;
    const cat = VARIANT_CAT[v.case], f = Protobuf.Telemetry.TelemetrySchema.field[v.case];
    if (cat && f && f.message) recordTele(p.from, cat, msgToObj(f.message, v.value), p.rxTime.getTime());
    if (v.case === "deviceMetrics") {
      const d = v.value;
      upsertNode(p.from, { battery: d.batteryLevel, voltage: d.voltage, chUtil: d.channelUtilization, airTx: d.airUtilTx, uptime: d.uptimeSeconds });
    } else if (v.case === "environmentMetrics") {
      const d = v.value;
      upsertNode(p.from, { env: { temp: d.temperature, hum: d.relativeHumidity, press: d.barometricPressure } });
    }
  });
  ev.onPaxcounterPacket.subscribe((p) => recordTele(p.from, "pax", msgToObj(Protobuf.PaxCount.PaxcountSchema, p.data), p.rxTime.getTime()));
  ev.onNeighborInfoPacket.subscribe((p) => { const id = p.data.nodeId || p.from; S.neigh.set(id, (p.data.neighbors || []).map((x) => ({ id: x.nodeId, snr: x.snr }))); S.neighT.set(id, Date.now()); scheduleRefresh("tele"); });
  ev.onWaypointPacket.subscribe((p) => {
    const w = p.data; if (!(w.latitudeI || w.longitudeI)) return;
    let icon = ""; try { icon = w.icon ? String.fromCodePoint(w.icon) : ""; } catch (e) {}
    S.waypoints.set(w.id, { id: w.id, name: w.name || "Waypoint", desc: w.description, lat: w.latitudeI / 1e7, lon: w.longitudeI / 1e7, expire: w.expire, icon });
    scheduleRefresh("tele");
  });
  ev.onMeshPacket.subscribe((pkt) => {
    const now = Math.floor(Date.now() / 1000);
    if (pkt.payloadVariant.case === "decoded" && pkt.payloadVariant.value.portnum === Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP) {
      const dv = pkt.payloadVariant.value, pm = pktMeta(pkt, dv.payload && dv.payload.length);
      if (dv.replyId) pm.replyTo = dv.replyId; if (dv.emoji) pm.emoji = dv.emoji;
      S.pktInfo.set(pkt.id, pm);
      if (S.pktInfo.size > 200) S.pktInfo.delete(S.pktInfo.keys().next().value);
    }
    if (pkt.from && pkt.from !== S.me) {
      const hp = pkt.hopStart ? Math.max(0, pkt.hopStart - pkt.hopLimit) : undefined;
      if (pkt.viaMqtt) upsertNode(pkt.from, { lastHeard: pkt.rxTime || now, viaMqtt: true }); /* llegó por Internet: no es una medición de radio */
      else upsertNode(pkt.from, {
        lastHeard: pkt.rxTime || now,
        snr: pkt.rxSnr || undefined,
        rssi: pkt.rxRssi || undefined,
        hops: hp,
        viaMqtt: false,
        relay: hp > 0 ? pkt.relayNode || 0 : 0, /* último byte del ID del nodo que lo retransmitió (solo si hubo saltos) */
        relayT: Date.now(),
      });
      const lo = {}; if (pkt.viaMqtt) lo.mqtt = 1; else { if (pkt.rxSnr) lo.snr = pkt.rxSnr; if (pkt.rxRssi) lo.rssi = pkt.rxRssi; if (hp !== undefined) lo.hops = hp; if (hp > 0 && pkt.relayNode) lo.relay = pkt.relayNode; }
      recordTele(pkt.from, "link", lo, Date.now(), 20000);
    }
    if (!S.logPause) {
      const port = pkt.payloadVariant.case === "decoded" ? enumName(Protobuf.Portnums.PortNum, pkt.payloadVariant.value.portnum) : "CIFRADO";
      S.logs.push({ t: Date.now(), from: pkt.from, to: pkt.to, port, snr: pkt.rxSnr, rssi: pkt.rxRssi });
      if (S.logs.length > 300) S.logs.shift();
      scheduleRefresh("logs");
    }
  });
  ev.onMessagePacket.subscribe((m) => addMessage(m));
  ev.onTraceRoutePacket.subscribe((p) => {
    const route = [p.to, ...(p.data.route || []), p.from].map(nameOf).join(" → ");
    toast("Ruta: " + route);
    const q = (v) => (v == null || v === -128 ? null : v / 4); /* el firmware informa el SNR en cuartos de dB */
    S.traces.push({ t: Date.now(), me: p.to, dest: p.from, route: [...(p.data.route || [])], snrT: (p.data.snrTowards || []).map(q), back: [...(p.data.routeBack || [])], snrB: (p.data.snrBack || []).map(q) });
    if (S.traces.length > 60) S.traces.splice(0, S.traces.length - 60);
    try { localStorage.setItem("meshportal:traces", JSON.stringify(S.traces)); } catch (e) {}
    scheduleRefresh("tele");
  });
}

async function startDevice(transport) {
  const info0 = transport.connection && transport.connection.getInfo && transport.connection.getInfo();
  S.portInfo = info0 && info0.usbVendorId != null ? info0.usbVendorId.toString(16).padStart(4, "0") + ":" + info0.usbProductId.toString(16).padStart(4, "0") : "";
  transport = tapTransport(transport);
  S.transport = transport;
  const dev = new MeshDevice(transport);
  try { dev.log.settings.minLevel = 99; } catch (e) {} // el logger de core falla en el navegador (Buffer); lo silenciamos
  S.device = dev; configuredOnce = false; S.userDisc = false;
  S.status = ST.DeviceConnecting;
  bindEvents(dev);
  try {
    if (info0) localStorage.setItem("meshportal:port", JSON.stringify(info0));
  } catch (e) {}
  scheduleRefresh("all");
  dev.setHeartbeatInterval(3 * 60 * 1000);
  await dev.configure();
}

/* ── conexiones guardadas: USB (serie), Bluetooth y red (WiFi / LAN por HTTP) ── */
const CONN_KEY = "meshportal:conns";
const loadConns = () => { try { return JSON.parse(localStorage.getItem(CONN_KEY) || "[]"); } catch (e) { return []; } };
const saveConns = (a) => { try { localStorage.setItem(CONN_KEY, JSON.stringify(a)); } catch (e) {} };
const CONN_NAME = { serial: "USB", bluetooth: "Bluetooth", http: "Red (WiFi / LAN)" };
const connShort = (c) => (c ? { serial: "USB", bluetooth: "Bluetooth", http: "WiFi" }[c.type] : "USB");
function rememberConn(c) {
  const a = loadConns(), key = c.type + "|" + (c.address || c.deviceId || "");
  let x = a.find((y) => y.key === key);
  if (!x) { x = { id: Math.random().toString(36).slice(2, 9), key, ...c }; a.push(x); } else Object.assign(x, c);
  x.last = Date.now(); saveConns(a); S.conn = x; return x;
}
function forgetConn(id) { saveConns(loadConns().filter((x) => x.id !== id)); scheduleRefresh("all"); }
const lastConn = () => S.conn || loadConns().sort((a, b) => (b.last || 0) - (a.last || 0))[0] || null;
function connFail(msg) { toast(msg, "err"); S.status = ST.DeviceDisconnected; scheduleRefresh("all"); return false; }

async function connectUSB() {
  if (!("serial" in navigator)) { toast("Este navegador no soporta USB (Web Serial). Usá Chrome, Edge o Brave en PC.", "err"); return false; }
  try {
    S.demo = false;
    const t = await TransportWebSerial.create(115200);
    rememberConn({ type: "serial", name: "USB" });
    await startDevice(t);
    return true;
  } catch (e) {
    if (e && e.name === "NotFoundError") return false; // el usuario canceló el selector
    return connFail("No se pudo abrir el puerto: " + (e.message || e) + ". ¿Está abierto en otra app (otro cliente web, Python, Arduino)?");
  }
}
async function connectBT(known) {
  if (!navigator.bluetooth) { toast("Este navegador no soporta Bluetooth web. Usá Chrome o Edge. En Brave activá brave://flags/#brave-web-bluetooth-api y reiniciá.", "err"); return false; }
  try {
    S.demo = false;
    const dev = known || await navigator.bluetooth.requestDevice({ filters: [{ services: [TransportWebBluetooth.ServiceUuid] }] });
    const t = await TransportWebBluetooth.createFromDevice(dev);
    rememberConn({ type: "bluetooth", name: dev.name || "Bluetooth", deviceId: dev.id });
    await startDevice(t);
    return true;
  } catch (e) {
    if (e && e.name === "NotFoundError") return false;
    return connFail("No se pudo conectar por Bluetooth: " + (e.message || e) + ". Revisá que el Bluetooth del nodo esté activado, que no esté conectado a otro celular o PC y, si pide PIN, el que muestra la pantalla del nodo.");
  }
}
const cleanAddr = (a) => String(a || "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
async function connectNet(address, tls, name) {
  address = cleanAddr(address);
  if (!address) { toast("Escribí la dirección IP o el nombre del nodo", "err"); return false; }
  if (location.protocol === "https:" && !tls && !IS_APP) { toast("Esta página está en https: el navegador bloquea el acceso sin HTTPS. Activá “Usar HTTPS” o abrí el portal desde el archivo.", "err"); return false; }
  try {
    S.demo = false;
    const t = await makeNetTransport(address, !!tls);
    rememberConn({ type: "http", name: name || address, address, tls: !!tls });
    await startDevice(t);
    return true;
  } catch (e) {
    return connFail("No se pudo conectar con " + address + ": " + (e.message || e) + ". Revisá que el nodo tenga el WiFi encendido y conectado a la misma red que esta PC" + (tls ? ", y que el certificado de https://" + address + " esté aceptado en el navegador." : "."));
  }
}
async function testNet(address, tls) {
  address = cleanAddr(address); if (!address) return "Escribí la dirección del nodo";
  const d = await diagNode(address, tls, 8000);
  return d.ok ? "" : d.msg;
}
/* Prueba una dirección y explica en castellano qué pasó. Separa tres casos distintos:
   no contesta nadie · contesta pero el navegador no tiene permiso (CORS) · contesta y es un nodo. */
async function diagNode(hostPort, tls, ms) {
  const url = `${tls ? "https" : "http"}://${hostPort}`;
  const api = await rawFetch(url + "/api/v1/toradio", { method: "OPTIONS" }, ms);
  if (api.ok) return { ok: true, kind: "node", msg: "" };
  const alive = await probeAlive(hostPort.replace(/:\d+$/, ""), +(hostPort.match(/:(\d+)$/) || [0, tls ? 443 : 80])[1], tls, ms);
  if (alive.ok) {
    if (api.err === "timeout") return { ok: false, kind: "slow", msg: "El equipo contesta pero tarda demasiado en responder la consulta del portal. Probá de nuevo o acercá el nodo al WiFi." };
    return { ok: false, kind: "blocked", msg: tls
      ? "Hay un equipo en esa dirección, pero el navegador no acepta su certificado. Abrí " + url + " en una pestaña, aceptá el aviso de seguridad y volvé a probar."
      : "Hay un equipo en esa dirección, pero no deja que el portal le hable (el navegador lo bloquea). Si es tu nodo, revisá que tenga el servidor web activado; si no, es otro equipo de la red." };
  }
  if (api.err === "timeout" || alive.err === "timeout") return { ok: false, kind: "timeout", msg: "Tiempo de espera agotado: nadie respondió en esa dirección." };
  return { ok: false, kind: "dead", msg: "No se pudo alcanzar el equipo (¿IP correcta, misma red, WiFi del nodo encendido?)" };
}
/* fetch con tope de tiempo que devuelve el motivo del fallo en vez de tirar una excepción */
async function rawFetch(url, opts, ms, sig) {
  const n = NAT();
  if (n && /^https?:\/\//i.test(url) && opts.mode !== "no-cors") { /* en la app lo pide el teléfono */
    try { const r = await n.http(url, opts.method || "GET", opts.body || null, ms); return { ok: r.status === 204 || (r.status >= 200 && r.status < 400), status: r.status }; }
    catch (e) { return { ok: false, err: e.kind === "timeout" ? "timeout" : "red" }; }
  }
  const ctl = new AbortController(), ab = () => ctl.abort();
  const to = setTimeout(() => { ctl.__to = true; ctl.abort(); }, ms);
  if (sig) sig.addEventListener("abort", ab);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, cache: "no-store", redirect: "follow" });
    return { ok: opts.mode === "no-cors" ? true : r.ok || r.status === 204, status: r.status, type: r.type };
  } catch (e) {
    return { ok: false, err: ctl.__to ? "timeout" : (sig && sig.aborted) ? "cancel" : "red" };
  } finally { clearTimeout(to); if (sig) sig.removeEventListener("abort", ab); }
}
/* ── En la app, el teléfono hace los pedidos de red por nosotros. El visor web pone trabas para
   hablarle a equipos de la red local desde una página https; pidiéndoselo a Android no las hay. ── */
const NAT = () => (IS_APP && window.__nativeNet) || null;
/* Transporte HTTP equivalente al de la librería, pero por la vía nativa. */
function makeAppTransport(url) {
  const n = NAT();
  let ctrl = null, timer = 0, closed = false, last = null;
  const estado = (st, why) => { if (st === last) return; last = st; ctrl && ctrl.enqueue({ type: "status", data: { status: st, reason: why } }); };
  const leer = async () => {
    if (closed) return;
    try {
      for (let i = 0; i < 40; i++) { /* se vacía la cola del nodo de a un paquete, como hace la librería */
        const r = await n.http(url + "/api/v1/fromradio?all=false", "GET", null, 7000);
        if (r.status !== 200) throw new Error("fromradio " + r.status);
        estado(ST.DeviceConnected);
        if (!r.body || !r.body.length) break;
        ctrl && ctrl.enqueue({ type: "packet", data: r.body });
      }
    } catch (e) { if (!closed) estado(ST.DeviceDisconnected, "read-error"); }
  };
  return {
    fromDevice: new ReadableStream({ start: (c) => { ctrl = c; estado(ST.DeviceConnecting); leer(); timer = setInterval(leer, 3000); }, cancel: () => { clearInterval(timer); timer = 0; } }),
    toDevice: new WritableStream({ write: async (chunk) => {
      try { const r = await n.http(url + "/api/v1/toradio", "PUT", chunk, 4000); if (r.status !== 200 && r.status !== 204) throw new Error("toradio " + r.status); }
      catch (e) { if (!closed) estado(ST.DeviceDisconnected, "write-error"); }
    } }),
    disconnect: async () => { closed = true; clearInterval(timer); timer = 0; estado(ST.DeviceDisconnected, "user"); },
  };
}
async function makeNetTransport(address, tls) {
  const n = NAT();
  if (!n) return await TransportHTTP.create(address, !!tls);
  const url = (tls ? "https" : "http") + "://" + address;
  const r = await n.http(url + "/api/v1/toradio", "OPTIONS", null, 8000); /* comprueba que esté y que sea un nodo */
  if (r.status >= 400) throw new Error("el equipo respondió " + r.status);
  return makeAppTransport(url);
}
/* ── búsqueda de nodos en la red: un navegador no puede abrir conexiones TCP crudas (no hay escaneo de puertos real);
   lo que sí puede es preguntarle a cada dirección y puerto si responde como la API web de un nodo ── */
const SCAN_KEY = "meshportal:scan";
const scanCfg = () => { let u = {}; try { u = JSON.parse(localStorage.getItem(SCAN_KEY) || "{}"); } catch (e) {} const sv = loadConns().filter((c) => c.type === "http").map((c) => (c.address.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/) || [])[1]).filter(Boolean); return { prefixes: u.prefixes || [...new Set([...sv, "192.168.1", "192.168.0"])].join(", "), p80: u.p80 !== false, p443: !!u.p443, extra: u.extra || "" }; };
const scanSave = (o) => { try { localStorage.setItem(SCAN_KEY, JSON.stringify({ ...scanCfg(), ...o })); } catch (e) {} };
const addrOf = (host, port, tls) => host + (port !== (tls ? 443 : 80) ? ":" + port : "");
const urlOf = (host, port, tls) => (tls ? "https" : "http") + "://" + addrOf(host, port, tls);
/* Pasada 1: ¿hay algo escuchando? Pregunta sin pedir permiso de lectura (no-cors), así una dirección
   viva se detecta aunque el equipo no autorice al portal. Rápida: se le da poco tiempo. */
/* En la app se prueba el puerto de verdad (conexión TCP): más rápido y sin falsos positivos. */
const probeAlive = (host, port, tls, ms, sig) => { const n = NAT(); return n ? n.probe(host, port, ms) : rawFetch(urlOf(host, port, tls) + "/api/v1/toradio", { method: "GET", mode: "no-cors" }, ms, sig); };
/* Pasada 2: solo sobre las direcciones vivas, y con tiempo de sobra: ¿es un nodo con su API web? */
const probeApi = (host, port, tls, ms, sig) => rawFetch(urlOf(host, port, tls) + "/api/v1/toradio", { method: "OPTIONS" }, ms, sig);
/* Convierte lo escrito en una lista de direcciones. Acepta, separados por coma o espacio:
   192.168.1            red entera (.1 a .254)      192.168.1.*        lo mismo
   192.168.1.0/24       lo mismo                    192.168.1.10-40    un tramo
   192.168.1.10         una sola dirección          mi-nodo.local      un nombre */
const ok255 = (a) => a.every((n) => +n >= 0 && +n <= 255);
const hostsOf = (txt) => {
  const out = new Set();
  for (const t of String(txt).split(/[\s,;]+/).filter(Boolean)) {
    let m;
    if ((m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})$/)) || (m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\*$/)) || (m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/))) {
      if (!ok255(m[1].split("."))) continue;
      for (let i = 1; i <= 254; i++) out.add(m[1] + "." + i);
    } else if ((m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/))) {
      if (!ok255([...m[1].split("."), m[2], m[3]])) continue;
      const a = Math.min(+m[2], +m[3]), b = Math.max(+m[2], +m[3]);
      for (let i = a; i <= b; i++) out.add(m[1] + "." + i);
    } else if ((m = t.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/))) {
      if (ok255(m[1].split("."))) out.add(m[1]);
    } else if (/^[a-z0-9][a-z0-9.-]*$/i.test(t)) out.add(t); /* nombre de equipo */
  }
  return [...out];
};
/* /24 de una dirección: 192.168.1.25 -> 192.168.1 */
const red24 = (t) => { const m = String(t).trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}/); return m && ok255(m[1].split(".")) ? m[1] : null; };
/* Dos pasadas. La primera barre toda la red rápido; la segunda confirma solo los candidatos,
   con paciencia. Así un nodo lento ya no se pierde y el barrido entero no tarda minutos. */
async function scanNetwork(hosts, ports, onProg, sig, conc = 64) {
  const jobs = []; for (const h of hosts) for (const p of ports) jobs.push([h, p]);
  const pool = async (list, fn, n) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length && !(sig && sig.aborted)) { const k = i++; await fn(list[k]); } })); };
  const total = jobs.length; let done = 0;
  const alive = [], lentos = [], nodes = [];
  await pool(jobs, async ([h, p]) => {
    /* en una red real las direcciones vacías fallan enseguida: el tope alto solo lo pagan las que no contestan */
    const r = await probeAlive(h, p.port, p.tls, 3000, sig); done++;
    if (r.ok) alive.push({ host: h, port: p.port, tls: p.tls });
    else if (r.err === "timeout") lentos.push({ host: h, port: p.port, tls: p.tls }); /* quizá sea un nodo lento: se reintenta con más tiempo */
    onProg(done, total, nodes, "buscando");
  }, conc);
  if (sig && sig.aborted) return { nodes, otros: [] };
  const otros = [];
  /* las que no contestaron a tiempo se reintentan con el doble de paciencia: un nodo cargado puede tardar varios segundos */
  await pool(lentos.slice(0, 24), async (a) => {
    const r = await probeAlive(a.host, a.port, a.tls, 8000, sig); done++;
    if (r.ok) alive.push(a);
    onProg(done, total + lentos.length + alive.length, nodes, "confirmando");
  }, 12);
  if (sig && sig.aborted) return { nodes, otros };
  await pool(alive.slice(0, 60), async (a) => {
    const r = await probeApi(a.host, a.port, a.tls, 12000, sig); done++;
    if (r.ok) nodes.push(a); else otros.push({ ...a, why: r.err === "timeout" ? "no contestó a tiempo" : "no deja que el portal le hable" });
    onProg(done, total + lentos.length + alive.length, nodes, "confirmando");
  }, 8);
  return { nodes, otros };
}
async function findKnownPort() {
  if (!("serial" in navigator)) return null;
  const ports = await navigator.serial.getPorts();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("meshportal:port") || "null"); } catch (e) {}
  if (saved) {
    const m = ports.find((p) => { const i = p.getInfo(); return i.usbVendorId === saved.usbVendorId && i.usbProductId === saved.usbProductId; });
    if (m) return m;
  }
  return ports[0] || null;
}
async function reconnectKnown(silent, conn) {
  const c = conn || lastConn(), type = c ? c.type : "serial";
  try {
    S.demo = false;
    if (type === "http") {
      const t = await makeNetTransport(c.address, !!c.tls); S.conn = c; await startDevice(t); return true;
    }
    if (type === "bluetooth") {
      let dev = null;
      if (navigator.bluetooth && navigator.bluetooth.getDevices) dev = (await navigator.bluetooth.getDevices()).find((d) => d.id === c.deviceId) || null;
      if (!dev) { if (!silent) return connectBT(); return false; }
      S.conn = c; return await connectBT(dev);
    }
    const port = await findKnownPort();
    if (!port) { if (!silent) toast("No hay un puerto autorizado todavía. Usá “USB”.", "err"); return false; }
    const t = await TransportWebSerial.createFromPort(port, 115200);
    if (c) S.conn = c; await startDevice(t);
    return true;
  } catch (e) {
    if (!silent) toast("No se pudo reconectar: " + (e.message || e), "err");
    return false;
  }
}
/* ventana "Agregar conexión" (red, Bluetooth, USB) */
function openConnDialog(tab0) {
  let tab = tab0 || "http", tls = false;
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() });
  const nameIn = el("input", { class: "inp", placeholder: "Mi nodo (opcional)", autocomplete: "off" });
  const addrIn = el("input", { class: "inp", placeholder: "192.168.1.10", autocomplete: "off", inputmode: "url" });
  const res = el("div", { class: "muted small", style: "min-height:1.2em" });
  let scanCtl = null; const scanBox = el("div", { class: "scanbox" });
  const fmtAddr = (f) => f.host + (f.port !== (f.tls ? 443 : 80) ? ":" + f.port : "");
  const useFound = (f) => { addrIn.value = fmtAddr(f); tls = f.tls; draw(); res.textContent = "Dirección cargada: " + fmtAddr(f) + (f.tls ? " (HTTPS)" : ""); };
  const drawScan = () => {
    const c = scanCfg(), busy = !!scanCtl;
    const pre = el("input", { class: "inp", value: c.prefixes, placeholder: "192.168.1, 192.168.0", autocomplete: "off", disabled: busy, onchange: (e) => scanSave({ prefixes: e.target.value }) });
    const ck = (k, label) => el("label", { class: "ck" }, el("input", { type: "checkbox", checked: c[k], disabled: busy, onchange: (e) => scanSave({ [k]: e.target.checked }) }), el("span", {}, label));
    const ex = el("input", { class: "inp", value: c.extra, placeholder: "8080, 8443", style: "width:130px", autocomplete: "off", disabled: busy, onchange: (e) => scanSave({ extra: e.target.value }) });
    const list = el("div", { class: "scanres" }), prog = el("div", { class: "muted small" }), bar = el("div", { class: "pbar" }, el("i", {}));
    const byHost = (a, b) => a.host.localeCompare(b.host, undefined, { numeric: true });
    const nodeRow = (f) => el("div", { class: "destit" }, el("b", {}, fmtAddr(f)), el("small", {}, f.tls ? "HTTPS" : "HTTP"), el("button", { class: "mini acc", onclick: () => useFound(f) }, "Usar"));
    const otroRow = (f) => el("div", { class: "destit otro" }, el("b", {}, fmtAddr(f)), el("small", {}, "responde, pero " + f.why),
      el("button", { class: "mini", title: "Probar esta dirección y ver el motivo exacto", onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Probando…"; const d = await diagNode(fmtAddr(f), f.tls, 8000); e.target.disabled = false; e.target.textContent = "Probar"; if (d.ok) { useFound(f); toast("Es un nodo: dirección cargada", "ok"); } else toast(d.msg, "err"); } }, "Probar"),
      el("button", { class: "mini", title: "Cargar igual esta dirección para intentar conectar", onclick: () => useFound(f) }, "Usar igual"));
    const MAXO = 12;
    const showRes = (box, nodes, otros) => box && box.replaceChildren(...[
      ...nodes.sort(byHost).map(nodeRow),
      otros.length ? el("div", { class: "blkh sub" }, "Otros equipos que respondieron (" + otros.length + ")") : null,
      ...otros.sort(byHost).slice(0, MAXO).map(otroRow),
      otros.length > MAXO ? el("div", { class: "muted small" }, "y " + (otros.length - MAXO) + " más") : null].filter(Boolean));
    /* Si lo escrito tiene direcciones completas (o hay una en el cuadro de arriba), se ofrece revisar su red entera:
       es el error más común, escribir 192.168.1.10 en vez de 192.168.1. */
    const sugRow = () => {
      const txt = pre.value || "", yaRed = new Set(txt.split(/[\s,;]+/).filter((t) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(t)));
      const cand = new Set();
      for (const t of txt.split(/[\s,;]+/).filter(Boolean)) { const r = red24(t); if (r && !yaRed.has(r)) cand.add(r); }
      const ra = red24(cleanAddr(addrIn.value).replace(/:\d+$/, "")); if (ra && !yaRed.has(ra)) cand.add(ra);
      for (const c of loadConns().filter((x) => x.type === "http")) { const r = red24(String(c.address).replace(/:\d+$/, "")); if (r && !yaRed.has(r)) cand.add(r); }
      if (!cand.size) return el("span");
      return el("div", { class: "rowbtn chips sug" }, el("small", { class: "muted" }, "¿Querías revisar la red entera?"),
        ...[...cand].slice(0, 4).map((r) => el("button", { class: "mini acc", disabled: busy, onclick: () => { pre.value = r; scanSave({ prefixes: r }); drawScan(); } }, "Revisar toda " + r + ".x")));
    };
    const portsList = () => { const c = scanCfg(), l = []; if (c.p80) l.push({ port: 80, tls: false }); if (c.p443) l.push({ port: 443, tls: true }); for (const t of String(c.extra).split(/[\s,;]+/).filter(Boolean)) { const n = +t; if (n > 0 && n < 65536 && !l.some((x) => x.port === n)) l.push({ port: n, tls: n === 443 || n === 8443 }); } return l; };
    const run = async (hosts, ports, what) => {
      if (!hosts.length) return toast("Escribí al menos una red válida, por ejemplo 192.168.1", "err");
      if (!ports.length) return toast("Elegí al menos un puerto", "err");
      scanCtl = new AbortController(); const sig = scanCtl.signal; drawScan(); const L = $(".scanbox .scanres"), P = $(".scanbox .pbar i"), T = $(".scanbox .scantxt");
      const t0 = Date.now();
      const r = await scanNetwork(hosts, ports, (d, n, f, fase) => { if (P) P.style.width = Math.round((d / Math.max(1, n)) * 100) + "%"; if (T) T.textContent = what + " · " + (fase === "confirmando" ? "confirmando candidatos" : "recorriendo direcciones") + ": " + d + " de " + n + " · nodos: " + f.length; if (fase === "confirmando") showRes(L, f, []); }, sig);
      const stopped = sig.aborted; scanCtl = null; drawScan(); const L2 = $(".scanbox .scanres"), T2 = $(".scanbox .scantxt");
      const seg = Math.round((Date.now() - t0) / 1000);
      const rango = hosts.length > 3 ? hosts.length + " direcciones (" + hosts[0] + " a " + hosts[hosts.length - 1] + ")" : hosts.join(", ");
      const puertos = (ports.length > 1 ? "los puertos " : "el puerto ") + ports.map((x) => x.port).join(", ");
      if (T2) T2.textContent = (stopped ? "Búsqueda detenida. " : "Se revisaron " + rango + " en " + puertos + ", en " + seg + " s. ")
        + (r.nodes.length ? "Nodos encontrados: " + r.nodes.length + "." : r.otros.length
          ? (r.otros.length >= 15
              ? "Respondieron " + r.otros.length + " direcciones: parece que algo en la red (un proxy o un portal cautivo) contesta por todas. En este caso el barrido no sirve: escribí a mano la IP del nodo en el cuadro de arriba y tocá “Probar conexión”."
              : "Ningún nodo confirmado, pero " + r.otros.length + " equipo(s) respondieron: mirá la lista, puede que uno sea tu nodo.")
          : "No respondió nadie. Revisá que el nodo tenga el WiFi y el servidor web activados, que esta PC esté en la misma red y que la red escrita arriba sea la correcta.");
      showRes(L2, r.nodes, r.otros);
      if (r.nodes.length === 1 && !stopped) useFound(r.nodes[0]);
    };
    scanBox.replaceChildren(el("div", { class: "blkh" }, "Buscar el nodo en la red"),
      el("small", { class: "muted" }, "El portal recorre las direcciones de la red en dos pasadas: primero ve cuáles responden y después confirma cuáles son nodos. Tarda unos segundos. Un navegador no puede hacer un escaneo de puertos completo: solo detecta nodos con la interfaz web (HTTP/HTTPS) activa."),
      row("Redes a revisar", "Poné los TRES primeros números: 192.168.1 revisa de .1 a .254. También valen 192.168.1.* , 192.168.1.0/24 y un tramo como 192.168.1.10-40. Si escribís una dirección completa se revisa solo esa. Varias separadas por coma. Además se prueban las direcciones de fábrica del punto de acceso del nodo.", pre),
      sugRow(),
      row("Puertos", "80 = HTTP (lo normal). Marcá 443 solo si tu nodo usa HTTPS: hay que aceptarle el certificado a mano una vez, y duplica el tiempo de búsqueda.", el("div", { class: "inlrow" }, ck("p80", "80 HTTP"), ck("p443", "443 HTTPS"), ex)),
      el("div", { class: "rowbtn chips" },
        busy ? el("button", { class: "btn ghost", onclick: () => scanCtl && scanCtl.abort() }, "Detener")
          : el("button", { class: "btn", onclick: () => { const h = hostsOf(pre.value); scanSave({ prefixes: pre.value }); run([...new Set([...h, "192.168.42.1", "192.168.4.1"])], portsList(), "Red"); } }, "Buscar nodos en la red"),
        busy ? el("span") : el("button", { class: "btn ghost", title: "Prueba los puertos 80, 443, 8080 y 8443 de la dirección escrita arriba", onclick: () => { const a = cleanAddr(addrIn.value).replace(/:\d+$/, ""); if (!a) return toast("Escribí primero la dirección IP en el cuadro de arriba", "err"); run([a], [{ port: 80, tls: false }, { port: 443, tls: true }, { port: 8080, tls: false }, { port: 8443, tls: true }], "Puertos de " + a); } }, "Escanear puertos de la dirección escrita")),
      busy ? bar : el("span"), el("div", { class: "muted small scantxt" }, prog.textContent || ""), list);
  };
  drawScan();
  const draw = () => {
    const seg = el("div", { class: "seg" }, ...[["http", "Red (WiFi / LAN)"], ["bluetooth", "Bluetooth"], ["serial", "USB"]].map(([k, l]) => el("button", { class: tab === k ? "on" : "", onclick: () => { tab = k; draw(); } }, l)));
    let body;
    if (tab === "http") {
      const tlsSw = el("label", { class: "sw" }, el("input", { type: "checkbox", checked: tls, onchange: (e) => (tls = e.target.checked) }), el("span", {}));
      body = [
        el("small", { class: "muted" }, "Para nodos con WiFi o Ethernet. El nodo y esta PC tienen que estar en la misma red (WiFi, cable o el punto de acceso del propio nodo)."),
        row("Nombre", "", nameIn), row("Dirección IP o nombre", "Ejemplo: 192.168.1.10", addrIn), row("Usar HTTPS", "Solo si el nodo lo tiene activado", tlsSw), res, scanBox,
        el("div", { class: "mfoot" },
          el("button", { class: "btn ghost", onclick: async (e) => { e.target.disabled = true; res.textContent = "Probando…"; const m = await testNet(addrIn.value, tls); res.textContent = m || "Conexión correcta: el nodo responde."; e.target.disabled = false; } }, "Probar conexión"),
          el("button", { class: "btn", onclick: async (e) => { e.target.disabled = true; dlg.remove(); await connectNet(addrIn.value, tls, nameIn.value.trim()); } }, "Guardar y conectar"))];
    } else if (tab === "bluetooth") {
      body = [el("small", { class: "muted" }, "Activá el Bluetooth del nodo (Configuración del dispositivo → Bluetooth) y desconectalo de cualquier celular. El navegador muestra la lista de equipos cercanos; si pide PIN, es el que aparece en la pantalla del nodo (123456 si no cambió). En Brave hay que activar brave://flags/#brave-web-bluetooth-api."),
        el("div", { class: "mfoot" }, el("button", { class: "btn", onclick: async (e) => { dlg.remove(); await connectBT(); } }, "Buscar dispositivos Bluetooth"))];
    } else {
      body = [el("small", { class: "muted" }, "Enchufá el nodo a la PC con un cable USB de datos y elegí el puerto en la lista del navegador (“USB Serial”, “CP210x”, “CH340” o “USB JTAG/serial”). Cerrá cualquier otra app que use el puerto."),
        el("div", { class: "mfoot" }, el("button", { class: "btn", onclick: async () => { dlg.remove(); await connectUSB(); } }, "Elegir puerto USB"))];
    }
    dlg.replaceChildren(el("div", { class: "mbox" }, el("h3", {}, "Agregar conexión"), el("small", { class: "muted" }, "Elegí cómo se conecta el nodo"), seg, ...body, el("div", { class: "mfoot" }, el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cerrar"))));
  };
  draw(); document.body.append(dlg);
}
async function disconnect() {
  if (S.demo) { S.demo = false; resetConn(); return; }
  S.expectReboot = false; S.userDisc = true;
  try { await S.transport.disconnect(); } catch (e) {}
  resetConn();
}
function resetConn() {
  S.device = null; S.transport = null; S.status = ST.DeviceDisconnected; S.form = null;
  scheduleRefresh("all");
}
function onDisconnected() {
  const wasReboot = S.expectReboot;
  S.device = null; S.transport = null;
  if (wasReboot && !S.reconnecting) autoReconnect();
  else if (!wasReboot && !S.userDisc) toast("Se perdió la conexión con el nodo", "err");
  S.userDisc = false;
}
async function autoReconnect() {
  S.reconnecting = true; S.expectReboot = false;
  toast("El nodo se está reiniciando… reconectando solo");
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    if (await reconnectKnown(true)) { S.reconnecting = false; return; }
  }
  S.reconnecting = false;
  toast("No pude reconectar solo. Tocá “Reconectar último puerto”.", "err");
}
if ("serial" in navigator) navigator.serial.addEventListener("disconnect", () => { if (S.device && !S.demo && (!S.conn || S.conn.type === "serial")) { S.status = ST.DeviceDisconnected; onDisconnected(); scheduleRefresh("all"); } });

/* ───────────────────────── mensajes ───────────────────────── */
function convOf(m) { return m.dm ? "dm" + (m.mine ? m.to : m.from) : "ch" + m.ch; }
function addMessage(m) {
  const mine = m.from === S.me;
  if (S.msgs.some((x) => x.id === m.id && x.from === m.from)) return;
  const t = m.rxTime.getTime() > 1e12 ? m.rxTime.getTime() : Date.now(); // si el módulo no tiene hora, se usa la de la PC
  const sn = S.nodes.get(m.from), mp = mePos();
  const info = S.pktInfo.get(m.id) || {}; S.pktInfo.delete(m.id);
  const msg = { id: m.id, t, from: m.from, to: m.to, ch: m.channel, dm: m.type === "direct", text: m.data, mine, st: mine ? "pending" : null, ...info,
    fn: sn && sn.user ? sn.user.longName : undefined, sn: sn && sn.user ? sn.user.shortName : undefined,
    sPos: !mine && sn && sn.pos ? { lat: sn.pos.lat, lon: sn.pos.lon } : undefined,
    dist: !mine && mp && sn && sn.pos ? hav(mp.lat, mp.lon, sn.pos.lat, sn.pos.lon) : undefined };
  if (msg.emoji && msg.replyTo) { /* reacción: se suma al mensaje original en lugar de aparecer como mensaje */
    if (applyReact(msg.replyTo, msg.from, String(msg.text).slice(0, 8))) { if (!mine) { const t0 = S.msgs.find((x) => x.id === msg.replyTo); if (t0 && t0.mine) sysNotify(msg.dm ? "dm" : "ch", convOf(t0), nameOf(msg.from) + " reaccionó " + msg.text, String(t0.text).slice(0, 80)); } return; }
  }
  if (mine) {
    const ji = S.outJobs.map((j, k) => [j, k]).reverse().filter(([j]) => !j.matched && j.text === m.data && j.ch === m.channel && (j.dest === "broadcast") === (m.type !== "direct"))[0];
    if (ji) { const j = ji[0]; j.matched = true; msg.job = j; msg.st = "pending"; if (j.tries > 1 && j.up !== undefined && j.up !== "queued" && j.up !== "pending") msg.up = j.up; }
  }
  if (mine && S.okIds.has(m.id)) msg.st = "ok";
  if (mine && !S.demo && msg.up === undefined) { const u = mqDecideUplink(msg); if (u) msg.up = u; }
  if (msg.job) msg.job.up = msg.up;
  S.msgs.push(msg);
  if (!mine && isAlertText(msg.text)) { S.alerts.set(msg.from, { t, text: String(msg.text).slice(0, 200), ack: false, conv: convOf(msg) }); logEvent("panic", msg.from, String(msg.text).slice(0, 200), t); playEvent("panic", true); notifyMsg(msg, true); scheduleRefresh("all"); }
  else if (!mine) { notifyIncoming(msg); notifyMsg(msg, false); }
  const key = convOf(msg);
  if (!mine && !(S.view === "messages" && S.conv === key)) S.unread[key] = (S.unread[key] || 0) + 1;
  scheduleRefresh("msgs"); persistSoon();
}
function setMsgState(id, st, why) {
  const m = S.msgs.find((x) => x.id === id && x.mine);
  if (m) { m.st = st; m.why = why; if (st === "ok") { m.retryAt = 0; playEvent("ok"); } scheduleRefresh("msgs"); persistSoon(); }
}
/* ── envío con reintentos: si falla, vuelve a intentar a los 60 s y otra vez a los 60 s; después aparece “Reenviar” ── */
const RETRY_MS = 60000, MAX_TRIES = 3;
S.outJobs = []; S.okIds = new Set();
async function dispatch(job) {
  job.tries = (job.tries || 0) + 1; job.t = Date.now(); job.matched = false;
  S.outJobs = S.outJobs.filter((j) => Date.now() - j.t < 120000); S.outJobs.push(job);
  try {
    if (!S.device || !ready()) throw new Error("sin conexión con el nodo");
    const id = await S.device.sendText(job.text, job.dest, job.dest !== "broadcast", job.ch, job.replyTo || undefined, job.emoji || undefined);
    S.okIds.add(id); setMsgState(id, "ok");
    if (S.okIds.size > 500) { const it = S.okIds.values(); for (let k = 0; k < 250; k++) S.okIds.delete(it.next().value); } /* solo sirve para casar la confirmación con el mensaje recién enviado: no hace falta guardar el historial entero */
  } catch (e) {
    onSendFail(job, e && e.id, e && e.error !== undefined ? ruteoTexto(e.error) : String((e && e.message) || e));
  }
}
function onSendFail(job, id, why) {
  S.outJobs = S.outJobs.filter((j) => j !== job);
  if (job.react) { applyReact(job.react, S.me, job.text, false); toast("No se pudo enviar la reacción: " + why, "err"); return; }
  let m = (id != null && S.msgs.find((x) => x.id === id && x.mine)) || S.msgs.find((x) => x.job === job);
  if (!m) { /* el nodo no llegó a devolver el mensaje: se muestra igual para que el operador lo vea */
    m = { id: -Date.now() - Math.floor(Math.random() * 1000), t: Date.now(), from: S.me, to: job.dest === "broadcast" ? 0xffffffff : job.dest, ch: job.ch, dm: job.dest !== "broadcast", text: job.text, mine: true, replyTo: job.replyTo };
    S.msgs.push(m);
  }
  m.job = job; m.why = why;
  if (job.tries < MAX_TRIES) { m.st = "retry"; m.retryAt = Date.now() + RETRY_MS; } else { m.st = "fail"; m.retryAt = 0; toast("Mensaje no entregado: tocá “Reenviar mensaje”", "err"); playEvent("fail"); }
  scheduleRefresh("msgs"); persistSoon();
}
function resendNow(m, reset) { /* reintenta ya (reintento programado o botón “Reenviar”) */
  const job = { text: m.text, dest: m.dm ? m.to : "broadcast", ch: m.ch, tries: reset ? 0 : (m.job && m.job.tries) || 0, up: m.up, replyTo: m.replyTo };
  S.msgs = S.msgs.filter((x) => x !== m); scheduleRefresh("msgs");
  return dispatch(job);
}
async function sendMsg(text) {
  text = text.trim();
  if (!text) return;
  if (!S.device) { toast("Conectate primero al nodo", "err"); return; }
  let dest = "broadcast", ch = 0;
  if (S.conv.startsWith("ch")) ch = +S.conv.slice(2); else dest = +S.conv.slice(2);
  const rt = S.replyTo && convOf(S.replyTo) === S.conv && S.replyTo.id > 0 ? S.replyTo.id : undefined;
  S.replyTo = null; drawReplyBar();
  await dispatch({ text, dest, ch, tries: 0, replyTo: rt });
}
/* ── mensajes programados ── */
const SCHED_KEY = "meshportal:sched", SCHED_GRACE = 15 * 60000;
S.sched = []; try { S.sched = JSON.parse(localStorage.getItem(SCHED_KEY) || "[]"); } catch (e) {}
const saveSched = () => { try { localStorage.setItem(SCHED_KEY, JSON.stringify(S.sched)); } catch (e) {} scheduleRefresh("msgs"); };
const schedOpen = () => S.sched.filter((x) => x.st === "wait" || x.st === "late");
function schedAdd(text, at, conv) { S.sched.push({ id: Math.random().toString(36).slice(2, 9), text, at, conv, st: "wait" }); saveSched(); }
async function schedFire(x) {
  x.st = "sent"; x.sentAt = Date.now(); saveSched();
  toast("Se envía el mensaje programado de las " + hhmm(x.at));
  if (x.conv === "all") { /* grupo de reenvío: el mismo texto a todos los canales activos */
    const chans = activeChans();
    for (const ch of chans.length ? chans : [0]) { dispatch({ text: x.text, dest: "broadcast", ch, tries: 0 }); await new Promise((r) => setTimeout(r, 700)); }
    return;
  }
  const dest = x.conv.startsWith("dm") ? +x.conv.slice(2) : "broadcast", ch = x.conv.startsWith("ch") ? +x.conv.slice(2) : 0;
  await dispatch({ text: x.text, dest, ch, tries: 0 });
}
let tickBusy = false;
function msgTick() {
  if (tickBusy) return; tickBusy = true;
  try {
    const now = Date.now();
    for (const x of S.sched) if (x.st === "wait" && now >= x.at) {
      if (S.device && ready()) schedFire(x);
      else if (now - x.at > SCHED_GRACE) { x.st = "late"; saveSched(); toast("Mensaje programado vencido: el nodo no estaba conectado", "err"); }
    }
    let anyRetry = false;
    for (const m of S.msgs.slice()) if (m.mine && m.st === "retry") { anyRetry = true; if (now >= m.retryAt) resendNow(m, false); }
    if (anyRetry || schedOpen().length) { const bx = $("#schedbadge"); if (bx) bx.textContent = schedBadgeText(); if (anyRetry) renderMsgList(false); }
  } finally { tickBusy = false; }
}
setInterval(msgTick, 1000);
const schedBadgeText = () => { const n = schedOpen().length; return n ? "Programados (" + n + ")" : "Programar mensaje"; };
function openSchedDialog() {
  let conv = S.conv, mode = "chat"; const pad = (n) => String(n).padStart(2, "0");
  const loc = (t) => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const tx = el("input", { class: "inp", maxlength: 200, autocomplete: "off", placeholder: "Texto del mensaje (hasta 200 caracteres)" });
  const when = el("input", { class: "inp", type: "datetime-local", value: loc(Date.now() + 10 * 60000), min: loc(Date.now()) });
  const listBox = el("div", { class: "schedlist" });
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() });
  /* destinatario: chat abierto, un nodo (con buscador) o un grupo de reenvío */
  const destBox = el("div", { class: "destbox" }), curChat = S.conv;
  const drawDest = () => {
    const seg = el("div", { class: "seg" }, ...[["chat", "Chat abierto"], ["node", "Buscar un nodo"], ["group", "Grupo de reenvío"]].map(([k, l]) => el("button", { class: mode === k ? "on" : "", onclick: () => { mode = k; if (k === "chat") conv = curChat; else if (k === "group") conv = activeChans().length ? "ch" + activeChans()[0] : "all"; else if (!conv.startsWith("dm")) conv = ""; drawDest(); } }, l)));
    const sel = el("div", { class: "destsel" }, el("small", { class: "muted" }, "Se enviará a: "), el("b", {}, conv ? convTitle(conv) : "— elegí un nodo —"));
    let body = null;
    if (mode === "node") {
      const q = el("input", { class: "inp", placeholder: "Buscar por nombre, sigla o ID (!a1b2c3d4)", autocomplete: "off" }), res = el("div", { class: "destres" });
      const fill = () => {
        const t = q.value.trim().toLowerCase().replace(/^!/, "");
        const l = [...S.nodes.values()].filter((n) => n.num !== S.me && (!t || (n.user && ((n.user.longName || "").toLowerCase().includes(t) || (n.user.shortName || "").toLowerCase().includes(t))) || hex8(n.num).includes(t))).sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0)).slice(0, 8);
        res.replaceChildren(...(l.length ? l.map((n) => el("button", { class: "destit" + (conv === "dm" + n.num ? " on" : ""), onclick: () => { conv = "dm" + n.num; sel.lastChild.textContent = nodeName(n); fill(); } }, el("b", {}, nodeName(n)), el("small", {}, nodeShort(n) + " · !" + hex8(n.num)))) : [el("div", { class: "muted pad" }, S.nodes.size > 1 ? "Ningún nodo coincide con la búsqueda" : "Todavía no hay otros nodos en la lista")]));
      };
      q.addEventListener("input", fill); fill(); body = el("div", {}, q, res);
    } else if (mode === "group") {
      const chans = activeChans();
      const op = (v, t) => el("option", { value: v, selected: conv === v }, t);
      const g = el("select", { class: "inp", "aria-label": "Destino del mensaje programado", onchange: () => { conv = g.value; sel.lastChild.textContent = convTitle(conv); } }, ...chans.map((i) => op("ch" + i, "# " + chName(i))), chans.length > 1 ? op("all", "Todos los grupos (" + chans.length + ")") : null);
      body = chans.length ? el("div", {}, g, el("small", { class: "muted" }, "El mismo mensaje sale por el grupo elegido; con “Todos los grupos” sale por cada canal cargado.")) : el("div", { class: "muted pad" }, "Todavía no hay grupos cargados: conectá el nodo");
    }
    destBox.replaceChildren(seg, sel, ...(body ? [body] : []));
  };
  drawDest();
  const drawList = () => {
    const items = S.sched.filter((x) => x.st !== "cancel").sort((a, b) => a.at - b.at).slice(-30);
    listBox.replaceChildren(...(items.length ? items.map((x) => el("div", { class: "sitem " + x.st },
      el("div", { class: "sit" }, el("b", {}, new Date(x.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })), el("small", {}, " · " + convTitle(x.conv) + " · " + ({ wait: "esperando la hora", late: "vencido (nodo sin conexión)", sent: "enviado " + hhmm(x.sentAt || x.at) })[x.st]), el("div", { class: "tx" }, x.text)),
      x.st === "late" ? el("button", { class: "mini", onclick: () => { schedFire(x); drawList(); } }, "Enviar ahora") : null,
      el("button", { class: "mini danger", onclick: () => { S.sched = S.sched.filter((y) => y !== x); saveSched(); drawList(); } }, x.st === "sent" ? "Quitar" : "Cancelar"))) : [el("div", { class: "muted pad" }, "No hay mensajes programados")]));
  };
  dlg.append(el("div", { class: "mbox" }, el("h3", {}, "Programar mensaje"), el("small", { class: "muted" }, "Se envía por LoRa a la hora elegida. El portal tiene que estar abierto y conectado al nodo en ese momento; si el nodo no está conectado, espera hasta 15 minutos."),
    row("Destinatario", "A quién se le envía", destBox), row("Mensaje", "", tx), row("Fecha y hora", "Hora de esta PC", when),
    el("div", { class: "mfoot" }, el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cerrar"),
      el("button", { class: "btn", onclick: () => {
        const t = tx.value.trim(), at = new Date(when.value).getTime();
        if (!conv) return toast("Elegí el nodo destinatario", "err");
        if (!t) return toast("Escribí el mensaje", "err");
        if (new TextEncoder().encode(t).length > 200) return toast("El mensaje supera los 200 bytes", "err");
        if (!at || at < Date.now() + 5000) return toast("Elegí una hora futura", "err");
        schedAdd(t, at, conv); tx.value = ""; toast("Mensaje programado para las " + hhmm(at) + " del " + new Date(at).toLocaleDateString("es-AR"), "ok"); drawList();
      } }, "Programar")),
    el("div", { class: "blkh" }, "Programados"), listBox));
  drawList(); document.body.append(dlg);
}
/* ── botón de pánico: un mismo mensaje de alerta a todos los canales ── */
const EM_KEY = "meshportal:emerg";
const EM_DEF = { msg: "EMERGENCIA: necesito ayuda urgente", phone: "", country: "", freqOn: false, band: "VHF", freq: "", coords: true };
const emCfg = () => { try { return { ...EM_DEF, ...JSON.parse(localStorage.getItem(EM_KEY) || "{}") }; } catch (e) { return { ...EM_DEF }; } };
const emSave = (o) => { try { localStorage.setItem(EM_KEY, JSON.stringify({ ...emCfg(), ...o })); } catch (e) {} };
const EM_COUNTRIES = ["Argentina", "Bolivia", "Brasil", "Chile", "Colombia", "Ecuador", "Paraguay", "Perú", "Uruguay", "Venezuela", "México", "España", "Estados Unidos"];
const byteLen = (t) => new TextEncoder().encode(t).length;
/* arma el texto final; devuelve { text, err } */
function emBuild(o, pos) {
  const parts = [(o.msg || "").trim()];
  if ((o.phone || "").trim()) { if (!/^[0-9+()\s.-]{5,25}$/.test(o.phone.trim())) return { text: "", err: "El teléfono solo puede llevar números, +, espacios, guiones y paréntesis" }; parts.push("Tel: " + o.phone.trim()); }
  if ((o.country || "").trim()) parts.push("País: " + o.country.trim());
  if (o.freqOn) {
    const f = parseFloat(String(o.freq).replace(",", "."));
    if (!f) return { text: "", err: "Escribí la frecuencia en MHz (por ejemplo 146.520)" };
    if (o.band === "VHF" && !(f >= 30 && f <= 300)) return { text: "", err: "Una frecuencia VHF va entre 30 y 300 MHz" };
    if (o.band === "UHF" && !(f > 300 && f <= 3000)) return { text: "", err: "Una frecuencia UHF va entre 300 y 3000 MHz" };
    parts.push(o.band + " " + f.toString().replace(/(\.\d{3})\d+$/, "$1") + " MHz");
  }
  if (o.coords && pos) parts.push("Pos: " + pos.lat.toFixed(5) + "," + pos.lon.toFixed(5));
  return { text: parts.filter(Boolean).join(" | "), err: "" };
}
function emFields(o, onChange) { /* controles compartidos por el cuadro de alerta y por la pantalla de parámetros */
  const f = {
    msg: el("textarea", { class: "inp panictx", rows: 3, maxlength: 200, placeholder: "Mensaje de alerta" }, o.msg),
    phone: el("input", { class: "inp", value: o.phone, placeholder: "Opcional: +54 9 11 1234-5678", autocomplete: "off", inputmode: "tel" }),
    country: el("input", { class: "inp", value: o.country, placeholder: "Opcional: país de la emergencia", autocomplete: "off", list: "emcountries" }),
    freqOn: el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!o.freqOn }), el("span", {})),
    band: el("select", { class: "inp", style: "width:90px", "aria-label": "Banda de la frecuencia" }, ...["VHF", "UHF"].map((b) => el("option", { value: b, selected: o.band === b }, b))),
    freq: el("input", { class: "inp", value: o.freq, placeholder: "146.520", inputmode: "decimal", style: "width:110px", autocomplete: "off" }),
    coords: el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!o.coords }), el("span", {})),
  };
  const dl = el("datalist", { id: "emcountries" }, ...EM_COUNTRIES.map((c) => el("option", { value: c })));
  const read = () => ({ msg: f.msg.value, phone: f.phone.value, country: f.country.value, freqOn: f.freqOn.querySelector("input").checked, band: f.band.value, freq: f.freq.value, coords: f.coords.querySelector("input").checked });
  const sync0 = () => { const on = f.freqOn.querySelector("input").checked; f.band.disabled = !on; f.freq.disabled = !on; };
  const sync = () => { sync0(); onChange && onChange(); };
  Object.values(f).forEach((n) => { n.addEventListener("input", sync); n.addEventListener("change", sync); });
  const freqRow = row("Frecuencia de radio", "Opcional: VHF o UHF y la frecuencia en MHz, para que te respondan por radio", el("div", { class: "inlrow" }, f.freqOn, f.band, f.freq, el("span", { class: "unit" }, "MHz")));
  const rows = [row("Mensaje", "Hasta 200 bytes en total con los datos que agregues", f.msg), row("Teléfono", "Opcional", f.phone), row("País de emergencia", "Opcional", f.country), freqRow, row("Enviar mi coordenada", "Agrega la posición del nodo si la tiene", f.coords), dl];
  sync0();
  return { f, read, rows, sync };
}
function openPanic() {
  const chans = activeChans(), pos = mePos();
  const cnt = el("div", { class: "emprev" });
  const fl = emFields(emCfg(), () => upd());
  const cur = () => emBuild(fl.read(), pos);
  function upd() { const r = cur(), n = byteLen(r.text); cnt.replaceChildren(el("small", { class: "muted" }, "Se enviará así:"), el("div", { class: "tx" }, r.text || "—"), el("small", { style: n > 200 || r.err ? "color:var(--err)" : "color:var(--mut)" }, r.err || (n + "/200 bytes" + (n > 200 ? " — demasiado largo, acortalo" : "")))); }
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() });
  const send = el("button", { class: "btn panicgo", onclick: async () => {
    const r = cur(), n = byteLen(r.text);
    if (r.err) return toast(r.err, "err");
    if (!r.text) return toast("Escribí el mensaje de alerta", "err");
    if (n > 200) return toast("El mensaje supera los 200 bytes", "err");
    if (!chans.length) return toast("No hay canales cargados todavía: conectá el nodo", "err");
    send.disabled = true; send.textContent = "Enviando…";
    logEvent("panicout", S.me, r.text);
    for (const ch of chans) { dispatch({ text: r.text, dest: "broadcast", ch, tries: 0 }); await new Promise((x) => setTimeout(x, 700)); }
    dlg.remove(); toast("ALERTA enviada a " + chans.length + (chans.length === 1 ? " canal" : " canales"), "ok");
    S.conv = "ch" + chans[0]; setView("messages");
  } }, "ENVIAR ALERTA A TODOS LOS CANALES");
  dlg.append(el("div", { class: "mbox panicbox" }, el("h3", { class: "panich" }, "🚨 EMERGENCIAS"),
    el("small", { class: "muted" }, "El mismo mensaje se envía por LoRa a todos los canales activos (" + (chans.length ? chans.map((i) => "# " + chName(i)).join(", ") : "ninguno cargado") + "). Los mensajes directos no se usan para esta alerta."),
    !connected() ? el("div", { class: "warn" }, "El nodo no está conectado: el envío va a fallar y se reintenta; después aparece “Reenviar mensaje”.") : null,
    !pos ? el("small", { class: "muted" }, "El nodo todavía no informó su posición: no se puede enviar la coordenada.") : null,
    ...fl.rows, cnt,
    el("div", { class: "mfoot" }, el("button", { class: "btn ghost", onclick: () => { dlg.remove(); setView("emerg"); } }, "Parámetros…"), el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cancelar"), send)));
  upd(); document.body.append(dlg); fl.f.msg.focus();
}
/* herramienta: parámetros de emergencia (valores con los que se abre el cuadro de alerta) */
function viewEmerg(m) {
  const pos = mePos(); const prev = el("div", { class: "emprev" });
  const fl = emFields(emCfg(), () => upd());
  function upd() { const r = emBuild(fl.read(), pos || { lat: -40.1572, lon: -71.3533 }); prev.replaceChildren(el("div", { class: "tx" }, r.text || "—"), el("small", { style: r.err ? "color:var(--err)" : "color:var(--mut)" }, r.err || (byteLen(r.text) + "/200 bytes" + (pos ? "" : " (con una coordenada de ejemplo)")))); }
  m.append(el("div", { class: "setbody" },
    el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Parámetros de emergencia"), el("small", { class: "muted" }, "Lo que se carga de entrada en el cuadro del botón rojo EMERGENCIAS. Todo es opcional salvo el mensaje; al enviar una alerta todavía se puede cambiar."))),
    el("div", { class: "card" }, ...fl.rows,
      el("b", {}, "Vista previa"), prev,
      el("div", { class: "rowbtn chips" },
        el("button", { class: "btn", onclick: () => { const r = emBuild(fl.read(), pos || { lat: 0, lon: 0 }); if (r.err) return toast(r.err, "err"); if (!fl.read().msg.trim()) return toast("Escribí el mensaje de alerta", "err"); emSave(fl.read()); toast("Parámetros de emergencia guardados", "ok"); } }, "Guardar"),
        el("button", { class: "btn ghost", onclick: () => { emSave(EM_DEF); renderMain(); toast("Se restauraron los valores de fábrica"); } }, "Restaurar"),
        el("button", { class: "btn panicgo", onclick: openPanic }, "Abrir el cuadro de alerta")))));
  upd();
}
/* ── sonidos y notificaciones: un tono configurable para cada tipo de aviso ── */
const SND_KEY = "meshportal:sound", SND_FILES = "meshportal:sndfiles";
const TONES = { /* secuencia [frecuencia Hz, inicio s, duración s]; type = forma de onda; g = volumen base */
  alerta: { name: "Alerta (4 notas agudas)", type: "square", g: .3, seq: [[1175, 0, .12], [1568, .15, .12], [1175, .34, .12], [1568, .49, .22]] },
  suave: { name: "Suave (2 notas graves)", type: "sine", g: .55, seq: [[523, 0, .2], [392, .22, .26]] },
  campana: { name: "Campana", type: "sine", g: .5, seq: [[880, 0, .5], [1318, .18, .7]] },
  radio: { name: "Beep de radio", type: "square", g: .22, seq: [[1000, 0, .09], [1400, .12, .09]] },
  gota: { name: "Gota (1 nota corta)", type: "sine", g: .6, seq: [[1046, 0, .16]] },
  ascendente: { name: "Ascendente", type: "triangle", g: .5, seq: [[523, 0, .13], [659, .14, .13], [784, .28, .22]] },
  descendente: { name: "Descendente", type: "triangle", g: .5, seq: [[784, 0, .13], [659, .14, .13], [523, .28, .26]] },
  sirena: { name: "Sirena", type: "sawtooth", g: .2, seq: [[700, 0, .22], [950, .24, .22], [700, .48, .22], [950, .72, .22], [700, .96, .22], [950, 1.2, .26]] },
  urgente: { name: "Urgente (6 pitidos)", type: "square", g: .22, seq: [0, .14, .28, .42, .56, .7].map((t) => [1760, t, .08]) },
};
const SND_EV = [
  ["dm", "Mensaje directo", "Te escribe un nodo a vos"],
  ["ch", "Mensaje de un canal", "Llega un mensaje a un grupo"],
  ["fav", "Mensaje de un nodo favorito", "Si es de un favorito suena este tono en lugar de los anteriores"],
  ["ok", "Mensaje entregado", "El nodo confirma que salió por radio"],
  ["fail", "Mensaje no entregado", "Se agotaron los reintentos"],
  ["link", "Conexión con el nodo", "Se conecta o se pierde la conexión"],
  ["panic", "ALERTA de pánico recibida", "Un nodo manda una emergencia (suena aunque esté el silencio nocturno)"],
];
const SND_DEF = { on: true, vol: 0.6, quiet: { on: false, from: "22:00", to: "07:00" }, mutedCh: [],
  ev: { dm: { on: true, tone: "alerta" }, ch: { on: true, tone: "suave" }, fav: { on: false, tone: "campana" }, ok: { on: false, tone: "gota" }, fail: { on: true, tone: "descendente" }, link: { on: true, tone: "radio" }, panic: { on: true, tone: "urgente" } } };
const sndCfg = () => {
  let u = {}; try { u = JSON.parse(localStorage.getItem(SND_KEY) || "{}"); } catch (e) {}
  const ev = {}; for (const [k] of SND_EV) ev[k] = { ...SND_DEF.ev[k], ...((u.ev || {})[k] || {}) };
  return { ...SND_DEF, ...u, quiet: { ...SND_DEF.quiet, ...(u.quiet || {}) }, mutedCh: u.mutedCh || [], ev };
};
const sndSave = (o) => { try { localStorage.setItem(SND_KEY, JSON.stringify({ ...sndCfg(), ...o })); } catch (e) {} };
const sndEvSave = (k, o) => { const c = sndCfg(); sndSave({ ev: { ...c.ev, [k]: { ...c.ev[k], ...o } } }); };
let sndFiles = {}; try { sndFiles = JSON.parse(localStorage.getItem(SND_FILES) || "{}"); } catch (e) {}
const sndFilesSave = () => { try { localStorage.setItem(SND_FILES, JSON.stringify(sndFiles)); return true; } catch (e) { return false; } };
const sndBuf = new Map();
let actx = null;
function audioCtx() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); return actx; } catch (e) { return null; } }
document.addEventListener("click", () => audioCtx(), { once: true });
const inQuiet = (q) => { if (!q.on) return false; const m = (t) => { const [h, mi] = String(t).split(":").map(Number); return h * 60 + (mi || 0); }, d = new Date(), now = d.getHours() * 60 + d.getMinutes(), a = m(q.from), b = m(q.to); return a === b ? false : a < b ? now >= a && now < b : now >= a || now < b; };
function playSynth(tone, vol) {
  const a = audioCtx(), t = TONES[tone]; if (!a || !t) return;
  t.seq.forEach(([f, st, d]) => {
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime + st;
    o.type = t.type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol * t.g), t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + d + 0.03);
  });
}
async function playFile(key, vol) {
  const a = audioCtx(), f = sndFiles[key]; if (!a || !f) return false;
  try {
    let buf = sndBuf.get(key);
    if (!buf) { const ab = await (await fetch(f.data)).arrayBuffer(); buf = await a.decodeAudioData(ab); sndBuf.set(key, buf); }
    const src = a.createBufferSource(), g = a.createGain(); src.buffer = buf; g.gain.value = Math.min(1, vol * 1.3); src.connect(g); g.connect(a.destination); src.start();
    return true;
  } catch (e) { return false; }
}
/* reproduce el tono de un tipo de aviso; force = botón “Probar” (ignora silencios) */
function playEvent(kind, force, ch) {
  const c = sndCfg(), e = c.ev[kind]; if (!e) return;
  if (IS_APP && window.__appHidden && !force && notifCfg().on) return; /* con la app en segundo plano suena el aviso del celular */
  if (IS_APP && window.__appHidden && kind === "panic") return;
  if (!force) { if (!c.on || !e.on || inQuiet(c.quiet)) return; if (kind === "ch" && ch !== undefined && c.mutedCh.includes(ch)) return; }
  if (e.tone === "custom") { playFile(kind, c.vol).then((ok) => { if (!ok) playSynth(SND_DEF.ev[kind].tone, c.vol); }); return; }
  playSynth(e.tone, c.vol);
}
function notifyIncoming(msg) { /* mensaje recibido: favorito > directo > canal */
  const n = S.nodes.get(msg.from), c = sndCfg();
  if (n && isFav(n) && c.ev.fav.on && !(msg.dm === false && c.mutedCh.includes(msg.ch))) return playEvent("fav", false);
  playEvent(msg.dm ? "dm" : "ch", false, msg.ch);
}
const chBase = (i) => {
  const c = S.channels[i];
  return (c && c.settings && c.settings.name) || (i === 0 ? (S.cfg.lora && S.cfg.lora.usePreset !== false && PRESET_NAME[S.cfg.lora.modemPreset]) || "Primario" : "Canal " + i);
};
const chName = (i) => {
  const b = chBase(i);
  return S.channels.some((c, j) => j !== i && c && c.role !== 0 && chBase(j) === b) ? b + " (" + i + ")" : b;
};
const activeChans = () => S.channels.map((c, i) => (c && c.role !== 0 ? i : -1)).filter((i) => i >= 0);
let chCache = []; try { chCache = JSON.parse(localStorage.getItem("meshportal:chcache") || "[]"); } catch (e) {}
function saveChCache() {
  const l = activeChans().map((i) => ({ i, name: chName(i), primary: S.channels[i].role === 1 }));
  if (!l.length) return; chCache = l;
  try { localStorage.setItem("meshportal:chcache", JSON.stringify(l)); } catch (e) {}
}
const convTitle = (k) => (k === "all" ? "Todos los grupos" : k.startsWith("ch") ? "# " + chName(+k.slice(2)) : nameOf(+k.slice(2)));

/* ───────────────────────── refresco ───────────────────────── */
const pending = new Set(); let raf = 0, teleDeb = 0;
function scheduleRefresh(kind) {
  pending.add(kind);
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const k = new Set(pending); pending.clear();
    const all = k.has("all");
    if (all) { renderSide(); renderRight(); renderMain(); renderTopbar(); updRoute(); alertBar(); return; }
    if ((k.has("nodes") || k.has("tele")) && S.view === "topo") topoSoon();
    if ((k.has("nodes") || k.has("tele")) && nsNum != null) nsRedraw();
    if (k.has("alerts") || k.has("events")) { alertBar(); if (S.view === "guardia" && typeof updGuardia === "function") updGuardia(); }
    if (k.has("net")) { renderTopbar(); updRoute(); if (S.view === "settings" && S.sub === "portal.net") updNetView(); }
    if (k.has("nodes") || k.has("config") || k.has("side")) renderSide();
    if (k.has("nodes") || k.has("msgs")) renderRight();
    if (k.has("nodes")) { if (S.view === "nodes") renderNodesTable(); if (S.view === "map") drawMap(); persistSoon(); }
    if ((k.has("msgs") || k.has("config")) && S.view === "messages") renderTabs();
    if (k.has("msgs") && S.view === "messages") renderMsgList();
    if (k.has("config") && isCfgView() && !(S.form && S.form.isDirty())) renderMain();
    if (k.has("logs") && S.view === "console") renderLog();
    if (k.has("tele") && !teleDeb) teleDeb = setTimeout(() => { teleDeb = 0; if (S.view === "tele") renderTeleBody(); if (S.view === "map") drawMap(); }, 1500);
  });
}


/* ───────────────────────── modo operativo: semáforo de nodos, alertas y registro de eventos ───────────────────────── */
const OPS_KEY = "meshportal:ops", EV_KEY = "meshportal:events", AL_KEY = "meshportal:alerts";
const OPS_DEF = { downMin: 120, lowBat: 20, weakSnr: -10, banner: true, keepDays: 7, maxNodes: 1500 };
let opsMem = null;
const opsCfg = () => { if (opsMem) return opsMem; let u = {}; try { u = JSON.parse(localStorage.getItem(OPS_KEY) || "{}"); } catch (e) {} return (opsMem = { ...OPS_DEF, ...u }); };
const opsSave = (o) => { const v = { ...opsCfg(), ...o }; opsMem = v; try { localStorage.setItem(OPS_KEY, JSON.stringify(v)); } catch (e) {} scheduleRefresh("all"); };
S.events = []; try { S.events = JSON.parse(localStorage.getItem(EV_KEY) || "[]"); } catch (e) {}
S.alerts = new Map(); try { for (const [k, v] of JSON.parse(localStorage.getItem(AL_KEY) || "[]")) S.alerts.set(k, v); } catch (e) {}
let evSaveT = 0;
const evPersist = () => { clearTimeout(evSaveT); evSaveT = setTimeout(() => { try { localStorage.setItem(EV_KEY, JSON.stringify(S.events.slice(-2000))); localStorage.setItem(AL_KEY, JSON.stringify([...S.alerts])); } catch (e) {} }, 800); };
const EV_KINDS = { panic: ["🚨", "Alerta de pánico recibida", true], panicout: ["🚨", "Alerta de pánico enviada", true], ack: ["✔", "Alerta atendida", false], down: ["🔴", "Nodo caído (sin señal)", true], up: ["🟢", "Nodo recuperado", false], lowbatt: ["🟡", "Batería baja", true], weak: ["🟡", "Señal débil", false], link: ["🔌", "Nodo local", false] };
function logEvent(kind, num, text, t) {
  const n = num != null ? S.nodes.get(num) : null;
  S.events.push({ t: t || Date.now(), kind, num: num ?? null, name: n ? nodeName(n) : num != null ? "Nodo " + hex8(num).slice(-4) : "", text: text || "" });
  if (S.events.length > 2500) S.events.splice(0, S.events.length - 2000);
  evPersist(); scheduleRefresh("events");
}
const isAlertText = (t) => /^\s*(🚨|⚠|SOS\b|EMERGENCIA|P[ÁA]NICO|ALERTA)|\u0007/i.test(String(t || ""));
const ST_COL = { ok: "#22c55e", warn: "#facc15", down: "#ef4444", panic: "#ef4444", unk: "#94a3b8" };
const ST_LBL = { ok: "Activo", warn: "Atención", down: "Caído", panic: "ALERTA", unk: "Sin datos" };
function nodeStatus(n) {
  const c = opsCfg(), now = Date.now() / 1000, why = [], al = S.alerts.get(n.num);
  if (al && !al.ack && Date.now() - al.t < 86400000) return { k: "panic", why: ["Alerta de pánico: " + al.text], blink: true };
  const isMe = n.num === S.me;
  if (!isMe && n.lastHeard && now - n.lastHeard > c.downMin * 60) return { k: "down", why: ["Sin señal hace " + ago(n.lastHeard)], blink: true };
  if (!isMe && !n.lastHeard) return { k: "unk", why: ["Todavía no se escuchó"] };
  if (n.battery != null && n.battery <= c.lowBat) why.push("Batería baja: " + Math.round(n.battery) + " %");
  if (!isMe && n.snr != null && n.snr <= c.weakSnr) why.push("Señal débil: SNR " + n.snr.toFixed(1) + " dB");
  return why.length ? { k: "warn", why } : { k: "ok", why: [] };
}
const statusColor = (n) => ST_COL[nodeStatus(n).k];
const stDot = (n) => { const st = nodeStatus(n); return el("i", { class: "stdot st" + st.k + (st.blink ? " blink" : ""), title: ST_LBL[st.k] + (st.why.length ? ": " + st.why.join(" · ") : "") }); };
function ackAlert(num) { const a = S.alerts.get(num); if (!a) return; a.ack = true; a.ackT = Date.now(); logEvent("ack", num, "Alerta marcada como atendida"); evPersist(); scheduleRefresh("all"); if (S.view === "map") drawMap(); }
function statusTick() { /* detecta cambios de estado de los nodos y los anota en el registro */
  const prev = S.stPrev || (S.stPrev = new Map()), first = !S.stInit, downs = []; S.stInit = true;
  for (const n of S.nodes.values()) {
    if (n.num === S.me && !n.battery) continue;
    const st = nodeStatus(n), key = st.k + (st.k === "warn" ? ":" + st.why.map((w) => w.slice(0, 6)).join() : ""), old = prev.get(n.num);
    prev.set(n.num, key);
    if (first || old === key || old === undefined) continue;
    const ok = st.k === "ok" || st.k === "warn";
    if (st.k === "down") { logEvent("down", n.num, st.why[0]); downs.push(nodeName(n)); }
    else if (old && old.startsWith("down") && ok) logEvent("up", n.num, "Volvió a escucharse");
    if (st.k === "warn" && !(old || "").startsWith("warn")) for (const w of st.why) logEvent(w.startsWith("Batería") ? "lowbatt" : "weak", n.num, w);
  }
  if (downs.length === 1) toast("🔴 Nodo caído: " + downs[0], "err");
  else if (downs.length > 1) toast("🔴 " + downs.length + " nodos caídos: " + downs.slice(0, 3).join(", ") + (downs.length > 3 ? "…" : ""), "err");
  scheduleRefresh("events");
}
setInterval(() => { if (!document.hidden) statusTick(); }, 15000); setTimeout(statusTick, 3000);
function alertBar() {
  const bar = $("#alertbar"); if (!bar) return;
  const list = opsCfg().banner ? [...S.alerts].filter(([, a]) => !a.ack && Date.now() - a.t < 86400000) : [];
  bar.style.display = list.length ? "" : "none";
  bar.replaceChildren(...list.map(([num, a]) => { const n = S.nodes.get(num) || { num };
    return el("div", { class: "alertrow" }, el("b", {}, "🚨 ALERTA · " + nodeName(n)), el("span", { class: "altx" }, hhmm(a.t) + " · " + a.text),
      n.pos ? el("button", { class: "mini", onclick: () => { S.map.sel = num; S.map.fitted = true; const o = origin(), p = proj(n.pos.lat, n.pos.lon, o); S.map.cx = p.x; S.map.cy = p.y; S.map.mpp = Math.min(S.map.mpp, 60); setView("map"); } }, "Ver en el mapa") : null,
      el("button", { class: "mini", onclick: () => { S.conv = a.conv || S.conv; setView("messages"); } }, "Ver mensaje"),
      el("button", { class: "mini ack", onclick: () => ackAlert(num) }, "Marcar atendida")); }));
}
setInterval(() => { if (S.view === "map" && S.map.blink && !document.hidden) drawMap(); }, 600);
window.__ops = { nodeStatus, statusTick, logEvent, ackAlert, opsCfg };
window.__net = { diagNode, scanNetwork, probeAlive, probeApi, rawFetch, hostsOf, testNet };

/* ───────────────────────── barra lateral ───────────────────────── */
const NAV = [["messages", "Mensajes", "M4 5h16v11H8l-4 4z"], ["map", "Mapa", "M9 4l6 2 5-2v14l-5 2-6-2-5 2V6z M9 4v14 M15 6v14"], ["topo", "Topología", "M6 6h.01 M18 6h.01 M12 18h.01 M6 6h12 M6 6l6 12 M18 6l-6 12"], ["settings", "Ajustes", "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2"], ["nodes", "Nodos", "M9 11a3 3 0 100-6 3 3 0 000 6z M3 20c0-3 3-5 6-5s6 2 6 5 M17 11a2.5 2.5 0 100-5 M17 15c2.5 0 4 1.5 4 4"]];
const CFGNAV = [["radio", "Configuración de radio", "M12 11a1.5 1.5 0 100 3 1.5 1.5 0 000-3z M8.5 8a5 5 0 000 8 M15.5 8a5 5 0 010 8 M5.5 5a9 9 0 000 14 M18.5 5a9 9 0 010 14"], ["device", "Configuración del dispositivo", "M12 3v10 M8 7l4-4 4 4 M6 13h12v3a3 3 0 01-3 3H9a3 3 0 01-3-3z"], ["module", "Configuración del módulo", "M12 3l9 5-9 5-9-5z M3 12.5l9 5 9-5 M3 17l9 5 9-5"]];
const TOOLNAV = [["tele", "Telemetría", "M3 12h4l3-8 4 16 3-8h4"], ["console", "Módulo de consola", "M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5"], ["emerg", "Parámetros de emergencia", "M12 3l9 16H3z M12 10v4 M12 17h.01"], ["guardia", "Novedades y guardia", "M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4"]];
const IC = { batt: "M3 8h16v8H3z M21 11v2", bolt: "M13 2L4 14h7l-1 8 9-12h-7z", chip: "M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4", pulse: "M3 12h4l3-8 4 16 3-8h4", sun: "M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2", moon: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z", usb: "M12 3v12 M8 7l4-4 4 4 M9 15a3 3 0 106 0" };
const icon = (d) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ic"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };

const DEFSUB = { radio: "radio.lora", device: "dev.user", module: "mod.mqtt", settings: "portal.net" };
const isCfgView = () => ["settings", "radio", "device", "module"].includes(S.view);
function setView(v, sub) {
  if (S.form && S.form.isDirty() && !confirm("Tenés cambios sin guardar. ¿Descartarlos?")) return;
  document.body.classList.remove("drawer");
  S.view = v; if (sub) S.sub = sub; else if (DEFSUB[v] && !GROUPS[v].items.some((i) => i[0] === S.sub)) S.sub = DEFSUB[v];
  S.form = null;
  if (v === "messages") { S.unread[S.conv] = 0; clearNotif(S.conv); }
  closeMsgMenu();
  scheduleRefresh("all");
}
function renderBottom() { /* barra inferior para celulares: secciones principales siempre a mano */
  let bn = $("#bottomnav"); if (!bn) { bn = el("nav", { id: "bottomnav" }); document.body.append(bn); }
  const unread = Object.values(S.unread).reduce((a, b) => a + b, 0);
  const items = ["messages", "map", "topo", "nodes"].map((id) => NAV.find((n) => n[0] === id)).filter(Boolean);
  bn.replaceChildren(...items.map(([id, label, d]) => el("button", { class: S.view === id ? "on" : "", onclick: () => setView(id) }, icon(d), el("span", {}, label), id === "messages" && unread ? el("i", { class: "bdg" }, unread > 99 ? "99+" : String(unread)) : null)),
    el("button", { class: document.body.classList.contains("drawer") ? "on" : "", onclick: () => toggleDrawer() }, icon("M4 6h16 M4 12h16 M4 18h16"), el("span", {}, "Más")));
}
function navBtn(id, label, d, extra, badge) {
  return el("button", { class: "nav" + (S.view === id ? " on" : ""), onclick: () => setView(id) }, icon(d), el("span", {}, label + (extra || "")), badge ? el("em", { class: "bd" }, badge) : null);
}
/* bloques plegables de la barra lateral: el estado queda guardado en este navegador */
const BLK_KEY = "meshportal:bloques";
let blkState = {}; try { blkState = JSON.parse(localStorage.getItem(BLK_KEY) || "{}"); } catch (e) {}
const blkSave = () => { try { localStorage.setItem(BLK_KEY, JSON.stringify(blkState)); } catch (e) {} };
function blk(key, title, cls, ...body) {
  const open = blkState[key] !== false;
  return el("div", { class: "blk" + (cls ? " " + cls : "") + (open ? "" : " closed") },
    el("button", { class: "blkh tog", title: open ? "Contraer" : "Desplegar", "aria-expanded": open ? "true" : "false",
      onclick: () => { blkState[key] = !open; blkSave(); renderSide(); } }, el("span", {}, title), el("i", { class: "chev" }, open ? "▾" : "▸")),
    ...(open ? body.flat(Infinity).filter(Boolean) : []));
}
function renderSide() {
  const side = $("#side"); side.replaceChildren();
  if (!side.dataset.dw) { side.dataset.dw = 1; side.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b && !b.closest(".seg") && !b.classList.contains("blkh")) setTimeout(() => toggleDrawer(false), 0); }); } /* en el celular, tocar una opción cierra el menú */
  side.append(el("div", { class: "brand" }, el("div", { class: "logo" }), el("div", {}, el("b", {}, "OPEN SOURCE PARIZ"), el("small", {}, "Sistema LoRa Mesh"))));
  const mid = el("div", { class: "sidemid" }); side.append(mid);
  mid.append(el("div", { class: "sec" }, "Navegación"));
  for (const [id, label, d] of NAV) mid.append(navBtn(id, label, d, id === "nodes" ? ` (${S.nodes.size})` : "", id === "messages" ? Object.values(S.unread).reduce((a, b) => a + b, 0) : 0));
  mid.append(el("div", { class: "sec" }, "Configuración"));
  for (const [id, label, d] of CFGNAV) mid.append(navBtn(id, label, d));
  const live = activeChans();
  const list = connected() && live.length ? live.map((i) => ({ i, name: chName(i), primary: S.channels[i].role === 1 })) : chCache;
  mid.append(el("div", { class: "sec" }, "Canales" + (list.length ? " (" + list.length + ")" : "")));
  if (!list.length) mid.append(el("div", { class: "muted pad small" }, connected() ? "Descargando los canales del nodo…" : "Los canales aparecen al conectar el nodo."));
  for (const ch of list) {
    const key = "ch" + ch.i, u = S.unread[key], on = S.view === "messages" && S.conv === key;
    const stale = !(connected() && live.length);
    mid.append(el("button", { class: "nav ch" + (on ? " on" : "") + (stale ? " stale" : ""), title: stale ? "Último estado conocido: conectá el nodo" : "Canal " + ch.i + (ch.primary ? " (primario)" : ""), onclick: () => { if (stale) { toast("Conectá el nodo para usar este canal"); return; } S.conv = key; S.unread[key] = 0; setView("messages"); } }, el("span", { class: "hash" }, "#"), el("span", {}, ch.name), el("small", { class: "chn" }, ch.primary ? "1ª" : String(ch.i)), u ? el("em", { class: "bd" }, u) : null));
  }

  side.append(blk("tools", "Herramientas", "tools", TOOLNAV.map(([id, label, d]) => navBtn(id, label, d))));
  // Estado del módulo
  const me = S.nodes.get(S.me);
  const st = { [ST.DeviceDisconnected]: "Desconectado", [ST.DeviceConnecting]: "Conectando…", [ST.DeviceReconnecting]: "Reconectando…", [ST.DeviceConnected]: "Conectado", [ST.DeviceConfiguring]: "Descargando configuración…", [ST.DeviceConfigured]: "Conectado", [ST.DeviceRestarting]: "Reiniciando…" }[S.status] || "—";
  const dot = ready() ? "ok" : connected() ? "wait" : "off";
  side.append(blk("estado", "Estado del módulo", "",
    el("div", { class: "devcard" },
      me ? avatar(me, 38) : el("div", { class: "avatar off" }, "—"),
      el("div", { class: "dc" }, el("b", {}, me ? nodeName(me) : "Sin nodo"), el("small", {}, el("i", { class: "dot " + dot }), S.demo ? "Modo demo" : (S.conn && S.conn.type === "http" ? S.conn.address + " · " : S.conn && S.conn.type === "bluetooth" ? "Bluetooth · " : S.portInfo ? "Serie: " + S.portInfo + " · " : (me ? nodeId(me.num) + " · " : "")) + st))),
    me && ready() ? el("div", { class: "stats" },
      el("div", {}, icon(IC.batt), "Batería ", el("b", {}, battText(me.battery))),
      el("div", {}, icon(IC.bolt), "Tensión: ", el("b", {}, me.voltage ? me.voltage.toFixed(2) + " V" : "—")),
      el("div", {}, icon(IC.pulse), "Canal ocupado: ", el("b", {}, me.chUtil != null ? me.chUtil.toFixed(1) + " %" : "—"))) : null));
  // Versión
  side.append(blk("version", "Versión del software", "",
    el("div", { class: "stats" },
      el("div", {}, icon(IC.chip), "Firmware: ", el("b", {}, (S.meta && S.meta.firmwareVersion) || "—")),
      S.metaObj && S.metaObj.hwModel ? el("div", {}, icon(IC.usb), "Hardware: ", el("b", {}, String(S.metaObj.hwModel))) : null,
      el("div", { title: "Versión de este archivo del portal" }, icon(IC.chip), "Portal: ", el("b", {}, PORTAL_VER + (IS_APP ? " (app)" : "")), el("small", { class: "muted" }, " · " + PORTAL_BUILD))))); 
  // Tema
  const curTh = document.documentElement.dataset.theme || "dark";
  side.append(blk("apariencia", "Apariencia", "",
    el("div", { class: "seg" },
      el("button", { class: curTh === "light" ? "on" : "", onclick: () => setTheme("light") }, icon(IC.sun), "Claro"),
      el("button", { class: curTh === "dark" ? "on" : "", onclick: () => setTheme("dark") }, icon(IC.moon), "Oscuro"),
      el("button", { class: curTh === "hc" ? "on" : "", title: "Oscuro con máximo contraste", onclick: () => setTheme("hc") }, "◐ Alto contraste"))));
  side.append(el("button", { class: "panicbtn", onclick: openPanic }, el("b", {}, "🚨 EMERGENCIAS"), el("small", {}, "Botón de pánico: alerta a todos los canales")));
  const btns = el("div", { class: "sidebtns" });
  if (connected()) btns.append(el("button", { class: "btn ghost", onclick: disconnect }, "Desconectar"));
  else btns.append(el("button", { class: "btn", onclick: () => openConnDialog() }, "Conectar nodo…"));
  side.append(btns);
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("meshportal:theme", t); } catch (e) {}
  scheduleRefresh("side");
  if (S.view === "map") drawMap();
}
/* ───────────────────────── panel derecho (nodos) ───────────────────────── */
let rightSearch;
function renderRight() {
  renderBottom();
  const r = $("#right");
  const show = connected() && S.view === "messages";
  r.style.display = show ? "" : "none";
  if (!show) return;
  if (!rightSearch) rightSearch = el("input", { class: "inp", type: "search", placeholder: "Buscar nodos…", oninput: (e) => { S.search = e.target.value; fillRight(); } });
  if (!r.contains(rightSearch)) { r.replaceChildren(el("div", { class: "rs" }, rightSearch), el("div", { id: "rlist" })); }
  fillRight();
}
function filteredNodes() {
  const q = S.search.trim().toLowerCase();
  return [...S.nodes.values()].filter((n) => n.num !== S.me && (!q || (nodeName(n) + nodeShort(n) + nodeId(n.num)).toLowerCase().includes(q))).sort((a, b) => (isFav(b) - isFav(a)) || (b.lastHeard || 0) - (a.lastHeard || 0));
}
function fillRight() {
  const box = $("#rlist"); if (!box) return;
  const frag = document.createDocumentFragment();
  const list = filteredNodes();
  for (const n of list.slice(0, 150)) {
    const key = "dm" + n.num, u = S.unread[key];
    frag.append(el("button", { class: "rnode" + (S.conv === key ? " on" : ""), onclick: () => openDM(n.num) }, avatar(n, 36), el("div", { class: "rn" }, el("b", {}, (isFav(n) ? "★ " : "") + nodeName(n)), el("small", {}, ago(n.lastHeard) + (n.snr != null ? " · SNR " + n.snr.toFixed(1) : ""))), u ? el("em", { class: "bd" }, u) : null));
  }
  if (list.length > 150) frag.append(el("div", { class: "muted pad" }, `+${list.length - 150} más (usá el buscador)`));
  if (!list.length) frag.append(el("div", { class: "muted pad" }, "Sin nodos todavía"));
  box.replaceChildren(frag);
}
function openDM(num) { S.conv = "dm" + num; S.unread[S.conv] = 0; setView("messages"); }

/* ───────────────────────── vistas principales ───────────────────────── */
/* ── accesibilidad ──────────────────────────────────────────────────────────
   Muchos controles del portal son interruptores y cuadros sin etiqueta propia: el texto que
   los explica está al lado, en el título de la fila. Para el ojo alcanza, pero un lector de
   pantalla los anuncia como "casilla, sin etiqueta". Este barrido les pone ese título como
   nombre accesible, y le da acceso por teclado a las zonas que se desplazan. */
function a11ySweep(root) {
  if (!root) return;
  for (const fila of root.querySelectorAll(".row")) {
    const t = fila.querySelector(".rl b"); if (!t) continue;
    const base = (t.textContent || "").trim(); if (!base) continue;
    for (const c of fila.querySelectorAll(".rv input, .rv select, .rv textarea")) {
      if (c.type === "hidden" || c.getAttribute("aria-label") || c.getAttribute("aria-labelledby")) continue;
      const propia = c.closest("label");
      if (propia && propia.textContent.trim()) continue; /* ya la nombra su propia etiqueta */
      const antes = c.previousElementSibling, desp = c.nextElementSibling;
      const matiz = (antes && antes.classList.contains("unit") && antes.textContent.trim())
        || (desp && desp.classList.contains("unit") && desp.textContent.trim()) || "";
      c.setAttribute("aria-label", matiz ? base + " · " + matiz : base);
    }
  }
  /* zonas con barra de desplazamiento: sin esto no se pueden recorrer con el teclado */
  for (const z of root.querySelectorAll(".tblwrap, .tblwrap2, .scanres, .msglist, .logbox")) {
    if (!z.hasAttribute("tabindex")) { z.tabIndex = 0; if (!z.getAttribute("role")) z.setAttribute("role", "region"); }
  }
}
function renderMain() {
  const m = $("#main"); m.replaceChildren(); S.form = isCfgView() ? null : S.form;
  if (!connected() && !(S.view === "settings" && (S.sub === "portal.net" || S.sub === "portal.snd" || S.sub === "portal.ops" || S.sub === "portal.perf" || S.sub === "portal.gps")) && S.view !== "emerg" && S.view !== "guardia" && S.view !== "topo") return m.append(connectScreen());
  if (S.status === ST.DeviceConfiguring || S.status === ST.DeviceConnecting) m.append(el("div", { class: "banner" }, "Descargando la configuración del nodo… puede tardar unos segundos con muchos nodos."));
  ({ messages: viewMessages, nodes: viewNodes, tele: viewTele, map: viewMap, settings: viewSettings, radio: viewSettings, device: viewSettings, module: viewSettings, console: viewConsole, emerg: viewEmerg, guardia: viewGuardia, topo: viewTopo }[S.view] || viewMessages)(m);
  a11ySweep(m);
}

function connectScreen() {
  const serialOK = "serial" in navigator, btOK = !!navigator.bluetooth;
  const ctx = window.isSecureContext;
  const conns = loadConns().sort((x, y) => (y.last || 0) - (x.last || 0));
  const CI = { serial: IC.usb, bluetooth: "M7 7l10 10-5 5V2l5 5L7 17", http: "M2 9a15 15 0 0120 0 M5 13a10 10 0 0114 0 M8.5 16.5a5 5 0 017 0 M12 20h.01" };
  const saved = conns.length ? el("div", { class: "conns" }, el("div", { class: "blkh" }, "Conexiones guardadas"),
    ...conns.map((c) => el("div", { class: "conn" }, icon(CI[c.type] || IC.usb),
      el("div", { class: "cn" }, el("b", {}, c.name || CONN_NAME[c.type]), el("small", {}, CONN_NAME[c.type] + (c.address ? " · " + c.address + (c.tls ? " (HTTPS)" : "") : "") + (c.last ? " · último uso " + new Date(c.last).toLocaleDateString("es-AR") : ""))),
      el("button", { class: "btn", onclick: () => reconnectKnown(false, c) }, "Conectar"),
      el("button", { class: "btn ghost", title: "Quitar de la lista", onclick: () => forgetConn(c.id) }, "Quitar")))) : null;
  return el("div", { class: "connect" },
    el("div", { class: "cc" },
      el("div", { class: "bigico" }, icon("M12 3v10 M8 7l4-4 4 4 M6 13h12v3a3 3 0 01-3 3H9a3 3 0 01-3-3z")),
      el("h1", {}, "Conectá tu módulo LoRa Mesh"),
      el("p", { class: "muted" }, "Elegí cómo se conecta tu nodo: por cable USB, por Bluetooth o por la red (WiFi o cable de red / LAN)."),
      el("div", { class: "actions" },
        el("button", { class: "btn big", onclick: connectUSB, disabled: !serialOK }, "USB (cable)"),
        el("button", { class: "btn big", onclick: () => connectBT(), disabled: !btOK, title: btOK ? "" : "Este navegador no tiene Bluetooth web" }, "Bluetooth"),
        el("button", { class: "btn big", onclick: () => openConnDialog("http") }, "Red (WiFi / LAN)")),
      el("div", { class: "actions" }, conns.length ? el("button", { class: "btn ghost", onclick: () => reconnectKnown(false) }, "Reconectar la última") : null, el("button", { class: "btn ghost", onclick: () => openConnDialog() }, "Agregar conexión…")),
      saved,
      !serialOK ? el("div", { class: "warn" }, "Este navegador no tiene USB (Web Serial). Para USB y Bluetooth abrí el archivo con Google Chrome, Microsoft Edge, Brave u Opera en una PC (Firefox y Safari no lo soportan). La conexión por red funciona en cualquiera.") : null,
      serialOK && !btOK ? el("div", { class: "warn" }, "Bluetooth web no está disponible en este navegador. En Brave activá brave://flags/#brave-web-bluetooth-api y reiniciá; en Chrome o Edge ya viene activo.") : null,
      (serialOK || btOK) && !ctx ? el("div", { class: "warn" }, "La página no está en un contexto seguro. Abrila desde un servidor local: ejecutá “python -m http.server 8000” en la carpeta del archivo y entrá a http://localhost:8000") : null,
      el("ul", { class: "tips" },
        el("li", {}, IS_APP ? "USB: conectá el nodo con un adaptador OTG y un cable de datos (muchos son solo de carga). Android pregunta si abre esta app: tocá Aceptar." : "USB: cerrá cualquier otra app que use el puerto y usá un cable de datos (muchos son solo de carga)."),
        el("li", {}, "Bluetooth: activalo en el nodo y desconectalo de otros equipos; el PIN aparece en la pantalla del nodo."),
        el("li", {}, "Red: el nodo necesita el WiFi (o Ethernet) configurado; usá su dirección IP, y " + (IS_APP ? "el celular" : "la PC") + " tiene que estar en la misma red."),
        el("li", {}, "Todo funciona sin internet: nada se envía a ningún servidor.")),
      el("button", { class: "btn ghost", onclick: startDemo }, "Ver modo demo (sin nodo)")));
}

/* ── Mensajes ── */
function viewMessages(m) {
  const wrap = el("div", { class: "msgview" },
    el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Mensajes: " + convTitle(S.conv)), el("small", { class: "muted" }, S.conv.startsWith("dm") ? "Mensaje directo" : "Canal compartido con todos los nodos que usen esta clave")),
      el("div", { class: "phr" }, el("button", { class: "btn ghost", id: "sndbtn", title: "Sonido de mensajes nuevos", onclick: (e) => { sndSave({ on: !sndCfg().on }); e.target.textContent = sndCfg().on ? "🔔 Sonido: sí" : "🔕 Sonido: no"; if (sndCfg().on) playEvent("ch", true); } }, sndCfg().on ? "🔔 Sonido: sí" : "🔕 Sonido: no"), el("button", { class: "btn ghost", id: "schedbadge", onclick: openSchedDialog }, schedBadgeText()), el("button", { class: "btn ghost", onclick: openPrintDialog }, "Imprimir / PDF"))),
    el("div", { id: "chtabs", class: "chtabs" }),
    el("div", { class: "msgbsq" },
      el("input", { id: "msgbuscar", class: "inp", type: "search", value: S.msgq, "aria-label": "Buscar en todos los mensajes",
        placeholder: "Buscar en todos los mensajes (texto o nombre del nodo)…",
        oninput: (e) => { S.msgq = e.target.value; renderMsgList(true); },
        onkeydown: (e) => { if (e.key === "Escape" && S.msgq) { e.stopPropagation(); cerrarBusqueda(); } } })),
    el("div", { id: "msglist", class: "msglist" }),
    el("div", { id: "route", class: "route" }),
    el("div", { id: "replybar", class: "replybar", style: "display:none" }),
    el("form", { class: "composer", onsubmit: (e) => { e.preventDefault(); const i = $("#msgin"); const t = i.value; i.value = ""; $("#cnt").textContent = "0/200"; sendMsg(t); } },
      el("input", { id: "msgin", class: "inp", maxlength: 200, autocomplete: "off", placeholder: "Escribí tu mensaje…", oninput: (e) => ($("#cnt").textContent = new TextEncoder().encode(e.target.value).length + "/200") }),
      el("span", { id: "cnt", class: "cnt" }, "0/200"),
      el("button", { class: "btn send", type: "submit", disabled: !ready() }, "Enviar")));
  m.append(wrap);
  renderTabs(); renderMsgList(true); updRoute(); drawReplyBar();
}
function renderTabs() {
  const b = $("#chtabs"); if (!b) return;
  const l = activeChans();
  b.replaceChildren(...l.map((i) => { const k = "ch" + i, u = S.unread[k]; return el("button", { class: "ctab" + (S.conv === k ? " on" : ""), onclick: () => { S.conv = k; S.unread[k] = 0; setView("messages"); } }, "# " + chName(i), u ? el("em", { class: "bd" }, u) : null); }));
  b.style.display = l.length ? "" : "none";
}
function msgEl(x) {
  const n = S.nodes.get(x.from) || { num: x.from };
  const left = x.st === "retry" ? Math.max(0, Math.ceil(((x.retryAt || 0) - Date.now()) / 1000)) : 0;
  const stTxt = x.mine ? (x.st === "pending" ? "enviando…" : x.st === "ok" ? (x.dm ? "entregado ✓" : "enviado ✓") : x.st === "retry" ? "no se pudo enviar" + (x.why ? " (" + x.why + ")" : "") + " · reintento " + ((x.job && x.job.tries || 0) + 1) + " de " + MAX_TRIES + " en " + left + " s" : "NO ENTREGADO" + (x.why ? ": " + x.why : "")) : "";
  const more = el("button", { class: "mmore", title: "Responder, reaccionar, copiar…", "aria-label": "Opciones del mensaje", onclick: (e) => { e.stopPropagation(); msgMenu(x, e.currentTarget); } }, "⋯");
  return el("div", { class: "msg" + (x.mine ? " mine" : "") + (isAlertText(x.text) ? " alertmsg" : "") + (S.msgFoco != null && x.id === S.msgFoco ? " hallado" : "") }, x.mine ? null : el("span", { class: "avbtn", title: "Ver detalle del nodo", onclick: () => openNodeSheet(x.from) }, avatar(n, 32)), el("div", { class: "bub" }, more, x.mine ? null : el("b", { class: "who", onclick: () => openNodeSheet(x.from) }, nodeName(n)), x.replyTo ? quoteEl(x) : null, el("div", { class: "tx" }, x.text), reactsEl(x), el("small", {}, hhmm(x.t) + (stTxt ? " · " + stTxt : "") + (x.mine ? upLabel(x) : x.mqtt ? " · vía MQTT" : "")), x.mine && x.st === "fail" ? el("div", { class: "rsnd" }, el("span", {}, "No fue entregado."), el("button", { class: "mini", onclick: () => resendNow(x, true) }, "Reenviar mensaje")) : null, x.mine && x.st === "retry" ? el("div", { class: "rsnd" }, el("button", { class: "mini", onclick: () => resendNow(x, false) }, "Reintentar ahora")) : null));
}
/* ───────────────────────── buscar en los mensajes ─────────────────────────
   Se guardan hasta 4000 mensajes: sin buscador no hay forma de volver a encontrar algo que
   se dijo. Busca en todas las conversaciones a la vez, no solo en la que está abierta. */
const sinTildes = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function buscarMsgs(q) {
  const t = sinTildes(q).trim(); if (t.length < 2) return [];
  const partes = t.split(/\s+/);
  const hits = [];
  for (let i = S.msgs.length - 1; i >= 0 && hits.length < 300; i--) {
    const m = S.msgs[i];
    const quien = m.mine ? "yo vos propio" : sinTildes(nameOf(m.from) + " " + nodeId(m.from));
    const heno = sinTildes(m.text) + " " + quien + " " + sinTildes(convTitle(convOf(m)));
    if (partes.every((p) => heno.includes(p))) hits.push(m);
  }
  return hits;
}
/* Resalta en el texto lo que se buscó, sin usar HTML: se arma con nodos de texto. */
function resaltar(texto, q) {
  const cont = el("span", { class: "rs" });
  const base = sinTildes(texto), partes = [...new Set(sinTildes(q).trim().split(/\s+/).filter((x) => x.length > 1))];
  const marcas = [];
  for (const p of partes) { let i = base.indexOf(p); while (i >= 0) { marcas.push([i, i + p.length]); i = base.indexOf(p, i + p.length); } }
  marcas.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a2, b2] of marcas) {
    if (a2 < pos) continue;
    if (a2 > pos) cont.append(document.createTextNode(texto.slice(pos, a2)));
    cont.append(el("mark", {}, texto.slice(a2, b2)));
    pos = b2;
  }
  cont.append(document.createTextNode(texto.slice(pos)));
  return cont;
}
function renderBusqueda() {
  const box = $("#msglist"); if (!box) return false;
  const q = S.msgq.trim();
  if (q.length < 2) return false;
  box._vl = null; box._src = null;
  const hits = buscarMsgs(q);
  const cab = el("div", { class: "bsqcab" },
    el("b", {}, hits.length === 0 ? "Sin resultados" : hits.length + (hits.length === 1 ? " mensaje encontrado" : " mensajes encontrados") + (hits.length >= 300 ? " (se muestran los 300 más nuevos)" : "")),
    el("button", { class: "mini", onclick: () => cerrarBusqueda() }, "Volver a la conversación"));
  const items = hits.map((m) => el("button", {
    class: "bsqit", onclick: () => irAlMensaje(m),
  },
    el("div", { class: "bsqtop" },
      el("b", {}, m.mine ? "Vos" : nameOf(m.from)),
      el("span", { class: "bsqdonde" }, convTitle(convOf(m))),
      el("small", { class: "muted" }, fDT(m.t))),
    el("div", { class: "bsqtx" }, resaltar(m.text || "", q))));
  box.replaceChildren(cab, ...(items.length ? items : [el("div", { class: "empty" }, "Ningún mensaje contiene “" + q + "”. Probá con una palabra sola o con el nombre del nodo.")]));
  return true;
}
function cerrarBusqueda() {
  S.msgq = ""; const c = $("#msgbuscar"); if (c) c.value = "";
  renderMsgList(true);
}
function irAlMensaje(m) {
  const conv = convOf(m);
  S.msgq = ""; const c = $("#msgbuscar"); if (c) c.value = "";
  S.msgFoco = m.id;
  if (S.conv !== conv) { S.conv = conv; S.unread[conv] = 0; setView("messages"); }
  else { renderMsgList(false); renderTabs(); }
  requestAnimationFrame(() => enfocarMensaje());
}
/* Lleva la lista hasta el mensaje buscado y lo deja marcado un rato. */
function enfocarMensaje(intento) {
  const box = $("#msglist"); if (!box || !box._vl || S.msgFoco == null) return;
  const src = box._src; if (!src) return;
  const i = src.items.findIndex((it) => it.m && it.m.id === S.msgFoco);
  if (i < 0) { S.msgFoco = null; return; }
  box._vl.irA(i, true);
  const e = box.querySelector(".msg.hallado");
  if (e) { /* ya está dibujado: lo dejamos bien centrado */
    e.scrollIntoView({ block: "center", behavior: "auto" });
    setTimeout(() => { S.msgFoco = null; const x = box.querySelector(".msg.hallado"); if (x) x.classList.remove("hallado"); }, 4000);
    return;
  }
  /* las alturas de la lista son estimadas: puede hacer falta más de un intento para caer justo */
  const n = (intento || 0) + 1;
  if (n < 12) requestAnimationFrame(() => enfocarMensaje(n));
  else S.msgFoco = null;
}
function renderMsgList(scrollEnd) {
  const box = $("#msglist"); if (!box) return;
  if (renderBusqueda()) return; /* mientras se busca, la lista muestra los resultados */
  /* si venimos de un resultado de búsqueda no hay que irse al final: el mensaje está más arriba */
  const atEnd = S.msgFoco == null && (scrollEnd || box.scrollTop + box.clientHeight >= box.scrollHeight - 40);
  const list = S.msgs.filter((x) => convOf(x) === S.conv);
  if (!list.length) { box._vl = null; box.replaceChildren(el("div", { class: "empty" }, icon("M3 13l3-8h12l3 8v6H3z M3 13h5l1 3h6l1-3h5"), "Todavía no hay mensajes")); return; }
  const pv = box._src; /* si solo llegaron mensajes al final, se reaprovecha lo ya armado */
  let items, lastDay, from = 0;
  if (pv && pv.conv === S.conv && pv.list.length && list.length >= pv.list.length && list[pv.list.length - 1] === pv.list[pv.list.length - 1]) { items = pv.items; lastDay = pv.lastDay; from = pv.list.length; }
  else { items = []; lastDay = ""; }
  for (let i = from; i < list.length; i++) { const x = list[i], d = dayLbl(x.t); if (d !== lastDay) { items.push({ day: d, k: "d" + d }); lastDay = d; } items.push({ m: x, k: x.id + ":" + x.from }); }
  box._src = { conv: S.conv, list, items, lastDay };
  if (!box._vl) { box.replaceChildren(); box._vl = vlist(box, { est: 78, gap: 10, key: (it) => it.k, render: (it) => (it.day ? el("div", { class: "day" }, it.day) : msgEl(it.m)) }); }
  const st = box.scrollTop; box._vl.set(items, atEnd); if (!atEnd) box.scrollTop = st;
}

/* ───────────────────────── desplazamiento virtual: solo se dibuja lo que se ve ───────────────────────── */
function vlist(box, o) { /* lista de alturas variables (mensajes) */
  const gap = o.gap || 0, est = o.est || 80, OV = 700; let items = [], offs = [0], cache = new Map(), raf = 0, A = -1, B = -1, stick = false;
  const hc = o.hc || (o.hc = new Map()), top = el("div", { class: "vsp" }), bot = el("div", { class: "vsp" });
  const hOf = (it) => hc.get(o.key(it)) ?? est;
  const recalc = () => { offs = new Array(items.length + 1); offs[0] = 0; for (let i = 0; i < items.length; i++) offs[i + 1] = offs[i] + hOf(items[i]) + gap; };
  const first = (y) => { let lo = 0, hi = items.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m] <= y) lo = m; else hi = m - 1; } return lo; };
  const spacers = (i0, i1) => { const n = items.length; top.style.display = i0 ? "" : "none"; bot.style.display = i1 < n ? "" : "none"; top.style.height = Math.max(0, offs[i0] - gap) + "px"; bot.style.height = Math.max(0, offs[n] - gap - offs[i1]) + "px"; };
  const draw = (force) => {
    raf = 0; if (!items.length) return;
    let st = box.scrollTop; const vh = box.clientHeight || 600;
    if (stick) st = Math.max(0, offs[items.length] - vh);
    const i0 = first(Math.max(0, st - OV)); let i1 = i0; while (i1 < items.length && offs[i1] < st + vh + OV) i1++;
    if (force || i0 !== A || i1 !== B) {
      for (const k of [...cache.keys()]) if (k < i0 || k >= i1) cache.delete(k);
      const kids = [top]; for (let i = i0; i < i1; i++) { let e = cache.get(i); if (!e) { e = o.render(items[i], i); cache.set(i, e); } kids.push(e); } kids.push(bot);
      A = i0; B = i1; spacers(i0, i1); box.replaceChildren(...kids);
    }
    // medir lo dibujado y corregir las estimaciones
    let shift = 0, changed = false; const anchor = first(st);
    for (let i = i0; i < i1; i++) { const e = cache.get(i); if (!e) continue; const h = e.offsetHeight; if (!h) continue; const k = o.key(items[i]); if (Math.abs((hc.get(k) ?? est) - h) > 0.5) { if (i < anchor) shift += h - (hc.get(k) ?? est); hc.set(k, h); changed = true; } }
    if (changed) { recalc(); spacers(i0, i1); if (stick) box.scrollTop = box.scrollHeight; else if (shift) box.scrollTop = st + shift; }
    else if (stick) box.scrollTop = box.scrollHeight;
  };
  const sched = () => { if (!raf) raf = requestAnimationFrame(() => draw(false)); };
  box.addEventListener("scroll", () => { if (stick && box.scrollTop + box.clientHeight < box.scrollHeight - 30) stick = false; sched(); });
  const api = {
    set(list, toEnd) { items = list; cache.clear(); recalc(); A = B = -1; stick = !!toEnd; box.replaceChildren(); draw(true); draw(false); if (stick) { box.scrollTop = box.scrollHeight; requestAnimationFrame(() => { draw(false); if (stick) box.scrollTop = box.scrollHeight; }); } },
    irA(i, centrado) { /* saltar a un elemento concreto: lo usa el buscador */
      if (i < 0 || i >= items.length) return;
      stick = false;
      const vh = box.clientHeight || 600;
      box.scrollTop = Math.max(0, offs[i] - (centrado ? Math.max(0, (vh - hOf(items[i])) / 2) : 12));
      draw(true);
    },
    rendered: () => cache.size, count: () => items.length };
  return api;
}
function vtable(holder, scroller, head, rows, mk, cols, rh = 54) { /* tabla de filas de igual altura */
  const OV = 8, tb = el("tbody"), tbl = el("table", { class: "tbl vt" + (rh < 45 ? " s" : "") }, head, tb), sp = () => el("tr", { class: "vsp" }, el("td", { colspan: cols, style: "padding:0;border:0;height:0" }));
  const top = sp(), bot = sp(); let A = -1, B = -1, raf = 0;
  const draw = (force) => {
    raf = 0; const vh = scroller.clientHeight || 600;
    const off = tb.isConnected ? scroller.getBoundingClientRect().top - tb.getBoundingClientRect().top : 0; /* px del cuerpo de la tabla que ya pasaron por arriba */
    const y0 = Math.max(0, off), i0 = Math.max(0, Math.floor(y0 / rh) - OV), i1 = Math.min(rows.length, Math.ceil((y0 + vh) / rh) + OV);
    if (!force && i0 === A && i1 === B) return; A = i0; B = i1;
    top.firstChild.style.height = i0 * rh + "px"; bot.firstChild.style.height = (rows.length - i1) * rh + "px";
    tb.replaceChildren(top, ...rows.slice(i0, i1).map((r, k) => mk(r, i0 + k)), bot);
    const r1 = tb.querySelector("tr:not(.vsp)"); const real = r1 ? r1.getBoundingClientRect().height : 0; /* si las filas miden otra cosa, se corrige y se vuelve a dibujar */
    if (real && Math.abs(real - rh) > 1 && !tbl._fixed) { rh = real; tbl._fixed = true; draw(true); }
  };
  scroller.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => draw(false)); });
  holder.replaceChildren(tbl); draw(true); requestAnimationFrame(() => draw(true));
  return { redraw: () => draw(true), table: tbl, rendered: () => B - A };
}

/* ── Nodos ── */
/* ── nodos favoritos: se guardan en este navegador y, si hay nodo conectado, también en su lista ── */
const FAV_KEY = "meshportal:favs";
S.favs = new Set(); try { S.favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch (e) {}
const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...S.favs])); } catch (e) {} };
const isFav = (n) => !!n && (S.favs.has(n.num) || !!n.fav);
async function toggleFav(n) {
  if (!n || n.num === S.me) return;
  const on = !isFav(n);
  if (on) S.favs.add(n.num); else { S.favs.delete(n.num); n.fav = false; }
  saveFavs(); scheduleRefresh("nodes"); if (S.view === "map") drawMap();
  toast((on ? "★ Favorito: " : "Quitado de favoritos: ") + nodeName(n), on ? "ok" : undefined);
  if (S.device && ready()) { try { await sendAdmin(on ? "setFavoriteNode" : "removeFavoriteNode", n.num); } catch (e) {} }
}
const favBtn = (n, cls) => el("button", { class: "favbtn " + (cls || "") + (isFav(n) ? " on" : ""), title: isFav(n) ? "Quitar de favoritos" : "Marcar como favorito", "aria-pressed": isFav(n) ? "true" : "false", onclick: (e) => { e.stopPropagation(); toggleFav(n); } }, isFav(n) ? "★" : "☆");
let nodesSort = { k: "lastHeard", dir: -1 };
/* ── filtros de la lista de nodos ── */
const NF_KEY = "meshportal:nodef";
const NF_DEF = { scope: "all", state: "all", mins: 120, roles: [], fav: false };
const NF_ROLES = [["client", "Cliente", "Cliente, cliente silencioso, oculto y base"], ["router", "Nodo", "Router y router tardío: reenvían tráfico de la malla"], ["routerclient", "Nodo cliente", "Router + cliente (rol heredado)"], ["repeater", "Repetidor", "Repetidor puro"], ["other", "Otros", "Rastreador, sensor, TAK, objetos perdidos o rol desconocido"]];
const NF_MINS = [[15, "15 min"], [60, "1 hora"], [120, "2 horas"], [360, "6 horas"], [1440, "24 horas"]];
let nf = NF_DEF; try { nf = { ...NF_DEF, ...JSON.parse(localStorage.getItem(NF_KEY) || "{}") }; } catch (e) {}
const nfSave = () => { try { localStorage.setItem(NF_KEY, JSON.stringify(nf)); } catch (e) {} };
const roleGroup = (n) => { const r = n.user && n.user.role; if (!n.user) return "other"; if (r === 0 || r === 1 || r === 8 || r === 12) return "client"; if (r === 2 || r === 11) return "router"; if (r === 3) return "routerclient"; if (r === 4) return "repeater"; return "other"; };
const roleLabel = (n) => { if (!n.user) return "Sin datos"; const g = NF_ROLES.find((x) => x[0] === roleGroup(n)); return g && g[0] !== "other" ? g[1] : enumName(C.Config_DeviceConfig_Role, n.user.role); };
const isOffline = (n) => !n.lastHeard || Date.now() / 1000 - n.lastHeard > nf.mins * 60;
const nfActive = () => (nf.scope !== "all") + (nf.state !== "all") + (nf.roles.length ? 1 : 0) + (nf.fav ? 1 : 0);
function nfMatch(n) {
  if (n.num === S.me) return true;
  if (nf.fav && !isFav(n)) return false;
  if (nf.scope === "direct" && !(n.hops === 0 && !n.viaMqtt)) return false;
  if (nf.scope === "mqtt" && !n.viaMqtt) return false;
  if (nf.state === "off" && !isOffline(n)) return false;
  if (nf.state === "on" && isOffline(n)) return false;
  if (nf.roles.length && !nf.roles.includes(roleGroup(n))) return false;
  return true;
}
function nodeList() { /* nodos que pasan búsqueda y filtros */
  const q = S.search.trim().toLowerCase();
  return [...S.nodes.values()].filter((n) => (!q || (nodeName(n) + nodeShort(n) + nodeId(n.num)).toLowerCase().includes(q)) && nfMatch(n));
}
function drawNodeFilters() {
  const box = $("#nodef"); if (!box) return;
  const set = (o) => { nf = { ...nf, ...o }; nfSave(); drawNodeFilters(); renderNodesTable(); };
  const seg = (title, key, opts) => el("div", { class: "nfg" }, el("small", { class: "nft" }, title), el("div", { class: "nfseg" }, ...opts.map(([v, l, tip]) => el("button", { class: nf[key] === v ? "on" : "", title: tip || "", onclick: () => set({ [key]: v }) }, l))));
  const tog = (k) => nf.roles.includes(k) ? nf.roles.filter((x) => x !== k) : [...nf.roles, k];
  const mins = el("select", { class: "inp nfmin", "aria-label": "Minutos sin señal para considerar un nodo desconectado", title: "Tiempo sin recibir señal del nodo para considerarlo desconectado", onchange: (e) => set({ mins: +e.target.value }) }, ...NF_MINS.map(([v, l]) => el("option", { value: v, selected: nf.mins === v }, l)));
  const na = nfActive();
  box.replaceChildren(
    seg("Alcance", "scope", [["all", "Todos"], ["direct", "Solo directos", "Escuchados por radio sin saltos intermedios"], ["mqtt", "Solo por MQTT", "Nodos que llegan por un servidor MQTT"]]),
    el("div", { class: "nfg" }, el("small", { class: "nft" }, "Estado"), el("div", { class: "nfseg" }, ...[["all", "Todos"], ["on", "Conectados"], ["off", "Desconectados"]].map(([v, l]) => el("button", { class: nf.state === v ? "on" : "", onclick: () => set({ state: v }) }, l))), nf.state !== "all" ? el("span", { class: "nfafter" }, el("small", {}, nf.state === "off" ? "sin señal hace más de" : "con señal en los últimos"), mins) : null),
    el("div", { class: "nfg" }, el("small", { class: "nft" }, "Favoritos"), el("div", { class: "nfseg" }, el("button", { class: nf.fav ? "" : "on", onclick: () => set({ fav: false }) }, "Todos"), el("button", { class: nf.fav ? "on" : "", onclick: () => set({ fav: true }) }, "★ Solo favoritos"))),
    el("div", { class: "nfg wide" }, el("small", { class: "nft" }, "Función del nodo"), el("div", { class: "nfchips" }, ...NF_ROLES.map(([k, l, tip]) => el("button", { class: "nfchip" + (nf.roles.includes(k) ? " on" : ""), title: tip, onclick: () => set({ roles: tog(k) }) }, l)))),
    el("div", { class: "nfg end" }, el("button", { class: "btn ghost", disabled: !na, onclick: () => set({ scope: "all", state: "all", roles: [], fav: false }) }, na ? "Limpiar filtros (" + na + ")" : "Sin filtros")));
}
function viewNodes(m) {
  m.append(el("div", { class: "nodesview" },
    el("header", { class: "ph" }, el("h2", { id: "nodeh" }, `Nodos (${S.nodes.size})`),
      el("div", { class: "phr" }, el("input", { class: "inp", type: "search", placeholder: "Buscar…", value: S.search, oninput: (e) => { S.search = e.target.value; renderNodesTable(); } }),
        el("button", { class: "btn ghost", onclick: exportNodes }, "Exportar CSV"))),
    el("div", { class: "nodef", id: "nodef" }),
    el("div", { class: "tblwrap", id: "nodetbl" })));
  drawNodeFilters(); renderNodesTable();
}
function renderNodesTable() {
  const box = $("#nodetbl"); if (!box) return;
  const mp = mePos(), all = nodeList();
  const h = $("#nodeh"); if (h) h.textContent = all.length === S.nodes.size ? `Nodos (${S.nodes.size})` : `Nodos (${all.length} de ${S.nodes.size})`;
  const rows = all.map((n) => ({ n, dist: mp && n.pos ? hav(mp.lat, mp.lon, n.pos.lat, n.pos.lon) : null }));
  const val = { name: (r) => nodeName(r.n).toLowerCase(), lastHeard: (r) => r.n.lastHeard || 0, snr: (r) => r.n.snr ?? -99, hops: (r) => r.n.hops ?? 99, battery: (r) => r.n.battery ?? -1, dist: (r) => r.dist ?? 1e9 }[nodesSort.k];
  rows.sort((a, b) => (isFav(b.n) - isFav(a.n)) || (val(a) > val(b) ? 1 : -1) * nodesSort.dir);
  const th = (k, label) => el("th", { class: "sortable", onclick: () => { nodesSort = { k, dir: nodesSort.k === k ? -nodesSort.dir : 1 }; renderNodesTable(); } }, label + (nodesSort.k === k ? (nodesSort.dir > 0 ? " ▲" : " ▼") : ""));
  const head = el("thead", {}, el("tr", {}, th("name", "Nodo"), el("th", {}, "Modelo"), th("lastHeard", "Última vez"), th("snr", "SNR"), th("hops", "Conexión"), th("battery", "Batería"), th("dist", "Distancia"), el("th", {}, "")));
  const mkRow = ({ n, dist }) => el("tr", { class: (n.num === S.me ? "me" : "") + " vrow" },
      el("td", {}, el("div", { class: "cellnode" }, n.num === S.me ? el("span", { class: "favbtn ph" }, "") : favBtn(n), stDot(n), avatar(n, 30), el("div", { class: "nlink", title: "Ver detalle", onclick: () => openNodeSheet(n.num) }, el("b", {}, nodeName(n) + (n.num === S.me ? " (vos)" : "")), el("small", {}, nodeId(n.num) + " · "), el("small", { class: "rolebadge " + roleGroup(n) }, roleLabel(n)), n.num !== S.me && isOffline(n) ? el("small", { class: "offbadge" }, "desconectado") : null))),
      el("td", {}, n.user ? enumName(Mesh.HardwareModel, n.user.hwModel) : "—"),
      el("td", {}, ago(n.lastHeard)),
      el("td", { class: n.snr == null ? "" : n.snr >= 3 ? "snr-g" : n.snr >= -7 ? "snr-w" : "snr-b" }, n.snr != null ? n.snr.toFixed(1) + " dB" : "—"),
      el("td", {}, n.num === S.me ? "Este nodo" : n.hops == null ? (n.viaMqtt ? "Vía MQTT" : "Desconocido") : (n.hops === 0 ? "Directo" : n.hops + (n.hops === 1 ? " salto" : " saltos")) + (n.viaMqtt ? ", vía MQTT" : "")),
      el("td", {}, battText(n.battery)),
      el("td", {}, dist != null ? fmtDist(dist) : "—"),
      el("td", {}, n.num === S.me ? null : el("div", { class: "acts" }, [
        el("button", { class: "mini", title: "Ver detalle del nodo", onclick: () => openNodeSheet(n.num) }, "Detalle"),
        el("button", { class: "mini", title: "Mensaje directo", onclick: () => openDM(n.num) }, "Mensaje"),
        el("button", { class: "mini", title: "Trazar ruta", onclick: () => nodeAction("trace", n) }, "Ruta"),
        el("button", { class: "mini", title: "Pedir posición", onclick: () => nodeAction("pos", n) }, "Posición"),
        el("button", { class: "mini danger", title: "Quitar del NodeDB", onclick: () => nodeAction("del", n) }, "Quitar")])));
  const st0 = box.scrollTop; S.nvt = vtable(box, box, head, rows, mkRow, 8, 58); box.scrollTop = st0;
  if (!rows.length) box.append(el("div", { class: "muted pad" }, nfActive() || S.search ? "Ningún nodo cumple con la búsqueda y los filtros elegidos." : "Todavía no hay nodos en la lista."));
}
async function nodeAction(a, n) {
  if (!S.device) return;
  try {
    if (a === "trace") { await S.device.traceRoute(n.num); toast("Traceroute enviado a " + nodeName(n) + "…"); }
    if (a === "pos") { await S.device.requestPosition(n.num); toast("Posición solicitada a " + nodeName(n)); }
    if (a === "del" && confirm(`¿Quitar a ${nodeName(n)} de la lista de nodos del módulo?`)) { await S.device.removeNodeByNum(n.num); S.nodes.delete(n.num); scheduleRefresh("nodes"); }
  } catch (e) { toast("No se pudo completar: " + (e.error !== undefined ? ruteoTexto(e.error) : e.message || e), "err"); }
}
/* Escape para CSV. Además de las comillas, neutraliza el texto que Excel interpretaría como
   fórmula: un nombre de nodo o un mensaje llega de una radio ajena, y si empieza con = + - @
   Excel lo ejecuta al abrir el archivo. Se le antepone un apóstrofo, que Excel no muestra. */
const csvCell = (s) => {
  let v = String(s ?? "");
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
};
window.__csv = csvCell;
function exportNodes() {
  const head = "id,nombre_largo,nombre_corto,modelo,ultima_vez,snr,saltos,bateria,lat,lon,alt\n";
  const q = csvCell;
  const body = nodeList().map((n) => [nodeId(n.num), q(n.user && n.user.longName), q(n.user && n.user.shortName), n.user ? enumName(Mesh.HardwareModel, n.user.hwModel) : "", n.lastHeard ? new Date(n.lastHeard * 1000).toISOString() : "", n.snr ?? "", n.hops ?? "", n.battery ?? "", n.pos ? n.pos.lat : "", n.pos ? n.pos.lon : "", n.pos ? n.pos.alt : ""].join(",")).join("\n");
  download("nodos-lora-mesh.csv", new Blob([head + body], { type: "text/csv" }));
}
function download(name, blob) {
  if (IS_APP) { /* en el celular el archivo se guarda en Descargas/OPEN SOURCE PARIZ */
    blob.arrayBuffer().then((b) => { const u = new Uint8Array(b); let t = ""; for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); window.AndroidBridge.saveFile(name, blob.type || "application/octet-stream", btoa(t)); }).catch((e) => toast("No se pudo guardar: " + e.message, "err"));
    return;
  }
  const a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
}
function printFrame(f) { /* imprime el contenido de un iframe; en el celular usa el servicio de impresión de Android (permite "Guardar como PDF") */
  if (IS_APP) { const d = f.contentDocument; window.AndroidBridge.printHtml("<!doctype html>" + d.documentElement.outerHTML, d.title || "OPEN SOURCE PARIZ"); return; }
  f.contentWindow.focus(); f.contentWindow.print();
}

/* ── Consola ── */
function viewConsole(m) {
  m.append(el("div", { class: "consoleview" },
    el("header", { class: "ph" }, el("h2", {}, "Tráfico de radio"), el("div", { class: "phr" }, el("button", { class: "btn ghost", onclick: (e) => { S.logPause = !S.logPause; e.target.textContent = S.logPause ? "Reanudar" : "Pausar"; } }, S.logPause ? "Reanudar" : "Pausar"), el("button", { class: "btn ghost", onclick: () => { S.logs = []; renderLog(); } }, "Limpiar"))),
    el("div", { class: "tblwrap", id: "logbox" })));
  renderLog();
}
function renderLog() {
  const box = $("#logbox"); if (!box) return;
  box.replaceChildren(el("table", { class: "tbl mono" }, el("thead", {}, el("tr", {}, ["Hora", "De", "Para", "Tipo", "SNR", "RSSI"].map((h) => el("th", {}, h)))),
    el("tbody", {}, S.logs.slice(-200).reverse().map((l) => el("tr", {}, el("td", {}, new Date(l.t).toLocaleTimeString("es-AR")), el("td", {}, nameOf(l.from)), el("td", {}, l.to === 0xffffffff ? "Todos" : nameOf(l.to)), el("td", {}, l.port), el("td", {}, l.snr ? l.snr.toFixed(1) : "—"), el("td", {}, l.rssi || "—"))))));
}

/* ───────────────────────── telemetría ───────────────────────── */
const TEL_CATS = { device: "Dispositivo", env: "Ambiente / sensores", air: "Calidad del aire", power: "Energía (canales INA)", local: "Estadísticas del módulo", traf: "Tráfico de la malla", suelo: "Suelo y agua", health: "Salud", host: "Host Linux", link: "Enlace de radio recibido", pos: "Posición / GPS", pax: "Contador de personas" };
/* Las nueve clases de telemetría del firmware. Faltaban las dos últimas: si un nodo las
   mandaba, el portal tiraba el paquete sin decir nada. */
const VARIANT_CAT = { deviceMetrics: "device", environmentMetrics: "env", airQualityMetrics: "air", powerMetrics: "power", localStats: "local", healthMetrics: "health", hostMetrics: "host", trafficManagementStats: "traf", soilWaterMetrics: "suelo" };
const REQ_LABEL = { deviceMetrics: "Dispositivo", environmentMetrics: "Ambiente", localStats: "Estadísticas locales", airQualityMetrics: "Calidad del aire", powerMetrics: "Energía", trafficManagementStats: "Tráfico de la malla", soilWaterMetrics: "Suelo y agua" };
// campo: [etiqueta, unidad]  (@t = duración, @b = bytes)
const TF = {
  batteryLevel: ["Batería", "%"], voltage: ["Tensión", "V"], channelUtilization: ["Uso del canal", "%"], airUtilTx: ["Aire usado en TX", "%"], uptimeSeconds: ["Tiempo encendido", "@t"],
  temperature: ["Temperatura", "°C"], relativeHumidity: ["Humedad relativa", "%"], barometricPressure: ["Presión atmosférica", "hPa"], gasResistance: ["Resistencia de gas", "MΩ"], current: ["Corriente", "mA"], iaq: ["Calidad del aire (IAQ)", ""], distance: ["Distancia", "mm"], lux: ["Luz", "lx"], whiteLux: ["Luz blanca", "lx"], irLux: ["Luz infrarroja", "lx"], uvLux: ["Luz UV", "lx"], windDirection: ["Dirección del viento", "°"], windSpeed: ["Velocidad del viento", "m/s"], windGust: ["Ráfaga", "m/s"], windLull: ["Calma", "m/s"], weight: ["Peso", "kg"], radiation: ["Radiación", "µR/h"], rainfall1h: ["Lluvia última hora", "mm"], rainfall24h: ["Lluvia 24 h", "mm"], soilMoisture: ["Humedad del suelo", "%"], soilTemperature: ["Temperatura del suelo", "°C"],
  pm10Standard: ["PM1.0 estándar", "µg/m³"], pm25Standard: ["PM2.5 estándar", "µg/m³"], pm100Standard: ["PM10 estándar", "µg/m³"], pm10Environmental: ["PM1.0 ambiental", "µg/m³"], pm25Environmental: ["PM2.5 ambiental", "µg/m³"], pm100Environmental: ["PM10 ambiental", "µg/m³"], co2: ["CO₂", "ppm"],
  ch1Voltage: ["Canal 1 · tensión", "V"], ch1Current: ["Canal 1 · corriente", "mA"], ch2Voltage: ["Canal 2 · tensión", "V"], ch2Current: ["Canal 2 · corriente", "mA"], ch3Voltage: ["Canal 3 · tensión", "V"], ch3Current: ["Canal 3 · corriente", "mA"],
  numPacketsTx: ["Paquetes enviados", ""], numPacketsRx: ["Paquetes recibidos", ""], numPacketsRxBad: ["Paquetes dañados", ""], numOnlineNodes: ["Nodos en línea", ""], numTotalNodes: ["Nodos totales", ""], numRxDupe: ["Duplicados recibidos", ""], numTxRelay: ["Paquetes retransmitidos", ""], numTxRelayCanceled: ["Retransmisiones canceladas", ""], heapTotalBytes: ["Memoria total (heap)", "@b"], heapFreeBytes: ["Memoria libre (heap)", "@b"],
  freememBytes: ["Memoria libre", "@b"], diskfree1Bytes: ["Disco 1 libre", "@b"], diskfree2Bytes: ["Disco 2 libre", "@b"], diskfree3Bytes: ["Disco 3 libre", "@b"], load1: ["Carga 1 min", ""], load5: ["Carga 5 min", ""], load15: ["Carga 15 min", ""], userString: ["Texto de usuario", ""],
  snr: ["SNR", "dB"], rssi: ["RSSI", "dBm"], hops: ["Saltos", ""],
  lat: ["Latitud", "°"], lon: ["Longitud", "°"], altitude: ["Altitud", "m"], altitudeHae: ["Altitud elipsoidal", "m"], groundSpeed: ["Velocidad", "m/s"], groundTrack: ["Rumbo", "°"], satsInView: ["Satélites a la vista", ""], PDOP: ["PDOP", ""], HDOP: ["HDOP", ""], VDOP: ["VDOP", ""], gpsAccuracy: ["Precisión GPS", "mm"], precisionBits: ["Bits de precisión", ""], fixQuality: ["Calidad del fix", ""], fixType: ["Tipo de fix", ""], locationSource: ["Fuente de ubicación", ""], altitudeSource: ["Fuente de altitud", ""],
  wifi: ["Dispositivos WiFi", ""], ble: ["Dispositivos BLE", ""], heartBpm: ["Pulso", "bpm"], spO2: ["SpO₂", "%"],
  /* ── Lo que el firmware también sabe mandar y antes se mostraba con el nombre crudo ── */
  /* Tormentas eléctricas */
  lightningStrikeCount1h: ["Rayos en la última hora", ""], lightningDistanceKm: ["Distancia del rayo", "km"],
  /* Sol */
  solarIrradiance: ["Irradiación solar", "W/m²"],
  /* Suelo y agua */
  soilPh: ["pH del suelo", ""], electricalConductivity: ["Conductividad eléctrica", "µS/cm"],
  dissolvedOxygen: ["Oxígeno disuelto", "mg/L"], chemicalOxygenDemand: ["Demanda química de oxígeno", "mg/L"],
  biochemicalOxygenDemand: ["Demanda bioquímica de oxígeno", "mg/L"],
  /* Canales de energía 4 a 8 (los INA de más de tres canales) */
  ch4Voltage: ["Tensión canal 4", "V"], ch4Current: ["Corriente canal 4", "mA"],
  ch5Voltage: ["Tensión canal 5", "V"], ch5Current: ["Corriente canal 5", "mA"],
  ch6Voltage: ["Tensión canal 6", "V"], ch6Current: ["Corriente canal 6", "mA"],
  ch7Voltage: ["Tensión canal 7", "V"], ch7Current: ["Corriente canal 7", "mA"],
  ch8Voltage: ["Tensión canal 8", "V"], ch8Current: ["Corriente canal 8", "mA"],
  /* Entradas analógicas y sondas de temperatura de un cable */
  adcVoltageCh0: ["Tensión ADC 0", "V"], adcVoltageCh1: ["Tensión ADC 1", "V"], adcVoltageCh2: ["Tensión ADC 2", "V"], adcVoltageCh3: ["Tensión ADC 3", "V"],
  adcVoltageCh4: ["Tensión ADC 4", "V"], adcVoltageCh5: ["Tensión ADC 5", "V"], adcVoltageCh6: ["Tensión ADC 6", "V"], adcVoltageCh7: ["Tensión ADC 7", "V"],
  oneWireTemperature: ["Temperatura de la sonda", "°C"],
  oneWireTemperatureCh0: ["Temperatura sonda 0", "°C"], oneWireTemperatureCh1: ["Temperatura sonda 1", "°C"], oneWireTemperatureCh2: ["Temperatura sonda 2", "°C"], oneWireTemperatureCh3: ["Temperatura sonda 3", "°C"],
  oneWireTemperatureCh4: ["Temperatura sonda 4", "°C"], oneWireTemperatureCh5: ["Temperatura sonda 5", "°C"], oneWireTemperatureCh6: ["Temperatura sonda 6", "°C"], oneWireTemperatureCh7: ["Temperatura sonda 7", "°C"],
  /* Partículas en suspensión: cuántas hay de cada tamaño */
  particles03um: ["Partículas ≥ 0,3 µm", "/0,1 L"], particles05um: ["Partículas ≥ 0,5 µm", "/0,1 L"], particles10um: ["Partículas ≥ 1 µm", "/0,1 L"],
  particles25um: ["Partículas ≥ 2,5 µm", "/0,1 L"], particles40um: ["Partículas ≥ 4 µm", "/0,1 L"], particles50um: ["Partículas ≥ 5 µm", "/0,1 L"],
  particles100um: ["Partículas ≥ 10 µm", "/0,1 L"], particlesTps: ["Tamaño típico de partícula", "µm"],
  pm40Standard: ["PM4,0 (estándar)", "µg/m³"],
  /* Gases y estado del sensor de aire */
  co2Temperature: ["Temperatura del sensor de CO₂", "°C"], co2Humidity: ["Humedad del sensor de CO₂", "%"],
  formFormaldehyde: ["Formaldehído", "µg/m³"], formTemperature: ["Temperatura del sensor de formaldehído", "°C"], formHumidity: ["Humedad del sensor de formaldehído", "%"],
  pmTemperature: ["Temperatura del sensor de partículas", "°C"], pmHumidity: ["Humedad del sensor de partículas", "%"],
  pmVocIdx: ["Índice de compuestos orgánicos (VOC)", ""], pmNoxIdx: ["Índice de óxidos de nitrógeno (NOx)", ""],
  pmStatusFlags: ["Estado del sensor de partículas", ""],
  lastCleaningTime: ["Última limpieza del sensor", "@t"], lastCleaningValid: ["Dato de limpieza válido", ""],
  oneShotMode: ["Medición a pedido", ""], vocStateTime: ["Antigüedad del estado VOC", "@t"], vocStateValid: ["Estado VOC válido", ""], vocStateArray: ["Estado interno del sensor VOC", ""],
  /* Tráfico de la malla: para entender por qué la red va lenta o se pierden paquetes */
  numTxDropped: ["Envíos descartados", ""], noiseFloor: ["Piso de ruido", "dBm"],
  packetsInspected: ["Paquetes revisados", ""], positionDedupDrops: ["Posiciones repetidas descartadas", ""],
  nodeinfoCacheHits: ["Datos de nodo servidos de memoria", ""], rateLimitDrops: ["Descartados por límite de ritmo", ""],
  unknownPacketDrops: ["Paquetes desconocidos descartados", ""], hopExhaustedPackets: ["Paquetes sin saltos restantes", ""],
  routerHopsPreserved: ["Saltos ahorrados por repetidores", ""],
  tuningCapPf: ["Capacitor de sintonía", "pF"],
};
const tfLabel = (k) => (TF[k] ? TF[k][0] : human(k));
function fmtUp(s) {
  s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + " d " : "") + (h || d ? h + " h " : "") + m + " min";
}
function fmtTele(k, v) {
  if (typeof v !== "number") return String(v);
  const u = TF[k] ? TF[k][1] : "";
  if (u === "@t") return fmtUp(v);
  if (u === "@b") return v >= 1048576 ? (v / 1048576).toFixed(2) + " MB" : (v / 1024).toFixed(1) + " KB";
  if (k === "batteryLevel" && v > 100) return "Alimentado (USB/cargador)";
  if (k === "lat" || k === "lon") return v.toFixed(6) + " °";
  const dec = Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1;
  return v.toFixed(dec) + (u ? " " + u : "");
}
function msgToObj(desc, msg) {
  const o = {};
  if (!msg) return o;
  for (const f of desc.fields) {
    if ((f.fieldKind !== "scalar" && f.fieldKind !== "enum") || f.scalar === 12) continue;
    let set = true; try { set = isFieldSet(msg, f); } catch (e) {}
    if (!set) continue;
    let v = msg[f.localName];
    if (typeof v === "bigint") v = Number(v);
    if (f.fieldKind === "enum") { const ev = f.enum.values.find((x) => x.number === v); v = ev ? ev.name : v; }
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    o[f.localName] = v;
  }
  return o;
}
function recordTele(num, cat, obj, t = Date.now(), minGap = 0) {
  if (!num || !obj || !Object.keys(obj).length) return;
  let n = S.tele.get(num); if (!n) { n = {}; S.tele.set(num, n); }
  const c = n[cat] || (n[cat] = { last: {}, t: 0, hist: [] });
  if (minGap && t - c.t < minGap) return;
  Object.assign(c.last, obj); c.t = Math.max(c.t, t);
  const h = c.hist;
  if (h.length && h[h.length - 1].t === t) return;
  h.push({ t, ...obj });
  if (h.length > 400) h.splice(0, h.length - 400);
  scheduleRefresh("tele"); persistTeleSoon();
}
function addTrackPoint(num, lat, lon, alt, t = Date.now()) {
  if (!lat && !lon) return;
  let tr = S.tracks.get(num); if (!tr) { tr = []; S.tracks.set(num, tr); }
  const last = tr[tr.length - 1];
  if (last && hav(last.lat, last.lon, lat, lon) < 0.003 && t - last.t < 600000) return;
  const nd = S.nodes.get(num);
  tr.push({ t, lat, lon, alt, snr: nd && nd.snr != null ? nd.snr : null });
  if (tr.length > 400) tr.splice(0, tr.length - 400);
  scheduleRefresh("tele");
}
let teleT = 0;
function persistTeleSoon() { if (teleT) return; teleT = setTimeout(() => { teleT = 0; saveTele(); }, 20000); }
let teleCap = 150; /* muestras por categoría que se guardan en el navegador (en memoria se conservan todas) */
function saveTele() {
  if (!S.me || S.demo) return;
  while (true) {
    try {
      const o = {};
      for (const [num, cats] of S.tele) { const c2 = {}; for (const [k, c] of Object.entries(cats)) c2[k] = { last: c.last, t: c.t, hist: c.hist.length > teleCap ? c.hist.slice(-teleCap) : c.hist }; o[num] = c2; }
      const tr = {}; for (const [num, t] of S.tracks) tr[num] = t.length > teleCap ? t.slice(-teleCap) : t;
      localStorage.setItem(cacheKey("tele"), JSON.stringify({ tele: o, tracks: tr }));
      return;
    } catch (e) {
      if (teleCap <= 20) { try { localStorage.removeItem(cacheKey("tele")); } catch (e2) {} return; } /* no entra: se deja de guardar, pero NO se borra lo que está en memoria */
      teleCap = Math.floor(teleCap / 3);
    }
  }
}
function loadTele() {
  try {
    const d = JSON.parse(localStorage.getItem(cacheKey("tele")) || "null"); if (!d) return;
    for (const [k, v] of Object.entries(d.tele || {})) if (!S.tele.has(+k)) S.tele.set(+k, v);
    for (const [k, v] of Object.entries(d.tracks || {})) if (!S.tracks.has(+k)) S.tracks.set(+k, v);
  } catch (e) {}
}
function requestTele(num, kind, silent) {
  if (S.demo) { if (!silent) toast("Modo demo: no se envió nada"); return; }
  if (!S.device) return;
  const T = Protobuf.Telemetry;
  const msg = create(T.TelemetrySchema, { variant: { case: kind, value: {} } });
  const self = num === S.me;
  S.device.sendPacket(toBinary(T.TelemetrySchema, msg), Protobuf.Portnums.PortNum.TELEMETRY_APP, self ? "self" : num, 0, !self, true).catch(() => {});
  if (!silent) toast(`Pedí telemetría (${REQ_LABEL[kind]}) a ${nameOf(num)}. La respuesta puede tardar.`);
}

/* ── vista de telemetría ── */
S.tui = { node: null, tab: "summary", metric: null, range: 6 * 3600e3 };
function viewTele(m) {
  const sel = el("select", { class: "inp", "aria-label": "Nodo del que se ve la telemetría", onchange: (e) => { S.tui.node = +e.target.value; S.tui.tab = "detail"; S.tui.metric = null; renderTeleBody(); syncTabs(); } });
  const fillSel = () => {
    const nums = [...new Set([S.me, ...S.tele.keys()])].filter(Boolean).sort((a, b) => (a === S.me ? -1 : b === S.me ? 1 : nodeName(S.nodes.get(a)).localeCompare(nodeName(S.nodes.get(b)))));
    sel.replaceChildren(...nums.map((n) => el("option", { value: n, selected: n === (S.tui.node || S.me) }, nodeName(S.nodes.get(n)) + (n === S.me ? " (vos)" : ""))));
  };
  fillSel();
  const tabs = el("div", { class: "tabs" });
  const syncTabs = () => { tabs.replaceChildren(...[["summary", "Todos los nodos"], ["detail", "Detalle por nodo"]].map(([id, l]) => el("button", { class: "tab" + (S.tui.tab === id ? " on" : ""), onclick: () => { S.tui.tab = id; renderTeleBody(); syncTabs(); } }, l))); };
  syncTabs();
  m.append(el("div", { class: "teleview" },
    el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Telemetría"), el("small", { class: "muted" }, "Todo lo que reporta el módulo y los nodos de la malla, con historial.")),
      el("div", { class: "phr" }, el("button", { class: "btn ghost", onclick: exportTeleCSV }, "Exportar CSV"), el("button", { class: "btn ghost", onclick: exportDump }, "Exportar todo (JSON)"))),
    el("div", { class: "tbar" }, tabs, el("div", { class: "tsel" }, el("span", { class: "muted" }, "Nodo:"), sel)),
    el("div", { id: "telebody", class: "telebody" })));
  renderTeleBody();
}
function renderTeleBody() {
  const box = $("#telebody"); if (!box) return;
  const top = box.scrollTop;
  box.replaceChildren(S.tui.tab === "summary" ? teleSummary() : teleDetail());
  box.scrollTop = top;
}
function teleSummary() {
  const rows = [...new Set([S.me, ...S.tele.keys()])].filter(Boolean).map((num) => ({ num, t: S.tele.get(num) || {} }));
  const g = (r, cat, k) => (r.t[cat] && r.t[cat].last[k] !== undefined ? r.t[cat].last[k] : undefined);
  const first = (r, k) => { for (const c of ["device", "local"]) { const v = g(r, c, k); if (v !== undefined) return v; } };
  const upd = (r) => Math.max(0, ...Object.values(r.t).map((c) => c.t));
  rows.sort((a, b) => (a.num === S.me ? -1 : b.num === S.me ? 1 : upd(b) - upd(a)));
  const cell = (k, v) => el("td", {}, v === undefined ? "—" : fmtTele(k, v));
  if (!rows.length) return el("div", { class: "empty" }, "Todavía no llegó telemetría. El módulo la envía periódicamente (ver Ajustes → Módulos → Telemetría) o podés pedirla desde “Detalle por nodo”.");
  const holder = el("div", { class: "tblwrap2" });
  const head = el("thead", {}, el("tr", {}, ["Nodo", "Batería", "Tensión", "Uso canal", "Aire TX", "Temp.", "Humedad", "Presión", "Encendido", "Categorías", "Última"].map((h) => el("th", {}, h))));
    const mk = (r) => el("tr", { class: "clk vrow" + (r.num === S.me ? " me" : ""), onclick: () => { S.tui.node = r.num; S.tui.tab = "detail"; S.tui.metric = null; setView("tele"); } },
      el("td", {}, el("div", { class: "cellnode" }, avatar(S.nodes.get(r.num) || { num: r.num }, 28), el("b", {}, nodeName(S.nodes.get(r.num) || { num: r.num })))),
      cell("batteryLevel", first(r, "batteryLevel")), cell("voltage", first(r, "voltage") ?? g(r, "env", "voltage")), cell("channelUtilization", first(r, "channelUtilization")), cell("airUtilTx", first(r, "airUtilTx")),
      cell("temperature", g(r, "env", "temperature")), cell("relativeHumidity", g(r, "env", "relativeHumidity")), cell("barometricPressure", g(r, "env", "barometricPressure")), cell("uptimeSeconds", first(r, "uptimeSeconds")),
      el("td", {}, Object.keys(r.t).map((c) => TEL_CATS[c] ? TEL_CATS[c].split(" ")[0] : c).join(", ") || "—"), el("td", {}, upd(r) ? ago(upd(r) / 1000) : "—"));
  const sc = $("#telebody") || holder;
  vtable(holder, sc, head, rows, mk, 11, 56); return holder;
}
function teleDetail() {
  const num = S.tui.node || S.me, t = S.tele.get(num) || {};
  const wrap = el("div", { class: "teledetail" });
  // pedir telemetría
  wrap.append(el("div", { class: "card" }, el("b", {}, "Pedir telemetría ahora a " + nameOf(num)),
    el("small", { class: "muted" }, "Envía una solicitud por la malla; el nodo responde con sus valores actuales (si ese sensor existe)."),
    el("div", { class: "chips" }, Object.keys(REQ_LABEL).map((k) => el("button", { class: "mini", onclick: () => requestTele(num, k) }, REQ_LABEL[k])))));
  // gráfico
  const opts = [];
  for (const [cat, c] of Object.entries(t)) for (const k of Object.keys(c.last)) if (typeof c.last[k] === "number" && c.hist.filter((h) => typeof h[k] === "number").length >= 1) opts.push([cat, k]);
  if (opts.length) {
    if (!S.tui.metric || !opts.some(([a, b]) => a === S.tui.metric[0] && b === S.tui.metric[1])) {
      S.tui.metric = opts.find(([a, b]) => b === "batteryLevel") || opts.find(([a, b]) => b === "voltage") || opts[0];
    }
    const msel = el("select", { class: "inp", "aria-label": "Dato a graficar", onchange: (e) => { S.tui.metric = e.target.value.split("|"); drawTeleChart(); } }, opts.map(([cat, k]) => el("option", { value: cat + "|" + k, selected: cat === S.tui.metric[0] && k === S.tui.metric[1] }, TEL_CATS[cat].split(" /")[0] + " · " + tfLabel(k))));
    const rsel = el("select", { class: "inp", "aria-label": "Período del gráfico", onchange: (e) => { S.tui.range = +e.target.value; drawTeleChart(); } }, [["3600000", "1 hora"], ["21600000", "6 horas"], ["86400000", "24 horas"], ["604800000", "7 días"], ["0", "Todo"]].map(([v, l]) => el("option", { value: v, selected: +v === S.tui.range }, l)));
    wrap.append(el("div", { class: "card" }, el("div", { class: "chartbar" }, el("b", {}, "Gráfico"), msel, rsel), el("canvas", { id: "telechart", class: "telechart" }), el("div", { id: "chartstat", class: "muted" })));
    requestAnimationFrame(drawTeleChart);
  }
  // historial de muestras (tabla con desplazamiento virtual)
  const hcats = Object.keys(t).filter((c) => t[c].hist && t[c].hist.length);
  if (hcats.length) {
    const hb = el("div", { class: "histbox" }), cnt = el("small", { class: "muted" });
    const drawHist = () => {
      const c = S.tui.hcat && t[S.tui.hcat] ? S.tui.hcat : hcats[0], hist = t[c].hist.slice().reverse();
      const keys = [...new Set(hist.slice(0, 400).flatMap((h) => Object.keys(h).filter((k) => k !== "t")))].slice(0, 12);
      cnt.textContent = hist.length + " muestras · se dibujan solo las visibles";
      vtable(hb, hb, el("thead", {}, el("tr", {}, el("th", {}, "Hora"), keys.map((k) => el("th", { title: k }, tfLabel(k))))), hist, (h) => el("tr", {}, el("td", {}, fDT(h.t)), keys.map((k) => el("td", {}, h[k] === undefined ? "—" : typeof h[k] === "number" ? fmtTele(k, h[k]) : String(h[k])))), keys.length + 1, 34);
    };
    wrap.append(el("div", { class: "card" }, el("div", { class: "chartbar" }, el("b", {}, "Historial de muestras"), el("select", { class: "inp", "aria-label": "Cuántas muestras mostrar", onchange: (e) => { S.tui.hcat = e.target.value; drawHist(); } }, hcats.map((c) => el("option", { value: c, selected: c === (S.tui.hcat || hcats[0]) }, TEL_CATS[c] || c))), cnt), hb));
    requestAnimationFrame(drawHist);
  }
  // tarjetas por categoría
  const grid = el("div", { class: "catgrid" });
  for (const cat of Object.keys(TEL_CATS)) {
    const c = t[cat]; if (!c) continue;
    grid.append(el("div", { class: "card cat" }, el("div", { class: "cathead" }, el("b", {}, TEL_CATS[cat]), el("small", { class: "muted" }, ago(c.t / 1000) + " · " + c.hist.length + " muestras")),
      el("table", { class: "kv" }, el("tbody", {}, Object.entries(c.last).map(([k, v]) => el("tr", { class: typeof v === "number" ? "pick" : "", onclick: typeof v === "number" ? () => { S.tui.metric = [cat, k]; renderTeleBody(); } : null }, el("td", {}, tfLabel(k)), el("td", {}, fmtTele(k, v))))))));
  }
  const nb = S.neigh.get(num);
  if (nb && nb.length) grid.append(el("div", { class: "card cat" }, el("div", { class: "cathead" }, el("b", {}, "Vecinos directos (NeighborInfo)"), el("small", { class: "muted" }, nb.length + " nodos")), el("table", { class: "kv" }, el("tbody", {}, nb.map((x) => el("tr", {}, el("td", {}, nameOf(x.id)), el("td", {}, x.snr != null ? x.snr.toFixed(1) + " dB" : "—")))))));
  if (num === S.me && (S.myInfo || S.metaObj)) {
    const info = { ...(S.myInfo || {}), ...(S.metaObj || {}) };
    grid.append(el("div", { class: "card cat" }, el("div", { class: "cathead" }, el("b", {}, "Información fija del módulo")), el("table", { class: "kv" }, el("tbody", {}, Object.entries(info).map(([k, v]) => el("tr", {}, el("td", {}, human(k)), el("td", {}, typeof v === "boolean" ? (v ? "Sí" : "No") : String(v))))))));
  }
  if (!grid.children.length && !opts.length) wrap.append(el("div", { class: "empty" }, "Este nodo todavía no envió telemetría. Probá con los botones de arriba o esperá al próximo informe periódico."));
  wrap.append(grid);
  return wrap;
}
function drawTeleChart() {
  const c = $("#telechart"); if (!c || !S.tui.metric) return;
  const num = S.tui.node || S.me, [cat, k] = S.tui.metric, cc = S.tele.get(num) && S.tele.get(num)[cat]; if (!cc) return;
  const now = Date.now(), from = S.tui.range ? now - S.tui.range : 0;
  const pts = cc.hist.filter((h) => typeof h[k] === "number" && h.t >= from).map((h) => ({ t: h.t, v: h[k] }));
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight; if (!W) return;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d");
  const st = $("#chartstat");
  // Un corte en los datos (el nodo estuvo callado un rato largo) no se dibuja como línea recta:
  // eso haría creer que hubo mediciones donde no las hubo. Se marca punteado y tenue.
  const dts = []; for (let i = 1; i < pts.length; i++) dts.push(pts[i].t - pts[i - 1].t);
  const med = dts.length ? dts.slice().sort((a, b) => a - b)[dts.length >> 1] : 0;
  const CORTE = Math.max(med * 3, 10 * 60000);
  const paint = (hover) => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css("--ink"), mut = css("--mut"), line = css("--line"), acc = css("--acc"), bg = css("--bg");
    g.clearRect(0, 0, W, H); g.font = "11px system-ui,sans-serif";
    g.lineJoin = "round"; g.lineCap = "round"; g.setLineDash([]);
    if (!pts.length) { g.fillStyle = mut; g.textAlign = "left"; g.fillText("Sin datos en este rango de tiempo.", 16, 28); return; }
    const vs = pts.map((p) => p.v); let lo = Math.min(...vs), hi = Math.max(...vs); if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const L = 56, R = 14, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    const t0 = from || pts[0].t, t1 = Math.max(now, pts[pts.length - 1].t);
    const tx = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * pw, vy = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    g.strokeStyle = line; g.fillStyle = mut; g.textAlign = "right"; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Math.round(vy(v)) + .5; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText((hi - lo) > 20 ? v.toFixed(0) : (hi - lo) > 2 ? v.toFixed(1) : v.toFixed(2), L - 6, y + 4); }
    g.textAlign = "center";
    for (let i = 0; i <= 4; i++) { const t = t0 + ((t1 - t0) * i) / 4, d = new Date(t); g.fillText(t1 - t0 > 86400000 ? d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }) : d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }), tx(t), H - 8); }
    // la línea del dato, cortada donde no hubo muestras
    g.strokeStyle = acc; g.lineWidth = 2;
    let ini = 0;
    const tramo = (a, b) => {
      if (a === b) { g.fillStyle = acc; g.beginPath(); g.arc(tx(pts[a].t), vy(pts[a].v), 1.8, 0, 7); g.fill(); return; }
      g.beginPath(); for (let i = a; i <= b; i++) { const x = tx(pts[i].t), y = vy(pts[i].v); i === a ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
    };
    for (let i = 1; i <= pts.length; i++) {
      if (i === pts.length || pts[i].t - pts[i - 1].t > CORTE) {
        tramo(ini, i - 1);
        if (i < pts.length) { /* puente punteado: ahí faltan datos, no es una medición */
          g.save(); g.setLineDash([3, 4]); g.globalAlpha = .45; g.strokeStyle = acc; g.beginPath();
          g.moveTo(tx(pts[i - 1].t), vy(pts[i - 1].v)); g.lineTo(tx(pts[i].t), vy(pts[i].v)); g.stroke(); g.restore();
        }
        ini = i;
      }
    }
    // marcas: en todas las muestras solo si son pocas; la última siempre, con aro para despegarla del fondo
    g.fillStyle = acc;
    if (pts.length <= 60) for (const p of pts) { g.beginPath(); g.arc(tx(p.t), vy(p.v), 2.5, 0, 7); g.fill(); }
    const ult = pts[pts.length - 1], ux = tx(ult.t), uy = vy(ult.v);
    g.beginPath(); g.arc(ux, uy, 4, 0, 7); g.fill();
    g.strokeStyle = bg; g.lineWidth = 2; g.beginPath(); g.arc(ux, uy, 4, 0, 7); g.stroke();
    if (hover) {
      const x = tx(hover.t), y = vy(hover.v), txt = new Date(hover.t).toLocaleString("es-AR") + " · " + fmtTele(k, hover.v);
      g.save(); g.setLineDash([2, 3]); g.strokeStyle = mut; g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + .5, T); g.lineTo(Math.round(x) + .5, T + ph); g.stroke(); g.restore();
      g.fillStyle = ink; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.strokeStyle = bg; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, 7); g.stroke();
      g.font = "12px system-ui,sans-serif";
      const w = Math.min(g.measureText(txt).width + 14, W - 8), bx = clamp(x - w / 2, 4, Math.max(4, W - w - 4));
      const by = y - 34 >= 2 ? y - 34 : Math.min(H - 24, y + 12);
      g.fillStyle = ink; g.fillRect(bx, by, w, 22); g.fillStyle = bg; g.textAlign = "left"; g.fillText(txt, bx + 7, by + 15);
    }
    return { tx };
  };
  const geo = paint(null);
  if (!pts.length) { if (st) st.textContent = ""; return; }
  const vs = pts.map((p) => p.v);
  if (st) st.textContent = `${pts.length} muestras · mín ${fmtTele(k, Math.min(...vs))} · máx ${fmtTele(k, Math.max(...vs))} · prom ${fmtTele(k, vs.reduce((a, b) => a + b, 0) / vs.length)} · última ${fmtTele(k, vs[vs.length - 1])}`;
  c.setAttribute("role", "img");
  c.setAttribute("aria-label", "Gráfico de " + tfLabel(k) + ". " + (st ? st.textContent : ""));
  const mirar = (e) => {
    const x = e.clientX - c.getBoundingClientRect().left;
    let best = pts[0], bd = 1e9; for (const p of pts) { const d = Math.abs(geo.tx(p.t) - x); if (d < bd) { bd = d; best = p; } }
    paint(best);
  };
  c.onpointermove = mirar;
  c.onpointerdown = mirar; /* en pantalla táctil, tocar el gráfico muestra el valor */
  c.onpointerleave = () => paint(null);
  c.onpointercancel = () => paint(null);
}
/* ── exportación ── */
function exportTeleCSV() {
  const q = csvCell;
  const rows = ["fecha_iso,nodo_id,nodo,categoria,campo,valor"];
  for (const [num, cats] of S.tele) for (const [cat, c] of Object.entries(cats)) for (const pt of c.hist) for (const [k, v] of Object.entries(pt)) {
    if (k === "t") continue;
    rows.push([new Date(pt.t).toISOString(), nodeId(num), q(nodeName(S.nodes.get(num))), cat, k, typeof v === "string" ? q(v) : v].join(","));
  }
  if (rows.length === 1) return toast("Todavía no hay telemetría para exportar", "err");
  download("telemetria-lora-mesh.csv", new Blob(["﻿" + rows.join("\n")], { type: "text/csv" }));
}
function buildDump() {
  const js = (d, v) => { try { return toJson(d, v); } catch (e) { return null; } };
  const cfg = {}, mod = {};
  for (const k of Object.keys(S.cfg)) if (CFG_DESC[k]) { const j = js(CFG_DESC[k], S.cfg[k]); if (j && k === "security") { delete j.privateKey; delete j.adminKey; } cfg[k] = j; }
  for (const k of Object.keys(S.mod)) if (MOD_DESC[k]) mod[k] = js(MOD_DESC[k], S.mod[k]);
  const channels = S.channels.filter(Boolean).map((c) => { const j = js(NChannel.ChannelSchema, c); if (j && j.settings) delete j.settings.psk; return j; });
  const nodes = [...S.nodes.values()].map(({ rawUser, ...n }) => ({ id: nodeId(n.num), ...n }));
  const tele = {}; for (const [num, cats] of S.tele) tele[nodeId(num)] = cats;
  const tracks = {}; for (const [num, tr] of S.tracks) tracks[nodeId(num)] = tr;
  return { exportado: new Date().toISOString(), nodo_local: nodeId(S.me), informacion_modulo: { ...(S.myInfo || {}), ...(S.metaObj || {}) }, configuracion: cfg, modulos: mod, canales_sin_claves: channels, nodos: nodes, telemetria: tele, rastros: tracks, vecinos: Object.fromEntries([...S.neigh].map(([k, v]) => [nodeId(k), v])), waypoints: [...S.waypoints.values()], nota: "Por seguridad el archivo no incluye la clave privada del nodo ni las claves (PSK) de los canales." };
}
function exportDump() { download("lora-mesh-volcado-completo.json", new Blob([JSON.stringify(buildDump(), null, 1)], { type: "application/json" })); }

/* ───────────────────────── mapa sin conexión con capas ───────────────────────── */
const LAYER_DEFAULT = { grid: true, nodes: true, labels: true, activeOnly: false, rings: true, links: true, neigh: false, tracks: false, coverage: false, waypoints: true, color: "estado", stv: 1, base: "osm", over: {}, graticule: false };
const LAYER_DEFS = [
  ["Capas del módulo", [["nodes", "Nodos"], ["labels", "Etiquetas de nombre"], ["activeOnly", "Solo nodos activos (últimas 2 h)"], ["links", "Enlaces directos (color por SNR)"], ["neigh", "Vecinos reportados (NeighborInfo)"], ["tracks", "Rastros de movimiento"], ["coverage", "Cobertura medida (puntos por SNR)"], ["waypoints", "Waypoints compartidos"]]],
  ["Referencias", [["grid", "Cuadrícula y escala"], ["rings", "Anillos de distancia"]]],
];
try { Object.assign(S.map, { L: { ...LAYER_DEFAULT, ...(JSON.parse(localStorage.getItem("meshportal:layers") || "{}")) }, ext: [] }); } catch (e) { Object.assign(S.map, { L: { ...LAYER_DEFAULT }, ext: [] }); }
if (S.map.L.stv !== 1) { S.map.L.color = "estado"; S.map.L.stv = 1; }
const saveLayers = () => { try { localStorage.setItem("meshportal:layers", JSON.stringify(S.map.L)); } catch (e) {} };
const PALETTE = ["#e11d48", "#2563eb", "#d97706", "#7c3aed", "#0891b2", "#65a30d", "#db2777"];
let layerSeq = 1;

const snrColor = (s) => (s == null ? "#94a3b8" : s >= 5 ? "#16a34a" : s >= 0 ? "#84cc16" : s >= -5 ? "#f59e0b" : s >= -10 ? "#f97316" : "#dc2626");
function nodeColor(n) {
  const now = Date.now() / 1000, mode = S.map.L.color;
  if (mode === "estado") return statusColor(n);
  if (mode === "snr") return snrColor(n.snr);
  if (mode === "battery") return n.battery == null ? "#94a3b8" : n.battery > 100 ? "#2563eb" : n.battery > 50 ? "#16a34a" : n.battery > 20 ? "#f59e0b" : "#dc2626";
  if (mode === "age") { const d = now - (n.lastHeard || 0); return d < 900 ? "#16a34a" : d < 7200 ? "#f59e0b" : d < 86400 ? "#f97316" : "#94a3b8"; }
  return now - (n.lastHeard || 0) < 7200 ? `hsl(${(n.num * 47) % 360} 60% 45%)` : "#94a3b8";
}
const LEGENDS = {
  ident: null,
  estado: [["#22c55e", "Activo"], ["#facc15", "Batería baja / señal débil"], ["#ef4444", "Alerta de pánico o nodo caído (parpadea)"], ["#94a3b8", "Sin datos"]],
  snr: [["#16a34a", "≥ 5 dB"], ["#84cc16", "0 a 5"], ["#f59e0b", "-5 a 0"], ["#f97316", "-10 a -5"], ["#dc2626", "< -10"], ["#94a3b8", "sin dato"]],
  battery: [["#2563eb", "Alimentado"], ["#16a34a", "> 50 %"], ["#f59e0b", "20–50 %"], ["#dc2626", "< 20 %"], ["#94a3b8", "sin dato"]],
  age: [["#16a34a", "< 15 min"], ["#f59e0b", "< 2 h"], ["#f97316", "< 24 h"], ["#94a3b8", "más viejo"]],
};

function viewMap(m) {
  const canvas = el("canvas", { id: "mapc" });
  m.append(el("div", { class: "mapview" },
    el("header", { class: "ph" }, el("h2", {}, "Mapa"), el("div", { class: "phr" }, el("div", { id: "mapstat", class: "mapstat" }), el("small", { class: "muted maphint" }, "Arrastrá para mover · rueda, pellizco o + / − para zoom"), el("button", { class: "btn ghost fitbtn", onclick: () => { fitMap(); drawMap(); } }, "Ajustar a los nodos"))),
    el("div", { class: "mapbox" }, canvas, el("div", { id: "mapinfo", class: "mapinfo" }), el("div", { id: "maplayers", class: "layers" }), el("div", { id: "maplegend", class: "legend" }), el("div", { class: "mapzoom" }, el("button", { title: "Acercar", "aria-label": "Acercar", onclick: () => mapZoomAt(1 / 1.6) }, "+"), el("button", { title: "Alejar", "aria-label": "Alejar", onclick: () => mapZoomAt(1.6) }, "−"), el("button", { class: "fit", title: "Ajustar a los nodos", "aria-label": "Ajustar a los nodos", onclick: () => { fitMap(); drawMap(); } }, "◎")), el("div", { id: "mapattr", class: "mapattr" }), el("div", { id: "mapcoord", class: "coord" }))));
  S.map.fitted = false;
  buildLayersPanel();
  setupMap(canvas);
}

/* panel de capas */
function buildLayersPanel() {
  const box = $("#maplayers"); if (!box) return;
  if (!box.dataset.open && innerWidth < 600) box.dataset.open = "0"; /* en el celular el panel de capas arranca cerrado */
  const open = box.dataset.open !== "0";
  const chk = (label, checked, on) => el("label", { class: "ck" }, el("input", { type: "checkbox", checked, onchange: (e) => on(e.target.checked) }), el("span", {}, label));
  const body = el("div", { class: "lbody" });
  for (const [title, items] of LAYER_DEFS) {
    body.append(el("div", { class: "lsec" }, title));
    for (const [k, label] of items) body.append(chk(label, !!S.map.L[k], (v) => { S.map.L[k] = v; saveLayers(); drawMap(); }));
  }
  // mapas base en línea
  body.append(el("div", { class: "lsec" }, "Mapa base (con Internet)"));
  for (const [k, v] of [["", { n: "Sin mapa base" }], ...Object.entries(BASES)]) body.append(el("label", { class: "ck" }, el("input", { type: "radio", name: "mapbase", checked: (S.map.L.base || "") === k, onchange: () => { S.map.L.base = k; saveLayers(); drawMap(); } }), el("span", {}, v.n)));
  body.append(el("div", { class: "lsec" }, "Superposiciones"));
  for (const [k, v] of Object.entries(OVERS)) body.append(chk(v.n, !!(S.map.L.over && S.map.L.over[k]), (on) => { S.map.L.over = { ...(S.map.L.over || {}), [k]: on }; saveLayers(); drawMap(); }));
  body.append(chk("Coordenadas (grados, minutos, segundos)", !!S.map.L.graticule, (on) => { S.map.L.graticule = on; saveLayers(); drawMap(); }));
  const cin = el("input", { class: "inp", placeholder: "Ir a lat, lon  (ej. -40.15, -71.35)" });
  body.append(el("div", { class: "g2" }, cin, el("button", { class: "mini", onclick: () => { const m = cin.value.replace(",", " ").trim().split(/\s+/).map(Number); if (m.length < 2 || m.some((x) => !isFinite(x)) || Math.abs(m[0]) > 90 || Math.abs(m[1]) > 180) return toast("Esas coordenadas no son válidas. Escribí latitud y longitud en grados decimales, por ejemplo -40.148, -71.257.", "err"); const o = origin(), p = proj(m[0], m[1], o); S.map.cx = p.x; S.map.cy = p.y; S.map.mpp = Math.min(S.map.mpp, 60); drawMap(); } }, "Ir")));
  const cnt = el("small", { class: "muted" }, "Mapas guardados: …");
  tileCountDB().then((n) => { cnt.textContent = n == null ? "Sin almacenamiento local disponible" : `Mapas guardados para uso sin conexión: ${n} teselas`; });
  body.append(el("div", { class: "chips" }, el("button", { class: "mini", id: "dlbtn", onclick: () => openOfflineDialog() }, "⬇ Guardar zona para usar sin conexión…"), el("button", { class: "mini danger", onclick: async () => { if (confirm("¿Borrar todos los mapas guardados para usar sin conexión?\n\nEl mapa en pantalla sigue andando mientras haya Internet, pero para volver a tenerlo sin conexión habrá que descargar las zonas de nuevo.")) { await tileClearDB(); tileMem.clear(); buildLayersPanel(); drawMap(); } } }, "Borrar guardados")), cnt, el("small", { class: "muted" }, "Los mapas que mirás con Internet se guardan solos y se ven después sin conexión."));
  body.append(el("div", { class: "lsec" }, "Colorear nodos por"),
    el("select", { class: "inp", "aria-label": "Criterio para colorear los nodos", onchange: (e) => { S.map.L.color = e.target.value; saveLayers(); drawMap(); } }, [["estado", "Estado (semáforo)"], ["ident", "Identidad"], ["snr", "Calidad de señal (SNR)"], ["battery", "Batería"], ["age", "Antigüedad"]].map(([v, l]) => el("option", { value: v, selected: S.map.L.color === v }, l))));
  body.append(el("div", { class: "lsec" }, "Mis capas (archivos locales)"));
  if (!S.map.ext.length) body.append(el("small", { class: "muted" }, "GeoJSON, GPX, KML, imágenes de mapa y carpetas de teselas z/x/y."));
  for (const e of S.map.ext) body.append(extRow(e));
  const fileIn = el("input", { type: "file", multiple: true, accept: ".geojson,.json,.gpx,.kml,image/*", style: "display:none", onchange: (ev) => { addFiles([...ev.target.files]); ev.target.value = ""; } });
  const dirIn = el("input", { type: "file", webkitdirectory: true, style: "display:none", onchange: (ev) => { addTiles([...ev.target.files]); ev.target.value = ""; } });
  body.append(fileIn, dirIn, el("div", { class: "chips" }, el("button", { class: "mini", onclick: () => fileIn.click() }, "＋ Archivo…"), el("button", { class: "mini", onclick: () => dirIn.click() }, "＋ Carpeta de teselas…")));
  box.dataset.open = open ? "1" : "0";
  box.replaceChildren(el("button", { class: "ltoggle", onclick: () => { box.dataset.open = box.dataset.open === "1" ? "0" : "1"; buildLayersPanel(); } }, el("b", {}, "Capas"), el("span", {}, open ? "–" : "+")), ...(open ? [body] : []));
}
function extRow(e) {
  const row = el("div", { class: "extrow" });
  row.append(el("div", { class: "exth" },
    el("input", { type: "checkbox", checked: e.visible, onchange: (ev) => { e.visible = ev.target.checked; drawMap(); } }),
    el("span", { class: "extn", title: e.name }, e.name),
    e.type === "vector" ? el("input", { type: "color", value: e.color, class: "col", onchange: (ev) => { e.color = ev.target.value; drawMap(); } }) : null,
    e.bbox || e.type === "image" ? el("button", { class: "mini", title: "Ir a la capa", onclick: () => zoomExt(e) }, "⌖") : null,
    el("button", { class: "mini danger", title: "Quitar capa", onclick: () => { S.map.ext = S.map.ext.filter((x) => x !== e); buildLayersPanel(); drawMap(); } }, "✕")));
  if (e.type === "vector") row.append(el("small", { class: "muted" }, `${e.feats.length} elementos`));
  if (e.type === "tiles") row.append(el("small", { class: "muted" }, `${e.idx.size} teselas · zoom ${e.zmin}–${e.zmax}`), el("label", { class: "ck" }, el("input", { type: "checkbox", checked: e.tms, onchange: (ev) => { e.tms = ev.target.checked; e.cache.clear(); drawMap(); } }), el("span", {}, "Invertir Y (TMS)")));
  if (e.type === "image") {
    row.append(el("small", { class: "muted" }, "Coordenadas de los bordes de la imagen:"), el("div", { class: "g4s" }, ["N lat", "S lat", "O lon", "E lon"].map((l, i) => el("input", { class: "inp", type: "number", step: "any", placeholder: l, title: l, value: isFinite(e.b[i]) ? e.b[i] : "", oninput: (ev) => { e.b[i] = parseFloat(ev.target.value); drawMap(); } }))),
      el("input", { type: "range", min: 10, max: 100, value: e.alpha * 100, title: "Opacidad", oninput: (ev) => { e.alpha = ev.target.value / 100; drawMap(); } }));
  }
  return row;
}

/* importación de capas */
function geoFeats(j, out = [], name = "") {
  if (!j) return out;
  switch (j.type) {
    case "FeatureCollection": (j.features || []).forEach((f) => geoFeats(f, out)); break;
    case "Feature": geoFeats(j.geometry, out, (j.properties && (j.properties.name || j.properties.Name || j.properties.title)) || ""); break;
    case "GeometryCollection": (j.geometries || []).forEach((x) => geoFeats(x, out, name)); break;
    case "Point": out.push({ k: "pt", c: j.coordinates, n: name }); break;
    case "MultiPoint": j.coordinates.forEach((c) => out.push({ k: "pt", c, n: name })); break;
    case "LineString": out.push({ k: "line", c: j.coordinates, n: name }); break;
    case "MultiLineString": j.coordinates.forEach((c) => out.push({ k: "line", c, n: name })); break;
    case "Polygon": out.push({ k: "poly", c: j.coordinates, n: name }); break;
    case "MultiPolygon": j.coordinates.forEach((c) => out.push({ k: "poly", c, n: name })); break;
  }
  return out;
}
const xmlTxt = (n, sel) => { const x = n.querySelector(sel); return x ? x.textContent.trim() : ""; };
function parseGPX(txt) {
  const d = new DOMParser().parseFromString(txt, "application/xml"), out = [];
  const ll = (p) => [parseFloat(p.getAttribute("lon")), parseFloat(p.getAttribute("lat"))];
  d.querySelectorAll("wpt").forEach((w) => out.push({ k: "pt", c: ll(w), n: xmlTxt(w, "name") }));
  d.querySelectorAll("trkseg").forEach((s) => out.push({ k: "line", c: [...s.querySelectorAll("trkpt")].map(ll), n: "" }));
  d.querySelectorAll("rte").forEach((r) => out.push({ k: "line", c: [...r.querySelectorAll("rtept")].map(ll), n: xmlTxt(r, "name") }));
  return out;
}
function parseKML(txt) {
  const d = new DOMParser().parseFromString(txt, "application/xml"), out = [];
  const coords = (n) => (n ? n.textContent.trim().split(/\s+/).filter(Boolean).map((s) => s.split(",").map(Number)) : []);
  d.querySelectorAll("Placemark").forEach((pm) => {
    const name = xmlTxt(pm, "name");
    pm.querySelectorAll("Point").forEach((p) => { const c = coords(p.querySelector("coordinates"))[0]; if (c) out.push({ k: "pt", c, n: name }); });
    pm.querySelectorAll("LineString").forEach((p) => out.push({ k: "line", c: coords(p.querySelector("coordinates")), n: name }));
    pm.querySelectorAll("Polygon").forEach((p) => { const rings = [...p.querySelectorAll("LinearRing")].map((r) => coords(r.querySelector("coordinates"))); out.push({ k: "poly", c: rings, n: name }); });
  });
  return out;
}
function featsBBox(feats) {
  let n = -90, s = 90, w = 180, e = -180;
  const add = (c) => { if (!c || !isFinite(c[0]) || !isFinite(c[1])) return; w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); };
  for (const f of feats) { if (f.k === "pt") add(f.c); else if (f.k === "line") f.c.forEach(add); else f.c.forEach((r) => r.forEach(add)); }
  return e >= w ? [n, s, w, e] : null;
}
async function addFiles(files) {
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    try {
      if (["geojson", "json", "gpx", "kml"].includes(ext)) {
        const txt = await f.text();
        const feats = ext === "gpx" ? parseGPX(txt) : ext === "kml" ? parseKML(txt) : geoFeats(JSON.parse(txt));
        if (!feats.length) { toast(`“${f.name}” no tiene elementos con coordenadas`, "err"); continue; }
        S.map.ext.push({ id: layerSeq++, type: "vector", name: f.name, visible: true, color: PALETTE[(layerSeq - 1) % PALETTE.length], feats, bbox: featsBBox(feats) });
      } else if (f.type.startsWith("image/")) {
        const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
        S.map.ext.push({ id: layerSeq++, type: "image", name: f.name, visible: true, img, b: [NaN, NaN, NaN, NaN], alpha: 0.85 });
        toast("Imagen cargada: completá las coordenadas N/S/O/E de sus bordes para ubicarla.");
      } else toast(`Formato no soportado: ${f.name} (KMZ no está soportado; exportalo como KML)`, "err");
    } catch (e) { toast(`No pude leer “${f.name}”: ${e.message || e}`, "err"); }
  }
  buildLayersPanel(); drawMap();
}
function addTiles(files) {
  const idx = new Map(); let zmin = 99, zmax = 0, dir = "";
  for (const f of files) {
    const path = f.webkitRelativePath || f.name, m = path.match(/(\d+)[\\/](\d+)[\\/](\d+)\.(png|jpe?g|webp)$/i);
    if (!m) continue;
    const z = +m[1]; idx.set(`${z}/${m[2]}/${m[3]}`, f); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
    dir = dir || path.split("/")[0];
  }
  if (!idx.size) return toast("No encontré teselas con estructura z/x/y.png en esa carpeta", "err");
  S.map.ext.unshift({ id: layerSeq++, type: "tiles", name: "Teselas: " + (dir || "carpeta"), visible: true, idx, zmin, zmax, cache: new Map(), tms: false });
  buildLayersPanel(); drawMap(); toast(`${idx.size} teselas cargadas (zoom ${zmin}–${zmax})`, "ok");
}
function zoomExt(e) {
  const c = $("#mapc"); if (!c) return;
  const b = e.type === "image" ? e.b : e.bbox; if (!b || !b.every(isFinite)) return toast("Faltan las coordenadas de la capa", "err");
  const o = origin(), a = proj(b[0], b[2], o), z = proj(b[1], b[3], o);
  S.map.cx = (a.x + z.x) / 2; S.map.cy = (a.y + z.y) / 2;
  S.map.mpp = Math.max(Math.abs(z.x - a.x) / (c.clientWidth * 0.85), Math.abs(a.y - z.y) / (c.clientHeight * 0.85), 0.5);
  drawMap();
}

/* geometría y cámara */
function origin() {
  const p = mePos(); if (p) return p;
  const ps = [...S.nodes.values()].filter((n) => n.pos);
  if (ps.length) return { lat: ps[0].pos.lat, lon: ps[0].pos.lon };
  return { lat: -40.15, lon: -71.35 };
}
function proj(lat, lon, o) { return { x: (lon - o.lon) * Math.cos((o.lat * Math.PI) / 180) * 111320, y: (lat - o.lat) * 110574 }; }
function fitMap() {
  const o = origin(), c = $("#mapc"); if (!c) return;
  const pts = [...S.nodes.values()].filter((n) => n.pos).map((n) => proj(n.pos.lat, n.pos.lon, o));
  if (!pts.length) { S.map.cx = 0; S.map.cy = 0; S.map.mpp = 50; return; }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  S.map.cx = (x0 + x1) / 2; S.map.cy = (y0 + y1) / 2;
  S.map.mpp = Math.max((x1 - x0) / (c.clientWidth * 0.6), (y1 - y0) / (c.clientHeight * 0.8), 5); S.map.fitted = true;
}
function mapZoomAt(f, cx, cy) { /* acerca o aleja (f < 1 acerca) dejando quieto el punto de pantalla (cx, cy) */
  const c = $("#mapc"); if (!c) return;
  const r = c.getBoundingClientRect(), mx = (cx ?? r.left + r.width / 2) - r.left - r.width / 2, my = (cy ?? r.top + r.height / 2) - r.top - r.height / 2;
  const old = S.map.mpp, nw = clamp(old * f, 0.25, 400000);
  S.map.cx += mx * (old - nw); S.map.cy -= my * (old - nw); S.map.mpp = nw; drawMap();
}
function setupMap(c) {
  let drag = null, moved = 0, pinch = null, lastTap = null;
  const pts = new Map();
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  c.style.touchAction = "none"; /* en el celular el dedo mueve el mapa, no la página */
  new ResizeObserver(() => drawMap()).observe(c.parentElement);
  c.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); c.setPointerCapture(e.pointerId);
    if (pts.size === 2) { pinch = { d: dist(), m: mid() }; drag = null; moved = 99; }
    else if (pts.size === 1) { drag = { x: e.clientX, y: e.clientY }; moved = 0; c.style.cursor = "grabbing"; }
  });
  c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect(); updCoord(e.clientX - r.left, e.clientY - r.top);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { /* pellizco: zoom y desplazamiento a la vez */
      const d = dist(), m = mid();
      S.map.cx -= (m.x - pinch.m.x) * S.map.mpp; S.map.cy += (m.y - pinch.m.y) * S.map.mpp;
      mapZoomAt(pinch.d / d, m.x, m.y); pinch = { d, m }; return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; moved += Math.abs(dx) + Math.abs(dy);
    S.map.cx -= dx * S.map.mpp; S.map.cy += dy * S.map.mpp; drag = { x: e.clientX, y: e.clientY }; drawMap();
  });
  const up = (e) => {
    const was = pts.size; pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 1) { const [p] = [...pts.values()]; drag = { x: p.x, y: p.y }; return; }
    drag = null; c.style.cursor = "grab";
    if (e.type === "pointerup" && was === 1 && moved < 8) {
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { mapZoomAt(0.5, e.clientX, e.clientY); lastTap = null; } /* doble toque: acercar */
      else { lastTap = { t: now, x: e.clientX, y: e.clientY }; pickNode(e); }
    }
  };
  c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  c.addEventListener("wheel", (e) => { e.preventDefault(); mapZoomAt(e.deltaY > 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  requestAnimationFrame(() => { fitMap(); drawMap(); });
}
function scr(c, x, y) { return { sx: c.clientWidth / 2 + (x - S.map.cx) / S.map.mpp, sy: c.clientHeight / 2 - (y - S.map.cy) / S.map.mpp }; }
function unproj(c, sx, sy) {
  const o = origin(), x = (sx - c.clientWidth / 2) * S.map.mpp + S.map.cx, y = -(sy - c.clientHeight / 2) * S.map.mpp + S.map.cy;
  return { lat: o.lat + y / 110574, lon: o.lon + x / (111320 * Math.cos((o.lat * Math.PI) / 180)) };
}
function updCoord(sx, sy) {
  const c = $("#mapc"), box = $("#mapcoord"); if (!c || !box) return;
  const p = unproj(c, sx, sy), mp = mePos();
  box.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` + (mp ? ` · ${fmtDist(hav(mp.lat, mp.lon, p.lat, p.lon))} de tu nodo` : "");
}
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
let mapRaf = 0;
const drawMapSoon = () => { if (!mapRaf) mapRaf = requestAnimationFrame(() => { mapRaf = 0; drawMap(); }); };

/* teselas XYZ locales */
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
function drawTiles(g, c, L, o) {
  const W = c.clientWidth, H = c.clientHeight, ctr = unproj(c, W / 2, H / 2);
  let z = Math.round(Math.log2((156543.03392 * Math.cos((ctr.lat * Math.PI) / 180)) / S.map.mpp));
  z = clamp(z, L.zmin, L.zmax);
  const a = unproj(c, 0, 0), b = unproj(c, W, H), n = 2 ** z;
  const x0 = Math.floor(lon2x(a.lon, z)), x1 = Math.floor(lon2x(b.lon, z)), y0 = Math.floor(lat2y(a.lat, z)), y1 = Math.floor(lat2y(b.lat, z));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 600) return;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    if (x < 0 || y < 0 || x >= n || y >= n) continue;
    const key = `${z}/${x}/${L.tms ? n - 1 - y : y}`, f = L.idx.get(key); if (!f) continue;
    let bmp = L.cache.get(key);
    if (bmp === undefined) { L.cache.set(key, null); createImageBitmap(f).then((bm) => { L.cache.set(key, bm); drawMapSoon(); }).catch(() => {}); continue; }
    if (!bmp) continue;
    const p1 = proj(y2lat(y, z), x2lon(x, z), o), p2 = proj(y2lat(y + 1, z), x2lon(x + 1, z), o), s1 = scr(c, p1.x, p1.y), s2 = scr(c, p2.x, p2.y);
    g.drawImage(bmp, s1.sx, s1.sy, s2.sx - s1.sx + 0.6, s2.sy - s1.sy + 0.6);
  }
  if (L.cache.size > 400) { const ks = [...L.cache.keys()].slice(0, 150); ks.forEach((k) => { const bm = L.cache.get(k); if (bm && bm.close) bm.close(); L.cache.delete(k); }); }
}

/* ── mapas base en línea (se descargan cuando hay Internet y quedan guardados para usar sin conexión) ── */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const BASES = {
  osm: { n: "Calles (OpenStreetMap)", u: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", z: 19, a: "© OpenStreetMap" },
  topo: { n: "Topográfico (OpenTopoMap)", u: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", s: "abc", z: 17, a: "© OpenTopoMap (CC-BY-SA) · datos © OpenStreetMap" },
  esritopo: { n: "Topográfico (Esri)", u: ESRI + "World_Topo_Map/MapServer/tile/{z}/{y}/{x}", z: 19, a: "Esri, HERE, Garmin, USGS, NGA" },
  sat: { n: "Satélite (Esri)", u: ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", z: 19, a: "Esri, Maxar, Earthstar Geographics" },
  physical: { n: "Físico (Esri)", u: ESRI + "World_Physical_Map/MapServer/tile/{z}/{y}/{x}", z: 8, a: "Esri, US National Park Service" },
  political: { n: "Político (CARTO Voyager)", u: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", s: "abcd", z: 19, a: "© OpenStreetMap, © CARTO" },
  dark: { n: "Oscuro (CARTO)", u: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", s: "abcd", z: 19, a: "© OpenStreetMap, © CARTO" },
  ign: { n: "IGN Argentina (mapa base)", u: "https://wms.ign.gob.ar/geoserver/gwc/service/tms/1.0.0/capabaseargenmap@EPSG%3A3857@png/{z}/{x}/{-y}.png", z: 18, a: "© Instituto Geográfico Nacional (Argentina)" },
};
const OVERS = {
  bound: { n: "Límites políticos y nombres (Esri)", u: ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", z: 19, a: "Esri", op: 1 },
  hill: { n: "Relieve sombreado (Esri)", u: ESRI + "Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}", z: 16, a: "Esri, USGS", op: 0.6, blend: "multiply" },
};
for (const [k, v] of Object.entries(BASES)) v.id = "b-" + k;
for (const [k, v] of Object.entries(OVERS)) v.id = "o-" + k;
const tileMem = new Map(), tileFail = new Map(); let tileActive = 0; const tileQ = [];
let tdb = null;
function tileDB() {
  if (tdb) return tdb;
  tdb = new Promise((res) => { try { const r = indexedDB.open("lora-mesh-tiles", 1); r.onupgradeneeded = () => r.result.createObjectStore("t"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } });
  return tdb;
}
const idbReq = (mode, fn) => tileDB().then((db) => !db ? null : new Promise((res) => { try { const st = db.transaction("t", mode).objectStore("t"), rq = fn(st); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); } catch (e) { res(null); } }));
const tileGetDB = (k) => idbReq("readonly", (s) => s.get(k)), tilePutDB = (k, b) => idbReq("readwrite", (s) => s.put(b, k)), tileCountDB = () => idbReq("readonly", (s) => s.count()), tileClearDB = () => idbReq("readwrite", (s) => s.clear());
function tileURL(L, z, x, y) {
  const n = 2 ** z;
  return L.u.replace("{z}", z).replace("{x}", x).replace("{y}", y).replace("{-y}", n - 1 - y).replace("{s}", L.s ? L.s[(x + y) % L.s.length] : "");
}
async function fetchTileBlob(L, z, x, y) {
  const r = await fetch(tileURL(L, z, x, y), { mode: "cors", referrerPolicy: "no-referrer" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const b = await r.blob(); if (!b.size || !/image/.test(b.type || "image")) throw new Error("no es imagen");
  return b;
}
async function loadTile(L, key, z, x, y) {
  const cached = await tileGetDB(key);
  if (cached) { try { return await createImageBitmap(cached); } catch (e) {} }
  try { const b = await fetchTileBlob(L, z, x, y); tilePutDB(key, b); return await createImageBitmap(b); }
  catch (e) {
    // sin CORS: se muestra igual pero no se puede guardar
    return await new Promise((res) => { const im = new Image(); im.referrerPolicy = "no-referrer"; im.onload = () => createImageBitmap(im).then(res, () => res(null)); im.onerror = () => res(null); im.src = tileURL(L, z, x, y); });
  }
}
function pumpTiles() {
  while (tileActive < 8 && tileQ.length) {
    const job = tileQ.pop(); tileActive++;
    loadTile(...job.a).then((bm) => { if (bm) tileMem.set(job.key, bm); else { tileMem.set(job.key, false); tileFail.set(job.key, Date.now()); } }).catch(() => { tileMem.set(job.key, false); tileFail.set(job.key, Date.now()); }).finally(() => { tileActive--; drawMapSoon(); pumpTiles(); });
  }
}
function getTile(L, z, x, y, fetchIt = true) {
  const key = L.id + "/" + z + "/" + x + "/" + y; let v = tileMem.get(key);
  if (v === false && fetchIt && Date.now() - (tileFail.get(key) || 0) > 20000) { tileMem.delete(key); v = undefined; }
  if (v !== undefined) return v || null;
  if (!fetchIt) return null;
  tileMem.set(key, null); tileQ.push({ key, a: [L, key, z, x, y] }); pumpTiles();
  if (tileMem.size > 1800) { let n = 0; for (const [k, bm] of tileMem) { if (n++ > 600) break; if (bm && bm.close) bm.close(); tileMem.delete(k); } }
  return null;
}
window.addEventListener("online", () => { tileFail.clear(); for (const [k, v] of [...tileMem]) if (v === false) tileMem.delete(k); drawMapSoon(); });
function drawOnlineLayer(g, c, o, L, alpha = 1, blend) {
  const W = c.clientWidth, H = c.clientHeight, ctr = unproj(c, W / 2, H / 2);
  let z = Math.round(Math.log2((156543.03392 * Math.cos((ctr.lat * Math.PI) / 180)) / S.map.mpp)); z = clamp(z, 1, L.z);
  const a = unproj(c, 0, 0), b = unproj(c, W, H), n = 2 ** z;
  const x0 = Math.floor(lon2x(a.lon, z)), x1 = Math.floor(lon2x(b.lon, z)), y0 = Math.max(0, Math.floor(lat2y(a.lat, z))), y1 = Math.min(n - 1, Math.floor(lat2y(b.lat, z)));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return;
  g.save(); g.globalAlpha = alpha; if (blend) g.globalCompositeOperation = blend;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const xx = ((x % n) + n) % n;
    const p1 = proj(y2lat(y, z), x2lon(x, z), o), p2 = proj(y2lat(y + 1, z), x2lon(x + 1, z), o), s1 = scr(c, p1.x, p1.y), s2 = scr(c, p2.x, p2.y);
    const w = s2.sx - s1.sx + 0.6, h = s2.sy - s1.sy + 0.6;
    const bm = getTile(L, z, xx, y);
    if (bm) { g.drawImage(bm, s1.sx, s1.sy, w, h); continue; }
    for (let dz = 1; dz <= 4 && z - dz >= 0; dz++) { // mientras carga, se muestra la tesela de menor zoom
      const pb = getTile(L, z - dz, xx >> dz, y >> dz, false);
      if (pb) { const sw = pb.width / 2 ** dz, sh = pb.height / 2 ** dz; g.drawImage(pb, (xx - ((xx >> dz) << dz)) * sw, (y - ((y >> dz) << dz)) * sh, sw, sh, s1.sx, s1.sy, w, h); break; }
    }
  }
  g.restore();
}
function degFmt(v, step, lat) {
  const h = lat ? (v < 0 ? "S" : "N") : (v < 0 ? "O" : "E"); v = Math.abs(v);
  if (step >= 1) return Math.round(v) + "°" + h;
  const d = Math.floor(v + 1e-9), m = (v - d) * 60;
  if (step >= 1 / 60 - 1e-9) return d + "°" + String(Math.round(m)).padStart(2, "0") + "′" + h;
  return d + "°" + String(Math.floor(m + 1e-9)).padStart(2, "0") + "′" + ((m - Math.floor(m + 1e-9)) * 60).toFixed(step < 1 / 3600 ? 1 : 0).padStart(2, "0") + "″" + h;
}
function drawGraticule(g, c) {
  const W = c.clientWidth, H = c.clientHeight, a = unproj(c, 0, 0), b = unproj(c, W, H);
  const steps = [30, 10, 5, 2, 1, 0.5, 1 / 3, 0.25, 0.1, 1 / 12, 1 / 30, 1 / 60, 1 / 120, 1 / 360, 1 / 720, 1 / 3600], span = Math.abs(b.lon - a.lon);
  const step = [...steps].reverse().find((s) => span / s <= 9) || 30;
  g.save(); g.strokeStyle = "#0f766e"; g.fillStyle = "#0f766e"; g.lineWidth = 1; g.globalAlpha = 0.75; g.font = "11px system-ui,sans-serif";
  const P = (lat, lon) => { const o = origin(), p = proj(lat, lon, o); return scr(c, p.x, p.y); };
  for (let lon = Math.ceil(a.lon / step) * step; lon <= b.lon; lon += step) { const s = P(a.lat, lon); g.beginPath(); g.moveTo(s.sx, 0); g.lineTo(s.sx, H); g.stroke(); g.textAlign = "left"; g.fillText(degFmt(lon, step, false), s.sx + 3, H - 6); }
  for (let lat = Math.ceil(b.lat / step) * step; lat <= a.lat; lat += step) { const s = P(lat, a.lon); g.beginPath(); g.moveTo(0, s.sy); g.lineTo(W, s.sy); g.stroke(); g.textAlign = "left"; g.fillText(degFmt(lat, step, true), 4, s.sy - 3); }
  g.restore();
}
function mapAttribution() {
  const L = S.map.L, parts = [];
  if (L.base && BASES[L.base]) parts.push(BASES[L.base].a);
  for (const k of Object.keys(OVERS)) if (L.over && L.over[k]) parts.push(OVERS[k].a);
  const box = $("#mapattr"); if (box) { box.textContent = parts.join(" · "); box.style.display = parts.length ? "" : "none"; }
}
const gmapsDir = (lat, lon, from) => "https://www.google.com/maps/dir/?api=1&destination=" + lat + "," + lon + "&travelmode=driving" + (from ? "&origin=" + from.lat + "," + from.lon : "");
function openExternal(url) {
  if (S.net && S.net.online === false) toast("Sin Internet: Google Maps se abrirá cuando vuelva la conexión");
  if (IS_APP) { window.AndroidBridge.openUrl(url); return; }
  window.open(url, "_blank", "noopener");
}
async function downloadArea() {
  const L = S.map.L, c = $("#mapc"); if (!c) return;
  const layers = [BASES[L.base]].filter(Boolean).concat(Object.keys(OVERS).filter((k) => L.over && L.over[k]).map((k) => OVERS[k]));
  if (!layers.length) return toast("Elegí primero un mapa base", "err");
  const W = c.clientWidth, H = c.clientHeight, a = unproj(c, 0, 0), b = unproj(c, W, H), ctr = unproj(c, W / 2, H / 2);
  const z0 = clamp(Math.round(Math.log2((156543.03392 * Math.cos((ctr.lat * Math.PI) / 180)) / S.map.mpp)), 1, 18);
  const jobs = [];
  for (const l of layers) {
    for (let z = z0; z <= Math.min(l.z, z0 + 3); z++) {
      const n = 2 ** z, x0 = Math.floor(lon2x(a.lon, z)), x1 = Math.floor(lon2x(b.lon, z)), y0 = Math.max(0, Math.floor(lat2y(a.lat, z))), y1 = Math.min(n - 1, Math.floor(lat2y(b.lat, z)));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([l, z, ((x % n) + n) % n, y]);
    }
  }
  if (jobs.length > 2500) return toast(`La zona visible necesita ${jobs.length} teselas (máx. 2500). Acercá el mapa y reintentá.`, "err");
  if (!confirm(`Se van a descargar ${jobs.length} teselas (zoom ${z0} a ${Math.min(z0 + 3, 19)}) para usar sin conexión. Respetá las condiciones de uso de cada proveedor. ¿Continuar?`)) return;
  let done = 0, fail = 0;
  const worker = async () => { while (jobs.length) { const [l, z, x, y] = jobs.pop(); const key = l.id + "/" + z + "/" + x + "/" + y; try { if (!(await tileGetDB(key))) await tilePutDB(key, await fetchTileBlob(l, z, x, y)); } catch (e) { fail++; } done++; const bt = $("#dlbtn"); if (bt) bt.textContent = `Descargando… ${done}`; } };
  const total = jobs.length; toast("Descargando mapas para uso sin conexión…");
  await Promise.all(Array.from({ length: 6 }, worker));
  toast(fail ? `Listo: ${total - fail} teselas guardadas, ${fail} fallaron (¿sin Internet o el proveedor bloquea la descarga?)` : `Listo: ${total} teselas guardadas para usar sin conexión`, fail ? "err" : "ok");
  buildLayersPanel(); drawMapSoon();
}

/* dibujo */
function drawMap() {
  const c = $("#mapc"); if (!c) return;
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (!W || !H) return;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  if (!S.map.fitted && S.nodes.size) fitMap();
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = S.map.L, o = origin(), mpp = S.map.mpp, now = Date.now() / 1000;
  const P = (lat, lon) => { const p = proj(lat, lon, o); return scr(c, p.x, p.y); };
  g.fillStyle = css("--mapbg"); g.fillRect(0, 0, W, H);
  // 1) base: mapa en línea (guardado para uso sin conexión), teselas e imágenes
  if (L.base && BASES[L.base]) drawOnlineLayer(g, c, o, BASES[L.base]);
  for (const k of Object.keys(OVERS)) if (L.over && L.over[k]) drawOnlineLayer(g, c, o, OVERS[k], OVERS[k].op, OVERS[k].blend);
  for (const e of S.map.ext) {
    if (!e.visible) continue;
    if (e.type === "tiles") drawTiles(g, c, e, o);
    else if (e.type === "image" && e.b.every(isFinite)) { const a = P(e.b[0], e.b[2]), z = P(e.b[1], e.b[3]); g.globalAlpha = e.alpha; g.drawImage(e.img, a.sx, a.sy, z.sx - a.sx, z.sy - a.sy); g.globalAlpha = 1; }
  }
  // 2) cuadrícula
  const target = 110 * mpp, pow = 10 ** Math.floor(Math.log10(target)), step = [1, 2, 5, 10].map((k) => k * pow).find((v) => v >= target) || pow * 10;
  if (L.grid) {
    g.strokeStyle = css("--mapgrid"); g.lineWidth = 1;
    const x0 = S.map.cx - (W / 2) * mpp, x1 = S.map.cx + (W / 2) * mpp, y0 = S.map.cy - (H / 2) * mpp, y1 = S.map.cy + (H / 2) * mpp;
    for (let x = Math.ceil(x0 / step) * step; x < x1; x += step) { const { sx } = scr(c, x, 0); g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, H); g.stroke(); }
    for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) { const { sy } = scr(c, 0, y); g.beginPath(); g.moveTo(0, sy); g.lineTo(W, sy); g.stroke(); }
    const barPx = step / mpp; g.fillStyle = css("--ink"); g.fillRect(14, H - 22, barPx, 3);
    g.font = "12px system-ui,sans-serif"; g.textAlign = "left"; g.fillText(step >= 1000 ? step / 1000 + " km" : step + " m", 14, H - 28);
  }
  if (L.graticule) drawGraticule(g, c);
  // 3) capas vectoriales propias
  for (const e of S.map.ext) {
    if (!e.visible || e.type !== "vector") continue;
    g.strokeStyle = e.color; g.fillStyle = e.color + "33"; g.lineWidth = 2; g.lineJoin = "round";
    for (const f of e.feats) {
      if (f.k === "line") { g.beginPath(); f.c.forEach((q, i) => { const s = P(q[1], q[0]); i ? g.lineTo(s.sx, s.sy) : g.moveTo(s.sx, s.sy); }); g.stroke(); }
      else if (f.k === "poly") { g.beginPath(); f.c.forEach((ring) => { ring.forEach((q, i) => { const s = P(q[1], q[0]); i ? g.lineTo(s.sx, s.sy) : g.moveTo(s.sx, s.sy); }); g.closePath(); }); g.fill("evenodd"); g.stroke(); }
      else { const s = P(f.c[1], f.c[0]); g.fillStyle = e.color; g.beginPath(); g.arc(s.sx, s.sy, 4.5, 0, 7); g.fill(); g.fillStyle = e.color + "33"; if (f.n && e.feats.length < 200) { g.fillStyle = css("--ink"); g.font = "11px system-ui,sans-serif"; g.textAlign = "left"; g.fillText(f.n, s.sx + 8, s.sy + 4); g.fillStyle = e.color + "33"; } }
    }
  }
  const mp = mePos(), me = mp ? P(mp.lat, mp.lon) : null;
  // 4) anillos de distancia
  if (L.rings && me) { g.strokeStyle = css("--acc"); g.globalAlpha = 0.25; g.lineWidth = 1; for (let k = 1; k <= 4; k++) { g.beginPath(); g.arc(me.sx, me.sy, (k * step) / mpp, 0, 7); g.stroke(); } g.globalAlpha = 1; }
  // 5) cobertura medida
  if (L.coverage) { g.globalAlpha = 0.8; for (const tr of S.tracks.values()) for (const p of tr) { const s = P(p.lat, p.lon); g.fillStyle = snrColor(p.snr); g.beginPath(); g.arc(s.sx, s.sy, 3.5, 0, 7); g.fill(); } g.globalAlpha = 1; }
  // 6) rastros
  if (L.tracks) {
    g.lineWidth = 2; g.globalAlpha = 0.75;
    for (const [num, tr] of S.tracks) { if (tr.length < 2) continue; const n = S.nodes.get(num) || { num }; g.strokeStyle = nodeColor(n); g.beginPath(); tr.forEach((p, i) => { const s = P(p.lat, p.lon); i ? g.lineTo(s.sx, s.sy) : g.moveTo(s.sx, s.sy); }); g.stroke(); }
    g.globalAlpha = 1;
  }
  // 7) vecinos reportados y enlaces directos
  if (L.neigh) {
    g.strokeStyle = "#6366f1"; g.setLineDash([6, 5]); g.lineWidth = 1.5; g.globalAlpha = 0.7;
    for (const [id, list] of S.neigh) { const a = S.nodes.get(id); if (!a || !a.pos) continue; const sa = P(a.pos.lat, a.pos.lon); for (const nb of list) { const b = S.nodes.get(nb.id); if (!b || !b.pos) continue; const sb = P(b.pos.lat, b.pos.lon); g.beginPath(); g.moveTo(sa.sx, sa.sy); g.lineTo(sb.sx, sb.sy); g.stroke(); } }
    g.setLineDash([]); g.globalAlpha = 1;
  }
  if (L.links && me) {
    g.lineWidth = 2; g.globalAlpha = 0.8;
    for (const n of S.nodes.values()) { if (n.num === S.me || !n.pos || n.hops !== 0) continue; if (L.activeOnly && now - (n.lastHeard || 0) > 7200) continue; const s = P(n.pos.lat, n.pos.lon); g.strokeStyle = snrColor(n.snr); g.beginPath(); g.moveTo(me.sx, me.sy); g.lineTo(s.sx, s.sy); g.stroke(); }
    g.globalAlpha = 1;
  }
  // 8) waypoints
  S.map.hit = [];
  if (L.waypoints) for (const w of S.waypoints.values()) {
    if (w.expire && w.expire < now) continue;
    const s = P(w.lat, w.lon);
    g.fillStyle = "#f59e0b"; g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(s.sx, s.sy - 9); g.lineTo(s.sx + 8, s.sy); g.lineTo(s.sx, s.sy + 9); g.lineTo(s.sx - 8, s.sy); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = css("--ink"); g.font = "11px system-ui,sans-serif"; g.textAlign = "left"; g.fillText((w.icon ? w.icon + " " : "") + w.name, s.sx + 11, s.sy + 4);
    S.map.hit.push({ key: "w" + w.id, sx: s.sx, sy: s.sy });
  }
  // 9) nodos
  let any = 0, blink = false;
  if (L.nodes) for (const n of S.nodes.values()) {
    if (!n.pos) continue;
    if (L.activeOnly && n.num !== S.me && now - (n.lastHeard || 0) > 7200) continue;
    const s = P(n.pos.lat, n.pos.lon);
    if (s.sx < -20 || s.sy < -20 || s.sx > W + 20 || s.sy > H + 20) continue;
    const isMe = n.num === S.me; any++;
    const stt = L.color === "estado" ? nodeStatus(n) : null, blinkOn = stt && stt.blink, ph = Math.floor(Date.now() / 600) % 2 === 0;
    if (blinkOn) { blink = true; const r0 = (isMe ? 9 : 7); g.beginPath(); g.arc(s.sx, s.sy, r0 + (ph ? 9 : 4), 0, 7); g.fillStyle = "rgba(239,68,68," + (ph ? 0.28 : 0.12) + ")"; g.fill(); }
    g.beginPath(); g.arc(s.sx, s.sy, isMe ? 9 : 7, 0, 7); g.fillStyle = blinkOn && !ph ? "#7f1d1d" : isMe && !stt ? css("--acc") : nodeColor(n); g.fill();
    g.lineWidth = S.map.sel === n.num ? 3 : 1.5; g.strokeStyle = S.map.sel === n.num ? css("--ink") : "#fff"; g.stroke();
    if (stt && stt.k !== "ok") { g.fillStyle = stt.k === "warn" ? "#000" : "#fff"; g.font = "bold 10px system-ui,sans-serif"; g.textAlign = "center"; g.fillText(stt.k === "down" ? "×" : stt.k === "panic" ? "!" : stt.k === "warn" ? "▲" : "?", s.sx, s.sy + 3.5); g.textAlign = "left"; }
    if (isFav(n)) { g.beginPath(); g.arc(s.sx, s.sy, (isMe ? 9 : 7) + 3.5, 0, 7); g.lineWidth = 2.5; g.strokeStyle = "#f5b301"; g.stroke(); }
    if (L.labels) { g.fillStyle = css("--ink"); g.font = "11px system-ui,sans-serif"; g.textAlign = "left"; g.fillText((isFav(n) ? "★ " : "") + nodeShort(n), s.sx + 12, s.sy + 4); }
    S.map.hit.push({ key: n.num, sx: s.sx, sy: s.sy });
  }
  S.map.blink = blink; mapStatChips();
  if (!any && L.nodes) { g.fillStyle = css("--mut"); g.font = "14px system-ui,sans-serif"; g.textAlign = "left"; g.fillText("Ningún nodo informó su posición todavía.", 20, 30); }
  showInfo(); { const ib = $("#mapinfo"); if (ib) [...ib.childNodes].forEach((x) => x.nodeType === 3 && /^(null|undefined)+$/.test(x.textContent) && x.remove()); } showLegend(); mapAttribution();
}
function mapStatChips() {
  const box = $("#mapstat"); if (!box) return; const c = { ok: 0, warn: 0, down: 0, panic: 0 };
  for (const n of S.nodes.values()) { const k = nodeStatus(n).k; if (c[k] != null) c[k]++; }
  box.replaceChildren(el("span", { class: "sc", title: "Activos" }, el("i", { class: "stdot stok" }), c.ok + (c.ok === 1 ? " activo" : " activos")), el("span", { class: "sc", title: "Batería baja o señal débil" }, el("i", { class: "stdot stwarn" }), c.warn + " en atención"), el("span", { class: "sc", title: "Nodos caídos" }, el("i", { class: "stdot stdown" + (c.down ? " blink" : "") }), c.down + (c.down === 1 ? " caído" : " caídos")), el("span", { class: "sc", title: "Alertas de pánico sin atender" }, el("i", { class: "stdot stpanic" + (c.panic ? " blink" : "") }), c.panic + (c.panic === 1 ? " alerta" : " alertas")));
}
function showLegend() {
  const box = $("#maplegend"); if (!box) return;
  const items = [];
  if (S.map.L.coverage || S.map.L.links) items.push(["Señal (SNR)", LEGENDS.snr]);
  if (S.map.L.color !== "ident" && S.map.L.nodes) items.push([{ estado: "Nodos: estado", snr: "Señal (SNR)", battery: "Nodos: batería", age: "Nodos: antigüedad" }[S.map.L.color], LEGENDS[S.map.L.color]]);
  const seen = new Set(), list = items.filter(([t]) => !seen.has(t) && seen.add(t));
  box.style.display = list.length ? "" : "none";
  if (!box.dataset.min) box.dataset.min = innerWidth < 600 ? "1" : "0";
  if (box.dataset.min === "1") { box.replaceChildren(el("button", { class: "lgtoggle", onclick: () => { box.dataset.min = "0"; showLegend(); } }, "Leyenda ▸")); return; }
  box.replaceChildren(el("button", { class: "lgtoggle", onclick: () => { box.dataset.min = "1"; showLegend(); } }, "Leyenda ▾"), ...list.map(([t, its]) => el("div", { class: "lg" }, el("b", {}, t), el("div", { class: "lgi" }, its.map(([col, l]) => el("span", {}, el("i", { style: `background:${col}` }), l))))));
}
function pickNode(e) {
  const c = $("#mapc"), r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 16;
  for (const h of S.map.hit || []) { const d = Math.hypot(h.sx - x, h.sy - y); if (d < bd) { bd = d; best = h.key; } }
  S.map.sel = best; drawMap();
}
function showInfo() {
  const box = $("#mapinfo"); if (!box) return;
  const sel = S.map.sel;
  if (sel == null) { box.style.display = "none"; return; }
  box.style.display = ""; box.replaceChildren();
  if (typeof sel === "string") {
    const w = S.waypoints.get(+sel.slice(1)); if (!w) { box.style.display = "none"; return; }
    box.append(el("b", {}, (w.icon ? w.icon + " " : "") + w.name), el("small", {}, "Waypoint"), w.desc ? el("div", {}, w.desc) : null, el("div", {}, w.lat.toFixed(5) + ", " + w.lon.toFixed(5)), el("div", { class: "chips" }, el("button", { class: "mini acc", onclick: () => openExternal(gmapsDir(w.lat, w.lon)) }, "🧭 Cómo llegar (Google Maps)")));
    return;
  }
  const n = S.nodes.get(sel); if (!n || !n.pos) { box.style.display = "none"; return; }
  const mp = mePos(); let dist = null;
  if (mp && n.num !== S.me) dist = fmtDist(hav(mp.lat, mp.lon, n.pos.lat, n.pos.lon)) + " al " + compass(bearing(mp.lat, mp.lon, n.pos.lat, n.pos.lon));
  const t = S.tele.get(n.num) || {}, dm = t.device && t.device.last, em = t.env && t.env.last;
  const hopsTxt = n.num === S.me ? "Este nodo" : n.hops == null ? (n.viaMqtt ? "Vía MQTT (sin dato de saltos)" : "Sin dato") : (n.hops === 0 ? "Directo (0 saltos)" : n.hops + (n.hops === 1 ? " salto" : " saltos")) + (n.viaMqtt ? " · vía MQTT" : "");
  box.append(el("div", { class: "infohead" }, el("b", {}, nodeName(n)), n.num !== S.me ? favBtn(n, "big") : null), el("small", {}, nodeId(n.num) + (n.user ? " · " + enumName(Mesh.HardwareModel, n.user.hwModel) : "") + (n.user ? " · " + roleLabel(n) : "")),
    (() => { const st = nodeStatus(n); return el("div", { class: "infokv" }, stDot(n), el("b", { style: "color:" + ST_COL[st.k] }, ST_LBL[st.k]), el("small", {}, st.why.length ? " · " + st.why.join(" · ") : ""), st.k === "panic" ? el("button", { class: "mini ack", onclick: () => ackAlert(n.num) }, "Marcar atendida") : null); })(),
    el("div", {}, "Posición: " + n.pos.lat.toFixed(5) + ", " + n.pos.lon.toFixed(5)),
    el("div", { class: "infokv" }, el("span", {}, "⛰ Altura s. n. m.: "), el("b", {}, n.pos.alt != null && (n.pos.alt || n.pos.alt === 0) && n.pos.alt !== 0 ? Math.round(n.pos.alt) + " m" : "sin dato")),
    el("div", { class: "infokv" }, el("span", {}, "↗ Saltos: "), el("b", {}, hopsTxt)),
    dist ? el("div", {}, "Distancia: " + dist) : null,
    el("div", {}, "Visto " + ago(n.lastHeard) + (n.snr != null ? " · SNR " + n.snr.toFixed(1) + " dB" : "") + (n.rssi != null ? " · RSSI " + n.rssi : "")),
    dm && dm.batteryLevel !== undefined ? el("div", {}, "Batería: " + fmtTele("batteryLevel", dm.batteryLevel) + (dm.voltage ? " · " + dm.voltage.toFixed(2) + " V" : "")) : null,
    em && em.temperature !== undefined ? el("div", {}, "Temperatura: " + em.temperature.toFixed(1) + " °C" + (em.relativeHumidity !== undefined ? " · " + em.relativeHumidity.toFixed(0) + " % HR" : "")) : null,
    el("div", { class: "chips" }, el("button", { class: "mini acc", onclick: () => openExternal(gmapsDir(n.pos.lat, n.pos.lon)) }, "🧭 Cómo llegar (Google Maps)"), mp && n.num !== S.me ? el("button", { class: "mini", onclick: () => openExternal(gmapsDir(n.pos.lat, n.pos.lon, mp)) }, "Desde mi nodo") : null, el("button", { class: "mini", onclick: () => navigator.clipboard.writeText(n.pos.lat.toFixed(6) + ", " + n.pos.lon.toFixed(6)).then(() => toast("Coordenadas copiadas")) }, "Copiar coordenadas"), n.num !== S.me ? el("button", { class: "mini", onclick: () => openDM(n.num) }, "Mensaje directo") : null, el("button", { class: "mini", onclick: () => { S.tui.node = n.num; S.tui.tab = "detail"; S.tui.metric = null; setView("tele"); } }, "Ver telemetría"), el("button", { class: "mini", onclick: () => openNodeSheet(n.num) }, "Detalle del nodo")));
}

/* ───────────────────────── informe imprimible / PDF ───────────────────────── */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fDate = (t) => dtf("fdate", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(t);
const fDT = (t) => dtf("fdt", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(t);
const fTime = (t) => dtf("ftime", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(t);
const tzName = () => { try { const o = -new Date().getTimezoneOffset(), h = Math.floor(Math.abs(o) / 60), m = Math.abs(o) % 60; return Intl.DateTimeFormat().resolvedOptions().timeZone + " (UTC" + (o < 0 ? "-" : "+") + String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ")"; } catch (e) { return ""; } };
const yn = (v) => (v ? "Sí" : "No");
function pskKind(c) {
  const n = c && c.settings && c.settings.psk ? c.settings.psk.length : 0;
  return n === 0 ? "Sin cifrado" : n === 1 ? "Clave pública por defecto (índice " + c.settings.psk[0] + ")" : n === 16 ? "AES-128" : n === 32 ? "AES-256" : n + " bytes";
}
const PRIO = { 0: "—", 1: "mínima", 10: "baja", 64: "por defecto", 70: "confiable", 100: "respuesta", 120: "alta", 127: "alarma", 128: "máxima" };

/* metadatos de radio de un mensaje (se llama al recibirlo) */
function pktMeta(pkt, bytes) {
  if (!pkt) return {};
  const o = {};
  if (pkt.rxSnr) o.snr = pkt.rxSnr;
  if (pkt.rxRssi) o.rssi = pkt.rxRssi;
  if (pkt.hopStart) { o.hopStart = pkt.hopStart; o.hopLimit = pkt.hopLimit; o.hops = Math.max(0, pkt.hopStart - pkt.hopLimit); }
  if (pkt.viaMqtt) o.mqtt = true;
  if (pkt.pkiEncrypted) o.pki = true;
  if (pkt.relayNode) o.relay = pkt.relayNode;
  if (pkt.wantAck) o.wantAck = true;
  if (pkt.priority) o.prio = pkt.priority;
  if (bytes) o.bytes = bytes;
  return o;
}

/* ── ventana de opciones ── */
function openPrintDialog() {
  const cur = S.conv;
  const o = { scope: "cur", range: "all", from: "", to: "", detail: "full", cover: true, nodes: true, chans: true, order: "asc" };
  const sel = (id, opts, val) => el("select", { class: "inp", id, "aria-label": id, onchange: (e) => (o[id] = e.target.value) }, opts.map(([v, l]) => el("option", { value: v, selected: v === val }, l)));
  const ck = (key, label) => el("label", { class: "ck" }, el("input", { type: "checkbox", checked: o[key], onchange: (e) => (o[key] = e.target.checked) }), el("span", {}, label));
  const count = el("small", { class: "muted" }, "");
  const upd = () => { const n = reportMessages(o).length; count.textContent = n + (n === 1 ? " mensaje" : " mensajes") + " en el informe"; };
  const re = (id, opts, val) => { const s = sel(id, opts, val); s.addEventListener("change", upd); return s; };
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() },
    el("div", { class: "mbox" },
      el("h3", {}, "Imprimir / guardar chat en PDF"),
      el("div", { class: "row2" }, el("label", {}, "Qué conversaciones", re("scope", [["cur", "Solo esta: " + convTitle(cur)], ["ch", "Todos los canales"], ["dm", "Todos los mensajes directos"], ["all", "Todo (canales y directos)"]], "cur"))),
      el("div", { class: "row2" }, el("label", {}, "Período", re("range", [["all", "Todo el historial"], ["today", "Hoy"], ["24h", "Últimas 24 horas"], ["7d", "Últimos 7 días"], ["custom", "Personalizado…"]], "all")),
        el("label", {}, "Orden", re("order", [["asc", "Más antiguos primero"], ["desc", "Más nuevos primero"]], "asc"))),
      el("div", { class: "row2", id: "customrange", style: "display:none" }, el("label", {}, "Desde", el("input", { class: "inp", type: "date", onchange: (e) => { o.from = e.target.value; upd(); } })), el("label", {}, "Hasta", el("input", { class: "inp", type: "date", onchange: (e) => { o.to = e.target.value; upd(); } }))),
      el("div", { class: "row2" }, el("label", {}, "Nivel de detalle", re("detail", [["full", "Completo: todos los datos de cada mensaje"], ["compact", "Compacto: hora, remitente y texto"]], "full"))),
      el("div", { class: "lsec" }, "Incluir en el informe"),
      ck("cover", "Portada con resumen y estadísticas"), ck("nodes", "Datos del nodo local y tabla de participantes"), ck("chans", "Configuración de los canales y de la radio (sin claves)"),
      count,
      el("div", { class: "mfoot" },
        el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cancelar"),
        el("button", { class: "btn ghost", onclick: () => { const h = buildReport(o); if (h) download("chat-lora-mesh.html", new Blob([h], { type: "text/html" })); } }, "Guardar como HTML"),
        el("button", { class: "btn", onclick: () => { if (printReport(o)) dlg.remove(); } }, "Imprimir / PDF"))),
  );
  $("#app").append(dlg);
  dlg.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => { $("#customrange").style.display = o.range === "custom" ? "" : "none"; }));
  upd();
}

/* ── selección de mensajes ── */
function reportMessages(o) {
  let list = S.msgs.filter((m) => (o.scope === "cur" ? convOf(m) === S.conv : o.scope === "ch" ? !m.dm : o.scope === "dm" ? m.dm : true));
  const now = Date.now(); let from = 0, to = Infinity;
  if (o.range === "today") { const d = new Date(); d.setHours(0, 0, 0, 0); from = +d; }
  else if (o.range === "24h") from = now - 86400000;
  else if (o.range === "7d") from = now - 7 * 86400000;
  else if (o.range === "custom") { if (o.from) from = +new Date(o.from + "T00:00:00"); if (o.to) to = +new Date(o.to + "T23:59:59"); }
  list = list.filter((m) => m.t >= from && m.t <= to).sort((a, b) => a.t - b.t);
  return o.order === "desc" ? list.reverse() : list;
}

/* ── generación del informe ── */
function buildReport(o) {
  const msgs = reportMessages(o);
  if (!msgs.length) { toast("No hay mensajes para ese período y esas conversaciones", "err"); return ""; }
  const full = o.detail === "full", me = S.nodes.get(S.me), now = Date.now();
  const lora = S.cfg.lora, dev = S.cfg.device;
  const convs = new Map();
  for (const m of msgs) { const k = convOf(m); if (!convs.has(k)) convs.set(k, []); convs.get(k).push(m); }
  const keys = [...convs.keys()].sort((a, b) => (a[1] === b[1] ? a.localeCompare(b, undefined, { numeric: true }) : a[1] === "h" ? -1 : 1));
  const tMin = Math.min(...msgs.map((m) => m.t)), tMax = Math.max(...msgs.map((m) => m.t));
  const sent = msgs.filter((m) => m.mine), recv = msgs.filter((m) => !m.mine);
  const snrs = recv.map((m) => m.snr).filter((v) => typeof v === "number"), rssis = recv.map((m) => m.rssi).filter((v) => typeof v === "number");
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const who = (m) => { const n = S.nodes.get(m.from); return { long: (n && n.user && n.user.longName) || m.fn || (m.mine && me ? nodeName(me) : nodeName(n || { num: m.from })), short: (n && n.user && n.user.shortName) || m.sn || nodeShort(n || { num: m.from }) }; };
  const dest = (m) => (m.dm ? (m.mine ? nameOf(m.to) : m.to === S.me ? "Vos (mensaje directo)" : nameOf(m.to)) : "Todos · " + chName(m.ch));
  const stTxt = (m) => (!m.mine ? "" : m.st === "ok" ? (m.dm ? "Entregado ✓" : "Enviado ✓") : m.st === "fail" ? "Falló" + (m.why ? ": " + m.why : "") : "Sin confirmar");
  const kv = (rows) => `<table class="kv">${rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== "").map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const title = o.scope === "cur" ? convTitle(S.conv).replace(/^# /, "") : { ch: "Todos los canales", dm: "Mensajes directos", all: "Todas las conversaciones" }[o.scope];

  let h = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>OPEN SOURCE PARIZ — Chat Sistema LoRa Mesh — ${esc(title)}</title><style>${REPORT_CSS}@page{@bottom-left{content:${JSON.stringify("OPEN SOURCE PARIZ · Chat Sistema LoRa Mesh · " + title + " · generado el " + fDT(now))};font:9px system-ui,sans-serif;color:#64748b}}</style></head><body>`;
  /* portada */
  h += `<header class="top"><div class="logo">M</div><div><h1>Registro de mensajes del sistema LoRa Mesh</h1><div class="sub">${esc(title)}</div></div></header>`;
  if (o.cover) {
    const topS = {}; for (const m of msgs) { const w = who(m); const k = m.from; topS[k] = topS[k] || { n: 0, name: w.long }; topS[k].n++; }
    const tops = Object.values(topS).sort((a, b) => b.n - a.n).slice(0, 8);
    h += `<section><h2>Resumen</h2><div class="grid2">${kv([
      ["Generado", fDT(now)], ["Zona horaria", tzName()], ["Alcance", { cur: "Una conversación: " + convTitle(S.conv), ch: "Todos los canales", dm: "Todos los mensajes directos", all: "Todas las conversaciones" }[o.scope]],
      ["Período del informe", fDT(tMin) + "  →  " + fDT(tMax)], ["Duración cubierta", fmtUp((tMax - tMin) / 1000)],
    ])}${kv([
      ["Mensajes en total", msgs.length], ["Enviados por este nodo", sent.length], ["Recibidos", recv.length],
      ["Conversaciones incluidas", keys.length], ["Participantes distintos", new Set(msgs.map((m) => m.from)).size],
      ["Caracteres en total", msgs.reduce((a, m) => a + [...m.text].length, 0)],
      ["Enviados confirmados", sent.length ? sent.filter((m) => m.st === "ok").length + " de " + sent.length : "—"],
      ["Enviados con falla", sent.filter((m) => m.st === "fail").length || undefined],
      ["SNR medio de recibidos", avg(snrs) != null ? avg(snrs).toFixed(1) + " dB (mín " + Math.min(...snrs).toFixed(1) + " · máx " + Math.max(...snrs).toFixed(1) + ")" : undefined],
      ["RSSI medio de recibidos", avg(rssis) != null ? avg(rssis).toFixed(0) + " dBm" : undefined],
      ["Recibidos por MQTT", recv.filter((m) => m.mqtt).length || undefined],
      ["Enviados también por MQTT", sent.filter((m) => m.up === "ok" || m.up === "node").length || undefined],
      ["Enviados sin salir a MQTT (en cola o falla)", sent.filter((m) => m.up === "queued" || m.up === "fail").length || undefined],
    ])}</div>
    ${tops.length > 1 ? `<h3>Quién más escribió</h3><table class="tbl"><tr><th>Participante</th><th class="r">Mensajes</th><th>Proporción</th></tr>${tops.map((t) => `<tr><td>${esc(t.name)}</td><td class="r">${t.n}</td><td><span class="bar" style="width:${Math.max(2, Math.round((t.n / msgs.length) * 100))}%"></span> ${Math.round((t.n / msgs.length) * 100)} %</td></tr>`).join("")}</table>` : ""}</section>`;
  }
  /* nodo local */
  if (o.nodes) {
    const t = (S.tele.get(S.me) || {}), dm = (t.device && t.device.last) || {}, em = (t.env && t.env.last) || {}, lc = (t.local && t.local.last) || {};
    const mi = { ...(S.myInfo || {}), ...(S.metaObj || {}) };
    h += `<section><h2>Nodo local</h2><div class="grid2">${kv([
      ["Nombre", me ? nodeName(me) : "—"], ["Nombre corto", me ? nodeShort(me) : "—"], ["ID de nodo", nodeId(S.me)], ["Número de nodo", S.me],
      ["Modelo de hardware", me && me.user ? enumName(Mesh.HardwareModel, me.user.hwModel) : mi.hwModel], ["Rol", me && me.user ? enumName(C.Config_DeviceConfig_Role, me.user.role) : (dev ? enumName(C.Config_DeviceConfig_Role, dev.role) : "")],
      ["Radioaficionado licenciado", me && me.user ? yn(me.user.isLicensed) : undefined], ["Firmware", mi.firmwareVersion], ["Reinicios", mi.rebootCount], ["Entorno PlatformIO", mi.pioEnv],
      ["WiFi / Bluetooth / Ethernet", mi.hasWifi !== undefined ? [yn(mi.hasWifi), yn(mi.hasBluetooth), yn(mi.hasEthernet)].join(" / ") : undefined],
    ])}${kv([
      ["Posición", me && me.pos ? me.pos.lat.toFixed(6) + ", " + me.pos.lon.toFixed(6) + (me.pos.alt ? " · " + me.pos.alt + " m s. n. m." : "") : "Sin posición"],
      ["Batería", dm.batteryLevel !== undefined ? fmtTele("batteryLevel", dm.batteryLevel) : undefined], ["Tensión", dm.voltage !== undefined ? dm.voltage.toFixed(2) + " V" : undefined],
      ["Uso del canal", (lc.channelUtilization ?? dm.channelUtilization) !== undefined ? (lc.channelUtilization ?? dm.channelUtilization).toFixed(1) + " %" : undefined], ["Aire usado en TX", (lc.airUtilTx ?? dm.airUtilTx) !== undefined ? (lc.airUtilTx ?? dm.airUtilTx).toFixed(2) + " %" : undefined],
      ["Tiempo encendido", (lc.uptimeSeconds ?? dm.uptimeSeconds) !== undefined ? fmtUp(lc.uptimeSeconds ?? dm.uptimeSeconds) : undefined],
      ["Temperatura / humedad / presión", em.temperature !== undefined ? em.temperature.toFixed(1) + " °C" + (em.relativeHumidity !== undefined ? " · " + em.relativeHumidity.toFixed(0) + " %" : "") + (em.barometricPressure !== undefined ? " · " + em.barometricPressure.toFixed(0) + " hPa" : "") : undefined],
      ["Nodos conocidos", S.nodes.size], ["Paquetes TX / RX / dañados", lc.numPacketsTx !== undefined ? [lc.numPacketsTx, lc.numPacketsRx, lc.numPacketsRxBad].join(" / ") : undefined],
    ])}</div></section>`;
  }
  /* radio y canales */
  if (o.chans) {
    h += `<section><h2>Radio y canales</h2>`;
    if (lora) h += `<div class="grid2">${kv([
      ["Región", enumName(C.Config_LoRaConfig_RegionCode, lora.region)], ["Preset de módem", lora.usePreset ? enumName(C.Config_LoRaConfig_ModemPreset, lora.modemPreset) : "Parámetros manuales"],
      ["Límite de saltos", lora.hopLimit], ["Transmisión habilitada", yn(lora.txEnabled)], ["Potencia de TX", lora.txPower ? lora.txPower + " dBm" : "Máxima permitida"],
      ["Slot de frecuencia", lora.channelNum || "Automático"], ["Offset de frecuencia", lora.frequencyOffset ? lora.frequencyOffset + " MHz" : undefined],
    ])}${kv([["Ignorar paquetes MQTT", yn(lora.ignoreMqtt)], ["Permitir subir a MQTT", yn(lora.configOkToMqtt)], ["Ganancia RX reforzada", yn(lora.sx126xRxBoostedGain)], ["Ignorar duty cycle", yn(lora.overrideDutyCycle)]])}</div>`;
    const chs = S.channels.map((c, i) => [c, i]).filter(([c, i]) => c && c.role !== 0 && (o.scope === "dm" ? false : o.scope === "cur" ? (S.conv.startsWith("ch") ? i === +S.conv.slice(2) : false) : true));
    if (chs.length) h += `<h3>Canales</h3><table class="tbl"><tr><th>#</th><th>Nombre</th><th>Rol</th><th>Cifrado</th><th>MQTT subir / bajar</th><th>Posición</th><th class="r">Mensajes</th></tr>${chs.map(([c, i]) => `<tr><td>${i}</td><td class="nw"><b>${esc(chName(i))}</b></td><td class="nw">${["Desactivado", "Primario", "Secundario"][c.role]}</td><td>${esc(pskKind(c))}</td><td class="nw">${yn(c.settings && c.settings.uplinkEnabled)} / ${yn(c.settings && c.settings.downlinkEnabled)}</td><td class="nw">${c.settings && c.settings.moduleSettings && c.settings.moduleSettings.positionPrecision ? c.settings.moduleSettings.positionPrecision + " bits" : "No comparte"}</td><td class="r">${msgs.filter((m) => !m.dm && m.ch === i).length}</td></tr>`).join("")}</table><p class="note">Por seguridad el informe no incluye las claves de los canales.</p>`;
    h += `</section>`;
  }
  /* participantes */
  if (o.nodes) {
    const ids = [...new Set(msgs.flatMap((m) => [m.from, ...(m.dm ? [m.to] : [])]))].filter((n) => n && n !== 0xffffffff);
    const mp = mePos();
    h += `<section><h2>Participantes</h2><table class="tbl small"><tr><th>Nodo</th><th>ID</th><th>Modelo / rol</th><th class="r">Msgs</th><th>Última vez</th><th>Señal</th><th>Batería</th><th>Posición / distancia</th></tr>${ids.map((id) => {
      const n = S.nodes.get(id) || { num: id }, cnt = msgs.filter((m) => m.from === id).length;
      const dst = mp && n.pos && id !== S.me ? fmtDist(hav(mp.lat, mp.lon, n.pos.lat, n.pos.lon)) + " al " + compass(bearing(mp.lat, mp.lon, n.pos.lat, n.pos.lon)) : "";
      const sig = id === S.me ? "—" : (n.snr != null ? n.snr.toFixed(1) + " dB" : "—") + "<br>" + (n.hops != null ? (n.hops === 0 ? "directo" : n.hops + (n.hops === 1 ? " salto" : " saltos")) : "");
      return `<tr><td><b>${esc(nodeName(n))}</b>${n.user ? `<br><span class="muted">${esc(nodeShort(n))}</span>` : ""}${id === S.me ? ' <span class="tag">este nodo</span>' : ""}</td><td class="mono nw">${nodeId(id)}</td><td>${n.user ? esc(enumName(Mesh.HardwareModel, n.user.hwModel)) + "<br><span class=\"muted\">" + esc(enumName(C.Config_DeviceConfig_Role, n.user.role)) + "</span>" : "—"}</td><td class="r">${cnt}</td><td class="nw">${n.lastHeard ? esc(fDT(n.lastHeard * 1000)).replace(", ", "<br>") : "—"}</td><td class="nw">${sig}</td><td class="nw">${n.battery != null ? esc(battText(n.battery)) : "—"}</td><td class="mono">${n.pos ? n.pos.lat.toFixed(4) + ", " + n.pos.lon.toFixed(4) : "—"}${dst ? "<br>" + esc(dst) : ""}</td></tr>`;
    }).join("")}</table></section>`;
  }
  /* mensajes */
  for (const k of keys) {
    const list = convs.get(k);
    const head = k.startsWith("ch") ? "Canal " + k.slice(2) + " · " + chName(+k.slice(2)) : "Mensajes directos con " + nameOf(+k.slice(2)) + " (" + nodeId(+k.slice(2)) + ")";
    h += `<section class="conv"><h2>${esc(head)}</h2><div class="convsub">${list.length} ${list.length === 1 ? "mensaje" : "mensajes"} · ${esc(fDT(Math.min(...list.map((m) => m.t))))} → ${esc(fDT(Math.max(...list.map((m) => m.t))))}</div>`;
    let lastDay = "";
    for (const m of list) {
      const day = fDate(m.t);
      if (day !== lastDay) { h += `<div class="day">${esc(day)}</div>`; lastDay = day; }
      const w = who(m);
      if (!full) { h += `<div class="cmsg ${m.mine ? "mine" : ""}"><span class="ct">${fTime(m.t)}</span> <b>${esc(w.long)}</b>: ${esc(m.text)}</div>`; continue; }
      const chips = [];
      chips.push(["ID msg", "!" + hex8(m.id)]);
      if (m.snr !== undefined) chips.push(["SNR", m.snr.toFixed(2) + " dB"]);
      if (m.rssi !== undefined) chips.push(["RSSI", m.rssi + " dBm"]);
      if (m.hops !== undefined) chips.push(["Saltos", (m.hops === 0 ? "directo" : m.hops) + " (" + m.hopLimit + "/" + m.hopStart + " restantes)"]);
      if (m.relay) chips.push(["Retransmitido por", "…" + (m.relay & 0xff).toString(16).padStart(2, "0")]);
      if (m.dist != null) chips.push(["Distancia", fmtDist(m.dist)]);
      if (m.sPos) chips.push(["Posición emisor", m.sPos.lat.toFixed(5) + ", " + m.sPos.lon.toFixed(5)]);
      chips.push(["Cifrado", m.pki ? "PKI (mensaje directo)" : m.dm ? (m.mine ? "lo decide el nodo (PKI si ambos tienen clave)" : "clave de canal") : pskKind(S.channels[m.ch])]);
      if (m.mine) chips.push(["Vía de envío", "LoRa" + ({ ok: " + MQTT (broker)", queued: " · MQTT pendiente (en cola)", pending: " · MQTT enviando", fail: " · MQTT falló" + (m.upWhy ? " (" + m.upWhy + ")" : ""), node: " + MQTT (por el proxy del nodo)", na: " · MQTT no aplica a directos" }[m.up] || "")]);
      else chips.push(["Vía de recepción", m.gw ? "MQTT (gateway " + m.gw + ")" : m.mqtt ? "LoRa, retransmitido por un gateway MQTT" : "LoRa"]);
      if (m.prio) chips.push(["Prioridad", PRIO[m.prio] || m.prio]);
      chips.push(["Tamaño", (m.bytes || new TextEncoder().encode(m.text).length) + " bytes · " + [...m.text].length + " car."]);
      chips.push(["Destino", dest(m)]);
      chips.push(["Canal", m.ch + " · " + chName(m.ch)]);
      h += `<article class="msg ${m.mine ? "mine" : ""}"><div class="mh"><span class="when">${esc(fDT(m.t))}</span><span class="who"><b>${esc(w.long)}</b> <span class="muted">[${esc(w.short)}] ${nodeId(m.from)}</span></span>${m.mine ? '<span class="tag">enviado</span>' : ""}${m.dm ? '<span class="tag dm">directo</span>' : ""}${m.mine ? `<span class="st ${m.st}">${esc(stTxt(m))}</span>` : ""}</div><div class="mt">${esc(m.text)}</div><div class="mm">${chips.map(([a, b]) => `<span><i>${esc(a)}</i> ${esc(b)}</span>`).join("")}</div></article>`;
    }
    h += `</section>`;
  }
  h += `<footer class="end">Fin del informe · ${msgs.length} mensajes · generado por OPEN SOURCE PARIZ (portal local del sistema LoRa Mesh).</footer></body></html>`;
  return h;
}

function printReport(o) {
  const html = buildReport(o); if (!html) return false;
  const old = $("#printframe"); if (old) old.remove();
  const f = el("iframe", { id: "printframe", style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden" });
  document.body.append(f);
  const d = f.contentDocument; d.open(); d.write(html); d.close();
  const go = () => { try { printFrame(f); toast("En la ventana de impresión elegí “Guardar como PDF” como destino.", "ok"); } catch (e) { toast("No se pudo abrir la impresión: " + (e.message || e), "err"); } };
  setTimeout(go, 350);
  return true;
}
window.__print = { buildReport, reportMessages };

const REPORT_CSS = `
@page{size:A4;margin:16mm 14mm 18mm 14mm;@bottom-right{content:"Página " counter(page) " de " counter(pages);font:9px system-ui,sans-serif;color:#64748b}}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font:11px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#0f172a;margin:0}
.muted{color:#64748b}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px}.r{text-align:right}
.top{display:flex;gap:14px;align-items:center;border-bottom:3px solid #67ea94;padding-bottom:10px;margin-bottom:14px}
.logo{width:42px;height:42px;border-radius:10px;background:#67ea94;color:#0b3d1d;display:grid;place-items:center;font-weight:800;font-size:22px}
h1{margin:0;font-size:22px}.sub{font-size:14px;color:#334155;margin-top:2px}
h2{font-size:14px;margin:18px 0 8px;padding:5px 8px;background:#eef2f6;border-left:4px solid #2563eb;break-after:avoid}
h3{font-size:12px;margin:12px 0 6px;break-after:avoid}
section{margin-bottom:6px}
.grid2{break-inside:avoid;display:grid;grid-template-columns:1fr 1fr;gap:0 18px}
table{border-collapse:collapse;width:100%}
.kv th{width:42%;text-align:left;font-weight:600;color:#475569;padding:3px 6px 3px 0;border-bottom:1px solid #e2e8f0;vertical-align:top}
.kv td{padding:3px 0;border-bottom:1px solid #e2e8f0;vertical-align:top;word-break:break-word}
.tbl th{background:#f1f5f9;text-align:left;padding:4px 6px;border:1px solid #e2e8f0;font-size:10px}
.tbl td{padding:4px 6px;border:1px solid #e2e8f0;vertical-align:top;overflow-wrap:break-word}
.nw{white-space:nowrap}
.tbl.small{font-size:9.5px}.tbl tr{break-inside:avoid}
.bar{display:inline-block;height:7px;background:#2563eb;border-radius:3px;vertical-align:middle;max-width:70%}
.note{font-size:9.5px;color:#64748b;margin:4px 0}
.tag{display:inline-block;background:#dbeafe;color:#1e40af;border-radius:99px;padding:0 7px;font-size:9px;font-weight:700}.tag.dm{background:#e0e7ff;color:#3730a3}
.convsub{color:#64748b;font-size:10px;margin:-2px 0 6px}
.day{margin:12px 0 6px;font-weight:700;color:#334155;border-bottom:1px dashed #cbd5e1;padding-bottom:2px;break-after:avoid}
.day::first-letter{text-transform:uppercase}
.msg{border:1px solid #e2e8f0;border-left:4px solid #94a3b8;border-radius:6px;padding:6px 9px;margin:5px 0;break-inside:avoid;background:#fff}
.msg.mine{border-left-color:#2563eb;background:#eff6ff}
.mh{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.when{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#475569}
.mt{font-size:12.5px;margin:3px 0 4px;white-space:pre-wrap;overflow-wrap:anywhere}
.mm{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:9px;color:#475569;border-top:1px solid #e2e8f0;padding-top:3px}
.mm i{font-style:normal;color:#94a3b8;margin-right:2px}
.st{margin-left:auto;font-size:9.5px;font-weight:700}.st.ok{color:#15803d}.st.fail{color:#dc2626}.st.pending{color:#d97706}
.cmsg{padding:2px 0;border-bottom:1px solid #f1f5f9;break-inside:avoid;overflow-wrap:anywhere}.cmsg.mine{background:#eff6ff}.ct{font-family:ui-monospace,Menlo,Consolas,monospace;color:#64748b;font-size:10px}
.end{margin-top:18px;border-top:1px solid #cbd5e1;padding-top:6px;color:#64748b;font-size:9.5px;text-align:center}
`;



/* ───────────────────────── Topología: enlaces observados vs. rutas inferidas ───────────────────────── */
S.traces = []; try { S.traces = JSON.parse(localStorage.getItem("meshportal:traces") || "[]"); } catch (e) {}
S.neighT = new Map();
const TP_KEY = "meshportal:topo", TP_DEF = { maxAge: 86400, direct: true, neigh: true, trace: true, infer: true };
const tpCfg = () => { let u = {}; try { u = JSON.parse(localStorage.getItem(TP_KEY) || "{}"); } catch (e) {} return { ...TP_DEF, ...u }; };
const tpSave = (o) => { try { localStorage.setItem(TP_KEY, JSON.stringify({ ...tpCfg(), ...o })); } catch (e) {} };
S.topo = { sel: null, k: 1, tx: 0, ty: 0, fitted: false, model: null, hover: null };
const linkHist = (num) => (S.tele.get(num) && S.tele.get(num).link && S.tele.get(num).link.hist) || [];
function lastDirect(n) { /* última vez que se escuchó al nodo SIN repetidores y por radio */
  const h = linkHist(n.num);
  for (let i = h.length - 1; i >= 0; i--) { const x = h[i]; if (x.hops === 0 && !x.mqtt) return { t: x.t, snr: x.snr, rssi: x.rssi }; }
  if (n.hops === 0 && !n.viaMqtt && n.lastHeard) return { t: n.lastHeard * 1000, snr: n.snr, rssi: n.rssi };
  return null;
}
const EV_RANK = { direct: 3, trace: 2, neigh: 2, infer: 0 };
const EV_TXT = {
  direct: ["Enlace directo observado", "Tu nodo recibió paquetes de este nodo sin ningún repetidor en el medio (saltos = 0). Medición propia."],
  neigh: ["Informado por un vecino (NeighborInfo)", "Uno de los dos nodos declara escuchar al otro directamente. La medición la hizo ese nodo; tu nodo no la verificó."],
  trace: ["Observado en un traceroute", "El paquete de traceroute pasó realmente por este tramo y cada nodo anotó el SNR con que lo recibió. Vale para el momento de la medición."],
  infer: ["INFERIDO · no confirmado", "No hay ninguna medición de este tramo. Se deduce de los saltos del paquete y del último byte del ID del repetidor: puede ser otro nodo o una cadena más larga."],
};
function topoModel() {
  const c = tpCfg(), now = Date.now(), cut = c.maxAge ? now - c.maxAge * 1000 : 0, me = S.me;
  const nodes = new Map(), edges = new Map();
  const add = (num) => { if (!nodes.has(num)) nodes.set(num, { num, n: S.nodes.get(num) || { num, user: null, pos: null, lastHeard: 0, snr: null, rssi: null, hops: null }, cls: "unk", ring: null, parent: null, traceHops: null }); return nodes.get(num); };
  const ev = (a, b, e) => { const k = a < b ? a + "-" + b : b + "-" + a; let x = edges.get(k); if (!x) { x = { k, a: Math.min(a, b), b: Math.max(a, b), ev: [] }; edges.set(k, x); } x.ev.push(e); };
  const mo = add(me); mo.cls = "me"; mo.ring = 0;
  for (const n of S.nodes.values()) { if (n.num === me) continue; if (cut && (n.lastHeard || 0) * 1000 < cut) continue; add(n.num); }
  /* 1) enlaces directos observados por tu nodo */
  for (const o of nodes.values()) { if (o.num === me) continue; const d = lastDirect(o.n); if (d && (!cut || d.t >= cut)) { o.cls = "direct"; o.ring = 1; if (c.direct) ev(me, o.num, { kind: "direct", snr: d.snr, rssi: d.rssi, hops: 0, t: d.t, by: me }); } }
  /* 2) tablas de vecinos informadas por otros nodos */
  for (const [rep, list] of S.neigh) {
    const t = S.neighT.get(rep) || 0; if (cut && t && t < cut) continue;
    add(rep); for (const nb of list) { if (!nb.id) continue; add(nb.id); if (c.neigh) ev(rep, nb.id, { kind: "neigh", snr: nb.snr, rssi: null, hops: 0, t, by: rep });
      if (rep === me) { const o = nodes.get(nb.id); if (o.cls !== "direct") { o.cls = "direct"; o.ring = 1; } } }
  }
  /* 3) rutas medidas con traceroute */
  for (const tr of S.traces) {
    if (cut && tr.t < cut) continue;
    const paths = [[[tr.me, ...tr.route, tr.dest], tr.snrT, "ida"], [[tr.dest, ...tr.back, tr.me], tr.snrB, "vuelta"]];
    for (const [pth, snr, dir] of paths) {
      if (pth.length < 2 || (dir === "vuelta" && !tr.back.length && !(tr.snrB || []).length)) continue;
      const hops = pth.length - 1; const mine = dir === "ida" ? pth : [...pth].reverse();
      mine.forEach((num, i) => { const o = add(num); if (o.traceHops == null || i < o.traceHops) o.traceHops = i; });
      pth.forEach((num, i) => { if (i < pth.length - 1) { add(num); add(pth[i + 1]); if (c.trace) ev(num, pth[i + 1], { kind: "trace", snr: snr[i] ?? null, rssi: null, hops: 1, total: hops, t: tr.t, by: tr.me, dir }); } });
    }
  }
  /* 4) clasificar el resto; las inferencias van aparte y siempre quedan marcadas como tales */
  for (const o of nodes.values()) {
    if (o.num === me || o.cls === "direct") continue; const n = o.n;
    if (n.hops != null && n.hops >= 1 && !n.viaMqtt) { o.cls = "relayed"; o.ring = o.traceHops != null ? Math.max(2, o.traceHops) : n.hops + 1; }
    else if (o.traceHops != null) { o.cls = "relayed"; o.ring = Math.max(2, o.traceHops); }
    else if (n.viaMqtt) o.cls = "mqtt";
  }
  for (const o of nodes.values()) { /* los que solo aparecen en la tabla de vecinos de otro nodo */
    if (o.cls !== "unk" || o.num === me) continue;
    for (const e of edges.values()) { if (e.a !== o.num && e.b !== o.num) continue; const other = nodes.get(e.a === o.num ? e.b : e.a); if (other && other.ring != null) { o.cls = "reported"; o.ring = other.ring + 1; o.parent = other.num; break; } }
  }
  for (const o of nodes.values()) {
    if (o.cls !== "relayed" || !c.infer) continue; const n = o.n;
    const hasTr = [...edges.values()].some((e) => (e.a === o.num || e.b === o.num) && e.ev.some((x) => x.kind === "trace"));
    if (hasTr) continue;
    const cands = n.relay ? [...nodes.values()].filter((x) => x.cls === "direct" && x.num !== o.num && (x.num & 255) === n.relay) : [];
    const t = n.relayT || (n.lastHeard || 0) * 1000;
    if (cands.length === 1) { o.parent = cands[0].num; o.relayCand = cands[0].num; ev(cands[0].num, o.num, { kind: "infer", hops: n.hops, t, by: me, relay: n.relay, cand: 1 }); }
    else { o.relayAmb = cands.length; ev(me, o.num, { kind: "infer", hops: n.hops, t, by: me, relay: n.relay, cand: cands.length, unknown: true }); }
  }
  for (const e of edges.values()) { /* el nodo que cuelga de otro nodo (para ubicarlo cerca en el dibujo) */
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) { const ox = nodes.get(x), oy = nodes.get(y); if (ox && oy && oy.parent == null && oy.ring != null && ox.ring != null && ox.ring === oy.ring - 1 && ox.num !== me) oy.parent = x; }
  }
  return { nodes, edges, cut };
}
function topoLayout(M) {
  const pos = new Map(), R0 = 130, dR = 105, byRing = new Map(), SEP = 86, kids = new Map();
  pos.set(S.me, { x: 0, y: 0, a: 0, r: 0 });
  for (const o of M.nodes.values()) if (o.ring >= 1) { if (!byRing.has(o.ring)) byRing.set(o.ring, []); byRing.get(o.ring).push(o); }
  let maxR = R0;
  for (const r of [...byRing.keys()].sort((a, b) => a - b)) {
    const list = byRing.get(r), rad = Math.max(R0 + (r - 1) * dR, (list.length * SEP) / (2 * Math.PI)); maxR = Math.max(maxR, rad);
    for (const o of list) { const pp = o.parent != null && pos.get(o.parent); if (!pp) { o.want = null; continue; } const i = kids.get(o.parent) || 0; kids.set(o.parent, i + 1); o.want = pp.a + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.34; }
    const free = list.filter((o) => o.want == null); free.forEach((o, i) => (o.want = (i / Math.max(1, free.length)) * 2 * Math.PI + r * 0.4));
    list.sort((a, b) => a.want - b.want || a.num - b.num);
    const sep = SEP / rad; let ang = list.map((o) => o.want);
    for (let i = 1; i < ang.length; i++) ang[i] = Math.max(ang[i], ang[i - 1] + sep);
    if (ang.length > 1 && ang[ang.length - 1] - ang[0] > 2 * Math.PI - sep) ang = ang.map((_, i) => (ang[0] + (i / ang.length) * 2 * Math.PI));
    list.forEach((o, i) => pos.set(o.num, { x: Math.cos(ang[i]) * rad, y: Math.sin(ang[i]) * rad, a: ang[i], r: rad }));
  }
  const bands = []; let y = maxR + 130;
  for (const [cls, title] of [["mqtt", "Llegan por Internet (MQTT): sin enlace de radio verificado"], ["unk", "Sin datos suficientes para ubicarlos"]]) {
    const list = [...M.nodes.values()].filter((o) => o.cls === cls); if (!list.length) continue;
    const per = 9; bands.push({ title, y: y - 44, rows: Math.ceil(list.length / per), cls });
    list.forEach((o, i) => pos.set(o.num, { x: ((i % per) - (Math.min(per, list.length) - 1) / 2) * 92, y: y + Math.floor(i / per) * 84, a: 0, r: 0 }));
    y += Math.ceil(list.length / per) * 84 + 90;
  }
  return { pos, rings: [...byRing.keys()].map((r) => ({ r, rad: Math.max(R0 + (r - 1) * dR, (byRing.get(r).length * SEP) / (2 * Math.PI)) })), bands, maxR };
}
const SVGNS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) { if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c)); return e; };
const evOf = (e) => e.ev.slice().sort((x, y) => EV_RANK[y.kind] - EV_RANK[x.kind] || y.t - x.t);
function viewTopo(m) {
  const c = tpCfg();
  const sel = el("select", { class: "inp", "aria-label": "Antigüedad máxima de las mediciones", onchange: (e) => { tpSave({ maxAge: +e.target.value }); S.topo.fitted = false; topoDraw(); } }, [[3600, "1 hora"], [21600, "6 horas"], [86400, "24 horas"], [604800, "7 días"], [0, "Todo lo guardado"]].map(([v, l]) => el("option", { value: v, selected: c.maxAge === v }, l)));
  const ck = (k, label, cls) => el("label", { class: "ck tpk " + cls }, el("input", { type: "checkbox", checked: c[k], onchange: (e) => { tpSave({ [k]: e.target.checked }); S.topo.sel = null; topoDraw(); topoPanel(); } }), el("span", {}, label));
  m.append(el("div", { class: "topoview" },
    el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Topología de la red"), el("small", { class: "muted" }, "Qué nodos se escuchan directamente, qué rutas se conocen y cuáles dependen de repetidores.")),
      el("div", { class: "phr" }, el("label", { class: "gdl" }, "Mediciones de los últimos", sel), el("button", { class: "btn ghost", onclick: () => { S.topo.fitted = false; topoDraw(); } }, "Ajustar vista"))),
    el("div", { class: "tpbar" }, ck("direct", "Enlaces directos observados", "k-direct"), ck("neigh", "Informados por vecinos", "k-neigh"), ck("trace", "Medidos con traceroute", "k-trace"), ck("infer", "Rutas inferidas (no confirmadas)", "k-infer"), el("span", { id: "tpsum", class: "tpsum" })),
    el("div", { class: "tpwrap" }, el("div", { id: "tpcanvas", class: "tpcanvas" }), el("aside", { id: "tppanel", class: "tppanel" }))));
  const host = $("#tpcanvas"); S.topo.host = host; topoMount(host); topoDraw(); topoPanel();
}
function topoMount(host) {
  const T = S.topo, svg = sv("svg", { class: "tpsvg", width: "100%", height: "100%" }), g = sv("g", { id: "tpg" }); svg.append(g); host.replaceChildren(svg);
  host.append(el("div", { class: "tplegend" },
    el("div", { class: "tpl" }, el("i", { class: "ln direct" }), "Observado directo (color = SNR)"), el("div", { class: "tpl" }, el("i", { class: "ln neigh" }), "Informado por vecino"), el("div", { class: "tpl" }, el("i", { class: "ln trace" }), "Medido en traceroute"), el("div", { class: "tpl" }, el("i", { class: "ln infer" }), "Inferido (no confirma conexión)"),
    el("div", { class: "tpl small" }, "● directo · ▢ llega con repetidores · ⬚ sin enlace de radio"), el("div", { class: "tpl small" }, "La distancia en el dibujo no es la distancia real.")),
    el("div", { class: "tpzoom" }, el("button", { class: "mini", onclick: () => zoomBy(1.25) }, "＋"), el("button", { class: "mini", onclick: () => zoomBy(1 / 1.25) }, "－")));
  const apply = () => g.setAttribute("transform", `translate(${T.tx} ${T.ty}) scale(${T.k})`); T.apply = apply;
  const zoomBy = (f, mx, my) => { const r = svg.getBoundingClientRect(); mx = mx ?? r.width / 2; my = my ?? r.height / 2; const k = Math.min(4, Math.max(0.2, T.k * f)); T.tx = mx - (mx - T.tx) * (k / T.k); T.ty = my - (my - T.ty) * (k / T.k); T.k = k; apply(); };
  svg.addEventListener("wheel", (e) => { e.preventDefault(); const r = svg.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => { if (e.target.closest(".tpn,.tpe")) return; drag = { x: e.clientX, y: e.clientY, tx: T.tx, ty: T.ty, moved: false }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; T.tx = drag.tx + dx; T.ty = drag.ty + dy; apply(); });
  svg.addEventListener("pointerup", () => { if (drag && !drag.moved && T.sel) { T.sel = null; topoMarcar(); topoPanel(); } drag = null; });
}
let tpTimer = 0; const topoSoon = () => { clearTimeout(tpTimer); tpTimer = setTimeout(() => { if (S.view === "topo") { topoDraw(); topoPanel(); } }, 700); };
/* Elegir un nodo o un enlace solo cambia qué está resaltado: con cientos de nodos,
   rehacer todo el dibujo tardaba un cuarto de segundo en cada clic. Ahora se marca en el sitio. */
function topoMarcar() {
  const g = $("#tpg"); if (!g) return; const sel = S.topo.sel;
  for (const n of g.querySelectorAll(".tpn.sel")) n.classList.remove("sel");
  for (const e of g.querySelectorAll(".tpe-g.sel")) e.classList.remove("sel");
  if (!sel) return;
  const q = sel.type === "node" ? '.tpn[data-id="' + sel.id + '"]' : '.tpe-g[data-k="' + CSS.escape(String(sel.id)) + '"]';
  const el2 = g.querySelector(q); if (el2) el2.classList.add("sel");
}
function topoDraw() {
  const g = $("#tpg"); if (!g) return; const T = S.topo, M = topoModel(), L = topoLayout(M); T.model = M; T.lay = L;
  const kids = [];
  for (const r of L.rings) kids.push(sv("circle", { class: "tpring", r: r.rad }), sv("text", { class: "tprl", x: 0, y: -r.rad - 5, "text-anchor": "middle" }, r.r === 1 ? "Directos (0 saltos)" : r.r - 1 + (r.r === 2 ? " salto" : " saltos")));
  for (const b of L.bands) kids.push(sv("rect", { class: "tpband", x: -470, y: b.y, width: 940, height: b.rows * 84 + 52, rx: 14 }), sv("text", { class: "tprl", x: -456, y: b.y + 20 }, b.title));
  const pos = L.pos, sorted = [...M.edges.values()].sort((a, b) => EV_RANK[evOf(a)[0].kind] - EV_RANK[evOf(b)[0].kind]);
  for (const e of sorted) {
    const pa = pos.get(e.a), pb = pos.get(e.b); if (!pa || !pb) continue; const top = evOf(e)[0], age = (Date.now() - top.t) / 1000;
    const col = top.kind === "direct" ? snrColor(top.snr) : null, sl = T.sel && T.sel.type === "edge" && T.sel.id === e.k;
    const cls = "tpe " + top.kind + (age > 21600 ? " old" : "");
    kids.push(sv("g", { class: "tpe-g" + (sl ? " sel" : ""), "data-k": e.k, onclick: (ev) => { ev.stopPropagation(); T.sel = { type: "edge", id: e.k }; topoMarcar(); topoPanel(); } },
      sv("line", { class: cls, x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, style: col ? "stroke:" + col : null }),
      sv("line", { class: "tpe-hit", x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }),
      top.kind === "infer" ? sv("text", { class: "tpelb", x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - 4, "text-anchor": "middle" }, "inferido") : null,
      top.kind !== "infer" ? sv("text", { class: "tpelb" + (top.kind === "direct" ? "" : " alseleccionar"), x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 - 4, "text-anchor": "middle" }, top.snr != null ? top.snr.toFixed(1) + " dB" : "") : null));
  }
  /* Con muchísimos nodos los nombres largos se pisan y no se leen; además son la mitad
     del dibujo. Pasados los 120 se muestran solo al elegir el nodo, en el panel de al lado. */
  const conNombres = M.nodes.size <= 120;
  for (const o of M.nodes.values()) {
    const p = pos.get(o.num); if (!p) continue; const n = o.n, me = o.num === S.me, st = nodeStatus(n), sl = T.sel && T.sel.type === "node" && T.sel.id === o.num, rr = me ? 22 : 17;
    const fill = `hsl(${(o.num * 47) % 360} 55% 42%)`, ring = ST_COL[st.k];
    const shape = o.cls === "relayed" || o.cls === "reported" ? sv("rect", { x: -rr, y: -rr, width: rr * 2, height: rr * 2, rx: 6, fill, stroke: ring, "stroke-width": 3 }) : o.cls === "mqtt" ? sv("rect", { x: -rr, y: -rr, width: rr * 2, height: rr * 2, rx: 6, fill, stroke: ring, "stroke-width": 3, "stroke-dasharray": "4 3" }) : sv("circle", { r: rr, fill, stroke: ring, "stroke-width": 3, "stroke-dasharray": o.cls === "unk" ? "2 3" : null });
    kids.push(sv("g", { class: "tpn" + (sl ? " sel" : "") + (st.blink ? " blink" : ""), "data-id": o.num, transform: `translate(${p.x} ${p.y})`, onclick: (ev) => { ev.stopPropagation(); T.sel = { type: "node", id: o.num }; topoMarcar(); topoPanel(); } },
      sv("circle", { r: rr + 7, class: "tpselring" }), shape, sv("text", { class: "tpsn", "text-anchor": "middle", y: 3.5 }, nodeShort(n).slice(0, 4)), conNombres || me || sl ? sv("text", { class: "tpln", "text-anchor": "middle", y: rr + 14 }, nodeName(n).slice(0, 22) + (me ? " (vos)" : "")) : null));
  }
  g.replaceChildren(...kids);
  if (!T.fitted) { const host = T.host, W = host.clientWidth || 800, H = host.clientHeight || 600; let minX = -150, maxX = 150, minY = -150, maxY = 150; for (const p of pos.values()) { minX = Math.min(minX, p.x - 60); maxX = Math.max(maxX, p.x + 60); minY = Math.min(minY, p.y - 60); maxY = Math.max(maxY, p.y + 60); } const k = Math.min(1.2, Math.min(W / (maxX - minX), H / (maxY - minY))); T.k = k; T.tx = W / 2 - ((minX + maxX) / 2) * k; T.ty = H / 2 - ((minY + maxY) / 2) * k; T.fitted = true; }
  T.apply();
  const cnt = (cl) => [...M.nodes.values()].filter((o) => o.cls === cl).length, ne = [...M.edges.values()], obs = ne.filter((e) => e.ev.some((x) => x.kind !== "infer")).length, inf = ne.length - obs;
  const sm = $("#tpsum"); if (sm) sm.textContent = `Directos ${cnt("direct")} · con repetidores ${cnt("relayed") + cnt("reported")} · solo MQTT ${cnt("mqtt")} · sin datos ${cnt("unk")} · enlaces observados ${obs} · inferidos ${inf}`;
}
function topoPanel() {
  const box0 = $("#tppanel"); if (!box0) return; const box = { replaceChildren: (...k) => box0.replaceChildren(...k.flat().filter((x) => x != null && x !== false)) }; const T = S.topo, M = T.model; if (!M) return;
  const row = (k, v, cls) => el("div", { class: "tprow " + (cls || "") }, el("span", {}, k), el("b", {}, v));
  const fmtT = (t) => (t ? ago(t / 1000) + " (" + fDT(t) + ")" : "sin dato");
  if (T.sel && T.sel.type === "edge" && M.edges.has(T.sel.id)) {
    const e = M.edges.get(T.sel.id), A = M.nodes.get(e.a), B = M.nodes.get(e.b), evs = evOf(e), confirmed = evs.some((x) => x.kind !== "infer");
    box.replaceChildren(el("h3", {}, nodeShort(A.n) + " ↔ " + nodeShort(B.n)), el("small", { class: "muted" }, nodeName(A.n) + "  ↔  " + nodeName(B.n)),
      el("div", { class: "tpbadge " + (confirmed ? "ok" : "inf") }, confirmed ? "Hay al menos una medición que lo confirma" : "SOLO INFERIDO: no hay medición que confirme este enlace"),
      ...evs.map((x) => el("div", { class: "tpev " + x.kind }, el("b", {}, EV_TXT[x.kind][0] + (x.kind === "trace" ? " (" + x.dir + ")" : "")), el("small", {}, EV_TXT[x.kind][1]),
        row("RSSI", x.rssi != null ? x.rssi + " dBm" : x.kind === "direct" ? "no registrado" : "no informado por este método"),
        row("SNR", x.snr != null ? x.snr.toFixed(1) + " dB" : "no informado"),
        row("Saltos", x.kind === "direct" || x.kind === "neigh" ? "0 (enlace directo)" : x.kind === "trace" ? "1 tramo · ruta completa de " + x.total + (x.total === 1 ? " salto" : " saltos") : (x.hops != null ? x.hops + " en total hasta el nodo (repetidores intermedios desconocidos)" : "desconocidos")),
        row("Antigüedad de la medición", x.kind === "infer" ? "deducido de un paquete: " + fmtT(x.t) : fmtT(x.t)),
        row("Medido por", x.by != null ? nameOf(x.by) + (x.by === S.me ? " (tu nodo)" : "") : "—"),
        x.kind === "infer" ? el("div", { class: "tpwarn" }, x.unknown ? (x.cand > 1 ? "Hay " + x.cand + " nodos directos cuyo ID termina igual que el último repetidor (0x" + (x.relay || 0).toString(16).padStart(2, "0") + "): no se puede saber cuál fue. " : x.relay ? "Ningún nodo directo conocido coincide con el repetidor (0x" + x.relay.toString(16).padStart(2, "0") + "). " : "El paquete no trae el repetidor. ") + "Se dibuja desde tu nodo solo para marcar que depende de repetidores; no significa conexión directa." : "Coincide con un solo nodo directo, pero el último byte del ID no es una prueba: es una hipótesis." + (x.hops > 1 ? " Además, entre ese repetidor y el nodo hay otros saltos que no se conocen." : "")) : null)));
    return;
  }
  if (T.sel && T.sel.type === "node" && M.nodes.has(T.sel.id)) {
    const o = M.nodes.get(T.sel.id), n = o.n, st = nodeStatus(n), me = o.num === S.me;
    const cls = { me: "Tu nodo", direct: "Se escucha directamente (observado)", relayed: "Llega a través de repetidores" + (n.hops ? ": " + n.hops + (n.hops === 1 ? " salto" : " saltos") : ""), reported: "Aparece solo en la tabla de vecinos de otro nodo", mqtt: "Llega solo por Internet (MQTT): no hay enlace de radio verificado", unk: "Sin datos suficientes para saber cómo se conecta" }[o.cls];
    const links = [...M.edges.values()].filter((e) => e.a === o.num || e.b === o.num);
    const dn = (me ? null : lastDirect(n));
    box.replaceChildren(el("h3", {}, nodeName(n)), el("small", { class: "muted" }, nodeId(o.num) + (n.user ? " · " + roleLabel(n) : "")),
      el("div", { class: "tpbadge " + (o.cls === "direct" || me ? "ok" : o.cls === "relayed" ? "rep" : "inf") }, cls),
      row("Estado", ST_LBL[st.k] + (st.why.length ? " · " + st.why.join(" · ") : "")),
      !me ? row("Última vez escuchado", n.lastHeard ? ago(n.lastHeard) : "sin dato") : null,
      !me ? row("Saltos del último paquete", n.viaMqtt && n.hops == null ? "no aplica (por MQTT)" : n.hops == null ? "sin dato (el paquete no traía el contador)" : String(n.hops)) : null,
      !me && dn ? row("Última medición directa", fmtT(dn.t)) : null,
      !me && dn ? row("SNR / RSSI directos", (dn.snr != null ? dn.snr.toFixed(1) + " dB" : "—") + " / " + (dn.rssi != null ? dn.rssi + " dBm" : "—")) : null,
      !me && !dn && n.snr != null ? el("div", { class: "tpwarn" }, "El SNR (" + n.snr.toFixed(1) + " dB) y el RSSI del último paquete corresponden al ÚLTIMO TRAMO que llegó a tu nodo, desde un repetidor; no miden el enlace con este nodo.") : null,
      o.relayAmb != null ? el("div", { class: "tpwarn" }, o.relayAmb > 1 ? "El último repetidor podría ser cualquiera de " + o.relayAmb + " nodos directos." : "No se pudo identificar el último repetidor entre los nodos directos conocidos.") : null,
      el("div", { class: "lsec" }, "Enlaces (" + links.length + ")"),
      links.length ? el("div", { class: "tplinks" }, ...links.map((e) => { const other = M.nodes.get(e.a === o.num ? e.b : e.a), top = evOf(e)[0]; return el("button", { class: "tplk " + top.kind, onclick: () => { T.sel = { type: "edge", id: e.k }; topoDraw(); topoPanel(); } }, el("i", { class: "ln " + top.kind }), el("span", {}, nodeName(other.n)), el("small", {}, EV_TXT[top.kind][0].split(" (")[0])); })) : el("small", { class: "muted" }, "Ningún enlace con los datos y filtros actuales."),
      !me ? el("div", { class: "chips" }, el("button", { class: "mini acc", onclick: () => nodeAction("trace", n) }, "Trazar ruta (traceroute)"), n.pos ? el("button", { class: "mini", onclick: () => { S.map.sel = o.num; setView("map"); } }, "Ver en el mapa") : null) : null,
      el("small", { class: "muted" }, "El traceroute es la única forma de confirmar los tramos intermedios: al recibir la respuesta, esos tramos pasan de inferidos a observados."));
    return;
  }
  box.replaceChildren(el("h3", {}, "Cómo leer este diagrama"),
    el("div", { class: "tpev direct" }, el("b", {}, "Línea continua de color"), el("small", {}, "Enlace directo observado por tu nodo: recibió paquetes del otro sin repetidores. El color indica el SNR.")),
    el("div", { class: "tpev neigh" }, el("b", {}, "Línea continua azul / violeta"), el("small", {}, "Otro nodo informó escuchar a su vecino (NeighborInfo) o un traceroute pasó por ese tramo. Está medido, pero no por tu nodo.")),
    el("div", { class: "tpev infer" }, el("b", {}, "Línea punteada"), el("small", {}, "Inferencia. Solo indica que el nodo llega con saltos; no afirma que exista una conexión directa entre los dos extremos dibujados.")),
    el("small", { class: "muted" }, "Tocá un nodo o un enlace para ver RSSI, SNR, saltos y la antigüedad de la medición. Rueda del mouse para acercar, arrastrar para mover."));
}
window.__topo = { topoModel, topoLayout, lastDirect };

/* ───────────────────────── Novedades y Libro de Guardia: filtro por horas y exportación a Excel / PDF ───────────────────────── */
const GD_KEY = "meshportal:guardia";
const gdMeta = () => { let u = {}; try { u = JSON.parse(localStorage.getItem(GD_KEY) || "{}"); } catch (e) {} return { unit: "", chief: "", notes: "", ...u }; };
const gdSave = (o) => { try { localStorage.setItem(GD_KEY, JSON.stringify({ ...gdMeta(), ...o })); } catch (e) {} };
const GD_CATS = [["ch", "Mensajes de canales"], ["dm", "Mensajes directos"], ["panic", "Alertas de pánico"], ["down", "Nodos caídos / recuperados"], ["warn", "Batería baja / señal débil"], ["link", "Conexión del nodo local"]];
const gdF = { preset: "24h", from: 0, to: 0, cats: { ch: true, dm: true, panic: true, down: true, warn: true, link: true }, crit: false, q: "", node: "", desc: false };
const toLocalInput = (t) => { const d = new Date(t); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" + p2(d.getHours()) + ":" + p2(d.getMinutes()); };
const fUTC = (t) => new Date(t).toISOString().slice(0, 19).replace("T", " ") + " Z";
function gdRange() {
  const now = Date.now(), d0 = new Date(); d0.setHours(0, 0, 0, 0);
  switch (gdF.preset) {
    case "8h": return [now - 8 * 3600e3, now]; case "12h": return [now - 12 * 3600e3, now]; case "24h": return [now - 24 * 3600e3, now];
    case "today": return [+d0, now]; case "yesterday": return [+d0 - 864e5, +d0 - 1];
    default: return [gdF.from || now - 864e5, gdF.to || now];
  }
}
function gdEntries() {
  const [a, b] = gdRange(), out = [], c = gdF.cats, ev = S.events.filter((e) => e.t >= a && e.t <= b);
  const cat = (k) => (k === "panic" || k === "panicout" || k === "ack" ? "panic" : k === "down" || k === "up" ? "down" : k === "lowbatt" || k === "weak" ? "warn" : "link");
  for (const e of ev) { const [ic, lbl, crit] = EV_KINDS[e.kind] || ["•", e.kind, false]; if (!c[cat(e.kind)]) continue; out.push({ t: e.t, kind: e.kind, icon: ic, label: lbl, node: e.name || "", detail: e.text || "", crit, chan: "" }); }
  const panicEv = ev.filter((e) => e.kind === "panic");
  for (const m of S.msgs) {
    if (m.t < a || m.t > b) continue;
    const alert = isAlertText(m.text);
    if (alert && !m.mine) { if (!c.panic) continue; if (panicEv.some((e) => e.num === m.from && Math.abs(e.t - m.t) < 8000)) continue; out.push({ t: m.t, kind: "panic", icon: "🚨", label: "Alerta de pánico recibida", node: m.fn || nameOf(m.from), detail: m.text, crit: true, chan: convTitle(convOf(m)) }); continue; }
    if (m.dm ? !c.dm : !c.ch) continue;
    const who = m.mine ? "Este nodo" : m.fn || nameOf(m.from);
    out.push({ t: m.t, kind: m.dm ? "dm" : "ch", icon: m.dm ? "✉" : "💬", label: (m.dm ? "Mensaje directo " : "Mensaje de canal ") + (m.mine ? "enviado" : "recibido"), node: who, detail: m.text, crit: alert, chan: m.dm ? (m.mine ? "→ " + nameOf(m.to) : "de " + who) : "# " + chName(m.ch) });
  }
  let list = out; if (gdF.crit) list = list.filter((x) => x.crit);
  if (gdF.node) list = list.filter((x) => x.node === gdF.node);
  const q = gdF.q.trim().toLowerCase(); if (q) list = list.filter((x) => (x.node + " " + x.detail + " " + x.label + " " + x.chan).toLowerCase().includes(q));
  list.sort((x, y) => x.t - y.t); if (gdF.desc) list.reverse(); return list;
}
function gdNodeNames() { const set = new Set(); for (const e of S.events) if (e.name) set.add(e.name); for (const m of S.msgs) set.add(m.mine ? "Este nodo" : m.fn || nameOf(m.from)); return [...set].sort((a, b) => a.localeCompare(b)); }
let gdUpd = null;
function updGuardia() { if (gdUpd) gdUpd(); }
/* ───────────────────────── parte de situación ─────────────────────────
   Un resumen corto del estado de la red, armado para leerse por radio o pegarse en un
   informe: quién está, quién no, con qué batería y qué pasó en el período. */
function parteTexto(horas) {
  const ahora = Date.now(), desde = ahora - horas * 3600000, c = opsCfg(), meta = gdMeta();
  const L = [];
  const nodos = [...S.nodes.values()];
  const clasif = { ok: [], warn: [], down: [], unk: [], panic: [] };
  for (const n of nodos) clasif[nodeStatus(n).k].push(n);
  const nom = (n) => nodeName(n) + " (" + nodeId(n.num) + ")";

  L.push("PARTE DE SITUACIÓN — RED LORA MESH");
  if (meta.unit) L.push("Puesto: " + meta.unit);
  if (meta.chief) L.push("Operador: " + meta.chief);
  L.push("Fecha y hora: " + fDT(ahora) + "   (UTC " + fUTC(ahora) + ")");
  L.push("Período informado: últimas " + horas + (horas === 1 ? " hora" : " horas"));
  L.push("");

  L.push("1. ESTACIÓN PROPIA");
  const yo = S.nodes.get(S.me);
  if (yo) {
    L.push("   Nodo: " + nom(yo));
    const d = (S.tele.get(S.me) || {}).device;
    if (d && d.last) {
      if (d.last.batteryLevel != null) L.push("   Batería: " + fmtTele("batteryLevel", d.last.batteryLevel) + (d.last.voltage ? " · " + fmtTele("voltage", d.last.voltage) : ""));
      if (d.last.channelUtilization != null) L.push("   Uso del canal: " + fmtTele("channelUtilization", d.last.channelUtilization) + (d.last.airUtilTx != null ? " · aire en TX " + fmtTele("airUtilTx", d.last.airUtilTx) : ""));
    }
  } else L.push("   Sin nodo conectado.");
  const conex = S.demo ? "modo demo (sin nodo real)" : S.conn ? (CONN_NAME[S.conn.type] || S.conn.type) + (S.conn.address ? " · " + S.conn.address : "") : "sin conexión";
  L.push("   Enlace con el módulo: " + conex);
  const mqCon = S.mq && S.mq.srv ? S.mq.srv.filter((x) => x && x.st === "on").length : 0;
  const mqPed = S.mq && S.mq.cfg ? S.mq.cfg.servers.filter((x) => x.enabled && (x.url || x.host)).length : 0;
  L.push("   Internet: " + (navigator.onLine ? "sí" : "NO") + " · MQTT: " + mqCon + " de " + mqPed + " servidores conectados");
  L.push("");

  L.push("2. NODOS DE LA MALLA (" + nodos.length + " conocidos)");
  L.push("   Activos: " + clasif.ok.length + " · en atención: " + clasif.warn.length + " · caídos: " + clasif.down.length + " · sin datos: " + clasif.unk.length + " · con alerta: " + clasif.panic.length);
  const fila = (n, extra) => "     - " + nom(n) + (n.lastHeard ? " · visto " + ago(n.lastHeard) : " · nunca escuchado") + (extra ? " · " + extra : "");
  if (clasif.panic.length) { L.push("   CON ALERTA DE PÁNICO SIN ATENDER:"); for (const n of clasif.panic) L.push(fila(n, (S.alerts.get(n.num) || {}).text || "")); }
  if (clasif.down.length) { L.push("   CAÍDOS (sin señal hace más de " + c.downMin + " min):"); for (const n of clasif.down) L.push(fila(n)); }
  if (clasif.warn.length) { L.push("   EN ATENCIÓN:"); for (const n of clasif.warn) L.push(fila(n, nodeStatus(n).why.join(" · "))); }
  if (clasif.ok.length) { L.push("   ACTIVOS:"); for (const n of clasif.ok) L.push(fila(n, [n.battery != null ? (n.battery > 100 ? "alimentado (USB/cargador)" : "batería " + Math.round(n.battery) + " %") : "", n.snr != null ? "SNR " + n.snr.toFixed(1) + " dB" : "", n.hops != null ? (n.hops === 0 ? "directo" : n.hops + " salto" + (n.hops === 1 ? "" : "s")) : ""].filter(Boolean).join(" · "))); }
  if (clasif.unk.length) { L.push("   SIN DATOS SUFICIENTES:"); for (const n of clasif.unk) L.push(fila(n)); }
  L.push("");

  L.push("3. MOVIMIENTO EN EL PERÍODO");
  const msgs = S.msgs.filter((x) => x.t >= desde);
  L.push("   Mensajes: " + msgs.length + " (" + msgs.filter((x) => x.mine).length + " propios, " + msgs.filter((x) => !x.mine).length + " recibidos)");
  const fallados = msgs.filter((x) => x.mine && (x.st === "retry" || x.st === "fail"));
  if (fallados.length) L.push("   Mensajes propios sin confirmar: " + fallados.length);
  const evs = (S.logs || []).filter((x) => x.t >= desde);
  const porTipo = {};
  for (const e of evs) porTipo[e.kind] = (porTipo[e.kind] || 0) + 1;
  const etiq = { panic: "alertas de pánico", down: "caídas de nodo", up: "recuperaciones", lowbatt: "avisos de batería baja", weak: "avisos de señal débil", ack: "alertas atendidas", err: "errores" };
  const linea = Object.entries(porTipo).filter(([k]) => etiq[k]).map(([k, v]) => v + " " + etiq[k]);
  L.push("   Novedades registradas: " + (linea.length ? linea.join(", ") : "ninguna"));
  L.push("");

  if (meta.notes) { L.push("4. OBSERVACIONES"); for (const r of String(meta.notes).split("\n")) L.push("   " + r); L.push(""); }
  L.push("— Generado por OPEN SOURCE PARIZ, portal v" + PORTAL_VER + " —");
  return L.join("\n");
}
function abrirParte() {
  let horas = 8;
  const area = el("textarea", { class: "inp parte", rows: 20, readonly: true, "aria-label": "Texto del parte de situación" });
  const pintar = () => { area.value = parteTexto(horas); };
  const sel = el("select", { class: "inp", "aria-label": "Período del parte", onchange: (e) => { horas = +e.target.value; pintar(); } },
    [[1, "Última hora"], [8, "Últimas 8 horas"], [12, "Últimas 12 horas"], [24, "Últimas 24 horas"], [72, "Últimos 3 días"]].map(([v, t]) => el("option", { value: v, selected: v === horas }, t)));
  pintar();
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() },
    el("div", { class: "mbox partebox" },
      el("h3", {}, "Parte de situación"),
      el("p", { class: "muted" }, "Un resumen del estado de la red listo para leer por radio, copiar en un mensaje o guardar con el acta."),
      el("div", { class: "g2" }, el("label", { class: "gdl" }, "Período", sel)),
      area,
      el("div", { class: "mfoot" },
        el("button", { class: "btn", onclick: () => { copiarTexto(area.value); } }, "Copiar"),
        el("button", { class: "btn ghost", onclick: () => download("parte-situacion-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "") + ".txt", new Blob(["﻿" + area.value], { type: "text/plain;charset=utf-8" })) }, "Descargar .txt"),
        el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cerrar"))));
  document.body.append(dlg);
}
/* Copiar que también anda dentro de la app de Android. */
function copiarTexto(t) {
  const ok = () => toast("Parte copiado: ya lo podés pegar donde lo necesites", "ok");
  if (IS_APP && window.AndroidBridge && window.AndroidBridge.copyText) { window.AndroidBridge.copyText(t); ok(); return; }
  navigator.clipboard.writeText(t).then(ok, () => toast("El navegador no dejó copiar al portapapeles. Seleccioná el texto a mano y copialo con Ctrl+C.", "err"));
}
function viewGuardia(m) {
  const meta = gdMeta(), box = el("div", { class: "gdview" }); m.append(box);
  const fromIn = el("input", { class: "inp", type: "datetime-local", onchange: (e) => { gdF.preset = "custom"; gdF.from = e.target.value ? +new Date(e.target.value) : 0; sync(); upd(); } });
  const toIn = el("input", { class: "inp", type: "datetime-local", onchange: (e) => { gdF.preset = "custom"; gdF.to = e.target.value ? +new Date(e.target.value) + 59999 : 0; sync(); upd(); } });
  const preset = el("select", { class: "inp", "aria-label": "Período del libro de guardia", onchange: (e) => { gdF.preset = e.target.value; if (gdF.preset === "custom") { const [a, b] = gdRange(); gdF.from = a; gdF.to = b; } sync(); upd(); } },
    [["8h", "Últimas 8 horas"], ["12h", "Últimas 12 horas"], ["24h", "Últimas 24 horas"], ["today", "Hoy (desde las 00:00)"], ["yesterday", "Ayer"], ["custom", "Personalizado (desde / hasta)"]].map(([v, l]) => el("option", { value: v, selected: gdF.preset === v }, l)));
  const sync = () => { const [a, b] = gdRange(); fromIn.value = toLocalInput(a); toIn.value = toLocalInput(b); preset.value = gdF.preset; };
  const ck = (label, get, set) => el("label", { class: "ck" }, el("input", { type: "checkbox", checked: get(), onchange: (e) => { set(e.target.checked); upd(); } }), el("span", {}, label));
  const nodeSel = el("select", { class: "inp", "aria-label": "Filtrar por nodo", onchange: (e) => { gdF.node = e.target.value; upd(); } }, [el("option", { value: "" }, "Todos los nodos"), ...gdNodeNames().map((n) => el("option", { value: n, selected: gdF.node === n }, n))]);
  const cnt = el("div", { class: "gdcount" }), holder = el("div", { class: "tblwrap gdtbl" });
  const unit = el("input", { class: "inp", value: meta.unit, placeholder: "Ej.: Base central / Puesto", onchange: (e) => gdSave({ unit: e.target.value }) });
  const chief = el("input", { class: "inp", value: meta.chief, placeholder: "Jefe de guardia / operador", onchange: (e) => gdSave({ chief: e.target.value }) });
  const notes = el("textarea", { class: "inp", rows: 2, placeholder: "Observaciones para el acta (opcional)", onchange: (e) => gdSave({ notes: e.target.value }) }, meta.notes);
  let list = [];
  const upd = () => {
    list = gdEntries(); const crit = list.filter((x) => x.crit).length;
    cnt.replaceChildren(el("b", {}, list.length + (list.length === 1 ? " registro" : " registros")), el("span", { class: "muted" }, " · "), el("b", { class: "gdcrit" }, crit + (crit === 1 ? " crítico" : " críticos")), el("span", { class: "muted" }, " · período en hora local " + utcOff(new Date()) + " (la columna UTC se exporta aparte)"));
    if (!list.length) { holder.replaceChildren(el("div", { class: "empty" }, "No hay registros en ese período con los filtros elegidos.")); return; }
    const head = el("thead", {}, el("tr", {}, ["Fecha y hora local", "Hora UTC", "Tipo", "Nodo", "Canal / destino", "Detalle"].map((h) => el("th", {}, h))));
    vtable(holder, holder, head, list, (x) => el("tr", { class: "vrow" + (x.crit ? " crit" : "") }, el("td", { class: "nw" }, fDT(x.t)), el("td", { class: "nw" }, fUTC(x.t)), el("td", { class: "nw" }, x.icon + " " + x.label), el("td", {}, x.node), el("td", {}, x.chan), el("td", { class: "gdtx", title: x.detail }, x.detail)), 6, 40);
  };
  gdUpd = upd;
  box.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Novedades y Libro de Guardia"), el("small", { class: "muted" }, "Filtrá mensajes y eventos críticos por horario y exportalos para el acta o el libro de guardia.")),
      el("div", { class: "phr" }, el("button", { class: "btn acc", onclick: abrirParte }, "📋 Parte de situación"), el("button", { class: "btn ghost", onclick: () => gdExport("csv", list) }, "CSV"), el("button", { class: "btn ghost", onclick: () => gdExport("xlsx", list) }, "⬇ Excel (.xlsx)"), el("button", { class: "btn", onclick: () => gdExport("pdf", list) }, "🖨 PDF / Imprimir"))),
    el("div", { class: "gdpanel" },
      el("div", { class: "gdcol" }, el("div", { class: "lsec" }, "Rango de horas"), preset, el("div", { class: "g2" }, el("label", { class: "gdl" }, "Desde", fromIn), el("label", { class: "gdl" }, "Hasta", toIn)),
        el("div", { class: "lsec" }, "Orden"), ck("Más recientes primero", () => gdF.desc, (v) => (gdF.desc = v))),
      el("div", { class: "gdcol" }, el("div", { class: "lsec" }, "Qué incluir"), ...GD_CATS.map(([k, l]) => ck(l, () => gdF.cats[k], (v) => (gdF.cats[k] = v))), ck("Solo eventos críticos", () => gdF.crit, (v) => (gdF.crit = v))),
      el("div", { class: "gdcol" }, el("div", { class: "lsec" }, "Buscar"), el("input", { class: "inp", type: "search", placeholder: "Texto, nodo o canal…", value: gdF.q, oninput: (e) => { gdF.q = e.target.value; upd(); } }), nodeSel,
        el("div", { class: "lsec" }, "Datos del acta (van en el PDF y en el Excel)"), unit, chief, notes)),
    cnt, holder);
  sync(); upd();
}
/* ── exportación ── */
const csvQ = csvCell;
function gdFile(ext) { const d = new Date(); return "novedades-guardia-" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + "." + ext; }
function gdExport(kind, list) {
  if (!list.length) return toast("No hay registros para exportar con este filtro", "err");
  const meta = gdMeta(), [a, b] = gdRange();
  if (kind === "csv") { const head = "fecha_hora_local,hora_utc,tipo,critico,nodo,canal_destino,detalle\n"; return download(gdFile("csv"), new Blob(["﻿" + head + list.map((x) => [csvQ(fDT(x.t)), csvQ(fUTC(x.t)), csvQ(x.label), x.crit ? "Sí" : "No", csvQ(x.node), csvQ(x.chan), csvQ(x.detail)].join(",")).join("\n")], { type: "text/csv;charset=utf-8" })); }
  if (kind === "xlsx") return download(gdFile("xlsx"), new Blob([xlsxFor(list, meta, a, b)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  printHtml(gdHtml(list, meta, a, b));
}
function printHtml(html) {
  const old = $("#printframe"); if (old) old.remove();
  const f = el("iframe", { id: "printframe", style: "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden" });
  document.body.append(f); const d = f.contentDocument; d.open(); d.write(html); d.close();
  setTimeout(() => { try { printFrame(f); toast("En la ventana de impresión elegí “Guardar como PDF” como destino.", "ok"); } catch (e) { toast("No se pudo abrir la impresión: " + e.message, "err"); } }, 350);
}
function gdHtml(list, meta, a, b) {
  const crit = list.filter((x) => x.crit).length, by = new Map(); for (const x of list) by.set(x.label, (by.get(x.label) || 0) + 1);
  const rows = list.map((x) => `<tr class="${x.crit ? "crit" : ""}"><td class="nw">${esc(fDT(x.t))}</td><td class="nw">${esc(fUTC(x.t))}</td><td>${esc(x.icon + " " + x.label)}</td><td>${esc(x.node)}</td><td>${esc(x.chan)}</td><td class="gtx">${esc(x.detail)}</td></tr>`).join("");
  const kv = (r) => `<table class="kv">${r.filter((x) => x[1]).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const sum = [...by].sort((p, q) => q[1] - p[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="r">${n}</td></tr>`).join("");
  const filt = [GD_CATS.filter(([k]) => gdF.cats[k]).map(([, l]) => l).join(", "), gdF.crit ? "solo críticos" : "", gdF.node ? "nodo: " + gdF.node : "", gdF.q ? "texto: «" + gdF.q + "»" : ""].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Novedades y Libro de Guardia</title><style>${REPORT_CSS}@page{@bottom-left{content:"OPEN SOURCE PARIZ · Novedades y Libro de Guardia";font:9px system-ui,sans-serif;color:#64748b}}
.gtx{white-space:pre-wrap}.tbl tr.crit td{background:#fee2e2}.tbl tr.crit td:first-child{border-left:4px solid #dc2626}.sign{display:flex;gap:40px;margin-top:34px;break-inside:avoid}.sign div{flex:1;border-top:1px solid #0f172a;padding-top:4px;text-align:center;font-size:10px}.obs{border:1px solid #cbd5e1;border-radius:6px;padding:6px 9px;white-space:pre-wrap;min-height:34px}</style></head><body>
<header class="top"><div class="logo">M</div><div><h1>Novedades y Libro de Guardia</h1><div class="sub">${esc(meta.unit || "Sistema LoRa Mesh")}</div></div></header>
<section><h2>Datos</h2><div class="grid2">${kv([["Dependencia", meta.unit], ["Jefe de guardia / operador", meta.chief], ["Período (hora local)", fDT(a) + "  →  " + fDT(b)], ["Período (UTC)", fUTC(a) + "  →  " + fUTC(b)], ["Zona horaria", tzName()]])}${kv([["Generado", fDT(Date.now()) + "  ·  " + fUTC(Date.now())], ["Registros", list.length], ["Eventos críticos", crit], ["Filtros", filt]])}</div></section>
<section><h2>Resumen por tipo</h2><table class="tbl small" style="max-width:360px"><tbody>${sum}</tbody></table></section>
<section><h2>Registro cronológico</h2><table class="tbl small"><thead><tr><th>Fecha y hora local</th><th>Hora UTC</th><th>Tipo</th><th>Nodo</th><th>Canal / destino</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table>
<p class="note">Las filas sombreadas en rojo son eventos críticos (alertas de pánico, nodos caídos, batería baja).</p></section>
${meta.notes ? `<section><h2>Observaciones</h2><div class="obs">${esc(meta.notes)}</div></section>` : ""}
<div class="sign"><div>${esc(meta.chief || "Jefe de guardia / operador")}<br><span class="muted">Firma y aclaración</span></div><div>Superior que recibe<br><span class="muted">Firma y aclaración</span></div></div>
<div class="end">Informe generado por OPEN SOURCE PARIZ · ${esc(fDT(Date.now()))}</div></body></html>`;
}
/* Excel real (.xlsx) sin librerías: archivos XML comprimidos en un zip sin compresión */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const u16 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255), u32 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const cat = (arr) => { const n = arr.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === "string" ? enc.encode(f.data) : f.data, crc = crc32(data);
    const lh = cat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]);
    parts.push(lh, data);
    cen.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
    off += lh.length + data.length;
  }
  const cd = cat(cen);
  return cat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(off), u16(0)]);
}
const xesc = (v) => String(v ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xcol = (i) => String.fromCharCode(65 + i);
function xsheet(sh) { /* sh: {cols:[ancho], rows:[[celda]], freeze, filter} celda = valor | {v, s, n} */
  const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => {
    const o = c !== null && typeof c === "object" ? c : { v: c }, ref = xcol(ci) + (ri + 1), st = o.s ? ` s="${o.s}"` : "";
    if (o.v === "" || o.v == null) return o.s ? `<c r="${ref}"${st}/>` : "";
    return typeof o.v === "number" ? `<c r="${ref}"${st}><v>${o.v}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xesc(o.v)}</t></is></c>`;
  }).join("") + "</row>").join("");
  const last = xcol(sh.cols.length - 1) + sh.rows.length;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"${sh.first ? ' tabSelected="1"' : ""}>${sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : ""}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData>${sh.filter ? `<autoFilter ref="${sh.filter}"/>` : ""}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" paperSize="9" fitToHeight="0"/></worksheet>`;
}
function xlsxFor(list, meta, a, b) {
  const off = new Date().getTimezoneOffset() * 60000, serial = (t, utc) => (utc ? t : t - off) / 86400000 + 25569;
  const H = (v) => ({ v, s: 1 }), nHead = 8;
  const info = [[{ v: "NOVEDADES Y LIBRO DE GUARDIA", s: 3 }], [{ v: "Dependencia", s: 7 }, meta.unit || ""], [{ v: "Jefe de guardia / operador", s: 7 }, meta.chief || ""], [{ v: "Período (hora local)", s: 7 }, fDT(a) + " → " + fDT(b)], [{ v: "Período (UTC)", s: 7 }, fUTC(a) + " → " + fUTC(b)], [{ v: "Generado", s: 7 }, fDT(Date.now()) + " · " + tzName()], [{ v: "Observaciones", s: 7 }, meta.notes || ""], []];
  const head = ["Fecha y hora local", "Hora UTC", "Tipo", "Crítico", "Nodo", "Canal / destino", "Detalle"].map(H);
  const data = list.map((x) => { const c = x.crit; return [{ v: serial(x.t), s: c ? 6 : 2 }, { v: serial(x.t, true), s: c ? 6 : 2 }, { v: x.icon + " " + x.label, s: c ? 5 : 4 }, { v: c ? "Sí" : "No", s: c ? 5 : 4 }, { v: x.node, s: c ? 5 : 4 }, { v: x.chan, s: c ? 5 : 4 }, { v: x.detail, s: c ? 5 : 4 }]; });
  const s1 = { cols: [20, 20, 30, 9, 26, 24, 80], rows: [...info, head, ...data], freeze: nHead, filter: "A" + nHead + ":G" + (nHead + data.length), first: true };
  const by = new Map(); for (const x of list) by.set(x.label, (by.get(x.label) || 0) + 1);
  const crit = list.filter((x) => x.crit).length;
  const s2 = { cols: [42, 14], rows: [[{ v: "RESUMEN", s: 3 }], [], [H("Tipo"), H("Cantidad")], ...[...by].sort((p, q) => q[1] - p[1]).map(([k, n]) => [k, n]), [], [{ v: "Total de registros", s: 7 }, list.length], [{ v: "Eventos críticos", s: 7 }, crit]] };
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm:ss"/></numFmts><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="15"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A8A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships", head0 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    { name: "[Content_Types].xml", data: head0 + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: "_rels/.rels", data: head0 + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: head0 + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets><sheet name="Novedades" sheetId="1" r:id="rId1"/><sheet name="Resumen" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Novedades!$A$${nHead}:$G$${nHead + data.length}</definedName></definedNames></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: head0 + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: xsheet(s1) },
    { name: "xl/worksheets/sheet2.xml", data: xsheet(s2) },
  ]);
}
window.__gd = { gdEntries, gdF, xlsxFor, gdHtml, zipStore };

/* ───────────────────────── ajustes ───────────────────────── */
const GROUPS = {
  radio: { title: "Configuración de radio", items: [["radio.lora", "LoRa"], ["radio.channels", "Canales"], ["radio.security", "Seguridad"]] },
  device: { title: "Configuración del dispositivo", items: [["dev.user", "Usuario"], ["dev.device", "Dispositivo"], ["dev.position", "Posición"], ["dev.power", "Consumo"], ["dev.network", "Conexión de red"], ["dev.display", "Pantalla"], ["dev.bluetooth", "Bluetooth"]] },
  module: { title: "Configuración del módulo", items: [["mod.mqtt", "MQTT"], ["mod.serial", "Conexión serial"], ["mod.externalNotification", "Notificación externa"], ["mod.storeForward", "Store & Forward"], ["mod.rangeTest", "Test de alcance"], ["mod.telemetry", "Telemetría"], ["mod.cannedMessage", "Mensajes predefinidos"], ["mod.audio", "Audio"], ["mod.remoteHardware", "Hardware remoto"], ["mod.neighborInfo", "Información de vecinos"], ["mod.ambientLighting", "Luz ambiental"], ["mod.detectionSensor", "Sensor de presencia"], ["mod.paxcounter", "Contador de personas"], ["mod.trafficManagement", "Gestión de tráfico"], ["mod.statusmessage", "Mensaje de estado"], ["mod.tak", "TAK"], ["mod.meshBeacon", "Baliza de malla"]] },
  settings: { title: "Ajustes", items: [["portal.net", "Internet y MQTT"], ["portal.ops", "Modo operativo y semáforo"], ["portal.perf", "Rendimiento y limpieza"], ["portal.snd", "Sonidos y notificaciones"], ["portal.gps", IS_APP ? "GPS del celular" : "Ubicación de esta PC"], ["sys", "Administración y respaldo"]] },
};
const CFG_DESC = { lora: C.Config_LoRaConfigSchema, security: C.Config_SecurityConfigSchema, device: C.Config_DeviceConfigSchema, position: C.Config_PositionConfigSchema, power: C.Config_PowerConfigSchema, network: C.Config_NetworkConfigSchema, display: C.Config_DisplayConfigSchema, bluetooth: C.Config_BluetoothConfigSchema };
const MOD_DESC = { mqtt: M.ModuleConfig_MQTTConfigSchema, serial: M.ModuleConfig_SerialConfigSchema, externalNotification: M.ModuleConfig_ExternalNotificationConfigSchema, storeForward: M.ModuleConfig_StoreForwardConfigSchema, rangeTest: M.ModuleConfig_RangeTestConfigSchema, telemetry: M.ModuleConfig_TelemetryConfigSchema, cannedMessage: M.ModuleConfig_CannedMessageConfigSchema, audio: M.ModuleConfig_AudioConfigSchema, remoteHardware: M.ModuleConfig_RemoteHardwareConfigSchema, neighborInfo: M.ModuleConfig_NeighborInfoConfigSchema, ambientLighting: M.ModuleConfig_AmbientLightingConfigSchema, detectionSensor: M.ModuleConfig_DetectionSensorConfigSchema, paxcounter: M.ModuleConfig_PaxcounterConfigSchema, trafficManagement: M.ModuleConfig_TrafficManagementConfigSchema, statusmessage: M.ModuleConfig_StatusMessageConfigSchema, tak: M.ModuleConfig_TAKConfigSchema, meshBeacon: M.ModuleConfig_MeshBeaconConfigSchema };
const MOD_NEW = new Set(["trafficManagement", "statusmessage", "tak", "meshBeacon"]);
const MOD_SUB = { trafficManagement: "Filtra posiciones repetidas y limita el tráfico excesivo para bajar la ocupación del canal. 0 desactiva cada función.", statusmessage: "Texto corto de estado que tu nodo anuncia a la malla.", tak: "Color de equipo y rol para integración con ATAK/TAK (roles TAK y TAK Tracker).", meshBeacon: "Balizas que ofrecen a otros equipos unirse a tu malla (región, preset y canal).", mqtt: "Conexión con un servidor MQTT. El portal también publica por MQTT cuando hay Internet.", telemetry: "Qué métricas envía tu nodo y cada cuánto.", storeForward: "Guarda mensajes en un servidor para reenviarlos a nodos que vuelven a conectarse." };
const SUBTXT = { lora: ["Ajustes de la red", "Opciones de la malla LoRa. Cambiar la región o el preset reinicia el nodo."], security: ["Seguridad", "Claves del nodo y acceso de administración."], device: ["Dispositivo", "Rol del nodo y comportamiento de retransmisión."], position: ["Posición", "GPS y difusión de la ubicación."], power: ["Energía", "Ahorro de energía y suspensión."], network: ["Red / WiFi", "Solo para módulos con WiFi o Ethernet."], display: ["Pantalla", "Opciones de la pantalla del módulo."], bluetooth: ["Bluetooth", "Emparejamiento con la app del celular."] };

// Etiquetas en español: [título, descripción]
const L = {
  region: ["Región", "Debe coincidir con tu país. Argentina: ANZ (915 MHz) según ENACOM. Sin región el nodo no transmite."], usePreset: ["Usar preset de módem", "Usa un preset predefinido en lugar de parámetros manuales"], modemPreset: ["Preset de módem", "Compromiso entre alcance y velocidad (LONG_FAST es el estándar)"], bandwidth: ["Ancho de banda (kHz)", "Solo si no usás preset"], spreadFactor: ["Spreading factor", "Solo si no usás preset"], codingRate: ["Coding rate", "Solo si no usás preset"], frequencyOffset: ["Offset de frecuencia (MHz)", "Corrección de cristal"], hopLimit: ["Límite de saltos", "Número máximo de saltos (3 es lo recomendado, máx. 7)"], txEnabled: ["Transmisión habilitada", "Desactivalo para solo escuchar"], txPower: ["Potencia de TX (dBm)", "0 = máxima permitida por el hardware/región"], channelNum: ["Slot de frecuencia", "Número de canal de frecuencia LoRa (0 = automático)"], overrideDutyCycle: ["Ignorar duty cycle", "Úsalo solo si la normativa local lo permite"], sx126xRxBoostedGain: ["Ganancia RX reforzada", "Mejora la sensibilidad en chips SX126x"], overrideFrequency: ["Frecuencia fija (MHz)", "0 = desactivado"], paFanDisabled: ["Desactivar ventilador del PA", ""], ignoreIncoming: ["Ignorar nodos (lista)", ""], ignoreMqtt: ["Ignorar paquetes MQTT", "No reenviar mensajes MQTT sobre la malla"], configOkToMqtt: ["Permitir subir paquetes al MQTT", "Autoriza a otros nodos a subir tus paquetes a MQTT"],
  role: ["Rol del dispositivo", "CLIENT es lo normal; ROUTER solo para nodos fijos bien ubicados"], rebroadcastMode: ["Modo de retransmisión", "Qué paquetes reenvía este nodo"], nodeInfoBroadcastSecs: ["Intervalo de info de nodo (s)", "Cada cuánto anuncia su nombre/info (mínimo 3 h)"], serialEnabled: ["Consola serie habilitada", ""], doubleTapAsButtonPress: ["Doble toque como botón", ""], disableTripleClick: ["Desactivar triple clic", ""], tzdef: ["Zona horaria (POSIX)", "Ej.: <-03>3 para Argentina"], ledHeartbeatDisabled: ["Apagar LED de latido", ""], buzzerMode: ["Modo del buzzer", ""], buttonGpio: ["GPIO del botón", ""], buzzerGpio: ["GPIO del buzzer", ""],
  positionBroadcastSecs: ["Intervalo de difusión de posición (s)", "0 = valor por defecto (15 min)"], positionBroadcastSmartEnabled: ["Difusión inteligente", "Envía más seguido solo cuando te movés"], broadcastSmartMinimumDistance: ["Distancia mínima (m)", ""], broadcastSmartMinimumIntervalSecs: ["Intervalo mínimo (s)", ""], fixedPosition: ["Posición fija", "Usa la posición guardada y desactiva el GPS"], gpsMode: ["Modo GPS", "Habilitado / Deshabilitado / No presente"], gpsUpdateInterval: ["Intervalo de actualización GPS (s)", ""], gpsAttemptTime: ["Tiempo de intento GPS (s)", ""], positionFlags: ["Flags de posición", "Máscara de bits de campos a enviar"], rxGpio: ["GPIO RX del GPS", ""], txGpio: ["GPIO TX del GPS", ""], gpsEnGpio: ["GPIO de enable del GPS", ""],
  isPowerSaving: ["Modo ahorro de energía", "Para nodos con batería/solar: apaga BT y duerme"], onBatteryShutdownAfterSecs: ["Apagar con batería tras (s)", ""], waitBluetoothSecs: ["Espera de Bluetooth (s)", ""], sdsSecs: ["Super deep sleep (s)", ""], lsSecs: ["Light sleep (s)", ""], minWakeSecs: ["Despertar mínimo (s)", ""], adcMultiplierOverride: ["Multiplicador ADC", "Calibración de la lectura de batería"],
  wifiEnabled: ["WiFi habilitado", ""], wifiSsid: ["SSID", "Nombre de la red WiFi"], wifiPsk: ["Contraseña WiFi", ""], ntpServer: ["Servidor NTP", ""], ethEnabled: ["Ethernet habilitado", ""],
  screenOnSecs: ["Pantalla encendida (s)", "0 = por defecto"], autoScreenCarouselSecs: ["Carrusel automático (s)", ""], flipScreen: ["Girar pantalla 180°", ""], units: ["Unidades", "Métricas o imperiales"], oled: ["Tipo de OLED", ""], displaymode: ["Modo de pantalla", ""], headingBold: ["Títulos en negrita", ""], wakeOnTapOrMotion: ["Despertar con toque/movimiento", ""], use12hClock: ["Reloj de 12 h", ""], compassNorthTop: ["Norte arriba en brújula", ""],
  enabled: ["Habilitado", ""], mode: ["Modo", ""], fixedPin: ["PIN fijo", "6 dígitos"],
  adminChannelEnabled: ["Canal admin heredado", "Permite administración por el canal “admin” (menos seguro)"], isManaged: ["Nodo administrado", "Bloquea ajustes locales; solo se cambia por admin remoto"], debugLogApiEnabled: ["API de debug por serie", ""],
  address: ["Servidor", ""], username: ["Usuario", ""], password: ["Contraseña", ""], encryptionEnabled: ["Cifrado habilitado", ""], jsonEnabled: ["JSON habilitado", ""], tlsEnabled: ["TLS", ""], root: ["Tema raíz", ""], proxyToClientEnabled: ["Proxy al cliente", ""], mapReportingEnabled: ["Reporte al mapa", ""],
  updateInterval: ["Intervalo de actualización (s)", ""], deviceUpdateInterval: ["Intervalo de telemetría del dispositivo (s)", ""], environmentUpdateInterval: ["Intervalo de telemetría ambiental (s)", ""], environmentMeasurementEnabled: ["Medición ambiental", ""], environmentScreenEnabled: ["Mostrar en pantalla", ""], deviceTelemetryEnabled: ["Telemetría del dispositivo", ""],
  sender: ["Intervalo de envío (s)", ""], save: ["Guardar en archivo", ""], heartbeat: ["Heartbeat", ""], records: ["Registros", ""], historyReturnMax: ["Máx. historial", ""], historyReturnWindow: ["Ventana de historial (min)", ""],
  baud: ["Baudios", ""], timeout: ["Timeout (s)", ""], echo: ["Eco", ""], rxd: ["GPIO RXD", ""], txd: ["GPIO TXD", ""], outputMs: ["Duración de salida (ms)", ""], output: ["GPIO de salida", ""], alertMessage: ["Alerta por mensaje", ""], alertBell: ["Alerta por campana", ""], active: ["Activo en alto", ""], useI2sAsBuzzer: ["I2S como buzzer", ""],
  rotary1Enabled: ["Encoder rotatorio", ""], inputbrokerPinA: ["Pin A", ""], inputbrokerPinB: ["Pin B", ""], inputbrokerPinPress: ["Pin pulsador", ""], updownEnabled: ["Arriba/abajo", ""], allowInputSource: ["Fuente de entrada permitida", ""], sendBell: ["Enviar campana", ""],
  longName: ["Nombre largo", "Nombre visible en la malla (hasta 39 caracteres)"], shortName: ["Nombre corto", "Hasta 4 caracteres"], isLicensed: ["Radioaficionado licenciado", "Marca el nodo como de radioaficionado (desactiva el cifrado de canales en el firmware)"], isUnmessagable: ["No recibir mensajes", "Oculta el nodo como destino de mensajes (infraestructura)"],
};
const human = (s) => s.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

function viewSettings(m) {
  const g = GROUPS[S.view] || GROUPS.settings;
  if (!g.items.some((i) => i[0] === S.sub)) S.sub = g.items[0][0];
  const items = g.items.filter(([id]) => !(id.startsWith("mod.") && MOD_NEW.has(id.slice(4))) || S.demo || S.mod[id.slice(4)] || S.sub === id);
  const left = el("div", { class: "tabs" }, items.map(([id, label]) => el("button", { class: "tab" + (S.sub === id ? " on" : ""), onclick: () => { if (S.form && S.form.isDirty() && !confirm("Tenés cambios sin guardar. ¿Descartarlos?")) return; S.sub = id; S.form = null; renderMain(); } }, label)));
  const body = el("section", { class: "setbody", id: "setbody" });
  m.append(el("div", { class: "pagebar" }, el("h1", {}, g.title)), el("div", { class: "setview" }, left, body));
  const sub = S.sub;
  if (sub === "radio.channels") return viewChannels(body);
  if (sub === "sys") return viewSystem(body);
  if (sub === "portal.net") return viewNet(body);
  if (sub === "portal.snd") return viewSound(body);
  if (sub === "portal.ops") return viewOps(body);
  if (sub === "portal.perf") return viewPerf(body);
  if (sub === "portal.gps") return viewGps(body);
  let key, desc, value, kind, title, subtitle, only, hide;
  if (sub === "dev.user") {
    const me = S.nodes.get(S.me);
    desc = Mesh.UserSchema; value = me && me.rawUser; kind = "user"; title = "Usuario"; subtitle = "Cómo aparece tu nodo en la malla."; only = ["longName", "shortName", "isLicensed", "isUnmessagable"];
  } else if (sub.startsWith("dev.") || sub === "radio.lora" || sub === "radio.security") {
    key = sub.split(".")[1]; desc = CFG_DESC[key]; value = S.cfg[key]; kind = "cfg";
    [title, subtitle] = SUBTXT[key];
  } else {
    key = sub.slice(4); desc = MOD_DESC[key]; value = S.mod[key]; kind = "mod";
    title = GROUPS.module.items.find((i) => i[0] === sub)[1]; subtitle = MOD_SUB[key] || "Configuración del módulo.";
  }
  if (!value && kind !== "user") { body.append(el("div", { class: "banner" }, ready() || S.demo ? "El nodo no informó esta sección (puede no existir en su firmware)." : S.device ? "Leyendo esta sección del nodo…" : "Conectá el módulo por USB para ver esta sección.")); return; }
  const f = buildForm({
    desc, value, only, hide: [],
    async onSave(nv) {
      if (kind === "cfg") await applySettings(async () => sendAdmin("setConfig", create(C.ConfigSchema, { payloadVariant: { case: key, value: nv } })), true);
      else if (kind === "mod") await applySettings(async () => sendAdmin("setModuleConfig", create(M.ModuleConfigSchema, { payloadVariant: { case: key, value: nv } })), true);
      else await applySettings(async (d) => d.setOwner(nv), false);
      if (kind === "cfg") S.cfg[key] = nv; else if (kind === "mod") S.mod[key] = nv;
    },
  });
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, title), el("small", { class: "muted" }, subtitle)), f.saveBtn), f.node);
  if (key === "security" && S.cfg.security) body.append(securityExtra());
  if (key === "position") body.append(fixedPosBox());
  if (kind === "mod" && key === "cannedMessage") body.append(textBox("Mensajes predefinidos", "Frases de uso rápido que se eligen desde la pantalla o con un encoder del equipo. Separalas con la barra vertical ( | ). Máximo 200 caracteres en total.", 200, "getCannedMessageModuleMessagesRequest", "getCannedMessageModuleMessagesResponse", "setCannedMessageModuleMessages", "Recibido|Ok|En camino|Necesito apoyo|Sin novedad"));
  if (kind === "mod" && key === "externalNotification") body.append(textBox("Tono de notificación (RTTTL)", "Melodía en formato RTTTL que suena en el buzzer al recibir un mensaje. Máximo 230 caracteres.", 230, "getRingtoneRequest", "getRingtoneResponse", "setRingtoneMessage", "24:d=32,o=5,b=565:f6,p,f6,4p,p,f6,p,f6,2p"));
  S.form = f;
}

function textBox(title, help, max, reqCase, respCase, setCase, ph) {
  const ta = el("textarea", { class: "inp", rows: 4, maxlength: max, placeholder: ph }); ta.disabled = true;
  const cnt = el("small", { class: "muted" }, "Leyendo del nodo…"), upd = () => { cnt.textContent = ta.value.length + " / " + max + " caracteres"; };
  ta.addEventListener("input", upd);
  const sv = el("button", { class: "btn", disabled: true, onclick: async () => {
    sv.disabled = true; try { await applySettings(() => sendAdmin(setCase, ta.value), false); } catch (e) {} sv.disabled = false;
  } }, "Guardar en el nodo");
  const load = async () => {
    if (S.demo) { ta.disabled = false; sv.disabled = false; cnt.textContent = "Modo demo"; return; }
    try { ta.value = await adminCall(reqCase, true, respCase, 6000); ta.disabled = false; sv.disabled = false; upd(); }
    catch (e) { cnt.textContent = "El nodo no respondió. Podés escribir igual y guardar."; ta.disabled = false; sv.disabled = false; }
  };
  load();
  return el("div", { class: "card" }, el("b", {}, title), el("small", { class: "muted" }, help), ta, el("div", { class: "g2" }, cnt, sv));
}

async function applySettings(fn, reboots) {
  if (S.demo) { toast("Modo demo: no se envió nada al nodo"); return; }
  if (!S.device) throw new Error("sin conexión");
  try {
    if (reboots) { await S.device.beginEditSettings(); }
    await fn(S.device);
    if (reboots) { S.expectReboot = true; await S.device.commitEditSettings(); toast("Guardado. El nodo se reinicia y el portal se reconecta solo.", "ok"); }
    else toast("Guardado en el nodo", "ok");
  } catch (e) {
    S.expectReboot = false;
    toast("No se pudo guardar: " + (e && e.error !== undefined ? ruteoTexto(e.error) : e.message || e), "err");
    throw e;
  }
}

/* ── Formularios guiados por los metadatos oficiales (field_metadata del firmware 2.8) ── */
const ES_X = ES_FIELDS.F, ES_E = ES_FIELDS.E;
const BITS = { "PositionConfig.positionFlags": "Config.PositionConfig.PositionFlags", "MeshBeaconConfig.flags": "ModuleConfig.MeshBeaconConfig.Flags" };
const NESTED_OK = new Set(["meshtastic.Config.NetworkConfig.IpV4Config", "meshtastic.ModuleConfig.MapReportSettings"]);
const fwNum = (s) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(s || ""); return m ? +m[1] * 1e6 + +m[2] * 1e3 + +m[3] : 0; };
const enumShort = (e) => e.typeName.replace(/^meshtastic\./, "");
function fieldInfo(d, f) {
  const sec = d.typeName.replace(/^meshtastic\./, ""), short = sec.split(".").pop(), name = f.localName;
  const meta = (FIELD_META["meshtastic." + sec] || {})[name] || {}, x = ES_X[short + "." + name], off = (ES_OFFICIAL[sec] || {})[name] || {}, l = L[name];
  const label = (x && x[0]) || (l && l[0]) || off.label || meta.label || human(name);
  const hint = x ? x[1] : ((l && l[1]) || off.description || "");
  const min = meta.min || meta.max ? meta.min : undefined, max = meta.min || meta.max ? meta.max : undefined;
  const nb = (t) => (t || "").replace(/Meshtastic/gi, "LoRa Mesh");
  return { name, short, sec, meta, label: nb(label), hint: nb(hint), unit: meta.unit, min, max, key: short + "." + name };
}

function buildForm({ desc, value, only, hide = [], onSave }) {
  const ctrls = [], top = new Map(); let dirty = false, advN = 0;
  const saveBtn = el("button", { class: "btn", disabled: true, onclick: save }, "Guardar");
  const mark = (v) => { dirty = v; saveBtn.disabled = !v; };
  const cur = value || create(desc);
  const node = el("div", { class: "form" });
  const fw = fwNum(S.meta && S.meta.firmwareVersion);
  const isZero = (v) => v === undefined || v === 0 || v === 0n || v === "" || v === false || (v && v.length === 0);

  function addFields(d, obj, path, host) {
    for (const f of d.fields) {
      const name = f.localName;
      if (!path.length && ((only && !only.includes(name)) || hide.includes(name))) continue;
      const info = fieldInfo(d, f), v = obj ? obj[name] : undefined, m = info.meta;
      if ((m.deprecated || f.deprecated) && isZero(v)) continue;
      if (m.sinceFirmware && fw && fwNum(m.sinceFirmware) > fw) continue;
      if (m.deprecatedSince && fw && fwNum(m.deprecatedSince) <= fw && isZero(v)) continue;
      const opt = !!f.optional;
      let inp, get, orig;
      const onch = () => mark(true);
      if (f.fieldKind === "message") {
        if (!NESTED_OK.has(f.message.typeName)) continue;
        const grp = el("div", { class: "subgrp" }, el("div", { class: "subh" }, el("b", {}, info.label), info.hint ? el("small", {}, info.hint) : null));
        host.append(grp);
        addFields(f.message, v, path.concat(name), grp);
        if (!path.length) top.set(name, { grp });
        continue;
      }
      if (f.fieldKind === "list") {
        if (f.listKind === "scalar" && f.scalar === 12) {
          const list = Array.from(v || []), N = name === "adminKey" ? 3 : Math.max(list.length, 1);
          const ins = Array.from({ length: N }, (_, i) => el("input", { class: "inp mono", value: list[i] ? b64(list[i]) : "", placeholder: "clave pública base64 (32 bytes)", oninput: onch }));
          inp = el("div", { class: "stack" }, ins);
          get = () => ins.map((i) => i.value.trim()).filter(Boolean).map((s) => { let k; try { k = unb64(s); } catch (e) { throw new Error(info.label + ": no es base64 válido"); } if (k.length !== 32) throw new Error(info.label + ": cada clave debe tener 32 bytes"); return k; });
          orig = null;
        } else continue;
      } else if (BITS[info.key] && f.scalar === 13) {
        const et = ES_E[BITS[info.key]], items = Object.entries(et).map(([n, o]) => [+n, o]).filter(([n, o]) => n > 0 && !o.dep);
        const cbs = items.map(([n, o]) => { const c = el("input", { type: "checkbox", checked: ((v || 0) & n) !== 0, onchange: onch }); return { n, c, w: el("label", { class: "chk" }, c, el("span", {}, o.l)) }; });
        inp = el("div", { class: "bits" }, cbs.map((x) => x.w));
        get = () => cbs.reduce((a, x) => a | (x.c.checked ? x.n : 0), 0) >>> 0;
        orig = Number(v || 0);
      } else if (f.fieldKind === "enum") {
        const et = ES_E[enumShort(f.enum)] || {}, sel = el("select", { class: "inp", "aria-label": info.label, onchange: () => { upd(); onch(); } });
        if (opt) sel.append(el("option", { value: "" }, "— sin definir —"));
        for (const o of f.enum.values) { const t = et[o.number] || {}; if (t.dep && o.number !== v) continue; sel.append(el("option", { value: o.number, selected: v !== undefined && o.number === v, title: o.name }, t.l || o.name)); }
        const ds = el("small", { class: "muted edesc" });
        const upd = () => { const t = et[sel.value]; ds.textContent = (t && t.d) || ""; };
        upd(); inp = el("div", { class: "stack" }, sel, ds);
        get = () => (sel.value === "" ? undefined : parseInt(sel.value, 10)); orig = v;
      } else if (f.scalar === 8) {
        const c = el("input", { type: "checkbox", checked: !!v, onchange: onch }); inp = el("label", { class: "sw" }, c, el("span", {}));
        get = () => c.checked; orig = !!v;
      } else if (f.scalar === 9) {
        const i = el("input", { class: "inp", type: /psk|password/i.test(name) ? "password" : "text", value: v ?? "", oninput: onch, autocomplete: "off" });
        inp = i; get = () => i.value; orig = v ?? "";
      } else if (f.scalar === 12) continue;
      else {
        const fl = f.scalar === 1 || f.scalar === 2, big = [3, 4, 6, 16, 18].includes(f.scalar);
        const i = el("input", { class: "inp", type: "number", step: fl ? "any" : "1", value: v !== undefined ? Number(v) : (opt ? "" : 0), oninput: onch });
        if (info.min !== undefined) { i.min = info.min; i.max = info.max; }
        inp = info.unit ? el("div", { class: "unitwrap" }, i, el("span", { class: "unit" }, info.unit)) : i;
        get = () => {
          if (i.value === "" && opt) return undefined;
          const n = fl ? parseFloat(i.value) : parseInt(i.value, 10), val = Number.isFinite(n) ? n : 0;
          if (info.min !== undefined && val !== Number(orig) && (val < info.min || val > info.max)) throw new Error(info.label + ": debe estar entre " + info.min + " y " + info.max);
          return big ? BigInt(Math.trunc(val)) : val;
        };
        orig = v !== undefined ? Number(v) : 0;
      }
      const rng = info.min !== undefined ? "Rango: " + info.min + " – " + info.max + (info.unit ? " " + info.unit : "") : "";
      const hint = [info.hint, rng].filter(Boolean).join(" · ");
      const adv = !!(m.diyOnly || m.adminOnly); if (adv) advN++;
      const r = el("div", { class: "row" + (adv ? " adv" : "") }, el("div", { class: "rl" }, el("b", {}, info.label), hint ? el("small", {}, hint) : null, adv ? el("small", { class: "tag" }, m.diyOnly ? "Avanzado · placas DIY" : "Solo administración") : null), el("div", { class: "rv" }, inp));
      host.append(r);
      const c = { path: path.concat(name), f, get, row: r, orig }; ctrls.push(c); if (!path.length) top.set(name, c);
    }
  }
  addFields(desc, cur, [], node);

  if (advN) {
    const b = el("button", { class: "mini", onclick: () => { const on = node.classList.toggle("showadv"); b.textContent = on ? "Ocultar opciones avanzadas" : "Mostrar opciones avanzadas (" + advN + ")"; } }, "Mostrar opciones avanzadas (" + advN + ")");
    node.prepend(el("div", { class: "advbar" }, b));
  }
  const cb = (n) => { const c = top.get(n); return c && c.row && c.row.querySelector("input[type=checkbox]"); };
  if (desc === C.Config_LoRaConfigSchema && cb("usePreset")) {
    const sw = cb("usePreset");
    const sync = () => { for (const k of ["bandwidth", "spreadFactor", "codingRate"]) { const c = top.get(k); if (c) c.row.style.display = sw.checked ? "none" : ""; } const mp = top.get("modemPreset"); if (mp) mp.row.style.display = sw.checked ? "" : "none"; };
    sw.addEventListener("change", sync); sync();
  }
  if (desc === C.Config_NetworkConfigSchema && top.get("addressMode") && top.get("ipv4Config")) {
    const sel = top.get("addressMode").row.querySelector("select"), g = top.get("ipv4Config").grp;
    const sync = () => { g.style.display = sel.value === "1" ? "" : "none"; }; sel.addEventListener("change", sync); sync();
  }
  if (!ctrls.length) node.append(el("div", { class: "muted pad" }, "Esta sección no tiene opciones editables desde aquí."));
  async function save() {
    const nv = clone(desc, cur);
    try {
      for (const c of ctrls) {
        if (c.row.style.display === "none") continue;
        const val = c.get();
        let t = nv;
        for (let k = 0; k < c.path.length - 1; k++) { const p = c.path[k]; if (!t[p]) { t[p] = create(findMsg(desc, c.path.slice(0, k + 1))); } t = t[p]; }
        t[c.path[c.path.length - 1]] = val;
      }
    } catch (e) { toast(e.message, "err"); return; }
    saveBtn.disabled = true; saveBtn.textContent = "Guardando…";
    try { await onSave(nv); mark(false); } catch (e) { mark(true); }
    saveBtn.textContent = "Guardar";
  }
  return { node, saveBtn, isDirty: () => dirty, save };
}
function findMsg(desc, path) { let d = desc; for (const p of path) d = d.fields.find((f) => f.localName === p).message; return d; }

function securityExtra() {
  const pk = S.cfg.security.publicKey;
  return el("div", { class: "card" }, el("b", {}, "Clave pública del nodo"), el("code", { class: "key" }, pk && pk.length ? b64(pk) : "—"),
    el("small", { class: "muted" }, "La clave privada nunca se muestra en el portal. Esta clave pública identifica tu nodo para mensajes directos cifrados."),
    pk && pk.length ? el("button", { class: "mini", onclick: () => navigator.clipboard.writeText(b64(pk)).then(() => toast("Copiada")) }, "Copiar") : null);
}
function fixedPosBox() {
  const mp = mePos();
  const la = el("input", { class: "inp", type: "number", step: "any", value: mp ? mp.lat : "" }), lo = el("input", { class: "inp", type: "number", step: "any", value: mp ? mp.lon : "" });
  return el("div", { class: "card" }, el("b", {}, "Fijar posición manualmente"),
    el("small", { class: "muted" }, "Útil para nodos fijos sin GPS (repetidores en cerro, torre, etc.). Después activá “Posición fija” arriba."),
    el("div", { class: "g2" }, el("label", {}, "Latitud", la), el("label", {}, "Longitud", lo)),
    el("button", { class: "btn", onclick: async () => { const a = parseFloat(la.value), b = parseFloat(lo.value); if (!isFinite(a) || !isFinite(b)) return toast("Esas coordenadas no son válidas. Escribí latitud y longitud en grados decimales, por ejemplo -40.148, -71.257.", "err"); if (S.demo) return toast("Modo demo"); try { await S.device.setFixedPosition(a, b); toast("Posición fija enviada", "ok"); } catch (e) { toast("Error: " + (e.message || e), "err"); } } }, "Enviar posición"));
}

/* ── Canales ── */
function viewChannels(body) {
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Canales"), el("small", { class: "muted" }, "Hasta 8 canales. El 0 es el primario y define la frecuencia junto con el preset."))));
  body.append(shareBox());
  for (let i = 0; i < 8; i++) {
    const ch = S.channels[i] || create(NChannel.ChannelSchema, { index: i, role: i === 0 ? 1 : 0, settings: {} });
    const set = ch.settings || create(NChannel.ChannelSettingsSchema);
    const roleSel = el("select", { class: "inp", "aria-label": "Rol del canal" }, [["0", "Desactivado"], ["1", "Primario"], ["2", "Secundario"]].map(([v, t]) => el("option", { value: v, selected: +v === ch.role }, t)));
    const name = el("input", { class: "inp", value: set.name || "", maxlength: 11 });
    const psk = el("input", { class: "inp mono", value: set.psk && set.psk.length ? b64(set.psk) : "" });
    const up = el("input", { type: "checkbox", checked: !!set.uplinkEnabled }), down = el("input", { type: "checkbox", checked: !!set.downlinkEnabled });
    const prec = el("input", { class: "inp", type: "number", min: 0, max: 32, value: set.moduleSettings ? set.moduleSettings.positionPrecision : 0 });
    const gen = (n) => () => { psk.value = n ? b64(crypto.getRandomValues(new Uint8Array(n))) : ""; };
    const det = el("details", { class: "chan", open: i === 0 },
      el("summary", {}, el("span", { class: "hash" }, "#" + i), el("b", {}, ch.role === 0 && !S.channels[i] ? "Sin configurar" : (set.name || (i === 0 ? "Primario (por defecto)" : "Canal " + i))), el("small", {}, ["Desactivado", "Primario", "Secundario"][ch.role])),
      el("div", { class: "form" },
        row("Rol", "El canal 0 debe ser Primario", i === 0 ? el("div", {}, "Primario") : roleSel),
        row("Nombre", "Hasta 11 caracteres", name),
        row("Clave (PSK, base64)", "Vacío = sin cifrar · AQ== = clave pública por defecto · 32 bytes = AES-256", el("div", {}, psk, el("div", { class: "chips" }, el("button", { class: "mini", onclick: gen(32) }, "Aleatoria AES-256"), el("button", { class: "mini", onclick: gen(16) }, "Aleatoria AES-128"), el("button", { class: "mini", onclick: () => (psk.value = "AQ==") }, "Por defecto"), el("button", { class: "mini", onclick: gen(0) }, "Sin cifrado")))),
        row("Subir a MQTT", "", el("label", { class: "sw" }, up, el("span", {}))),
        row("Bajar de MQTT", "", el("label", { class: "sw" }, down, el("span", {}))),
        row("Precisión de posición", "Bits (0 = no compartir, 32 = exacta)", prec),
        el("div", { class: "rowbtn" }, el("button", { class: "btn", onclick: async (e) => {
          let key; try { key = psk.value.trim() ? unb64(psk.value) : new Uint8Array(); } catch (err) { return toast("La clave no está en base64. Pegala tal como la copiaste del otro equipo, sin espacios de más.", "err"); }
          if (![0, 1, 16, 32].includes(key.length)) return toast("La clave tiene un largo que el módulo no acepta: dejala vacía, o usá una de 1, 16 o 32 bytes (las de 32 son las del QR).", "err");
          const nc = create(NChannel.ChannelSchema, { index: i, role: i === 0 ? 1 : +roleSel.value, settings: { name: name.value, psk: key, uplinkEnabled: up.checked, downlinkEnabled: down.checked, moduleSettings: { positionPrecision: parseInt(prec.value, 10) || 0 } } });
          e.target.disabled = true;
          try { await applySettings(() => sendAdmin("setChannel", nc), true); S.channels[i] = nc; } catch (err) {} finally { e.target.disabled = false; }
        } }, "Guardar canal"))));
    body.append(det);
  }
}
function row(label, hint, ctrl) { return el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, label), hint ? el("small", {}, hint) : null), el("div", { class: "rv" }, ctrl)); }
function shareBox() {
  const url = () => {
    const settings = S.channels.filter((c) => c && c.role !== 0).map((c) => c.settings);
    const set = create(NApp.ChannelSetSchema, { settings, loraConfig: S.cfg.lora });
    return "https://meshtastic.org/e/#" + b64url(toBinary(NApp.ChannelSetSchema, set));
  };
  const imp = el("input", { class: "inp", placeholder: "Pegá el enlace de canales (…/e/#…)" });
  const doImport = async () => {
      try {
        const frag = imp.value.trim().split("#")[1]; if (!frag) throw new Error("no es un enlace de canales");
        const set = fromBinary(NApp.ChannelSetSchema, unb64url(frag));
        if (!confirm(`Se van a reemplazar los canales del nodo por ${set.settings.length} canal(es) de la URL. ¿Continuar?`)) return;
        await applySettings(async () => {
          for (let i = 0; i < 8; i++) {
            const s = set.settings[i];
            await sendAdmin("setChannel", create(NChannel.ChannelSchema, { index: i, role: s ? (i === 0 ? 1 : 2) : 0, settings: s || {} }));
          }
          if (set.loraConfig) await sendAdmin("setConfig", create(C.ConfigSchema, { payloadVariant: { case: "lora", value: set.loraConfig } }));
        }, true);
      } catch (e) { toast("No se pudo importar: " + (e.message || e), "err"); }
  };
  const names = () => S.channels.filter((c) => c && c.role !== 0).map((c, k) => (c.settings && c.settings.name) || (k === 0 ? "Primario" : "Canal " + k));
  return el("div", { class: "card" }, el("b", {}, "Compartir / importar canales"),
    el("small", { class: "muted" }, "El enlace y el código QR contienen las claves de los canales: compartilos solo con gente de confianza. Se generan acá mismo, sin internet, y son compatibles con las demás apps LoRa Mesh."),
    el("div", { class: "chips" },
      el("button", { class: "mini acc", onclick: () => { try { showChannelQR(url(), names()); } catch (e) { toast("No se pudo generar el QR: " + (e.message || e), "err"); } } }, "▣ Mostrar código QR"),
      el("button", { class: "mini", onclick: () => { try { const u = url(); if (IS_APP && window.AndroidBridge.copyText) { window.AndroidBridge.copyText(u); toast("Enlace copiado"); } else navigator.clipboard.writeText(u).then(() => toast("Enlace copiado")); } catch (e) { toast("No se pudo armar el enlace del canal. Revisá que el canal tenga nombre y clave.", "err"); } } }, "Copiar enlace de mis canales")),
    el("div", { class: "g2" }, imp, el("div", { class: "chips", style: "margin:0" },
      el("button", { class: "btn ghost", onclick: () => scanChannelQR((t) => { imp.value = t; if (!/#/.test(t)) return toast("El código leído no es de canales: " + t.slice(0, 60), "err"); doImport(); }) }, "📷 Escanear QR"),
      el("button", { class: "btn", onclick: doImport }, "Importar"))));
}

/* ── Sistema: administración del nodo, respaldo y datos del portal ── */
const adminWait = new Map();
function onAdminPacket(p) {
  if (!p || p.payloadVariant.case !== "decoded") return;
  const d = p.payloadVariant.value; if (d.portnum !== NPort.PortNum.ADMIN_APP) return;
  let am; try { am = fromBinary(NAdmin.AdminMessageSchema, d.payload); } catch (e) { return; }
  const c = am.payloadVariant.case, w = c && adminWait.get(c);
  if (w) { adminWait.delete(c); w(am.payloadVariant.value); }
}
function adminCall(reqCase, reqVal, respCase, ms = 6000) {
  return new Promise((res, rej) => {
    const h = (v) => { clearTimeout(t); res(v); };
    const t = setTimeout(() => { if (adminWait.get(respCase) === h) adminWait.delete(respCase); rej(new Error("El nodo no respondió")); }, ms);
    adminWait.set(respCase, h);
    sendAdmin(reqCase, reqVal).catch((e) => { if (adminWait.get(respCase) === h) { adminWait.delete(respCase); clearTimeout(t); rej(e); } });
  });
}
const secH = (t, sub) => el("div", { class: "sech" }, el("b", {}, t), sub ? el("small", { class: "muted" }, sub) : null);
function actRow(label, hint, ctrls, danger) { return el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, label), el("small", {}, hint)), el("div", { class: "rv inl" }, ctrls)); }
function btn(label, fn, kind = "ghost") {
  const b = el("button", { class: "btn " + (kind === "danger" ? "dangerbtn" : kind), onclick: async () => {
    if (S.demo) return toast("Modo demo: no se envió nada al nodo");
    if (!S.device || !ready()) return toast("Conectá el nodo primero", "err");
    b.disabled = true; try { await fn(); } catch (e) { toast("Error: " + (e && e.error !== undefined ? ruteoTexto(e.error) : e.message || e), "err"); } finally { b.disabled = false; }
  } }, label);
  return b;
}
const numIn = (v, min, max, w = 90) => el("input", { class: "inp", type: "number", min, max, value: v, style: `width:${w}px` });

function viewOps(body) {
  const c = opsCfg(), cur = document.documentElement.dataset.theme || "dark";
  const sw = (on, f) => el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!on, onchange: (e) => f(e.target.checked) }), el("span", {}));
  const num = (key, min, max, step, unit) => el("div", { class: "rv inl" }, el("input", { class: "inp", type: "number", min, max, step, value: c[key], style: "width:110px", onchange: (e) => { const v = +e.target.value; if (isFinite(v)) opsSave({ [key]: Math.min(max, Math.max(min, v)) }); } }), el("span", { class: "unit" }, unit));
  const th = [["dark", "Oscuro (táctico)", "Predeterminado. Fondo oscuro que cansa menos la vista de noche o con poca luz."], ["hc", "Alto contraste", "Negro puro con texto blanco y bordes marcados: máxima legibilidad."], ["night", "Nocturno rojo", "Todo en tonos rojos para conservar la visión nocturna (incluido el mapa)."], ["light", "Claro", "Para uso a pleno sol o impresión en pantalla."]];
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Modo operativo y semáforo"), el("small", { class: "muted" }, "Apariencia para uso táctico o nocturno y reglas del semáforo de nodos. Se guarda en este navegador."))),
    el("div", { class: "form" },
      secH("Apariencia"),
      ...th.map(([k, t, d]) => actRow(t, d, el("button", { class: "btn " + (cur === k ? "" : "ghost"), onclick: () => { setTheme(k); renderMain(); } }, cur === k ? "✓ En uso" : "Usar"))),
      secH("Semáforo de nodos (mapa y lista)"),
      el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, "Cómo se pinta cada nodo"), el("small", {}, "🟢 verde: activo · 🟡 amarillo: batería baja o señal débil · 🔴 rojo intermitente: alerta de pánico sin atender o nodo caído · ⚪ gris: todavía sin datos."))),
      actRow("Nodo caído después de", "Si no se escucha al nodo durante este tiempo, pasa a rojo y se anota en el registro.", num("downMin", 5, 1440, 5, "minutos")),
      actRow("Batería baja desde", "Por debajo de este porcentaje el nodo pasa a amarillo.", num("lowBat", 5, 60, 1, "%")),
      actRow("Señal débil desde", "Si el SNR del último paquete es igual o menor, el nodo pasa a amarillo.", num("weakSnr", -25, 5, 1, "dB")),
      actRow("Barra roja de alerta", "Muestra, arriba de todo, las alertas de pánico recibidas hasta que las marques como atendidas.", sw(c.banner, (v) => opsSave({ banner: v }))),
      el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, "Cómo se reconoce una alerta"), el("small", {}, "Es todo mensaje recibido que empieza con 🚨, SOS, EMERGENCIA, PÁNICO o ALERTA (el botón EMERGENCIAS de este portal arma el mensaje así). El tono se elige en Sonidos y suena aunque esté el silencio nocturno.")))))
}
/* ───────────────────────── Rendimiento y limpieza ───────────────────────── */
const fmtKB = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
function lsUse() { /* cuánto ocupa el portal en el almacenamiento del navegador, por tipo de dato */
  const grupos = { "Mensajes guardados": /:msgs$/, "Libreta de nodos": /:nodes$/, "Telemetría": /:tele$/, "Registro de eventos y alertas": /:(events|alerts)$/, "Rutas (traceroute)": /:traces$/, "Sonidos propios": /:sndfiles$/ };
  const out = {}; let total = 0, otros = 0;
  for (const k in localStorage) {
    if (!Object.prototype.hasOwnProperty.call(localStorage, k) || !k.startsWith("meshportal:")) continue;
    const b = ((localStorage[k] || "").length + k.length) * 2; total += b; /* el navegador guarda 2 bytes por carácter */
    let puesto = false;
    for (const [g, re] of Object.entries(grupos)) if (re.test(k)) { out[g] = (out[g] || 0) + b; puesto = true; break; }
    if (!puesto) otros += b;
  }
  if (otros) out["Ajustes y conexiones"] = otros;
  return { out, total };
}
async function tileUse() { try { const n = await idbReq("readonly", (st) => st.count()); return n || 0; } catch (e) { return 0; } }
function medirFrames(ms = 3000) { /* mide cuánto tarda el navegador en dibujar cada cuadro */
  return new Promise((res) => {
    const t = []; let last = performance.now(); const fin = last + ms;
    const paso = () => { const n = performance.now(); t.push(n - last); last = n; if (n < fin) requestAnimationFrame(paso); else { t.sort((a, b) => a - b); res({ p50: t[t.length >> 1] || 0, p95: t[(t.length * 0.95) | 0] || 0, peor: t[t.length - 1] || 0, fps: Math.round(1000 / (t[t.length >> 1] || 16)) }); } };
    requestAnimationFrame(paso);
  });
}
let perfLast = null;
async function perfMedir() {
  const t0 = performance.now(), fr = await medirFrames(3000), tiles = await tileUse(), ls = lsUse();
  let teleM = 0; for (const cats of S.tele.values()) for (const c of Object.values(cats)) teleM += (c.hist || []).length;
  const nav = performance.getEntriesByType("navigation")[0];
  perfLast = {
    cuando: Date.now(),
    aperturaMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    fps: fr.fps, p50: Math.round(fr.p50), p95: Math.round(fr.p95), peor: Math.round(fr.peor),
    pantalla: S.view, nodos: S.nodes.size, porMqtt: [...S.nodes.values()].filter((n) => n.viaMqtt).length,
    mensajes: S.msgs.length, muestrasTele: teleM, eventos: S.events.length, rutas: S.traces.length,
    almacenamiento: ls, mosaicosMapa: tiles,
    mqtt: S.mq.srv ? S.mq.srv.filter((x) => x && x.st === "on").length + "/" + S.mq.cfg.servers.filter((x) => x.on).length : "0/0",
    conexion: S.demo ? "modo demo" : S.transport || "sin nodo",
    navegador: navigator.userAgent, nucleos: navigator.hardwareConcurrency || "?", memoriaGB: navigator.deviceMemory || "?",
    medicionMs: Math.round(performance.now() - t0),
  };
  return perfLast;
}
function perfTexto(d) {
  const L = ["DIAGNÓSTICO DE RENDIMIENTO · OPEN SOURCE PARIZ", "Fecha: " + fDT(d.cuando), "",
    "Cuadros por segundo: " + d.fps + " (normal 60; por debajo de 30 se nota lento)",
    "Tiempo por cuadro: típico " + d.p50 + " ms · el 95 % bajo " + d.p95 + " ms · peor " + d.peor + " ms",
    "Apertura del portal: " + (d.aperturaMs != null ? d.aperturaMs + " ms" : "sin dato"),
    "Pantalla medida: " + d.pantalla, "",
    "Nodos en la libreta: " + d.nodos + " (de los cuales por Internet/MQTT: " + d.porMqtt + ")",
    "Mensajes guardados: " + d.mensajes, "Muestras de telemetría: " + d.muestrasTele,
    "Eventos: " + d.eventos + " · Rutas guardadas: " + d.rutas, "Mosaicos de mapa guardados: " + d.mosaicosMapa, "",
    "Almacenamiento usado: " + fmtKB(d.almacenamiento.total)];
  for (const [k, v] of Object.entries(d.almacenamiento.out)) L.push("   " + k + ": " + fmtKB(v));
  L.push("", "Servidores MQTT conectados: " + d.mqtt, "Conexión con el nodo: " + d.conexion,
    "Equipo: " + d.nucleos + " núcleos · " + d.memoriaGB + " GB de memoria", "Navegador: " + d.navegador);
  return L.join("\n");
}
function viewPerf(body) {
  const c = opsCfg(), res = el("div", { class: "perfres" }, el("small", { class: "muted" }, "Tocá «Medir ahora»: la medición tarda unos 3 segundos."));
  const num = (key, min, max, step, unit) => el("div", { class: "rv inl" }, el("input", { class: "inp", type: "number", min, max, step, value: c[key], style: "width:110px", onchange: (e) => { const v = +e.target.value; if (isFinite(v)) opsSave({ [key]: Math.min(max, Math.max(min, v)) }); } }), el("span", { class: "unit" }, unit));
  const pintar = (d) => {
    const fila = (k, v, mal) => el("div", { class: "tprow" + (mal ? " malo" : "") }, el("span", {}, k), el("b", {}, v));
    res.replaceChildren(
      el("div", { class: "perfhead " + (d.fps >= 50 ? "ok" : d.fps >= 30 ? "medio" : "malo") }, el("b", {}, d.fps + " cuadros por segundo"), el("span", {}, d.fps >= 50 ? "El portal va fluido en esta pantalla." : d.fps >= 30 ? "Se nota algo lento." : "Va lento: mirá los números de abajo.")),
      fila("Tiempo por cuadro (típico)", d.p50 + " ms", d.p50 > 33), fila("El 95 % de los cuadros bajo", d.p95 + " ms", d.p95 > 50), fila("Peor cuadro", d.peor + " ms"),
      fila("Apertura del portal", d.aperturaMs != null ? d.aperturaMs + " ms" : "sin dato", d.aperturaMs > 3000),
      fila("Nodos en la libreta", d.nodos + (d.porMqtt ? " (" + d.porMqtt + " por Internet)" : ""), d.nodos > 2000),
      fila("Mensajes guardados", String(d.mensajes), d.mensajes > 6000), fila("Muestras de telemetría", String(d.muestrasTele), d.muestrasTele > 40000),
      fila("Mosaicos de mapa guardados", String(d.mosaicosMapa)),
      fila("Almacenamiento usado", fmtKB(d.almacenamiento.total), d.almacenamiento.total > 4e6),
      ...Object.entries(d.almacenamiento.out).map(([k, v]) => el("div", { class: "tprow sub" }, el("span", {}, k), el("b", {}, fmtKB(v)))),
      fila("Servidores MQTT conectados", d.mqtt), fila("Equipo", d.nucleos + " núcleos · " + d.memoriaGB + " GB"),
      el("div", { class: "chips" },
        el("button", { class: "mini acc", onclick: async () => { try { await navigator.clipboard.writeText(perfTexto(d)); toast("Diagnóstico copiado: pegalo donde lo necesites", "ok"); } catch (e) { toast("El navegador no dejó copiar al portapapeles. Seleccioná el texto a mano y copialo con Ctrl+C.", "err"); } } }, "Copiar diagnóstico"),
        el("button", { class: "mini", onclick: () => download("diagnostico-rendimiento.txt", new Blob([perfTexto(d)], { type: "text/plain;charset=utf-8" })) }, "Guardar en un archivo")));
  };
  const medir = el("button", { class: "btn", onclick: async () => { medir.disabled = true; medir.textContent = "Midiendo…"; res.replaceChildren(el("small", { class: "muted" }, "Midiendo durante 3 segundos, no toques nada…")); const d = await perfMedir(); pintar(d); medir.disabled = false; medir.textContent = "Medir de nuevo"; } }, "Medir ahora");
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Rendimiento y limpieza"), el("small", { class: "muted" }, "Para saber por qué el portal va lento en este equipo y liberar espacio sin perder lo importante.")), el("div", { class: "phr" }, medir)),
    el("div", { class: "form" }, secH("Medición en este equipo"), res,
      secH("Limpieza automática de la libreta de nodos"),
      el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, "Por qué sirve"), el("small", {}, "Con MQTT entran nodos de todo el país que no son de tu red. Cuantos más nodos hay, más tarda cada dibujo de pantalla. El portal los va soltando solo. Nunca borra tu nodo, los favoritos, los que te escribieron ni los que llegan por radio."))),
      actRow("Olvidar nodos de Internet sin señal hace", "Se sueltan los que llegaron por MQTT y no se escucharon en este tiempo.", num("keepDays", 1, 90, 1, "días")),
      actRow("Tope de nodos en la libreta", "Si se pasa de este número, se sueltan primero los más viejos.", num("maxNodes", 200, 10000, 100, "nodos")),
      actRow("Limpiar ahora", "Aplica la limpieza en este momento y te dice cuántos nodos soltó.", el("button", { class: "btn ghost", onclick: () => { const k = pruneNodes(true); toast(k ? "Se soltaron " + k + " nodos viejos" : "No había nodos viejos para soltar", k ? "ok" : ""); renderMain(); } }, "Limpiar ahora")),
      secH("Si sigue lento"),
      el("div", { class: "row" }, el("div", { class: "rl" }, el("b", {}, "Qué probar, en orden"), el("small", {}, "1) Cerrá las otras pestañas del navegador y volvé a medir. 2) Desconectá los servidores MQTT que no uses (Ajustes → Internet y MQTT): cada uno trae tráfico de toda la red. 3) En el mapa, apagá las capas que no mires (rastros, cobertura, vecinos). 4) Si el almacenamiento pasa de 4 MB, usá «Limpiar ahora» y, si hace falta, borrá los datos desde Administración y respaldo.")))));
}
window.__perf = { perfMedir, perfTexto, lsUse, pruneNodes, toast };
function viewSound(body) {
  const c = sndCfg(), sw = (on, f) => el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!on, onchange: (e) => f(e.target.checked) }), el("span", {}));
  const btn = (t, f, cls) => el("button", { class: "btn " + (cls ?? "ghost"), onclick: f }, t);
  const vol = el("input", { type: "range", min: 0.1, max: 1, step: 0.05, value: c.vol, oninput: (e) => { sndSave({ vol: +e.target.value }); vo.textContent = Math.round(+e.target.value * 100) + " %"; } });
  const vo = el("span", { class: "unit" }, Math.round(c.vol * 100) + " %");
  const q = c.quiet, qf = el("input", { class: "inp", type: "time", value: q.from, style: "width:135px", onchange: (e) => sndSave({ quiet: { ...sndCfg().quiet, from: e.target.value } }) }), qt = el("input", { class: "inp", type: "time", value: q.to, style: "width:135px", onchange: (e) => sndSave({ quiet: { ...sndCfg().quiet, to: e.target.value } }) });
  const evRows = SND_EV.map(([k, label, hint]) => {
    const e = c.ev[k], fileName = sndFiles[k] && sndFiles[k].name;
    const sel = el("select", { class: "inp", style: "min-width:210px", onchange: (ev) => { sndEvSave(k, { tone: ev.target.value }); playEvent(k, true); } },
      ...Object.entries(TONES).map(([id, t]) => el("option", { value: id, selected: e.tone === id }, t.name)),
      fileName ? el("option", { value: "custom", selected: e.tone === "custom" }, "Mi sonido: " + fileName) : null);
    const fi = el("input", { type: "file", accept: "audio/*", style: "display:none", onchange: (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      if (f.size > 400 * 1024) return toast("El archivo pesa más de 400 KB: elegí uno más corto (unos segundos)", "err");
      const r = new FileReader(); r.onload = () => { sndFiles[k] = { name: f.name.slice(0, 40), data: r.result }; sndBuf.delete(k); if (!sndFilesSave()) { delete sndFiles[k]; return toast("No hay lugar para guardar el sonido en este navegador", "err"); } sndEvSave(k, { tone: "custom" }); renderMain(); playEvent(k, true); toast("Sonido cargado: " + f.name, "ok"); }; r.readAsDataURL(f);
    } });
    return el("div", { class: "row sndrow" }, el("div", { class: "rl" }, el("b", {}, label), el("small", {}, hint)),
      el("div", { class: "rv inl" }, sw(e.on, (v) => sndEvSave(k, { on: v })), sel, btn("▶ Probar", () => playEvent(k, true)), btn("Mi sonido…", () => fi.click()), fileName ? btn("Quitar", () => { delete sndFiles[k]; sndBuf.delete(k); sndFilesSave(); if (sndCfg().ev[k].tone === "custom") sndEvSave(k, { tone: SND_DEF.ev[k].tone }); renderMain(); }) : null, fi));
  });
  const chans = activeChans().length ? activeChans().map((i) => [i, chName(i)]) : chCache.map((x) => [x.i, x.name]);
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Sonidos y notificaciones"), el("small", { class: "muted" }, "Cada aviso tiene su propio tono. Se guardan en este navegador y valen mientras el portal esté abierto."))),
    el("div", { class: "form" },
      secH("General"),
      actRow("Sonidos activados", "Interruptor general: si está apagado no suena nada.", sw(c.on, (v) => sndSave({ on: v }))),
      actRow("Volumen", "Aplica a todos los tonos.", [vol, vo]),
      actRow("Silencio nocturno", "No suena nada en el horario elegido (los botones “Probar” siempre suenan).", [sw(q.on, (v) => sndSave({ quiet: { ...sndCfg().quiet, on: v } })), el("span", { class: "unit" }, "de"), qf, el("span", { class: "unit" }, "a"), qt]),
      secH(IS_APP ? "Avisos del celular" : "Avisos del sistema", IS_APP ? "Con la app en segundo plano o la pantalla apagada, los mensajes llegan como avisos de Android; al tocarlos se abre la conversación. Las alertas de emergencia usan el sonido de alarma." : "Con el portal minimizado o en otra pestaña, los mensajes aparecen como avisos de Windows / del navegador."),
      actRow("Mostrar avisos de mensajes", "Directos, favoritos y alertas. Las alertas de emergencia se avisan siempre.", sw(notifCfg().on, (v) => notifSave({ on: v }))),
      actRow("Incluir mensajes de canales", "Si está apagado solo avisan los directos, los favoritos y las alertas. Los canales silenciados más abajo tampoco avisan.", sw(notifCfg().ch, (v) => notifSave({ ch: v }))),
      !IS_APP ? actRow("Permiso del navegador", typeof Notification === "undefined" ? "Este navegador no permite avisos." : Notification.permission === "granted" ? "Concedido ✓" : Notification.permission === "denied" ? "Bloqueado: habilitalo desde el candado de la barra de direcciones." : "Hace falta dar permiso una vez.", typeof Notification !== "undefined" && Notification.permission === "default" ? btn("Permitir avisos", () => Notification.requestPermission().then(() => renderMain()), "") : null) : null,
      secH("Tono de cada aviso", "Elegí el tono de la lista o cargá tu propio sonido (un archivo corto de audio, hasta 400 KB)."),
      ...evRows,
      secH("Canales", "Silenciá los grupos que hablan mucho. Los mensajes directos y los de favoritos siguen sonando."),
      ...(chans.length ? chans.map(([i, name]) => actRow("# " + name, "Sonar cuando llega un mensaje a este canal", sw(!c.mutedCh.includes(i), (v) => { const m = new Set(sndCfg().mutedCh); v ? m.delete(i) : m.add(i); sndSave({ mutedCh: [...m] }); }))) : [el("div", { class: "muted pad" }, "Los canales aparecen cuando conectás el nodo por primera vez.")]),
      secH("Restablecer"),
      actRow("Valores de fábrica", "Vuelve los tonos, el volumen y los silencios al estado inicial (no borra tus sonidos cargados).", btn("Restablecer", () => { try { localStorage.removeItem(SND_KEY); } catch (e) {} renderMain(); toast("Sonidos restablecidos"); }))));
}
function viewSystem(body) {
  const rb = numIn(5, 0, 3600), sd = numIn(5, 0, 3600), dd = numIn(30, 1, 3650);
  const bkLoc = el("select", { class: "inp", style: "width:140px", "aria-label": "Dónde guardar el respaldo dentro del nodo" }, el("option", { value: 0 }, "Memoria flash"), el("option", { value: 1 }, "Tarjeta SD"));
  const inactive = () => { const lim = Date.now() / 1000 - (+dd.value || 30) * 86400; return [...S.nodes.values()].filter((n) => n.num !== S.me && !n.fav && (!n.lastHeard || n.lastHeard < lim)); };
  const fi = el("input", { type: "file", accept: ".cfg,.bin", style: "display:none", onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) f.arrayBuffer().then((b) => openRestoreDialog(new Uint8Array(b), f.name)).catch((er) => toast("No se pudo leer el archivo: " + er.message, "err")); } });
  const keysCk = el("input", { type: "checkbox" });
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Administración del nodo"), el("small", { class: "muted" }, "Operaciones sobre el módulo conectado, respaldo de su configuración y datos guardados en este navegador."))),
    el("div", { class: "form" },
      secH("Energía"),
      actRow("Reiniciar", "El portal se reconecta solo cuando el nodo vuelve.", [rb, el("span", { class: "unit" }, "s"), btn("Reiniciar", async () => { S.expectReboot = true; await sendAdmin("rebootSeconds", Math.max(0, +rb.value | 0)); toast("Reiniciando…"); })]),
      actRow("Apagar", "Hay que volver a encenderlo a mano.", [sd, el("span", { class: "unit" }, "s"), btn("Apagar", async () => { if (confirm("¿Apagar el nodo?\n\nDeja de recibir y de repetir mensajes. Para encenderlo hay que apretar el botón del módulo: no se puede prender desde el portal.")) { await sendAdmin("shutdownSeconds", Math.max(0, +sd.value | 0)); toast("Apagando…"); } })]),
      actRow("Modo DFU (nRF52)", "Reinicia el equipo como unidad USB para cargar firmware arrastrando el .uf2. Solo placas nRF52 (RAK4631, T-Echo…).", btn("Entrar en modo DFU", async () => { if (confirm("El nodo dejará de responder hasta que cargues firmware o lo reinicies a mano. ¿Continuar?")) { await sendAdmin("enterDfuModeRequest", true); toast("Modo DFU solicitado"); } })),
      secH("Hora"),
      actRow("Poner en hora el nodo", "Copia la hora de esta computadora al nodo (útil sin GPS ni Internet). Los mensajes y posiciones usan esta hora.", btn("Sincronizar con esta PC", async () => { await sendAdmin("setTimeOnly", Math.floor(Date.now() / 1000)); toast("Hora enviada: " + new Date().toLocaleString(), "ok"); })),
      secH("Sonidos"),
      actRow("Tonos de notificación", "Elegí un tono para cada tipo de aviso, el volumen, el silencio nocturno y los canales silenciados.", btn("Configurar sonidos…", async () => setView("settings", "portal.snd"))),
      secH("Lista de nodos"),
      actRow("Borrar nodos inactivos", "Quita del nodo los contactos sin actividad hace más de N días (no toca favoritos).", [dd, el("span", { class: "unit" }, "días"), btn("Borrar", async () => { const l = inactive(); if (!l.length) return toast("No hay nodos inactivos con ese criterio"); if (!confirm(`Se van a quitar ${l.length} nodo(s) de la lista del módulo. ¿Continuar?`)) return; for (const n of l) { await sendAdmin("removeByNodenum", n.num); S.nodes.delete(n.num); } scheduleRefresh("all"); toast(l.length + " nodo(s) quitados", "ok"); })]),
      actRow("Borrar toda la lista de nodos", "Vacía el NodeDB del módulo; los nodos se vuelven a descubrir con el tiempo.", btn("Borrar lista", async () => { if (confirm("¿Borrar la lista de nodos que guarda el módulo?\n\nEl módulo olvida todos los nodos que conoce y los vuelve a aprender a medida que los escucha. Lo guardado en el portal no se toca.")) { S.expectReboot = true; await sendAdmin("nodedbReset", true); S.nodes.clear(); upsertNode(S.me, {}); toast("Lista de nodos reiniciada"); } })),
      secH("Respaldo y restauración", "Archivo .cfg (perfil de dispositivo del sistema LoRa Mesh): nombre, canales, configuración de radio/dispositivo/módulos, posición fija, mensajes predefinidos y tono."),
      actRow("Guardar respaldo en un archivo", "Descarga un .cfg con la configuración actual del nodo. Contiene las claves de los canales: guardalo en un lugar seguro.", [el("label", { class: "ck" }, keysCk, el("span", {}, "Incluir clave privada del nodo")), btn("Descargar respaldo", () => exportProfile(keysCk.checked), "")]),
      actRow("Restaurar desde un archivo", "Elegí un .cfg y revisá qué secciones aplicar antes de enviarlas al nodo.", [btn("Elegir archivo…", async () => fi.click(), "")]),
      actRow("Respaldo dentro del nodo", "El firmware guarda una copia de su configuración en su propia memoria y la puede restaurar después.", [bkLoc, btn("Guardar", async () => { await sendAdmin("backupPreferences", +bkLoc.value); toast("Respaldo guardado en el nodo", "ok"); }), btn("Restaurar", async () => { if (confirm("Se reemplaza la configuración actual por la copia guardada y el nodo se reinicia. ¿Continuar?")) { S.expectReboot = true; await sendAdmin("restorePreferences", +bkLoc.value); toast("Restaurando…"); } }), btn("Borrar copia", async () => { await sendAdmin("removeBackupPreferences", +bkLoc.value); toast("Copia borrada"); })]),
      secH("Datos del portal", "Lo que guarda este navegador (no se toca el módulo)."),
      actRow("Exportar telemetría y configuración", "Volcado completo en JSON: configuración, canales (sin claves), nodos, telemetría, rastros y waypoints.", el("button", { class: "btn ghost", onclick: () => exportDump() }, "Exportar JSON")),
      actRow("Imprimir / guardar chats en PDF", "Informe con todos los datos de cada mensaje, listo para imprimir o guardar como PDF.", el("button", { class: "btn ghost", onclick: () => openPrintDialog() }, "Abrir informe")),
      actRow("Exportar mensajes", "Descarga el historial guardado en este navegador (JSON).", el("button", { class: "btn ghost", onclick: () => download("mensajes-lora-mesh.json", new Blob([JSON.stringify(S.msgs, null, 1)], { type: "application/json" })) }, "Descargar")),
      actRow("Borrar historial local", "Elimina mensajes y nodos guardados en este navegador.", el("button", { class: "btn ghost", onclick: () => { if (confirm("¿Borrar el historial guardado en esta computadora?\n\nSe pierden los mensajes, la telemetría y las novedades guardados acá. No se puede deshacer.")) { S.msgs = []; try { localStorage.removeItem(cacheKey("msgs")); localStorage.removeItem(cacheKey("nodes")); } catch (e) {} scheduleRefresh("all"); toast("Historial local borrado"); } } }, "Borrar")),
      secH("Zona peligrosa"),
      actRow("Restablecer la configuración", "Vuelve toda la configuración a los valores de fábrica pero conserva la identidad (claves) y la lista de nodos.", btn("Restablecer configuración", async () => { if (prompt("Escribí RESTABLECER para confirmar") === "RESTABLECER") { S.expectReboot = true; await sendAdmin("factoryResetConfig", 1); toast("Configuración restablecida"); } }, "danger")),
      actRow("Restablecer de fábrica (todo)", "Borra TODO: configuración, claves, canales y nodos. No se puede deshacer.", btn("Restablecer de fábrica", async () => { if (prompt("Escribí BORRAR TODO para confirmar") === "BORRAR TODO") { S.expectReboot = true; await sendAdmin("factoryResetDevice", 1); toast("Restablecido de fábrica"); } }, "danger"))), fi);
}

const LC_FIELDS = () => NLocal.LocalConfigSchema.fields.map((f) => f.localName).filter((n) => n !== "version");
const LM_FIELDS = () => NLocal.LocalModuleConfigSchema.fields.map((f) => f.localName).filter((n) => n !== "version");
async function fetchExtras() {
  const out = {};
  try { out.canned = await adminCall("getCannedMessageModuleMessagesRequest", true, "getCannedMessageModuleMessagesResponse", 5000); } catch (e) {}
  try { out.ringtone = await adminCall("getRingtoneRequest", true, "getRingtoneResponse", 5000); } catch (e) {}
  return out;
}
async function exportProfile(withKeys) {
  if (S.demo) return toast("Modo demo: no hay nodo del que respaldar");
  if (!ready()) return toast("Conectá el nodo primero", "err");
  toast("Leyendo mensajes predefinidos y tono del nodo…");
  const ex = await fetchExtras();
  const me = S.nodes.get(S.me), u = me && me.rawUser;
  const config = create(NLocal.LocalConfigSchema), mc = create(NLocal.LocalModuleConfigSchema);
  for (const k of LC_FIELDS()) if (S.cfg[k]) config[k] = clone(S.cfg[k] && NLocal.LocalConfigSchema.fields.find((f) => f.localName === k).message, S.cfg[k]);
  for (const k of LM_FIELDS()) if (S.mod[k]) mc[k] = clone(NLocal.LocalModuleConfigSchema.fields.find((f) => f.localName === k).message, S.mod[k]);
  if (config.security && !withKeys) { config.security.privateKey = new Uint8Array(); }
  const settings = S.channels.filter((c) => c && c.role !== 0).map((c) => c.settings);
  const url = "https://meshtastic.org/e/#" + b64url(toBinary(NApp.ChannelSetSchema, create(NApp.ChannelSetSchema, { settings, loraConfig: S.cfg.lora })));
  const prof = create(NClient.DeviceProfileSchema, { longName: u && u.longName, shortName: u && u.shortName, channelUrl: url, config, moduleConfig: mc, isUnmessagable: u && u.isUnmessagable, isLicensed: u && u.isLicensed });
  if (S.cfg.position && S.cfg.position.fixedPosition) { const mp = mePos(); if (mp) prof.fixedPosition = create(NMesh.PositionSchema, { latitudeI: Math.round(mp.lat * 1e7), longitudeI: Math.round(mp.lon * 1e7), altitude: Math.round(mp.alt || 0) }); }
  if (ex.canned !== undefined) prof.cannedMessages = ex.canned;
  if (ex.ringtone !== undefined) prof.ringtone = ex.ringtone;
  const nm = ((u && u.shortName) || "nodo").replace(/[^\w-]+/g, "") + "_" + new Date().toISOString().slice(0, 10);
  download("lora-mesh_" + nm + ".cfg", new Blob([toBinary(NClient.DeviceProfileSchema, prof)], { type: "application/octet-stream" }));
  toast("Respaldo descargado" + (withKeys ? " (incluye la clave privada)" : ""), "ok");
}
function openRestoreDialog(bytes, fname) {
  let p; try { p = fromBinary(NClient.DeviceProfileSchema, bytes); } catch (e) { return toast("El archivo no es un respaldo válido (.cfg)", "err"); }
  const cfgKeys = p.config ? LC_FIELDS().filter((k) => p.config[k]) : [], modKeys = p.moduleConfig ? LM_FIELDS().filter((k) => p.moduleConfig[k]) : [];
  let set = null; try { if (p.channelUrl) set = fromBinary(NApp.ChannelSetSchema, unb64url(p.channelUrl.split("#")[1])); } catch (e) {}
  const hasPriv = !!(p.config && p.config.security && p.config.security.privateKey && p.config.security.privateKey.length);
  const opt = { owner: true, chans: true, pos: true, canned: true, ring: true, keys: false }, cfgOn = new Set(cfgKeys.filter((k) => k !== "security")), modOn = new Set(modKeys), secOn = { v: false };
  const ck = (label, on, fn, dis) => el("label", { class: "ck" }, el("input", { type: "checkbox", checked: on, disabled: !!dis, onchange: (e) => fn(e.target.checked) }), el("span", {}, label));
  const sections = [];
  const sec = (title, items) => items.length && sections.push(el("div", { class: "lsec" }, title), ...items);
  sec("Identidad", [(p.longName || p.shortName) ? ck(`Nombre: ${p.longName || ""} (${p.shortName || ""})`, true, (v) => (opt.owner = v)) : null].filter(Boolean));
  sec("Canales", set ? [ck(`${set.settings.length} canal(es): ${set.settings.map((s) => s.name || "(por defecto)").join(", ")} — reemplaza los actuales`, true, (v) => (opt.chans = v))] : []);
  const NM_CFG = { device: "Dispositivo", position: "Posición", power: "Energía", network: "Red", display: "Pantalla", lora: "LoRa (región y preset)", bluetooth: "Bluetooth", security: "Seguridad" };
  sec("Configuración", cfgKeys.map((k) => k === "security" ? ck("Seguridad (claves de administración y política)" + (hasPriv ? " — el archivo trae la clave privada" : ""), false, (v) => (v ? (cfgOn.add("security"), (secOn.v = true)) : (cfgOn.delete("security"), (secOn.v = false)))) : ck(NM_CFG[k] || k, true, (v) => (v ? cfgOn.add(k) : cfgOn.delete(k)))));
  if (hasPriv) sections.push(ck("Restaurar también la identidad (clave privada: cambia el ID del nodo)", false, (v) => (opt.keys = v)));
  sec("Módulos", modKeys.map((k) => ck((GROUPS.module.items.find((i) => i[0] === "mod." + k) || [0, k])[1], true, (v) => (v ? modOn.add(k) : modOn.delete(k)))));
  sec("Otros", [p.fixedPosition ? ck("Posición fija guardada", true, (v) => (opt.pos = v)) : null, p.cannedMessages ? ck("Texto de los mensajes predefinidos", true, (v) => (opt.canned = v)) : null, p.ringtone ? ck("Tono de notificación (RTTTL)", true, (v) => (opt.ring = v)) : null].filter(Boolean));
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() }, el("div", { class: "mbox" }, el("h3", {}, "Restaurar respaldo"), el("small", { class: "muted" }, `${fname} · elegí qué secciones aplicar. Al terminar el nodo se reinicia.`), ...sections,
    el("div", { class: "mfoot" }, el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cancelar"), btn("Aplicar al nodo", async () => {
      if (!confirm("Se van a escribir las secciones elegidas en el nodo y se reiniciará. ¿Continuar?")) return;
      await applySettings(async () => {
        if (opt.owner && (p.longName || p.shortName)) await sendAdmin("setOwner", create(NMesh.UserSchema, { longName: p.longName || "", shortName: p.shortName || "", isLicensed: !!p.isLicensed, isUnmessagable: !!p.isUnmessagable }));
        for (const k of cfgKeys) if (cfgOn.has(k)) {
          const v = clone(NLocal.LocalConfigSchema.fields.find((f) => f.localName === k).message, p.config[k]);
          if (k === "security" && !opt.keys) { v.privateKey = new Uint8Array(); v.publicKey = new Uint8Array(); }
          await sendAdmin("setConfig", create(C.ConfigSchema, { payloadVariant: { case: k, value: v } }));
        }
        for (const k of modKeys) if (modOn.has(k)) await sendAdmin("setModuleConfig", create(M.ModuleConfigSchema, { payloadVariant: { case: k, value: p.moduleConfig[k] } }));
        if (opt.chans && set) for (let i = 0; i < 8; i++) { const s = set.settings[i]; await sendAdmin("setChannel", create(NChannel.ChannelSchema, { index: i, role: s ? (i === 0 ? 1 : 2) : 0, settings: s || {} })); }
        if (opt.pos && p.fixedPosition) await sendAdmin("setFixedPosition", p.fixedPosition);
        if (opt.canned && p.cannedMessages) await sendAdmin("setCannedMessageModuleMessages", p.cannedMessages);
        if (opt.ring && p.ringtone) await sendAdmin("setRingtoneMessage", p.ringtone);
      }, true);
      dlg.remove();
    }, ""))));
  $("#app").append(dlg);
}


/* ───────────────────────── modo demo ───────────────────────── */
function startDemo() {
  S.demo = true; S.status = ST.DeviceConfigured; S.me = 0x10c4ea60;
  const now = Math.floor(Date.now() / 1000), base = { lat: -40.1572, lon: -71.3533 };
  const mk = (num, long, short, dlat, dlon, mins, snr, hops, batt, hw) => upsertNode(num, { user: { longName: long, shortName: short, hwModel: hw, role: 0 }, pos: { lat: base.lat + dlat, lon: base.lon + dlon, alt: 640 }, lastHeard: now - mins * 60, snr, hops, battery: batt, voltage: 3.9, chUtil: 8.2 });
  const H = Mesh.HardwareModel;
  mk(S.me, "Nodo demo", "DEMO", 0, 0, 0, undefined, 0, 84, H.HELTEC_V3 ?? 43);
  mk(0xa1b2c301, "Repetidor cerro", "RPT1", 0.045, -0.06, 4, 6.5, 0, 101, H.RAK4631 ?? 9);
  mk(0xa1b2c302, "Base del valle", "BAS1", 0.02, 0.19, 12, -3.2, 1, 71, H.TBEAM ?? 4);
  mk(0xa1b2c303, "Móvil 4x4", "MV04", -0.03, -0.02, 35, 2.0, 0, 55, H.TLORA_V2_1_1P6 ?? 6);
  mk(0xa1b2c304, "Refugio montaña", "REF1", 0.11, 0.02, 260, -9.0, 2, 33, H.HELTEC_V3 ?? 43);
  S.channels[0] = create(NChannel.ChannelSchema, { index: 0, role: 1, settings: { name: "DEMOmesh", psk: new Uint8Array([1]) } });
  S.channels[1] = create(NChannel.ChannelSchema, { index: 1, role: 2, settings: { name: "PRUEBAS", psk: crypto.getRandomValues(new Uint8Array(32)) } });
  S.cfg.lora = create(C.Config_LoRaConfigSchema, { region: C.Config_LoRaConfig_RegionCode.ANZ, usePreset: true, modemPreset: 0, hopLimit: 7, txEnabled: true });
  S.cfg.device = create(C.Config_DeviceConfigSchema, { role: 0, nodeInfoBroadcastSecs: 10800 });
  S.cfg.position = create(C.Config_PositionConfigSchema, { positionBroadcastSecs: 900, gpsMode: 1 });
  S.cfg.power = create(C.Config_PowerConfigSchema); S.cfg.network = create(C.Config_NetworkConfigSchema); S.cfg.display = create(C.Config_DisplayConfigSchema, { screenOnSecs: 60 });
  S.cfg.bluetooth = create(C.Config_BluetoothConfigSchema, { enabled: true }); S.cfg.security = create(C.Config_SecurityConfigSchema, { publicKey: crypto.getRandomValues(new Uint8Array(32)) });
  for (const k of Object.keys(MOD_DESC)) S.mod[k] = create(MOD_DESC[k]);
  S.meta = { firmwareVersion: "2.8.1.demo" };
  const T = (m) => Date.now() - m * 60000;
  const NQ0 = 0xa1b2c302, CH0 = 0xa1b2c301, MV0 = 0xa1b2c303;
  S.msgs = [
    { id: 0x1a2b3c01, t: T(60 * 26), from: NQ0, to: 0xffffffff, ch: 0, dm: false, text: "Buen día a todos, probando el enlace desde la base.", mine: false, snr: 3.25, rssi: -97, hops: 1, hopStart: 3, hopLimit: 2, relay: 0x4d, bytes: 52, fn: "Base del valle", sn: "BAS1", dist: 16.3, sPos: { lat: -40.137, lon: -71.163 }, prio: 64 },
    { id: 0x1a2b3c02, t: T(60 * 26 - 3), from: S.me, to: 0xffffffff, ch: 0, dm: false, text: "Recibido, todo bien por acá.", mine: true, st: "ok", bytes: 38 },
    { id: 0x1a2b3c03, t: T(60 * 5), from: MV0, to: 0xffffffff, ch: 0, dm: false, text: "Móvil 4x4 en camino, ETA 40 min 🚙", mine: false, snr: 6.5, rssi: -84, hops: 0, hopStart: 3, hopLimit: 3, bytes: 50, fn: "Móvil 4×4", sn: "MV04", dist: 3.7, sPos: { lat: -40.18, lon: -71.37 }, prio: 64 },
    { id: 1, t: T(42), from: NQ0, to: 0xffffffff, ch: 0, dm: false, text: "Buenas tardes, ¿alguien escucha desde el centro?", mine: false, snr: -3.2, rssi: -112, hops: 1, hopStart: 3, hopLimit: 2, relay: 0x9f, bytes: 48, fn: "Base del valle", sn: "BAS1", dist: 16.3, sPos: { lat: -40.137, lon: -71.163 }, prio: 64 },
    { id: 2, t: T(40), from: S.me, to: 0xffffffff, ch: 0, dm: false, text: "Recibido Base, señal limpia desde acá.", mine: true, st: "ok", bytes: 47 },
    { id: 4, t: T(25), from: S.me, to: 0xffffffff, ch: 1, dm: false, text: "Prueba en el canal PRUEBAS", mine: true, st: "ok", bytes: 28 },
    { id: 3, t: T(12), from: CH0, to: S.me, ch: 0, dm: true, text: "Repetidor cerro OK · batería 100% · panel cargando", mine: false, snr: 6.5, rssi: -79, hops: 0, hopStart: 3, hopLimit: 3, pki: true, bytes: 53, fn: "Repetidor cerro", sn: "RPT1", dist: 7.15, sPos: { lat: -40.1122, lon: -71.4133 }, prio: 70 },
    { id: 5, t: T(9), from: S.me, to: CH0, ch: 0, dm: true, text: "Gracias, confirmado.", mine: true, st: "ok", bytes: 20 },
    { id: 6, t: T(3), from: S.me, to: NQ0, ch: 0, dm: true, text: "Base del valle, ¿me confirma recepción del mensaje?", mine: true, st: "fail", why: "NO_RESPONSE", bytes: 49 },
  ];
  // telemetría, rastros y capas de ejemplo
  const tn = Date.now(), CH = 0xa1b2c301, NQ = 0xa1b2c302, MV = 0xa1b2c303, LAN = 0xa1b2c304;
  for (let i = 47; i >= 0; i--) {
    const t = tn - i * 15 * 60000;
    recordTele(S.me, "device", { batteryLevel: Math.round(78 + 8 * Math.sin(i / 6) - i / 12), voltage: +(3.95 + 0.12 * Math.sin(i / 6)).toFixed(2), channelUtilization: +(6 + 3 * Math.sin(i / 3)).toFixed(1), airUtilTx: +(0.8 + 0.4 * Math.cos(i / 4)).toFixed(2), uptimeSeconds: 86400 * 3 + (47 - i) * 900 }, t);
    recordTele(S.me, "env", { temperature: +(8 + 5 * Math.sin((i - 20) / 7.5)).toFixed(1), relativeHumidity: +(62 + 12 * Math.cos(i / 8)).toFixed(0), barometricPressure: +(922 + 2 * Math.sin(i / 10)).toFixed(1) }, t);
    recordTele(CH, "device", { batteryLevel: 101, voltage: +(13.1 + 0.4 * Math.sin(i / 5)).toFixed(2), channelUtilization: +(9 + 2 * Math.sin(i / 2)).toFixed(1), airUtilTx: 1.2, uptimeSeconds: 86400 * 21 + (47 - i) * 900 }, t);
    recordTele(CH, "env", { temperature: +(-2 + 6 * Math.sin((i - 20) / 7.5)).toFixed(1), relativeHumidity: 70, barometricPressure: +(815 + Math.sin(i / 9)).toFixed(1) }, t);
  }
  recordTele(S.me, "local", { uptimeSeconds: 86400 * 3 + 2700, channelUtilization: 6.4, airUtilTx: 0.9, numPacketsTx: 412, numPacketsRx: 5230, numPacketsRxBad: 38, numOnlineNodes: 4, numTotalNodes: 5, numRxDupe: 211, numTxRelay: 87, numTxRelayCanceled: 14, heapTotalBytes: 327680, heapFreeBytes: 181240 }, tn);
  recordTele(NQ, "device", { batteryLevel: 71, voltage: 3.88, channelUtilization: 5.1, airUtilTx: 0.4, uptimeSeconds: 7200 }, tn - 12 * 60000);
  recordTele(MV, "device", { batteryLevel: 55, voltage: 3.74, channelUtilization: 4.2, airUtilTx: 0.6, uptimeSeconds: 5400 }, tn - 35 * 60000);
  for (let j = 0; j < 26; j++) {
    const lat = base.lat - 0.03 + j * 0.0012, lon = base.lon - 0.07 + j * 0.0027;
    const tr = S.tracks.get(MV) || []; tr.push({ t: tn - (26 - j) * 120000, lat, lon, alt: 700 - j * 3, snr: +(8 - j * 0.65).toFixed(1) }); S.tracks.set(MV, tr);
  }
  S.neigh.set(CH, [{ id: NQ, snr: 4.2 }, { id: S.me, snr: 6.5 }]); S.neighT.set(CH, tn - 25 * 60000);
  for (const [num, snr, rssi, hops, min] of [[CH, 6.5, -79, 0, 4], [MV, 2.0, -101, 0, 35], [NQ, -3.2, -112, 1, 12], [LAN, -9.0, -118, 2, 260]]) recordTele(num, "link", hops === 0 ? { snr, rssi, hops } : { snr, rssi, hops, relay: CH & 255 }, tn - min * 60000);
  S.nodes.get(NQ).relay = CH & 255; S.nodes.get(NQ).relayT = tn - 12 * 60000; S.nodes.get(LAN).relay = CH & 255; S.nodes.get(LAN).relayT = tn - 260 * 60000;
  S.traces = [{ t: tn - 50 * 60000, me: S.me, dest: NQ, route: [CH], snrT: [6.25, 4.0], back: [CH], snrB: [3.75, 6.5] }];
  S.waypoints.set(1, { id: 1, name: "Punto de reunión", desc: "Refugio base", lat: base.lat + 0.012, lon: base.lon - 0.03, expire: 0, icon: "⛺" });
  S.myInfo = { myNodeNum: S.me, rebootCount: 12, minAppVersion: 30200, pioEnv: "heltec-v3" };
  S.metaObj = { firmwareVersion: "2.8.1.demo", deviceStateVersion: 24, canShutdown: true, hasWifi: true, hasBluetooth: true, hasEthernet: false, role: "CLIENT", hwModel: "HELTEC_V3" };
  S.view = "messages"; S.sub = "radio.lora"; scheduleRefresh("all");
  const proto = (name) => async (...a) => { if (name === "sendText") { const id = Math.floor(Math.random() * 1e9); addMessage({ id, rxTime: new Date(), type: a[1] === "broadcast" ? "broadcast" : "direct", from: S.me, to: a[1] === "broadcast" ? 0xffffffff : a[1], channel: a[3] || 0, data: a[0] }); setTimeout(() => setMsgState(id, "ok"), 700); return id; } return 0; };
  S.device = new Proxy({}, { get: (_, p) => proto(p) });
}

/* ───────────────────────── Internet y MQTT ───────────────────────── */
const MQ_PRESETS = [
  { name: "HiveMQ (público)", url: "wss://broker.hivemq.com:8884/mqtt", host: "broker.hivemq.com" },
  { name: "EMQX (público)", url: "wss://broker.emqx.io:8084/mqtt", host: "broker.emqx.io" },
  { name: "Mosquitto (público)", url: "wss://test.mosquitto.org:8081/", host: "test.mosquitto.org" },
  { name: "Eclipse IoT (público)", url: "wss://mqtt.eclipseprojects.io:443/mqtt", host: "mqtt.eclipseprojects.io" },
  { name: "Flespi", url: "wss://mqtt.flespi.io:443/", host: "mqtt.flespi.io", user: "FlespiToken " },
];
const SRV_DEF = [
  { name: "Servidor público oficial", host: "mqtt.meshtastic.org", port: 8883, tls: true, url: "", user: "meshdev", pass: "large4cats", root: "", enabled: true },
  { name: "HiveMQ (público)", host: "broker.hivemq.com", port: 8883, tls: true, url: "wss://broker.hivemq.com:8884/mqtt", user: "", pass: "", root: "", enabled: true },
  { name: "EMQX (público)", host: "broker.emqx.io", port: 8883, tls: true, url: "wss://broker.emqx.io:8084/mqtt", user: "", pass: "", root: "", enabled: true },
  { name: "Mosquitto (público)", host: "test.mosquitto.org", port: 8886, tls: true, url: "wss://test.mosquitto.org:8081/", user: "", pass: "", root: "", enabled: false },
  { name: "Eclipse IoT (público)", host: "mqtt.eclipseprojects.io", port: 8883, tls: true, url: "wss://mqtt.eclipseprojects.io:443/mqtt", user: "", pass: "", root: "", enabled: false },
  { name: "Flespi (necesita token)", host: "mqtt.flespi.io", port: 8883, tls: true, url: "wss://mqtt.flespi.io:443/", user: "FlespiToken ", pass: "", root: "", enabled: false },
];
const SRV_IDX = SRV_DEF.map((_, i) => i);
const NET_DEF = { v: 3, probeOn: true, probe: "https://1.1.1.1/cdn-cgi/trace", enabled: true, uplink: true, upAll: false, downlink: true, proxy: true, servers: SRV_DEF };
const mqHost = (a) => String(a || "").replace(/^[a-z]+:\/\//i, "").split(/[\/:]/)[0].toLowerCase();
/* acepta "servidor", "servidor:puerto" o la URL completa; un servidor sin WebSocket queda vacío (el portal busca la vía solo) */
function mqNormUrl(u) {
  u = (u || "").trim(); if (!u) return "";
  if (!/^wss?:\/\//i.test(u)) {
    u = u.replace(/^[a-z]+:\/\//i, "");
    const host = mqHost(u);
    const known = MQ_PRESETS.find((p) => p.host === host);
    if (known) return known.url;
    if (/meshtastic/i.test(host)) return "";
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".local") || !host.includes(".");
    u = (local && (location.protocol !== "https:" || IS_APP) ? "ws://" : "wss://") + u;
  }
  return u;
}
function loadNetCfg() {
  let o = {}; try { o = JSON.parse(localStorage.getItem("meshportal:net") || "{}"); } catch (e) {}
  const c = { ...NET_DEF, probeOn: o.probeOn ?? NET_DEF.probeOn, probe: o.probe || NET_DEF.probe, uplink: o.uplink ?? true, upAll: o.upAll ?? false, downlink: o.downlink ?? true, proxy: o.proxy ?? true, enabled: o.v === 3 ? o.enabled !== false : true };
  let sv = o.v === 3 && Array.isArray(o.servers) ? o.servers : null;
  if (!sv) { /* configuración vieja: el servidor propio que hubiera, pasa al lugar 3 */
    sv = JSON.parse(JSON.stringify(SRV_DEF));
    if (/^wss?:\/\//i.test(o.url || "") && !MQ_PRESETS.some((p) => p.url === o.url) && !/meshtastic/i.test(o.url)) sv[2] = { ...sv[2], name: "Mi servidor", host: mqHost(o.url), url: o.url, user: o.user || "", pass: o.pass || "", root: o.root || "" };
  }
  c.servers = SRV_IDX.map((i) => ({ ...SRV_DEF[i], ...(sv[i] || {}) }));
  return c;
}
function saveNetCfg() { try { localStorage.setItem("meshportal:net", JSON.stringify(S.mq.cfg)); } catch (e) {} }
const mqAnyEnabled = () => S.mq.cfg.enabled && S.mq.cfg.servers.some((s) => s.enabled && (s.url || s.host));
S.net = { online: navigator.onLine ? null : false, ms: null, last: 0 };
S.mq = { cfg: loadNetCfg(), srv: SRV_IDX.map(() => ({ client: null, st: "off", err: "", retry: 0, timer: 0, gen: 0, subs: new Set() })), queue: [], stats: { tx: 0, rx: 0, proxyTx: 0, proxyRx: 0, last: 0 }, seen: new Map() };
Object.defineProperties(S.mq, {
  st: { get() { const act = this.srv.filter((x, i) => this.cfg.servers[i].enabled && (this.cfg.servers[i].url || this.cfg.servers[i].host)); if (!this.cfg.enabled || !act.length) return "off"; if (act.some((x) => x.st === "on")) return "on"; if (act.some((x) => x.st === "connecting" || x.st === "off")) return "connecting"; if (act.some((x) => x.st === "error")) return "error"; return "wait"; } },
  err: { get() { const r = this.srv.find((x, i) => this.cfg.servers[i].enabled && x.err); return r ? r.err : ""; } },
  client: { get() { const r = this.srv.find((x) => x.client && x.client.ready); return r ? r.client : null; } },
  subs: { get() { const u = new Set(); this.srv.forEach((x) => x.subs.forEach((t) => u.add(t))); return u; } },
});
const mqClients = () => S.mq.srv.map((r, i) => ({ r, s: S.mq.cfg.servers[i], i })).filter((x) => x.r.client && x.r.client.ready);
const srvLabel = (s, i) => i === 0 ? "servidor oficial (Nº 1)" : ((s && s.name) || "servidor Nº " + (i + 1));

const mqEnc = new TextEncoder(), mqDec = new TextDecoder();
const mqCat = (...a) => { const o = new Uint8Array(a.reduce((x, y) => x + y.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const mqStr = (s) => { const b = mqEnc.encode(s); return mqCat(Uint8Array.of(b.length >> 8, b.length & 255), b); };
const mqLen = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Uint8Array.from(o); };
const mqPkt = (first, body) => mqCat(Uint8Array.of(first), mqLen(body.length), body);

/* cliente MQTT 3.1.1 sobre WebSocket (los navegadores no pueden usar TCP directo) */
class MQTTClient {
  constructor(o) { Object.assign(this, o); this.buf = new Uint8Array(0); this.pid = 1; this.ready = false; }
  connect(timeoutMs = 10000) {
    return new Promise((res, rej) => {
      let ws, done = false;
      const end = (ok, v) => { if (done) return; done = true; clearTimeout(tm); ok ? res(v) : rej(v); };
      try { ws = new WebSocket(this.url, "mqtt"); } catch (e) { return rej(new Error("URL de WebSocket inválida")); }
      const tm = setTimeout(() => { end(false, new Error("Tiempo de espera agotado")); try { ws.close(); } catch (e) {} }, timeoutMs);
      ws.binaryType = "arraybuffer"; this.ws = ws;
      ws.onopen = () => ws.send(this.connectPacket());
      ws.onerror = () => end(false, new Error("No se pudo abrir el WebSocket (¿broker apagado, URL o puerto incorrectos?)"));
      ws.onclose = () => { clearInterval(this.pingT); this.ready = false; end(false, new Error("Conexión cerrada por el broker")); if (this.onclose) this.onclose(); };
      ws.onmessage = (ev) => this.feed(new Uint8Array(ev.data), (code) => { if (code === 0) { this.ready = true; this.pingT = setInterval(() => this.raw(Uint8Array.of(0xc0, 0)), 30000); end(true); } else end(false, new Error(({ 1: "versión de protocolo no soportada", 2: "ClientID rechazado", 3: "servidor no disponible", 4: "usuario o contraseña incorrectos", 5: "no autorizado" })[code] || "rechazado (código " + code + ")")); });
    });
  }
  connectPacket() {
    const u = !!this.user, flags = 0x02 | (u ? 0x80 : 0) | (u && this.pass ? 0x40 : 0);
    return mqPkt(0x10, mqCat(mqStr("MQTT"), Uint8Array.of(4, flags, 0, 60), mqStr(this.clientId), u ? mqStr(this.user) : new Uint8Array(0), u && this.pass ? mqStr(this.pass) : new Uint8Array(0)));
  }
  raw(b) { if (this.ws && this.ws.readyState === 1) this.ws.send(b); }
  publish(topic, payload, retain = false) { if (!this.ready) throw new Error("MQTT no conectado"); this.raw(mqPkt(0x30 | (retain ? 1 : 0), mqCat(mqStr(topic), payload))); }
  subscribe(topics) { if (!topics.length) return; const id = this.pid++ & 0xffff || 1; this.raw(mqPkt(0x82, mqCat(Uint8Array.of(id >> 8, id & 255), ...topics.map((t) => mqCat(mqStr(t), Uint8Array.of(0)))))); }
  close() { try { this.ready = false; clearInterval(this.pingT); this.ws.onclose = null; this.raw(Uint8Array.of(0xe0, 0)); this.ws.close(); } catch (e) {} }
  feed(chunk, onConnack) {
    this.buf = mqCat(this.buf, chunk);
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      let mul = 1, rem = 0, i = 1, d;
      do { if (i >= b.length) return; d = b[i++]; rem += (d & 127) * mul; mul *= 128; } while (d & 128 && i < 5);
      if (b.length < i + rem) return;
      const first = b[0], body = b.subarray(i, i + rem); this.buf = b.slice(i + rem);
      const type = first >> 4;
      if (type === 2) onConnack(body[1]);
      else if (type === 3) {
        const qos = (first >> 1) & 3, tl = (body[0] << 8) | body[1], topic = mqDec.decode(body.subarray(2, 2 + tl)); let p = 2 + tl;
        if (qos > 0) { const pid = body.subarray(p, p + 2); p += 2; if (qos === 1) this.raw(Uint8Array.of(0x40, 2, pid[0], pid[1])); }
        try { this.onmessage && this.onmessage(topic, body.slice(p)); } catch (e) { console.warn(e); }
      }
    }
  }
}

/* ── cifrado de canal (AES-CTR, igual que el firmware) ── */
const DEFAULT_PSK = Uint8Array.from([0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01]);
function expandKey(psk) {
  if (!psk || !psk.length) return null;
  if (psk.length === 1) { if (psk[0] === 0) return null; const k = DEFAULT_PSK.slice(); k[15] = (k[15] + psk[0] - 1) & 255; return k; }
  return psk.length >= 32 ? psk.slice(0, 32) : psk.length >= 16 ? psk.slice(0, 16) : mqCat(psk, new Uint8Array(16 - psk.length));
}
const chHash = (name, key) => { let h = 0; for (const b of mqEnc.encode(name)) h ^= b; if (key) for (const b of key) h ^= b; return h & 255; };
async function aesCtr(key, id, from, data) {
  const nonce = new Uint8Array(16), dv = new DataView(nonce.buffer);
  dv.setUint32(0, id >>> 0, true); dv.setUint32(8, from >>> 0, true);
  const k = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: nonce, length: 32 }, k, data));
}
const PRESET_NAME = ["LongFast", "LongSlow", "VLongSlow", "MediumSlow", "MediumFast", "ShortSlow", "ShortFast", "LongMod", "ShortTurbo"];
function chRealName(i) {
  const c = S.channels[i], n = c && c.settings && c.settings.name;
  if (n) return n;
  return (S.cfg.lora && S.cfg.lora.usePreset !== false ? PRESET_NAME[S.cfg.lora.modemPreset] : null) || "LongFast";
}
function mqRoot(sv) {
  const mc = S.mod.mqtt;
  return ((sv && sv.root) || (mc && mc.root) || "msh/" + (S.cfg.lora ? enumName(C.Config_LoRaConfig_RegionCode, S.cfg.lora.region) : "ANZ")).replace(/\/+$/, "");
}
const proxyActive = () => { const m = S.mod.mqtt; return !!(S.mq.cfg.proxy && m && m.enabled && m.proxyToClientEnabled); };
const isLocalUrl = (u) => { try { const h = new URL(u).hostname; return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(h) || h.endsWith(".local") || !h.includes("."); } catch (e) { return false; } };

/* ── sondeo de Internet ── */
let probeT = 0, probing = false;
async function probeNet() {
  if (probing) return; probing = true;
  const cfg = S.mq.cfg; let on, ms = null;
  if (!navigator.onLine) on = false;
  else if (!cfg.probeOn || !cfg.probe) on = true;
  else {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4500), t0 = performance.now();
    try { await fetch(cfg.probe + (cfg.probe.includes("?") ? "&" : "?") + "_=" + Date.now(), { mode: "no-cors", cache: "no-store", signal: ctl.signal }); on = true; ms = Math.round(performance.now() - t0); } catch (e) { on = false; }
    clearTimeout(to);
  }
  probing = false; setNet(on, ms);
  clearTimeout(probeT); probeT = setTimeout(probeNet, on ? 30000 : 8000);
}
function setNet(on, ms) {
  const was = S.net.online; S.net.online = on; S.net.ms = ms; S.net.last = Date.now();
  if (was !== on) {
    if (was !== null) toast(on ? "Volvió Internet: el portal vuelve a usar MQTT." : "Se cortó Internet: el portal sigue funcionando por LoRa (USB).", on ? "ok" : "err");
    mqEnsure();
  }
  scheduleRefresh("net");
}
window.addEventListener("online", () => probeNet());
window.addEventListener("offline", () => setNet(false, null));

/* ── gestor de las conexiones MQTT (hasta 6 servidores a la vez) ── */
const mqBridge = (s) => `ws://localhost:9001/${mqHost(s.host)}/${s.port || (s.tls ? 8883 : 1883)}/${s.tls ? "tls" : "tcp"}`;
const mqCands = (s, i) => {
  const h = mqHost(s.host), br = h ? [mqBridge(s)] : [];
  if (s.url) return [mqNormUrl(s.url), ...br];
  if (!h) return [];
  return [`wss://${h}/mqtt`, `wss://${h}:443/ws`, `wss://${h}:9001/`, `wss://${h}:8084/mqtt`, `wss://${h}:8083/mqtt`, `wss://${h}:8884/mqtt`, `wss://${h}:8081/`, ...br];
};
async function mqOpen(s, i) {
  const cands = mqCands(s, i); if (!cands.length) throw new Error("Falta la dirección del servidor");
  const mk = (url) => new MQTTClient({ url, user: s.user, pass: s.pass, clientId: "meshportal-" + Math.random().toString(16).slice(2, 10) });
  if (cands.length === 1) { const c = mk(cands[0]); await c.connect(); c.url = cands[0]; return c; }
  const cs = cands.map(mk);
  return new Promise((res, rej) => {
    let fails = 0, won = false;
    cs.forEach((c, k) => c.connect(4000).then(() => { if (won) { c.close(); return; } won = true; cs.forEach((o) => o !== c && o.close()); c.url = cands[k]; res(c); }, () => { if (++fails === cs.length && !won) rej(new Error(s.url ? "No se pudo conectar por la dirección web ni por el puente local. Revisá la dirección, el usuario y la clave." : "Este servidor solo ofrece MQTT por TCP (el navegador no puede usarlo). Ejecutá el puente local (puente-mqtt.py) o tocá “Aplicar al nodo”.")); }));
  });
}
const mqAllowedFor = (s) => !!(s.enabled && (s.url || s.host) && (S.net.online !== false || (s.url && isLocalUrl(s.url))));
function mqCloseOne(i) { const r = S.mq.srv[i]; r.gen++; clearTimeout(r.timer); r.subs.clear(); if (r.client) { const c = r.client; r.client = null; c.close(); } }
function mqClose() { S.mq.srv.forEach((_, i) => mqCloseOne(i)); S.mq.srv.forEach((r) => { r.st = "off"; r.err = ""; }); }
function mqEnsure() { S.mq.cfg.servers.forEach((_, i) => mqEnsureOne(i)); scheduleRefresh("net"); }
function mqEnsureOne(i) {
  const q = S.mq, s = q.cfg.servers[i], r = q.srv[i]; clearTimeout(r.timer);
  if (!q.cfg.enabled || !s.enabled || !(s.url || s.host)) { mqCloseOne(i); r.st = "off"; r.err = ""; return; }
  if (r.st === "on" && r.client) return;
  if (!mqAllowedFor(s)) { mqCloseOne(i); r.st = "wait"; return; }
  if (r.st === "connecting") return;
  mqConnect(i);
}
function mqRetry(i) { const r = S.mq.srv[i]; clearTimeout(r.timer); if (S.mq.cfg.enabled && S.mq.cfg.servers[i].enabled) r.timer = setTimeout(() => mqEnsureOne(i), Math.min(60000, 3000 * 2 ** Math.min(r.retry++, 5))); }
async function mqConnect(i) {
  const q = S.mq, s = q.cfg.servers[i], r = q.srv[i], gen = ++r.gen; r.st = "connecting"; r.err = ""; scheduleRefresh("net");
  let c;
  try { c = await mqOpen(s, i); } catch (e) { if (gen !== r.gen) return; r.st = "error"; r.err = e.message || String(e); r.client = null; mqRetry(i); scheduleRefresh("net"); return; }
  if (gen !== r.gen) { c.close(); return; }
  c.onmessage = (t, p) => mqIncoming(t, p, i);
  c.onclose = () => { if (r.client === c) { r.client = null; r.subs.clear(); r.st = "error"; r.err = "El servidor cerró la conexión"; mqRetry(i); scheduleRefresh("net"); } };
  r.client = c; r.st = "on"; r.retry = 0; r.err = ""; r.via = c.url;
  toast("MQTT conectado: " + (s.name || "servidor " + (i + 1)), "ok");
  mqSubscribe(); mqFlush(); scheduleRefresh("net");
}
function mqSubscribe() {
  const q = S.mq; if (!S.cfg.lora) return;
  q.srv.forEach((r, i) => {
    if (!r.client || !r.client.ready) return;
    const sv = q.cfg.servers[i], want = [];
    S.channels.forEach((c, k) => { if (c && c.role !== 0 && (q.cfg.downlink || (proxyActive() && c.settings && c.settings.downlinkEnabled))) want.push(`${mqRoot(sv)}/2/e/${chRealName(k)}/#`); });
    const add = want.filter((t) => !r.subs.has(t)); add.forEach((t) => r.subs.add(t));
    if (add.length) r.client.subscribe(add);
  });
}

/* ── envío de mis mensajes por MQTT (uplink) ── */
async function mqPublishMsg(msg) {
  const q = S.mq, ch = S.channels[msg.ch];
  const cl = mqClients(); if (!cl.length) throw new Error("sin conexión a ningún servidor");
  if (!ch || !ch.settings) throw new Error("canal sin configurar");
  const key = expandKey(ch.settings.psk), name = chRealName(msg.ch), lora = S.cfg.lora, hop = (lora && lora.hopLimit) || 3;
  const data = toBinary(Mesh.DataSchema, create(Mesh.DataSchema, { portnum: Protobuf.Portnums.PortNum.TEXT_MESSAGE_APP, payload: mqEnc.encode(msg.text), bitfield: lora && lora.configOkToMqtt ? 1 : 0, replyId: msg.replyTo || 0 }));
  const base = { from: S.me, to: 0xffffffff, id: msg.id, hopLimit: hop, hopStart: hop, priority: Mesh.MeshPacket_Priority.DEFAULT, rxTime: Math.floor(msg.t / 1000) };
  const pkt = key
    ? create(Mesh.MeshPacketSchema, { ...base, channel: chHash(name, key), payloadVariant: { case: "encrypted", value: await aesCtr(key, msg.id, S.me, data) } })
    : create(Mesh.MeshPacketSchema, { ...base, channel: msg.ch, payloadVariant: { case: "decoded", value: fromBinary(Mesh.DataSchema, data) } });
  const env = create(Protobuf.Mqtt.ServiceEnvelopeSchema, { packet: pkt, channelId: name, gatewayId: nodeId(S.me) });
  const bin = toBinary(Protobuf.Mqtt.ServiceEnvelopeSchema, env);
  const topicFor = (s) => `${mqRoot(s)}/2/e/${name}/${nodeId(S.me)}`;
  if (q.cfg.upAll) { /* modo redundante: publica la misma copia en cada servidor conectado */
    const via = []; for (const { r, s, i } of cl) { try { r.client.publish(topicFor(s), bin); via.push(srvLabel(s, i)); } catch (e) {} }
    if (!via.length) throw new Error("no se pudo publicar en ningún servidor");
    msg.upVia = via.join(", ");
  } else { /* por el primero disponible; si falla, pasa al siguiente (no se publica por el resto) */
    let lastErr = null, done = false;
    for (const { r, s, i } of cl) { try { r.client.publish(topicFor(s), bin); msg.upVia = srvLabel(s, i); done = true; break; } catch (e) { lastErr = e; } }
    if (!done) throw lastErr || new Error("no se pudo publicar");
  }
  q.stats.tx++; q.stats.last = Date.now();
}
function mqDecideUplink(msg) {
  const q = S.mq, c = q.cfg;
  if (!mqAnyEnabled() || !c.uplink) return undefined;
  if (msg.dm) return "na";
  const chs = S.channels[msg.ch];
  if (proxyActive() && chs && chs.settings && chs.settings.uplinkEnabled) return "node";
  if (q.st === "on") {
    mqPublishMsg(msg).then(() => { msg.up = "ok"; scheduleRefresh("msgs"); persistSoon(); }, (e) => { msg.up = "fail"; msg.upWhy = e.message; scheduleRefresh("msgs"); persistSoon(); });
    return "pending";
  }
  q.queue.push(msg); scheduleRefresh("net");
  return "queued";
}
async function mqFlush() {
  const q = S.mq; if (!mqClients().length || !q.queue.length || !S.cfg.lora) return;
  const list = q.queue.splice(0), now = Date.now(); let ok = 0;
  for (const m of list) {
    if (now - m.t > 3600e3) { m.up = "fail"; m.upWhy = "venció (más de 1 h en cola)"; continue; }
    try { await mqPublishMsg(m); m.up = "ok"; ok++; } catch (e) { m.up = "fail"; m.upWhy = e.message; }
  }
  if (ok) toast(`Se enviaron por MQTT ${ok} mensaje(s) que estaban en cola`, "ok");
  scheduleRefresh("msgs"); scheduleRefresh("net"); persistSoon();
}
function mqRestoreQueue() { S.mq.queue = S.msgs.filter((m) => m.mine && m.up === "queued" && Date.now() - m.t < 3600e3); S.msgs.forEach((m) => { if (m.mine && (m.up === "queued" || m.up === "pending") && !S.mq.queue.includes(m)) { m.up = "fail"; m.upWhy = "venció"; } }); }
const upLabel = (m) => ({ ok: " + MQTT ✓" + (m.upVia ? " (" + m.upVia + ")" : ""), queued: " · MQTT en cola", pending: " · MQTT enviando…", fail: " · MQTT falló" + (m.upWhy ? " (" + m.upWhy + ")" : ""), node: " + MQTT (por el nodo)", na: " · MQTT: solo canales" })[m.up] || "";

/* ── recepción por MQTT (downlink) ── */
async function mqLocal(env, topic) {
  const p = env.packet; if (!p) return;
  let idx = -1, data;
  for (let i = 0; i < 8 && idx < 0; i++) {
    const c = S.channels[i]; if (!c || c.role === 0 || !c.settings) continue;
    if (chRealName(i) !== env.channelId) continue;
    const key = expandKey(c.settings.psk);
    if (p.payloadVariant.case === "decoded") { idx = i; data = p.payloadVariant.value; }
    else if (key && chHash(env.channelId, key) === p.channel) { try { const d = fromBinary(Mesh.DataSchema, await aesCtr(key, p.id, p.from, p.payloadVariant.value)); if (d.portnum) { idx = i; data = d; } } catch (e) {} }
  }
  if (idx < 0 || !data) return;
  const PN = Protobuf.Portnums.PortNum, now = Date.now(), t = Math.floor(now / 1000);
  const hops = p.hopStart ? { hopStart: p.hopStart, hopLimit: p.hopLimit, hops: Math.max(0, p.hopStart - p.hopLimit) } : {};
  if (data.portnum === PN.TEXT_MESSAGE_APP) {
    if (p.to !== 0xffffffff && p.to !== S.me) return;
    S.pktInfo.set(p.id, { via: "mqtt", mqtt: true, gw: env.gatewayId, bytes: data.payload.length, ...hops, ...(data.replyId ? { replyTo: data.replyId } : {}), ...(data.emoji ? { emoji: data.emoji } : {}) });
    addMessage({ id: p.id, rxTime: new Date(now), type: p.to === 0xffffffff ? "broadcast" : "direct", from: p.from, to: p.to, channel: idx, data: mqDec.decode(data.payload) });
    upsertNode(p.from, { lastHeard: t, viaMqtt: true });
  } else if (data.portnum === PN.NODEINFO_APP) {
    try { const u = fromBinary(Mesh.UserSchema, data.payload); upsertNode(p.from, { user: { longName: maskName(u.longName), shortName: u.shortName, hwModel: u.hwModel, role: u.role, id: u.id }, rawUser: u, lastHeard: t, viaMqtt: true }); } catch (e) {}
  } else if (data.portnum === PN.POSITION_APP) {
    try { const d = fromBinary(Mesh.PositionSchema, data.payload); if (d.latitudeI || d.longitudeI) { const lat = d.latitudeI / 1e7, lon = d.longitudeI / 1e7; upsertNode(p.from, { pos: { lat, lon, alt: d.altitude, time: t }, lastHeard: t, viaMqtt: true }); addTrackPoint(p.from, lat, lon, d.altitude, now); } } catch (e) {}
  } else if (data.portnum === PN.TELEMETRY_APP) {
    try {
      const tl = fromBinary(Protobuf.Telemetry.TelemetrySchema, data.payload), v = tl.variant;
      const cat = VARIANT_CAT[v.case], f = Protobuf.Telemetry.TelemetrySchema.field[v.case];
      if (cat && f && f.message) recordTele(p.from, cat, msgToObj(f.message, v.value), now);
      if (v.case === "deviceMetrics") upsertNode(p.from, { battery: v.value.batteryLevel, voltage: v.value.voltage, chUtil: v.value.channelUtilization, airTx: v.value.airUtilTx, uptime: v.value.uptimeSeconds, lastHeard: t });
    } catch (e) {}
  }
}
const mqHash = (b) => { let h = 2166136261 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h + ":" + b.length; };
function mqDup(key) { /* el mismo paquete puede llegar por varios servidores a la vez: se procesa una sola vez */
  const m = S.mq.seen, now = Date.now();
  if (m.size > 800) for (const [k, t] of m) if (now - t > 300000) m.delete(k);
  if (m.has(key) && now - m.get(key) < 300000) return true;
  m.set(key, now); return false;
}
function mqIncoming(topic, payload, from) {
  const q = S.mq; q.stats.rx++; q.stats.last = Date.now();
  const m = topic.match(/\/2\/e\/([^/]+)\/(![0-9a-f]{8})$/i); if (!m) return;
  if (m[2].toLowerCase() === nodeId(S.me)) return; // eco de mis propios envíos
  // proxy: lo que llega del servidor se entrega al nodo para que lo meta en la malla
  if (proxyActive() && !mqDup("p" + mqHash(payload))) {
    const ci = S.channels.findIndex((c, i) => c && c.role !== 0 && c.settings && c.settings.downlinkEnabled && chRealName(i) === m[1]);
    if (ci >= 0) mqProxyDown(topic, payload);
  }
  if (q.cfg.downlink) { let env; try { env = fromBinary(Protobuf.Mqtt.ServiceEnvelopeSchema, payload); } catch (e) { return; } if (env.packet && mqDup("e" + env.packet.from + ":" + env.packet.id + ":" + env.channelId)) return; mqLocal(env, topic).catch(() => {}); }
  scheduleRefresh("net");
}

/* ── proxy MQTT del nodo (el nodo no tiene WiFi: usa la Internet de la PC) ── */
function tapTransport(t) {
  const [a, b] = t.fromDevice.tee();
  (async () => {
    const r = b.getReader();
    for (;;) {
      const { done, value } = await r.read(); if (done) break;
      if (value && value.type === "packet") { try { onFromRadio(fromBinary(NMesh.FromRadioSchema, value.data)); } catch (e) { console.warn("FromRadio", e); } }
    }
  })().catch(() => {});
  return { toDevice: t.toDevice, fromDevice: a, disconnect: () => t.disconnect(), connection: t.connection };
}
// Lectura propia con los esquemas del firmware 2.8: configuración, módulos y canales con todos sus campos
function onFromRadio(fr) {
  const pv = fr.payloadVariant;
  switch (pv.case) {
    case "config": if (pv.value.payloadVariant.case) { S.cfg[pv.value.payloadVariant.case] = pv.value.payloadVariant.value; scheduleRefresh("config"); } break;
    case "moduleConfig": if (pv.value.payloadVariant.case) { S.mod[pv.value.payloadVariant.case] = pv.value.payloadVariant.value; scheduleRefresh("config"); } break;
    case "channel": S.channels[pv.value.index] = pv.value; scheduleRefresh("config"); if (ready()) mqSubscribe(); clearTimeout(chT); chT = setTimeout(saveChCache, 800); break;
    case "mqttClientProxyMessage": mqProxyUp(pv.value); break;
    case "clientNotification": onClientNotification(pv.value); break;
    case "packet": onAdminPacket(pv.value); break;
    case "configCompleteId": if (S.device && S.status !== ST.DeviceConfigured) { S.status = ST.DeviceConfigured; onConfigured(S.device); scheduleRefresh("all"); } break;
    case "metadata": S.meta = pv.value; try { S.metaObj = msgToObj(NMesh.DeviceMetadataSchema, pv.value); } catch (e) {} scheduleRefresh("side"); scheduleRefresh("tele"); break;
    default: break;
  }
}
function onClientNotification(n) {
  const msg = n.message || "";
  if (!msg) return;
  S.logs.push({ t: Date.now(), from: S.me, to: 0, port: "AVISO DEL NODO", snr: undefined, rssi: undefined, note: msg });
  toast("Aviso del nodo: " + msg, "");
  scheduleRefresh("logs");
}
// Administración con los esquemas 2.8 (respeta campos que la librería base no conoce)
async function sendAdmin(variantCase, value, dest = "self") {
  const msg = create(NAdmin.AdminMessageSchema, { payloadVariant: { case: variantCase, value } });
  return S.device.sendPacket(toBinary(NAdmin.AdminMessageSchema, msg), NPort.PortNum.ADMIN_APP, dest);
}
function mqProxyUp(pm) {
  const q = S.mq; if (!q.cfg.enabled || !proxyActive()) return;
  const cl = mqClients();
  if (!cl.length) { q.stats.proxyDrop = (q.stats.proxyDrop || 0) + 1; scheduleRefresh("net"); return; }
  const data = pm.payloadVariant.case === "data" ? pm.payloadVariant.value : mqEnc.encode(pm.payloadVariant.value || "");
  let ok = 0; for (const { r } of cl) { try { r.client.publish(pm.topic, data, !!pm.retained); ok++; } catch (e) {} }
  if (ok) { q.stats.proxyTx++; q.stats.last = Date.now(); }
  scheduleRefresh("net");
}
function mqProxyDown(topic, payload) {
  if (!S.device) return;
  const tr = create(Mesh.ToRadioSchema, { payloadVariant: { case: "mqttClientProxyMessage", value: create(Mesh.MqttClientProxyMessageSchema, { topic, payloadVariant: { case: "data", value: payload } }) } });
  Promise.resolve(S.device.sendRaw(toBinary(Mesh.ToRadioSchema, tr))).catch(() => {});
  S.mq.stats.proxyRx++;
}
window.__mqtt = { mqApplyToNode, mqDup, mqClients, addMessage, mqSubscribe, mqFlush, mqLocal, mqClose, tapTransport, mqProxyUp, mqIncoming, mqEnsure, probeNet, expandKey, chHash, aesCtr, mqPublishMsg, mkProxyFromRadio: (topic, data) => toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: { case: "mqttClientProxyMessage", value: create(Mesh.MqttClientProxyMessageSchema, { topic, payloadVariant: { case: "data", value: data } }) } })), decodeToRadio: (b) => { const t = fromBinary(Mesh.ToRadioSchema, b); return { case: t.payloadVariant.case, topic: t.payloadVariant.value && t.payloadVariant.value.topic, len: t.payloadVariant.value && t.payloadVariant.value.payloadVariant && t.payloadVariant.value.payloadVariant.value.length }; } };

/* ── barra superior ── */
const GLOBE = "M12 3a9 9 0 100 18 9 9 0 000-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18";
const MQ_ICON = "M4 12a8 8 0 018-8 M4 12a8 8 0 008 8 M8 12a4 4 0 014-4 M8 12a4 4 0 004 4 M12 11.2a.8.8 0 110 1.6.8.8 0 010-1.6z M20 12h-3";
/* ── reloj: hora UTC y hora local (la de la computadora) ── */
const p2 = (n) => String(n).padStart(2, "0");
const utcOff = (d) => { const m = -d.getTimezoneOffset(), a = Math.abs(m); return "UTC" + (m < 0 ? "−" : "+") + p2(Math.floor(a / 60)) + (a % 60 ? ":" + p2(a % 60) : ""); };
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
function tickClock() {
  const c = $("#clock"); if (!c) return; const d = new Date();
  const u = c.querySelector(".cu"), l = c.querySelector(".cl"); if (!u || !l) return;
  u.textContent = p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds());
  l.textContent = p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  c.querySelector(".cz").textContent = utcOff(d);
  c.title = "Hora UTC: " + DIAS[d.getUTCDay()] + " " + p2(d.getUTCDate()) + "/" + p2(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear() + " " + u.textContent + "\nHora local (" + utcOff(d) + "): " + DIAS[d.getDay()] + " " + p2(d.getDate()) + "/" + p2(d.getMonth() + 1) + "/" + d.getFullYear() + " " + l.textContent + "\nSale del reloj de esta computadora.";
}
setInterval(() => { if (!document.hidden) tickClock(); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { tickClock(); scheduleRefresh("all"); } });
/* ── botón “Iniciar puente”: abre el programa de Python (puente-mqtt.py) y conecta todos los servidores posibles.
   Una página web no puede ejecutar programas: usa un enlace propio (puentepariz://) que se registra una sola vez
   con instalar-boton-puente.bat. Ese enlace solo arranca el puente, no acepta órdenes. ── */
S.bridge = S.bridge || { up: false, busy: false, last: 0 };
async function probeBridge(ms = 1500) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms); let up = false;
  try { await fetch("http://127.0.0.1:9001/", { mode: "no-cors", cache: "no-store", signal: ctl.signal }); up = true; } catch (e) {}
  clearTimeout(to); S.bridge.last = Date.now();
  if (up !== S.bridge.up) { S.bridge.up = up; renderTopbar(); if (up && S.view === "settings") scheduleRefresh("net"); }
  return up;
}
function launchBridgeApp() { const a = el("a", { href: "puentepariz://iniciar", style: "display:none" }); document.body.append(a); a.click(); setTimeout(() => a.remove(), 500); }
function connectAllServers() {
  const c = S.mq.cfg; c.enabled = true; let n = 0;
  c.servers.forEach((sv, i) => {
    const needsToken = /^flespitoken\s*$/i.test(String(sv.user || "").trim());
    const ok = !!(sv.host || sv.url) && !needsToken;
    if (ok) { sv.enabled = true; n++; const r = S.mq.srv[i]; if (r.st !== "on") { mqCloseOne(i); r.retry = 0; } }
  });
  saveNetCfg(); mqEnsure(); scheduleRefresh("all");
  return n;
}
async function startBridge() {
  if (S.bridge.busy) return; S.bridge.busy = true; renderTopbar();
  try {
    if (!S.bridge.up) {
      toast("Iniciando el puente…");
      launchBridgeApp();
      let ok = false; for (let i = 0; i < 24 && !ok; i++) { await new Promise((r) => setTimeout(r, 600)); ok = await probeBridge(900); }
      if (!ok) { openBridgeHelp(); return; }
    }
    const n = connectAllServers();
    toast("Puente activo · conectando a " + n + " servidor" + (n === 1 ? "" : "es"), "ok");
  } finally { S.bridge.busy = false; renderTopbar(); }
}
function openBridgeHelp() {
  const dlg = el("div", { class: "modal", onclick: (e) => e.target === dlg && dlg.remove() });
  const li = (...k) => el("li", {}, ...k);
  dlg.append(el("div", { class: "mbox" }, el("h3", {}, "No se pudo iniciar el puente"),
    el("p", { class: "muted small" }, "Una página web no puede abrir programas por sí sola. La primera vez hay que preparar el botón (una sola vez):"),
    el("ol", { class: "helpol" },
      li(el("b", {}, "Instalá Python"), " desde python.org y marcá “Add Python to PATH” (si no lo tenés)."),
      li("Dejá en una misma carpeta: ", el("code", {}, "puente-mqtt.py"), ", ", el("code", {}, "lanzar-puente.vbs"), " e ", el("code", {}, "instalar-boton-puente.bat"), "."),
      li("Hacé doble clic en ", el("b", {}, "instalar-boton-puente.bat"), ". No pide permisos de administrador."),
      li("Volvé acá y tocá ", el("b", {}, "Iniciar puente"), ". Si el navegador pregunta si abre “Puente OPEN SOURCE PARIZ”, tocá ", el("b", {}, "Abrir"), " (podés marcar “permitir siempre”).")),
    el("p", { class: "muted small" }, "Alternativa sin instalar nada: hacé doble clic en ", el("code", {}, "iniciar-puente.bat"), " y dejá esa ventana abierta; este botón se pone en verde solo."),
    el("div", { class: "rowbtn" }, el("button", { class: "btn ghost", onclick: () => dlg.remove() }, "Cerrar"), el("button", { class: "btn", onclick: () => { dlg.remove(); startBridge(); } }, "Reintentar"))));
  document.body.append(dlg);
}
if (!IS_APP) { setTimeout(() => probeBridge(), 1200); setInterval(() => { if (!S.bridge.busy) probeBridge(); }, 20000); }
let appStLast = "";
function appStatus() { /* texto de la notificación fija de Android */
  if (!IS_APP) return;
  const me = S.nodes && S.nodes.get(S.me);
  const t = S.demo ? "Modo demo" : connected() ? "Conectado a " + (me ? nodeName(me) : "el nodo") + (S.conn ? " por " + (S.conn.type === "bluetooth" ? "Bluetooth" : S.conn.type === "http" ? "WiFi" : "USB") : "") : "Sin nodo conectado";
  const m = S.mq && S.mq.st === "on" ? " · MQTT conectado" : "";
  if (t + m !== appStLast) { appStLast = t + m; try { window.AndroidBridge.setStatus(t + m); } catch (e) {} }
}
function toggleDrawer(force) { /* menú lateral deslizable en celulares */
  const on = typeof force === "boolean" ? force : !document.body.classList.contains("drawer");
  document.body.classList.toggle("drawer", on);
  let bg = $("#drawerbg");
  if (!bg) { bg = el("div", { id: "drawerbg", onclick: () => toggleDrawer(false) }); document.body.append(bg); }
}
function renderTopbar() {
  appStatus();
  const bar = $("#topbar"); if (!bar) return;
  const n = S.net, q = S.mq, me = S.nodes.get(S.me);
  const lora = ready() ? ["ok", S.demo ? "Modo demo" : "LoRa: " + (me ? nodeShort(me) : "nodo") + " · " + connShort(S.conn)] : connected() ? ["wait", "LoRa: configurando…"] : ["off", "LoRa: sin nodo"];
  const netLbl = n.online === true ? "Con Internet" : n.online === false ? "Sin Internet" : "Comprobando…";
  const netTip = n.online === true ? "Internet disponible" + (n.ms != null ? " · respuesta " + n.ms + " ms" : "") + " · verificado " + hhmm(n.last) : n.online === false ? "Sin Internet. El portal sigue funcionando por LoRa. Último chequeo " + hhmm(n.last) : "Verificando la conexión…";
  const nAct = q.srv.filter((x, i) => q.cfg.enabled && q.cfg.servers[i].enabled).length, nOn = q.srv.filter((x) => x.st === "on").length;
  const mqLbl = { on: nOn + "/" + nAct + " conectados", connecting: "conectando…", error: "sin conexión", wait: "esperando Internet", off: "apagado" }[q.st];
  const mqDot = { on: "ok", connecting: "wait", error: "bad", wait: "wait", off: "off" }[q.st];
  bar.replaceChildren(...[
    el("button", { class: "chip menubtn", title: "Menú", "aria-label": "Abrir el menú", onclick: toggleDrawer }, "☰"),
    el("div", { class: "tbtitle" }, el("b", {}, "OPEN SOURCE PARIZ"), el("small", {}, "Sistema LoRa Mesh · LoRa + MQTT")),
    el("div", { class: "grow" }),
    el("div", { class: "clock", id: "clock" }, el("span", { class: "ck1" }, el("small", {}, "UTC"), el("b", { class: "cu" }, "--:--:--")), el("span", { class: "ck1" }, el("small", {}, "Local"), el("b", { class: "cl" }, "--:--:--"), el("em", { class: "cz" }, ""))),
    el("button", { class: "chip panicchip", title: "Botón de pánico: enviar una alerta a todos los canales", onclick: openPanic }, "🚨 EMERGENCIAS"),
    el("button", { class: "chip", title: "Estado del nodo conectado", onclick: () => setView(connected() ? "nodes" : "messages") }, icon("M12 3v10 M8 7l4-4 4 4 M6 13h12v3a3 3 0 01-3 3H9a3 3 0 01-3-3z"), el("i", { class: "dot " + lora[0] }), lora[1]),
    el("button", { class: "chip net " + (n.online === true ? "on" : n.online === false ? "off" : "unk"), title: netTip + " (clic para configurar)", onclick: () => setView("settings", "portal.net") },
      (() => { const s = icon(GLOBE); if (n.online === false) { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", "M4 4l16 16"); p.setAttribute("class", "slash"); s.append(p); } return s; })(), el("i", { class: "dot " + (n.online === true ? "ok" : n.online === false ? "bad" : "wait") }), el("b", {}, netLbl)),
    IS_APP ? null : el("button", { class: "chip bridgechip " + (S.bridge.up ? "on" : ""), title: S.bridge.up ? "El puente de Python está activo. Clic: conectar a todos los servidores posibles." : "Abre el programa de Python (puente) y conecta a la mayor cantidad de servidores", onclick: startBridge, disabled: S.bridge.busy }, icon("M13 2L4 14h7l-1 8 9-12h-7z"), el("i", { class: "dot " + (S.bridge.busy ? "wait" : S.bridge.up ? "ok" : "off") }), S.bridge.busy ? "Iniciando…" : S.bridge.up ? "Puente: activo" : "Iniciar puente"),
    el("button", { class: "chip", title: q.err || "Broker MQTT (clic para configurar)", onclick: () => setView("settings", "portal.net") }, icon(MQ_ICON), el("i", { class: "dot " + mqDot }), "MQTT: " + mqLbl + (q.queue.length ? " · " + q.queue.length + " en cola" : ""))].filter(Boolean));
  tickClock();
}
function updRoute() {
  const b = $("#route"); if (!b) return;
  const q = S.mq, ch = S.conv.startsWith("ch") ? S.channels[+S.conv.slice(2)] : null;
  const lora = ready() ? ["ok", "LoRa listo"] : connected() ? ["wait", "LoRa: configurando"] : ["off", "LoRa: sin nodo"];
  let mq;
  if (!mqAnyEnabled() || !q.cfg.uplink) mq = ["off", "MQTT apagado"];
  else if (S.conv.startsWith("dm")) mq = ["off", "MQTT: solo canales"];
  else if (proxyActive() && ch && ch.settings && ch.settings.uplinkEnabled) mq = ["ok", "MQTT por el nodo (proxy)"];
  else if (q.st === "on") mq = ["ok", "MQTT también"];
  else mq = ["wait", S.net.online === false ? "MQTT: en cola hasta que vuelva Internet" : "MQTT: en cola hasta conectar al broker"];
  b.replaceChildren(el("span", { class: "muted" }, "Se enviará por:"), el("span", { class: "rchip" }, el("i", { class: "dot " + lora[0] }), lora[1]), el("span", { class: "rchip" }, el("i", { class: "dot " + mq[0] }), mq[1]));
}

/* ── pantalla Internet y MQTT ── */
const SRV_ST = { on: ["ok", "Conectado"], connecting: ["wait", "Conectando…"], error: ["bad", "Sin conexión"], wait: ["wait", "Esperando Internet"], off: ["off", "Apagado"] };
function mqUseNode() { /* copia al servidor Nº 1 lo que el nodo tiene en su módulo MQTT */
  const m = S.mod.mqtt, c = S.mq.cfg; if (!m || !m.address) return toast("El nodo todavía no informó su módulo MQTT", "err");
  const a = String(m.address), pm = a.match(/:(\d+)$/);
  Object.assign(c.servers[0], { host: mqHost(a), port: pm ? +pm[1] : m.tlsEnabled ? 8883 : 1883, tls: !!m.tlsEnabled, user: m.username || "", pass: m.password || "", root: m.root && m.root !== "msh" ? m.root : "", url: "" });
  saveNetCfg(); mqCloseOne(0); mqEnsureOne(0); scheduleRefresh("all"); toast("Servidor Nº 1: datos tomados del nodo", "ok");
}
async function mqApplyToNode(s) { /* el nodo (con WiFi o Ethernet) se conecta solo al servidor por TCP */
  if (S.demo) return toast("Modo demo: no se envió nada al nodo");
  if (!S.device || !ready()) return toast("Conectá el nodo primero", "err");
  if (!s.host) return toast("Falta la dirección del servidor", "err");
  if (!confirm(`El nodo va a conectarse a ${s.host} (puerto ${s.port || (s.tls ? 8883 : 1883)}${s.tls ? ", TLS" : ""}) con su WiFi o Ethernet. Se guarda en su módulo MQTT y se reinicia. ¿Continuar?`)) return;
  const base = S.mod.mqtt ? clone(M.ModuleConfig_MQTTConfigSchema, S.mod.mqtt) : create(M.ModuleConfig_MQTTConfigSchema);
  const port = +s.port, defPort = s.tls ? 8883 : 1883;
  Object.assign(base, { enabled: true, address: s.host + (port && port !== 8883 && port !== 1883 && port !== defPort ? ":" + port : ""), username: s.user || "", password: s.pass || "", tlsEnabled: !!s.tls, jsonEnabled: false, root: s.root || base.root || "msh" });
  try { await applySettings(async () => sendAdmin("setModuleConfig", create(M.ModuleConfigSchema, { payloadVariant: { case: "mqtt", value: base } })), true); } catch (e) {}
}
function viewNet(body) {
  const q = S.mq, c = q.cfg, g = {}, F = SRV_IDX.map(() => ({}));
  const inp = (o, k, opt = {}) => el("input", { class: "inp", value: o[k] ?? "", autocomplete: "off", ...opt });
  const swi = (on) => el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!on }), el("span", {}));
  const chk = (n) => n.querySelector("input").checked;
  const readSrv = (i) => { const f = F[i]; return { name: f.name.value.trim(), host: f.host.value.trim(), port: parseInt(f.port.value, 10) || 0, tls: chk(f.tls), url: mqNormUrl(f.url.value), user: f.user.value.trim(), pass: f.pass.value, root: f.root.value.trim(), enabled: chk(f.on) }; };
  const readAll = () => { c.servers = SRV_IDX.map(readSrv); c.enabled = chk(g.enabled); c.uplink = chk(g.uplink); c.upAll = chk(g.upAll); c.downlink = chk(g.downlink); c.proxy = chk(g.proxy); };
  const saveAll = () => { readAll(); saveNetCfg(); mqClose(); mqEnsure(); probeNet(); scheduleRefresh("all"); toast("Guardado", "ok"); };
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, "Internet y MQTT del portal"), el("small", { class: "muted" }, "LoRa funciona siempre. Con Internet, el portal usa los servidores MQTT que tengas encendidos. Podés dejar encendido uno solo, algunos o todos: los apagados o sin conexión no afectan a los demás. El Nº 1 es el oficial de la red."))));
  body.append(el("div", { class: "card", id: "netstatus" }));
  const nm = S.mod.mqtt;
  if (nm && nm.address) {
    body.append(el("div", { class: "card" }, el("b", {}, "Módulo MQTT del nodo (lo que tiene cargado)"),
      el("small", { class: "muted" }, "Son los datos que el nodo trae de fábrica o que cargaste en Configuración del módulo → MQTT."),
      ...[["Habilitado", nm.enabled ? "Sí" : "No"], ["Servidor", /meshtastic/i.test(nm.address) ? "el predeterminado de la red LoRa Mesh" : nm.address], ["Usuario", nm.username || "—"], ["Tema raíz", nm.root || "—"], ["Cifrado", nm.encryptionEnabled ? "Sí" : "No"], ["JSON", nm.jsonEnabled ? "Sí" : "No"], ["TLS", nm.tlsEnabled ? "Sí" : "No"], ["Proxy al cliente", nm.proxyToClientEnabled ? "Sí" : "No"]].map(([k, v]) => row(k, "", el("span", {}, v))),
      el("div", { class: "rowbtn" }, el("button", { class: "btn ghost", onclick: mqUseNode }, "Copiar estos datos al servidor Nº 1"))));
  }
  body.append(el("div", { class: "card" }, el("b", {}, "General"),
    row("Usar MQTT", "Interruptor general. Cada servidor tiene además su propio encendido más abajo.", (g.enabled = swi(c.enabled))),
    row("Enviar mis mensajes también por MQTT", "Sale por el primer servidor conectado; si ese falla, pasa al siguiente. No se publica por el resto. Si no hay ninguno, queda en cola (hasta 1 h) y sale al volver. Solo canales, no directos.", (g.uplink = swi(c.uplink))),
    row("Enviar por todos los servidores a la vez", "Opción avanzada: publica la misma copia en cada servidor conectado (redundante). Normalmente no hace falta y conviene dejarlo apagado.", (g.upAll = swi(c.upAll))),
    row("Recibir mensajes y nodos por MQTT", "Muestra en el chat y el mapa lo que llegue de tus canales (si llega por varios servidores, se muestra una sola vez)", (g.downlink = swi(c.downlink))),
    row("Hacer de proxy MQTT del nodo", "Si el nodo tiene activado “Proxy al cliente” (Módulos → MQTT), el portal sube y baja su tráfico MQTT con la Internet de esta PC", (g.proxy = swi(c.proxy))),
    el("div", { class: "rowbtn chips" }, el("button", { class: "btn", onclick: saveAll }, "Guardar y conectar los servidores"))));
  c.servers.forEach((s, i) => {
    const f = F[i] = { name: inp(s, "name"), host: inp(s, "host", { placeholder: "servidor.ejemplo.com" }), port: inp(s, "port", { type: "number", min: 1, max: 65535 }), tls: swi(s.tls), url: inp(s, "url", { placeholder: i === 0 ? "Vacío = el portal la busca solo" : "wss://servidor:puerto/mqtt" }), user: inp(s, "user"), pass: inp(s, "pass", { type: "password" }), root: inp(s, "root", { placeholder: mqRoot() }), on: swi(s.enabled) };
    const fill = (d) => { f.name.value = d.name; f.host.value = d.host; f.port.value = d.port; f.url.value = d.url; f.user.value = d.user || ""; f.pass.value = d.pass || ""; f.root.value = d.root || ""; f.tls.querySelector("input").checked = !!d.tls; };
    const hint = i === 0
      ? "Dirección, puerto y TLS son los datos TCP del servidor (8883 con TLS, 1883 sin cifrar), los mismos que usa el nodo. El navegador solo habla WebSocket: el portal busca solo una dirección web de este servidor o el puente local (ws://localhost:9001). Si no hay ninguna, tocá “Aplicar al nodo”: el nodo se conecta solo, por su WiFi o Ethernet."
      : /flespi/i.test(s.host) ? "Flespi pide un token propio: en Usuario va “FlespiToken ” seguido de tu token (la contraseña queda vacía). Sin token no conecta." : "Este servidor tiene que ofrecer WebSocket (wss://…). Usuario y contraseña son opcionales.";
    body.append(el("div", { class: "card srv" },
      el("div", { class: "srvh" }, el("span", { class: "srvn" }, "Nº " + (i + 1)), el("b", {}, i === 0 ? "Servidor oficial de la red" : (s.name || "Servidor " + (i + 1))), el("span", { class: "srvs", id: "sst" + i })),
      el("small", { class: "muted" }, hint),
      row("Usar este servidor", "", f.on), row("Nombre", "", f.name), row("Dirección del servidor", "Nombre o IP", f.host), row("Puerto TCP", i === 0 ? "8883 con TLS · 1883 sin cifrar" : "Solo informativo", f.port), row("TLS (seguro)", "", f.tls),
      row("Dirección web (WebSocket)", "ws://… o wss://…", f.url), row("Usuario", "", f.user), row("Contraseña", "Se guarda solo en este navegador", f.pass),
      row("Tema raíz", "Vacío = el del nodo o msh/" + (S.cfg.lora ? enumName(C.Config_LoRaConfig_RegionCode, S.cfg.lora.region) : "REGIÓN") + " (actual: " + mqRoot() + ")", f.root),
      el("div", { class: "rowbtn chips" },
        el("button", { class: "btn ghost", onclick: async (e) => { const v = readSrv(i); e.target.disabled = true; toast("Probando…"); try { const t = await mqOpen(v, i); t.close(); toast("Conexión correcta: " + (t.url || ""), "ok"); } catch (er) { toast("No se pudo conectar: " + er.message, "err"); } e.target.disabled = false; } }, "Probar conexión"),
        i === 0 ? el("button", { class: "btn ghost", onclick: () => mqApplyToNode(readSrv(0)) }, "Aplicar al nodo") : null,
        i === 0 ? el("button", { class: "btn ghost", onclick: () => fill(SRV_DEF[0]) }, "Restaurar datos oficiales") : null,
        ...(i === 0 ? [] : MQ_PRESETS.map((p) => el("button", { class: "btn ghost", onclick: () => fill({ name: p.name, host: p.host, port: 8883, tls: true, url: p.url, user: p.user || "" }) }, p.name))))));
  });
  body.append(el("div", { class: "card" }, el("b", {}, "Detección de Internet"),
    el("small", { class: "muted" }, "El portal consulta una dirección cada 30 s (8 s si no hay Internet) solo para saber si hay salida a Internet. No envía datos tuyos. Podés cambiarla por un servidor propio, o desactivarla y usar solo el estado de red del navegador."),
    row("Verificar con una consulta", "", (g.probeOn = swi(c.probeOn))),
    row("Dirección de verificación", "", (g.probe = inp(c, "probe", { placeholder: NET_DEF.probe }))),
    el("div", { class: "rowbtn" }, el("button", { class: "btn ghost", onclick: () => { Object.assign(c, { probe: g.probe.value.trim(), probeOn: chk(g.probeOn) }); saveNetCfg(); probeNet(); toast("Verificando…"); } }, "Guardar y verificar ahora"))));
  body.append(el("div", { class: "card" }, el("b", {}, "Qué funciona sin Internet"),
    el("ul", { class: "tips" }, ["Conexión con el módulo por USB, Bluetooth o red y toda su configuración (LoRa, canales, dispositivo, módulos).", "Enviar y recibir mensajes por la red LoRa, canales y directos.", "Nodos, telemetría, mapa con tus capas y teselas locales, consola e informes en PDF.", "Con Internet: envío extra por MQTT, recepción desde los servidores y proxy MQTT del nodo."].map((t) => el("li", {}, t)))));
  updNetView();
}
function updNetView() {
  const box = $("#netstatus"); if (!box) return;
  const n = S.net, q = S.mq, st = q.stats;
  q.srv.forEach((r, i) => { const e = $("#sst" + i); if (!e) return; const s = q.cfg.servers[i], k = q.cfg.enabled && s.enabled ? r.st : "off", d = SRV_ST[k] || SRV_ST.off; e.replaceChildren(el("i", { class: "dot " + d[0] }), d[1] + (k === "on" && r.via ? " · " + r.via : "") + (k === "error" && r.err ? " · " + r.err : "")); });
  const nOn = q.srv.filter((x) => x.st === "on").length, nAct = q.srv.filter((x, i) => q.cfg.enabled && q.cfg.servers[i].enabled).length;
  const mqTxt = { on: nOn + " de " + nAct + (nAct === 1 ? " servidor conectado" : " servidores conectados") + (nOn ? " · se envía por el primero disponible" : ""), connecting: "Conectando…", error: "Ningún servidor conectado" + (q.err ? ": " + q.err : ""), wait: "Esperando que vuelva Internet", off: "Apagado" }[q.st];
  box.replaceChildren(...[el("b", {}, "Estado ahora"),
    el("table", { class: "kv" }, el("tbody", {},
      [["Internet", n.online === true ? "Con Internet" + (n.ms != null ? " · " + n.ms + " ms" : "") : n.online === false ? "Sin Internet" : "Comprobando…"], ["Último chequeo", n.last ? hhmm(n.last) : "—"], ["Nodo LoRa (" + (S.conn ? connShort(S.conn) : "USB") + ")", ready() ? "Conectado y configurado" : connected() ? "Configurando…" : "Sin conectar"], ["MQTT", mqTxt], ["Tema raíz", mqRoot()], ["Temas suscriptos", q.subs.size ? [...q.subs].join("  ") : "—"],
        ["Mensajes MQTT enviados / recibidos", st.tx + " / " + st.rx], ["Proxy del nodo: subidos / bajados", proxyActive() ? st.proxyTx + " / " + st.proxyRx + (st.proxyDrop ? " · " + st.proxyDrop + " perdidos sin conexión" : "") : "Inactivo"], ["Mensajes en cola para MQTT", q.queue.length]]
        .map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, String(v)))))),
    q.queue.length ? el("div", { class: "chips" }, el("button", { class: "mini", onclick: () => mqFlush() }, "Enviar la cola ahora"), el("button", { class: "mini danger", onclick: () => { q.queue.forEach((m) => { m.up = "fail"; m.upWhy = "descartado"; }); q.queue = []; scheduleRefresh("msgs"); scheduleRefresh("net"); } }, "Descartar la cola")) : null].filter(Boolean));
}


/* ═══════════════════════ versión 1.2: avisos, GPS, detalle de nodo, respuestas y reacciones, QR de canales, mapa sin conexión ═══════════════════════ */

/* ── avisos del sistema (celular: notificación de Android · PC: notificación del navegador) ── */
const NOTIF_KEY = "meshportal:sysnotif";
const notifCfg = () => { try { return { on: true, ch: true, ...JSON.parse(localStorage.getItem(NOTIF_KEY) || "{}") }; } catch (e) { return { on: true, ch: true }; } };
const notifSave = (o) => { try { localStorage.setItem(NOTIF_KEY, JSON.stringify({ ...notifCfg(), ...o })); } catch (e) {} };
const appHidden = () => (IS_APP ? !!window.__appHidden : document.hidden);
function sysNotify(kind, conv, title, text) {
  const c = notifCfg();
  if (!c.on && kind !== "alerta") return;
  if (kind === "ch" && !c.ch) return;
  if (!appHidden()) return; /* con el portal a la vista alcanza con el sonido y el contador */
  if (kind !== "alerta" && inQuiet(sndCfg().quiet)) return;
  text = String(text || "").slice(0, 300);
  if (IS_APP && window.AndroidBridge.notify) { try { window.AndroidBridge.notify(kind, conv, title, text); } catch (e) {} return; }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: text, tag: conv, renotify: true, requireInteraction: kind === "alerta" });
    n.onclick = () => { try { window.focus(); } catch (e) {} openConv(conv); n.close(); };
  } catch (e) {}
}
function clearNotif(conv) { if (IS_APP && window.AndroidBridge.clearNotif) { try { window.AndroidBridge.clearNotif(conv); } catch (e) {} } }
function openConv(k) { if (!k) return; S.conv = k; S.unread[k] = 0; setView("messages"); }
function notifyMsg(msg, alert) {
  const n = S.nodes.get(msg.from), who = n ? nodeName(n) : nameOf(msg.from), conv = convOf(msg);
  if (alert) return sysNotify("alerta", conv, "🚨 ALERTA de " + who, msg.text);
  if (!msg.dm && sndCfg().mutedCh.includes(msg.ch)) return;
  const kind = n && isFav(n) ? "fav" : msg.dm ? "dm" : "ch";
  sysNotify(kind, conv, msg.dm ? who + (kind === "fav" ? " ★" : "") : "# " + chName(msg.ch) + " · " + who, msg.text);
}
window.addEventListener("ab:open-conv", (e) => openConv(e.detail && e.detail[0]));
window.addEventListener("ab:app-visible", (e) => { if (e.detail && e.detail[0] === "1" && S.view === "messages") clearNotif(S.conv); });
if (IS_APP) setTimeout(() => { try { const c = window.AndroidBridge.takeConv && window.AndroidBridge.takeConv(); if (c) openConv(c); } catch (e) {} }, 400);

/* ── GPS del celular o de la PC: le pasa la posición al nodo (para nodos sin GPS propio) ── */
const GPS_KEY = "meshportal:gps", GPS_DEF = { on: false, every: 60, move: 25, beat: 15 };
const gpsCfg = () => { try { return { ...GPS_DEF, ...JSON.parse(localStorage.getItem(GPS_KEY) || "{}") }; } catch (e) { return { ...GPS_DEF }; } };
const gpsSave = (o) => { try { localStorage.setItem(GPS_KEY, JSON.stringify({ ...gpsCfg(), ...o })); } catch (e) {} };
S.gps = { active: false, last: null, sentAt: 0, sentPos: null, sent: 0, err: "", watch: null };
const gpsAvailable = () => IS_APP ? !!window.AndroidBridge.gpsStart : !!(navigator.geolocation);
function gpsStart() {
  const c = gpsCfg(); if (S.gps.active) gpsStop(true);
  S.gps.err = ""; S.gps.active = true;
  if (IS_APP && window.AndroidBridge.gpsStart) { try { window.AndroidBridge.gpsStart(Math.min(10, c.every), 0); } catch (e) { S.gps.err = String(e.message || e); } }
  else if (navigator.geolocation) {
    S.gps.watch = navigator.geolocation.watchPosition(
      (p) => gpsFix({ lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude, acc: p.coords.accuracy, spd: p.coords.speed, brg: p.coords.heading, t: p.timestamp || Date.now(), src: "navegador" }),
      (er) => { S.gps.err = er.code === 1 ? "El navegador no dio permiso de ubicación" : er.code === 2 ? "No se pudo obtener la ubicación" : "La ubicación tardó demasiado"; gpsUpd(); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 120000 });
  } else { S.gps.err = "Este equipo no ofrece ubicación"; S.gps.active = false; }
  gpsUpd();
}
function gpsStop(keep) {
  if (IS_APP && window.AndroidBridge.gpsStop) { try { window.AndroidBridge.gpsStop(); } catch (e) {} }
  if (S.gps.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(S.gps.watch);
  S.gps.watch = null; S.gps.active = false; if (!keep) gpsUpd();
}
async function gpsFix(f) {
  if (!isFinite(f.lat) || !isFinite(f.lon)) return;
  S.gps.last = f; S.gps.err = "";
  const c = gpsCfg(), now = Date.now(), sp = S.gps.sentPos;
  const moved = sp ? hav(sp.lat, sp.lon, f.lat, f.lon) * 1000 : Infinity;
  const due = !S.gps.busy && (!S.gps.sentAt || (now - S.gps.sentAt >= c.every * 1000 && moved >= c.move) || now - S.gps.sentAt >= c.beat * 60000);
  gpsUpd();
  if (due) await gpsSend(f, false);
}
async function gpsSend(f, manual) {
  f = f || S.gps.last;
  if (!f) { if (manual) toast("Todavía no hay ubicación del " + (IS_APP ? "celular" : "equipo"), "err"); return false; }
  if (!S.device || !ready() || S.demo) { if (manual) toast("Conectá el nodo primero", "err"); return false; }
  S.gps.busy = true; setTimeout(() => (S.gps.busy = false), 30000); /* el nodo puede tardar en confirmar */
  try {
    const t = Math.floor((f.t || Date.now()) / 1000);
    const pos = create(Mesh.PositionSchema, { latitudeI: Math.round(f.lat * 1e7), longitudeI: Math.round(f.lon * 1e7), altitude: f.alt != null && isFinite(f.alt) ? Math.round(f.alt) : undefined, time: t, timestamp: t, locationSource: 3 /* externa: GPS del celular o de la PC */, groundSpeed: f.spd != null && isFinite(f.spd) ? Math.round(f.spd) : undefined, groundTrack: f.brg != null && isFinite(f.brg) ? Math.round(f.brg * 1e5) : undefined });
    await S.device.setPosition(pos);
    S.gps.busy = false; S.gps.sentAt = Date.now(); S.gps.sentPos = { lat: f.lat, lon: f.lon }; S.gps.sent++;
    upsertNode(S.me, { pos: { lat: f.lat, lon: f.lon, alt: f.alt != null ? f.alt : undefined, time: t } }); addTrackPoint(S.me, f.lat, f.lon, f.alt, Date.now());
    if (manual) toast("Posición enviada al nodo", "ok");
    gpsUpd(); return true;
  } catch (e) { S.gps.busy = false; S.gps.err = "El nodo no aceptó la posición: " + (e && e.error !== undefined ? ruteoTexto(e.error) : (e && e.message) || e); if (manual) toast(S.gps.err, "err"); gpsUpd(); return false; }
}
window.addEventListener("ab:gps", (e) => { try { gpsFix(JSON.parse(e.detail[0])); } catch (er) {} });
window.addEventListener("ab:gps-err", (e) => { S.gps.err = e.detail[0]; toast("GPS: " + e.detail[0], "err"); gpsUpd(); });
function gpsUpd() { if (S.view === "settings" && S.sub === "portal.gps") drawGpsStatus(); }
setTimeout(() => { if (gpsCfg().on && gpsAvailable()) gpsStart(); }, 1500);
function drawGpsStatus() {
  const box = $("#gpsst"); if (!box) return;
  const g = S.gps, f = g.last, mp = mePos();
  const rows = [
    ["Estado", g.active ? (g.err ? "Con problemas" : f ? "Recibiendo ubicación" : "Buscando señal…") : "Apagado"],
    ["Fuente", IS_APP ? "GPS del celular" : "Ubicación del navegador / PC"],
    ["Última ubicación", f ? f.lat.toFixed(6) + ", " + f.lon.toFixed(6) + (f.acc ? " (±" + Math.round(f.acc) + " m)" : "") : "—"],
    ["Altura", f && f.alt != null && isFinite(f.alt) ? Math.round(f.alt) + " m" : "—"],
    ["Hora de la ubicación", f ? hhmm(f.t) : "—"],
    ["Último envío al nodo", g.sentAt ? hhmm(g.sentAt) + " · " + g.sent + (g.sent === 1 ? " envío" : " envíos") + " en esta sesión" : "Todavía no se envió"],
    ["Posición que tiene el nodo", mp ? mp.lat.toFixed(6) + ", " + mp.lon.toFixed(6) : "Sin posición"],
  ];
  box.replaceChildren(...[el("b", {}, "Estado ahora"), el("table", { class: "kv" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, v))))),
    g.err ? el("div", { class: "warnbox" }, "⚠ " + g.err) : null].filter(Boolean));
}
function viewGps(body) {
  const c = gpsCfg(), sw = (on, f) => el("label", { class: "sw" }, el("input", { type: "checkbox", checked: !!on, onchange: (e) => f(e.target.checked) }), el("span", {}));
  const num = (key, min, max, unit) => [el("input", { class: "inp", type: "number", min, max, value: c[key], style: "width:100px", onchange: (e) => { const v = clamp(+e.target.value || min, min, max); e.target.value = v; gpsSave({ [key]: v }); if (S.gps.active) gpsStart(); } }), el("span", { class: "unit" }, unit)];
  const fixedOn = S.cfg.position && S.cfg.position.fixedPosition;
  const gpsMode = S.cfg.position && S.cfg.position.gpsMode;
  body.append(el("header", { class: "ph" }, el("div", {}, el("h2", {}, IS_APP ? "GPS del celular" : "Ubicación de esta PC"), el("small", { class: "muted" }, "Para nodos sin GPS propio: el portal toma la ubicación del " + (IS_APP ? "celular" : "equipo") + " y se la pasa al nodo, que la comparte con la red como si fuera suya."))),
    el("div", { class: "form" },
      el("div", { class: "card", id: "gpsst" }),
      secH("Uso"),
      actRow("Compartir mi ubicación con el nodo", gpsAvailable() ? "Se pide permiso de ubicación la primera vez." + (IS_APP ? " Sigue funcionando con la pantalla apagada mientras la app esté abierta." : " El navegador tiene que quedar abierto.") : "Este equipo no ofrece ubicación.", sw(c.on, (v) => { gpsSave({ on: v }); if (v) gpsStart(); else gpsStop(); })),
      actRow("Enviar como máximo cada", "Tiempo mínimo entre dos envíos al nodo (cuida el aire de la red).", num("every", 10, 3600, "segundos")),
      actRow("Solo si me moví al menos", "Si estás quieto no se vuelve a enviar…", num("move", 0, 5000, "metros")),
      actRow("…salvo un aviso cada", "Aunque no te muevas, se reenvía la posición con esta frecuencia.", num("beat", 1, 240, "minutos")),
      actRow("Enviar ahora", "Manda la última ubicación al nodo en este momento.", el("button", { class: "btn ghost", onclick: () => gpsSend(null, true) }, "Enviar posición")),
      secH("Tené en cuenta"),
      el("ul", { class: "tips" }, [
        "Si el nodo tiene GPS propio encendido" + (gpsMode === 1 ? " (el tuyo lo tiene ENCENDIDO)" : "") + ", el nodo puede preferir el suyo. Para usar el del " + (IS_APP ? "celular" : "equipo") + ", en Configuración del dispositivo → Posición poné el GPS en “Desactivado” o “No presente”.",
        fixedOn ? "Tu nodo tiene una POSICIÓN FIJA activada: mientras esté así va a seguir informando esa posición. Desactivala en Posición si querés usar la del " + (IS_APP ? "celular." : "equipo.") : "Con posición fija activada en el nodo, este envío no tiene efecto.",
        "La precisión con la que se comparte en cada canal la define el nodo (Canales → precisión de posición).",
        "Se informa como fuente “externa”. Para no gastar aire, no bajes el intervalo de más: 60 s y 25 m alcanzan para seguimiento a pie o en vehículo.",
      ].map((t) => el("li", {}, t)))));
  drawGpsStatus();
}

/* ── detalle de nodo ── */
let nsNum = null, nsBox = null;
function sparkSvg(pts, opt = {}) { /* pts: [{t, v}] */
  pts = pts.filter((p) => p.v != null && isFinite(p.v));
  const W = 300, H = 56, P = 4;
  if (pts.length < 2) return el("div", { class: "nsnone" }, "Sin historial suficiente");
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (opt.min != null) lo = Math.min(lo, opt.min); if (opt.max != null) hi = Math.max(hi, opt.max);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const X = (t) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P), Y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", `0 0 ${W} ${H}`); s.setAttribute("class", "nsspark"); s.setAttribute("preserveAspectRatio", "none");
  s.setAttribute("aria-hidden", "true"); /* el resumen de abajo dice lo mismo en palabras */
  // los huecos largos sin muestras se cortan: una línea recta ahí haría creer que hubo datos
  const dts = []; for (let i = 1; i < pts.length; i++) dts.push(pts[i].t - pts[i - 1].t);
  const med = dts.slice().sort((a, b) => a - b)[dts.length >> 1] || 0;
  const corte = Math.max(med * 3, 10 * 60000);
  let d = "", puente = "";
  pts.forEach((p, i) => {
    const salto = i > 0 && p.t - pts[i - 1].t > corte;
    if (salto) puente += "M" + X(pts[i - 1].t).toFixed(1) + "," + Y(pts[i - 1].v).toFixed(1) + "L" + X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1) + " ";
    d += (i === 0 || salto ? "M" : "L") + X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1) + " ";
  });
  if (puente) { const pb = document.createElementNS(ns, "path"); pb.setAttribute("d", puente.trim()); pb.setAttribute("class", "hueco"); s.append(pb); }
  const pa = document.createElementNS(ns, "path"); pa.setAttribute("d", d.trim()); s.append(pa);
  const fmt = opt.fmt || ((v) => (Math.round(v * 10) / 10).toString());
  const last = pts[pts.length - 1], vals = pts.map((p) => p.v);
  // el punto de la última medición va como elemento propio: así no lo deforma el estirado del SVG
  const punto = el("i", { class: "nsdot", "aria-hidden": "true" });
  punto.style.left = (X(last.t) / W) * 100 + "%";
  punto.style.top = (Y(last.v) / H) * 100 + "%";
  const resumen = el("div", { class: "nsrange" }, el("small", {}, "mín " + fmt(Math.min(...vals)) + (opt.u || "")), el("small", {}, hhmm(t0) + " → " + hhmm(t1)), el("small", {}, "máx " + fmt(Math.max(...vals)) + (opt.u || "")));
  const caja = el("div", { class: "nssw" }, el("div", { class: "nsplot" }, s, punto), resumen);
  caja.setAttribute("role", "img");
  caja.setAttribute("aria-label", pts.length + " muestras entre " + hhmm(t0) + " y " + hhmm(t1) + ": mínimo " + fmt(Math.min(...vals)) + (opt.u || "") + ", máximo " + fmt(Math.max(...vals)) + (opt.u || "") + ", última " + fmt(last.v) + (opt.u || ""));
  return caja;
}
function openNodeSheet(num) {
  nsNum = num;
  if (nsBox) nsBox.remove();
  nsBox = el("div", { class: "modal nsmodal", onclick: (e) => { if (e.target === nsBox) closeNodeSheet(); } }, el("div", { class: "mbox nsheet", id: "nsheet" }));
  document.body.append(nsBox); nsDraw();
}
function closeNodeSheet() { if (nsBox) nsBox.remove(); nsBox = null; nsNum = null; }
let nsT = 0;
function nsRedraw() { if (nsNum == null || nsT) return; nsT = setTimeout(() => { nsT = 0; if (nsNum != null) nsDraw(); }, 800); }
function nsDraw() {
  const box = $("#nsheet"); if (!box) return;
  const num = nsNum, n = S.nodes.get(num) || { num }, me = num === S.me, mp = mePos();
  const st = nodeStatus(n), t = S.tele.get(num) || {}, dm = (t.device && t.device.last) || {}, em = (t.env && t.env.last) || {};
  const relayName = (b) => { const c = [...S.nodes.values()].filter((x) => (x.num & 0xff) === b && x.num !== num); return c.length === 1 ? nodeName(c[0]) : c.length > 1 ? c.length + " nodos posibles (…" + b.toString(16).padStart(2, "0") + ")" : "nodo …" + b.toString(16).padStart(2, "0"); };
  const conn = me ? "Este nodo" : n.hops == null ? (n.viaMqtt ? "Vía MQTT (sin dato de saltos)" : "Sin dato") : (n.hops === 0 ? "Directo por radio" : n.hops + (n.hops === 1 ? " salto" : " saltos")) + (n.viaMqtt ? " · vía MQTT" : "");
  const kv = [
    ["Identificador", nodeId(num) + (n.user && n.user.shortName ? " · " + n.user.shortName : "")],
    ["Modelo", n.user ? enumName(Mesh.HardwareModel, n.user.hwModel) : "—"],
    ["Función", roleLabel(n)],
    ["Visto", n.lastHeard ? ago(n.lastHeard) + " (" + hhmm(n.lastHeard * 1000) + ")" : "Nunca"],
    !me ? ["Conexión", conn] : null,
    !me && n.relay ? ["Retransmitido por", relayName(n.relay)] : null,
    !me ? ["Señal (último paquete)", n.snr != null ? "SNR " + n.snr.toFixed(1) + " dB" + (n.rssi != null ? " · RSSI " + n.rssi + " dBm" : "") : "—"] : null,
    ["Batería", dm.batteryLevel != null ? fmtTele("batteryLevel", dm.batteryLevel) + (dm.voltage ? " · " + dm.voltage.toFixed(2) + " V" : "") : battText(n.battery)],
    dm.channelUtilization != null ? ["Uso del canal / aire TX", dm.channelUtilization.toFixed(1) + " % / " + (dm.airUtilTx != null ? dm.airUtilTx.toFixed(1) + " %" : "—")] : null,
    dm.uptimeSeconds ? ["Encendido hace", fmtTele("uptimeSeconds", dm.uptimeSeconds)] : null,
    em.temperature != null ? ["Ambiente", em.temperature.toFixed(1) + " °C" + (em.relativeHumidity != null ? " · " + em.relativeHumidity.toFixed(0) + " % HR" : "") + (em.barometricPressure ? " · " + em.barometricPressure.toFixed(0) + " hPa" : "")] : null,
    ["Posición", n.pos ? n.pos.lat.toFixed(5) + ", " + n.pos.lon.toFixed(5) + (n.pos.alt ? " · " + Math.round(n.pos.alt) + " m" : "") : "Sin posición"],
    !me && mp && n.pos ? ["Distancia", fmtDist(hav(mp.lat, mp.lon, n.pos.lat, n.pos.lon)) + " al " + compass(bearing(mp.lat, mp.lon, n.pos.lat, n.pos.lon))] : null,
    n.user && n.user.publicKey && n.user.publicKey.length ? ["Mensajes directos", "Cifrados de punta a punta (clave pública conocida)"] : null,
  ].filter(Boolean);
  const lh = linkHist(num).filter((h) => !h.mqtt);
  const dh = (t.device && t.device.hist) || [];
  const neighOut = (S.neigh.get(num) || []).map((x) => ({ id: x.id, snr: x.snr }));
  const neighIn = [...S.neigh].filter(([id, l]) => id !== num && l.some((x) => x.id === num)).map(([id, l]) => ({ id, snr: l.find((x) => x.id === num).snr }));
  const traces = S.traces.filter((r) => r.dest === num).slice(-3).reverse();
  const nm = (id) => { const x = S.nodes.get(id); return x ? nodeName(x) : nodeId(id); };
  const snrTxt = (v) => (v == null ? "" : " (" + v.toFixed(1) + " dB)");
  const act = (label, fn, cls) => el("button", { class: "mini " + (cls || ""), onclick: fn }, label);
  box.replaceChildren(...[
    el("div", { class: "nshead" }, avatar(n, 46), el("div", { class: "nst" }, el("b", {}, nodeName(n) + (me ? " (vos)" : "")), el("div", { class: "infokv" }, stDot(n), el("span", { style: "color:" + ST_COL[st.k] }, ST_LBL[st.k]), st.why.length ? el("small", {}, " · " + st.why.join(" · ")) : null)), !me ? favBtn(n, "big") : null, el("button", { class: "mini nsx", title: "Cerrar", onclick: closeNodeSheet }, "✕")),
    st.k === "panic" ? el("div", { class: "warnbox" }, "🚨 Alerta sin atender ", el("button", { class: "mini ack", onclick: () => ackAlert(num) }, "Marcar atendida")) : null,
    el("table", { class: "kv nskv" }, el("tbody", {}, kv.map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, v))))),
    !me ? el("div", { class: "nsg" }, el("b", {}, "SNR recibido"), sparkSvg(lh.map((h) => ({ t: h.t, v: h.snr })), { u: " dB" })) : null,
    !me && lh.some((h) => h.rssi != null) ? el("div", { class: "nsg" }, el("b", {}, "RSSI recibido"), sparkSvg(lh.map((h) => ({ t: h.t, v: h.rssi })), { u: " dBm", fmt: (v) => String(Math.round(v)) })) : null,
    el("div", { class: "nsg" }, el("b", {}, "Batería"), sparkSvg(dh.map((h) => ({ t: h.t, v: h.batteryLevel > 100 ? null : h.batteryLevel })), { u: " %", min: 0, max: 100, fmt: (v) => String(Math.round(v)) })),
    dh.some((h) => h.voltage) ? el("div", { class: "nsg" }, el("b", {}, "Tensión"), sparkSvg(dh.map((h) => ({ t: h.t, v: h.voltage || null })), { u: " V", fmt: (v) => v.toFixed(2) })) : null,
    el("div", { class: "nsg" }, el("b", {}, "Vecinos que informa"), neighOut.length ? el("div", { class: "chips" }, neighOut.map((x) => act(nm(x.id) + snrTxt(x.snr), () => openNodeSheet(x.id)))) : el("small", { class: "muted" }, "Sin informe de vecinos (módulo Información de vecinos apagado o todavía sin datos)."),
      neighIn.length ? el("div", {}, el("small", { class: "muted" }, "Lo escuchan: "), el("div", { class: "chips" }, neighIn.map((x) => act(nm(x.id) + snrTxt(x.snr), () => openNodeSheet(x.id))))) : null),
    !me ? el("div", { class: "nsg" }, el("b", {}, "Rutas medidas (traceroute)"), traces.length ? traces.map((r) => el("div", { class: "nsroute" }, el("small", { class: "muted" }, hhmm(r.t)), el("div", {}, "Ida: " + [r.me, ...r.route, r.dest].map(nm).join(" → ")), r.back && r.back.length ? el("div", {}, "Vuelta: " + [r.dest, ...r.back, r.me].map(nm).join(" → ")) : null)) : el("small", { class: "muted" }, "Todavía no se trazó ninguna ruta a este nodo.")) : null,
    el("div", { class: "chips nsacts" },
      !me ? act("✉ Mensaje directo", () => { closeNodeSheet(); openDM(num); }, "acc") : null,
      !me ? act("Trazar ruta", () => nodeAction("trace", n)) : null,
      !me ? act("Pedir posición", () => nodeAction("pos", n)) : null,
      n.pos ? act("Ver en el mapa", () => { closeNodeSheet(); S.map.sel = num; S.map.fitted = true; const o = origin(), p = proj(n.pos.lat, n.pos.lon, o); S.map.cx = p.x; S.map.cy = p.y; S.map.mpp = Math.min(S.map.mpp, 60); setView("map"); }) : null,
      n.pos ? act("🧭 Cómo llegar", () => openExternal(gmapsDir(n.pos.lat, n.pos.lon))) : null,
      act("Telemetría", () => { closeNodeSheet(); S.tui.node = num; S.tui.tab = "detail"; S.tui.metric = null; setView("tele"); }),
      !me ? act("Quitar de la lista", () => { closeNodeSheet(); nodeAction("del", n); }, "danger") : null)].filter(Boolean));
}
window.__ns = { openNodeSheet, closeNodeSheet };

/* ── respuestas y reacciones ── */
const REACTS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "✅", "⚠️"];
S.replyTo = null;
function applyReact(targetId, from, emo, on = true) {
  const t = S.msgs.find((x) => x.id === targetId); if (!t) return false;
  const r = t.reacts || (t.reacts = {}), l = r[emo] || (r[emo] = []);
  const i = l.indexOf(from);
  if (on && i < 0) l.push(from); else if (!on && i >= 0) l.splice(i, 1);
  if (!l.length) delete r[emo];
  S.msgRev = (S.msgRev || 0) + 1; scheduleRefresh("msgs"); persistSoon();
  return true;
}
async function sendReact(x, emo) {
  if (!S.device || !ready()) return toast("Conectate primero al nodo", "err");
  if (!(x.id > 0)) return toast("Ese mensaje no llegó a enviarse: no se le puede reaccionar", "err");
  const dest = x.dm ? (x.mine ? x.to : x.from) : "broadcast";
  await dispatch({ text: emo, dest, ch: x.ch, tries: MAX_TRIES - 1, react: x.id, replyTo: x.id, emoji: emo.codePointAt(0) });
}
function setReply(x) { S.replyTo = x; drawReplyBar(); const i = $("#msgin"); if (i) i.focus(); }
function drawReplyBar() {
  const b = $("#replybar"); if (!b) return;
  const x = S.replyTo && convOf(S.replyTo) === S.conv ? S.replyTo : null;
  b.style.display = x ? "" : "none"; if (!x) return;
  const n = S.nodes.get(x.from) || { num: x.from };
  b.replaceChildren(el("span", { class: "rbic" }, "↩"), el("div", { class: "rbt" }, el("b", {}, "Respondiendo a " + (x.mine ? "tu mensaje" : nodeName(n))), el("small", {}, String(x.text).slice(0, 120))), el("button", { class: "mini", type: "button", title: "Cancelar respuesta", onclick: () => { S.replyTo = null; drawReplyBar(); } }, "✕"));
}
function quoteEl(x) {
  const o = S.msgs.find((y) => y.id === x.replyTo);
  const n = o && (S.nodes.get(o.from) || { num: o.from });
  return el("div", { class: "quote" }, el("b", {}, o ? (o.mine ? "Vos" : nodeName(n)) : "Respuesta"), el("span", {}, o ? String(o.text).slice(0, 100) : "(mensaje anterior no disponible)"));
}
function reactsEl(x) {
  const e = Object.entries(x.reacts || {}).filter(([, l]) => l.length);
  if (!e.length) return null;
  return el("div", { class: "reacts" }, e.map(([emo, l]) => el("button", { class: "react" + (l.includes(S.me) ? " mine" : ""), title: l.map(nameOf).join(", "), onclick: (ev) => { ev.stopPropagation(); if (!l.includes(S.me)) sendReact(x, emo); } }, emo, l.length > 1 ? el("span", {}, String(l.length)) : null)));
}
let msgMenuEl = null;
function closeMsgMenu() { if (msgMenuEl) msgMenuEl.remove(); msgMenuEl = null; }
document.addEventListener("pointerdown", (e) => { if (msgMenuEl && !msgMenuEl.contains(e.target)) closeMsgMenu(); }, true);
function msgMenu(x, anchor) {
  closeMsgMenu();
  const ok = x.id > 0 && !isNaN(x.id);
  const item = (label, fn, dis) => el("button", { class: "mmi", disabled: !!dis, onclick: () => { closeMsgMenu(); fn(); } }, label);
  msgMenuEl = el("div", { class: "msgmenu", role: "menu" },
    el("div", { class: "mmr" }, REACTS.map((e) => el("button", { class: "mme", title: "Reaccionar " + e, disabled: !ok || !ready(), onclick: () => { closeMsgMenu(); sendReact(x, e); } }, e))),
    item("↩ Responder", () => setReply(x), !ok),
    item("Copiar texto", () => { if (IS_APP && window.AndroidBridge.copyText) { window.AndroidBridge.copyText(x.text); toast("Texto copiado"); } else navigator.clipboard.writeText(x.text).then(() => toast("Texto copiado"), () => toast("El navegador no dejó copiar al portapapeles. Seleccioná el texto a mano y copialo con Ctrl+C.", "err")); }),
    !x.mine ? item("Ver detalle del nodo", () => openNodeSheet(x.from)) : null,
    !x.mine && !x.dm ? item("Responder en privado", () => openDM(x.from)) : null);
  document.body.append(msgMenuEl);
  const r = anchor.getBoundingClientRect(), mw = msgMenuEl.offsetWidth, mh = msgMenuEl.offsetHeight;
  msgMenuEl.style.left = clamp(r.right - mw, 8, innerWidth - mw - 8) + "px";
  msgMenuEl.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + "px";
}

/* ── canales por código QR ── */
function qrSvg(text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, sz = n + m * 2, ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", `0 0 ${sz} ${sz}`); s.setAttribute("class", "qrsvg"); s.setAttribute("shape-rendering", "crispEdges");
  let d = ""; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const bg = document.createElementNS(ns, "rect"); bg.setAttribute("width", sz); bg.setAttribute("height", sz); bg.setAttribute("fill", "#fff");
  const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); p.setAttribute("fill", "#000");
  s.append(bg, p); return s;
}
function showChannelQR(url, names) {
  const svg = qrSvg(url);
  const dlg = el("div", { class: "modal encima", onclick: (e) => e.target === dlg && dlg.remove() },
    el("div", { class: "mbox qrbox" }, el("h3", {}, "Código QR de mis canales"),
      el("small", { class: "muted" }, "Canales: " + names.join(", ") + ". Quien lo escanee recibe las claves: mostralo solo a gente de confianza."),
      el("div", { class: "qrwrap" }, svg),
      el("div", { class: "chips" },
        el("button", { class: "btn ghost", onclick: () => { const s = new XMLSerializer().serializeToString(svg); const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 900; const g = c.getContext("2d"); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, 900, 900); c.toBlob((b) => b && download("canales-qr.png", b), "image/png"); }; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s); } }, "Guardar imagen"),
        el("button", { class: "btn ghost", onclick: () => { if (IS_APP && window.AndroidBridge.copyText) { window.AndroidBridge.copyText(url); toast("Enlace copiado"); } else navigator.clipboard.writeText(url).then(() => toast("Enlace copiado")); } }, "Copiar enlace"),
        el("button", { class: "btn", onclick: () => dlg.remove() }, "Cerrar"))));
  document.body.append(dlg);
}
function decodeQrImage(src) { /* src: ImageBitmap | HTMLVideoElement | HTMLImageElement */
  const w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height; if (!w || !h) return null;
  const k = Math.min(1, 1000 / Math.max(w, h)), c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(src, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), r = jsQR(d.data, c.width, c.height, { inversionAttempts: "attemptBoth" });
  return r ? r.data : null;
}
function scanChannelQR(onText) {
  let stream = null, raf = 0, done = false;
  const video = el("video", { class: "qrvid", playsinline: true, muted: true, autoplay: true });
  const msg = el("small", { class: "muted" }, "Apuntá la cámara al código QR de canales…");
  const fi = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const bm = await createImageBitmap(f); const t = decodeQrImage(bm); if (t) finish(t); else msg.textContent = "No se encontró un código QR en la imagen."; } catch (er) { msg.textContent = "No se pudo leer la imagen."; }
  } });
  const stop = () => { done = true; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  const finish = (t) => { stop(); dlg.remove(); onText(t); };
  const dlg = el("div", { class: "modal encima", onclick: (e) => { if (e.target === dlg) { stop(); dlg.remove(); } } },
    el("div", { class: "mbox qrbox" }, el("h3", {}, "Escanear código QR de canales"), el("div", { class: "qrcam" }, video, el("i", { class: "qraim" })), msg,
      el("div", { class: "chips" }, el("button", { class: "btn ghost", onclick: () => fi.click() }, "Elegir una foto del QR…"), el("button", { class: "btn", onclick: () => { stop(); dlg.remove(); } }, "Cancelar")), fi));
  document.body.append(dlg);
  const loop = () => { if (done) return; try { if (video.readyState >= 2) { const t = decodeQrImage(video); if (t) return finish(t); } } catch (e) {} raf = requestAnimationFrame(loop); };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = "Este equipo no permite usar la cámara aquí: elegí una foto del código."; return; }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
    .then((s) => { if (done) { s.getTracks().forEach((t) => t.stop()); return; } stream = s; video.srcObject = s; video.play().catch(() => {}); loop(); })
    .catch((e) => { msg.textContent = (e && e.name === "NotAllowedError" ? "Sin permiso para usar la cámara." : "No se pudo abrir la cámara.") + " Podés elegir una foto del código."; });
}

/* ── mapa sin conexión: descarga por zona ── */
const ZONES_KEY = "meshportal:zones";
const zonesGet = () => { try { return JSON.parse(localStorage.getItem(ZONES_KEY) || "[]"); } catch (e) { return []; } };
const zonesSave = (l) => { try { localStorage.setItem(ZONES_KEY, JSON.stringify(l.slice(-30))); } catch (e) {} };
const TILE_KB = 18; /* tamaño promedio aproximado de una tesela */
function zoneTiles(layers, ctr, km, z0, z1) {
  const dLat = km / 111.32, dLon = km / (111.32 * Math.max(0.05, Math.cos((ctr.lat * Math.PI) / 180)));
  const a = { lat: Math.min(85, ctr.lat + dLat), lon: ctr.lon - dLon }, b = { lat: Math.max(-85, ctr.lat - dLat), lon: ctr.lon + dLon };
  const jobs = [];
  for (const l of layers) for (let z = z0; z <= Math.min(l.z, z1); z++) {
    const n = 2 ** z, x0 = Math.floor(lon2x(a.lon, z)), x1 = Math.floor(lon2x(b.lon, z)), y0 = Math.max(0, Math.floor(lat2y(a.lat, z))), y1 = Math.min(n - 1, Math.floor(lat2y(b.lat, z)));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([l, z, ((x % n) + n) % n, y]);
  }
  return { jobs, a, b };
}
let dlRun = null;
function openOfflineDialog() {
  const L = S.map.L, c = $("#mapc");
  const layers = [BASES[L.base]].filter(Boolean).concat(Object.keys(OVERS).filter((k) => L.over && L.over[k]).map((k) => OVERS[k]));
  if (!layers.length) return toast("Elegí primero un mapa base en Capas", "err");
  const ctr = c ? unproj(c, c.clientWidth / 2, c.clientHeight / 2) : mePos();
  if (!ctr) return toast("Abrí el mapa primero", "err");
  const zNow = clamp(Math.round(Math.log2((156543.03392 * Math.cos((ctr.lat * Math.PI) / 180)) / S.map.mpp)), 1, 18);
  const o = { km: 5, z0: Math.max(8, zNow - 2), z1: Math.min(16, Math.max(zNow + 1, 14)), name: "Zona " + (zonesGet().length + 1) };
  const MAXT = 30000;
  const est = el("div", { class: "dlest" }), prog = el("div", { class: "dlprog", style: "display:none" }, el("i", {})), ptxt = el("small", { class: "muted" });
  const go = el("button", { class: "btn" }, "Descargar");
  const upd = () => {
    const { jobs } = zoneTiles(layers, ctr, o.km, o.z0, o.z1), mb = (jobs.length * TILE_KB) / 1024;
    est.replaceChildren(el("b", {}, jobs.length.toLocaleString("es-AR") + " teselas"), el("span", {}, " · unos " + (mb < 1 ? Math.max(0.1, mb).toFixed(1) : Math.round(mb)) + " MB"), jobs.length > MAXT ? el("div", { class: "warnbox" }, "Es demasiado (máx. " + MAXT.toLocaleString("es-AR") + "): achicá el radio o el zoom máximo.") : el("span"));
    go.disabled = jobs.length > MAXT || !jobs.length || !!dlRun;
  };
  const numIn2 = (k, min, max, step = 1) => el("input", { class: "inp", type: "number", min, max, step, value: o[k], style: "width:90px", oninput: (e) => { const v = +e.target.value; if (isFinite(v)) { o[k] = clamp(v, min, max); if (o.z1 < o.z0) o.z1 = o.z0; upd(); } } });
  const zl = el("div", { class: "zlist" });
  const drawZones = () => {
    const l = zonesGet();
    zl.replaceChildren(l.length ? el("b", {}, "Zonas guardadas") : el("small", { class: "muted" }, "Todavía no guardaste zonas."),
      ...l.slice().reverse().map((z) => el("div", { class: "zrow" }, el("div", {}, el("b", {}, z.name), el("small", {}, " · " + z.km + " km · zoom " + z.z0 + "–" + z.z1 + " · " + z.n.toLocaleString("es-AR") + " teselas · " + new Date(z.t).toLocaleDateString("es-AR"))),
        el("div", { class: "chips" }, el("button", { class: "mini", onclick: () => { const o2 = origin(), p = proj(z.lat, z.lon, o2); S.map.cx = p.x; S.map.cy = p.y; S.map.fitted = true; S.map.mpp = (156543.03392 * Math.cos((z.lat * Math.PI) / 180)) / 2 ** (z.z0 + 1); dlg.remove(); drawMap(); } }, "Ir"),
          el("button", { class: "mini", disabled: !!dlRun, onclick: () => { Object.assign(o, { km: z.km, z0: z.z0, z1: z.z1, name: z.name }); dlg.remove(); dlZone({ lat: z.lat, lon: z.lon }, o, layers); } }, "Actualizar"),
          el("button", { class: "mini danger", onclick: () => { zonesSave(zonesGet().filter((x) => x.id !== z.id)); drawZones(); } }, "Quitar de la lista")))));
  };
  const dlg = el("div", { class: "modal encima", onclick: (e) => e.target === dlg && !dlRun && dlg.remove() },
    el("div", { class: "mbox dlbox" }, el("h3", {}, "Guardar mapa para usar sin conexión"),
      el("small", { class: "muted" }, "Se descarga un cuadrado alrededor del centro del mapa (" + ctr.lat.toFixed(4) + ", " + ctr.lon.toFixed(4) + ") con las capas que tenés activas: " + layers.map((l) => l.n).join(", ") + ". Respetá las condiciones de uso de cada proveedor."),
      el("div", { class: "g2 dlg2" },
        el("label", {}, el("small", {}, "Nombre"), el("input", { class: "inp", value: o.name, oninput: (e) => (o.name = e.target.value.slice(0, 40)) })),
        el("label", {}, el("small", {}, "Radio (km)"), numIn2("km", 0.5, 100, 0.5)),
        el("label", {}, el("small", {}, "Zoom mínimo (lejos)"), numIn2("z0", 1, 18)),
        el("label", {}, el("small", {}, "Zoom máximo (cerca)"), numIn2("z1", 1, 19))),
      el("small", { class: "muted" }, "Guía: zoom 12 = ciudad entera · 14 = barrios · 16 = calles · 17-18 = casas. Cada nivel más de zoom multiplica por 4 las teselas."),
      est, prog, ptxt,
      el("div", { class: "chips" }, go, el("button", { class: "btn ghost", onclick: () => { if (dlRun) { dlRun.cancel = true; return; } dlg.remove(); } }, "Cerrar / cancelar")),
      zl));
  go.onclick = () => dlZone(ctr, o, layers, { prog, ptxt, go, after: () => { drawZones(); upd(); } });
  document.body.append(dlg); upd(); drawZones();
}
async function dlZone(ctr, o, layers, ui = {}) {
  if (dlRun) return toast("Ya hay una descarga en curso", "err");
  if (S.net && S.net.online === false) return toast("Sin Internet: no se pueden descargar mapas ahora", "err");
  const { jobs } = zoneTiles(layers, ctr, o.km, o.z0, o.z1), total = jobs.length;
  const run = (dlRun = { cancel: false, done: 0, fail: 0, have: 0 });
  if (ui.go) ui.go.disabled = true; if (ui.prog) ui.prog.style.display = "";
  const show = () => { const p = Math.round((run.done / Math.max(1, total)) * 100); if (ui.prog) ui.prog.firstChild.style.width = p + "%"; if (ui.ptxt) ui.ptxt.textContent = `${run.done.toLocaleString("es-AR")} de ${total.toLocaleString("es-AR")} (${p} %) · ya estaban: ${run.have} · fallaron: ${run.fail}`; const bt = $("#dlbtn"); if (bt) bt.textContent = `Descargando… ${p} %`; };
  const worker = async () => { while (jobs.length && !run.cancel) { const [l, z, x, y] = jobs.shift(); const key = l.id + "/" + z + "/" + x + "/" + y; try { if (await tileGetDB(key)) run.have++; else await tilePutDB(key, await fetchTileBlob(l, z, x, y)); } catch (e) { run.fail++; } run.done++; if (run.done % 10 === 0 || !jobs.length) show(); } };
  toast("Descargando mapa: " + total.toLocaleString("es-AR") + " teselas…");
  await Promise.all(Array.from({ length: 6 }, worker));
  dlRun = null; show();
  const ok = run.done - run.fail;
  if (!run.cancel) { const l = zonesGet().filter((z) => z.name !== o.name); l.push({ id: Math.random().toString(36).slice(2, 9), name: o.name || "Zona", lat: ctr.lat, lon: ctr.lon, km: o.km, z0: o.z0, z1: o.z1, n: total, t: Date.now() }); zonesSave(l); }
  toast(run.cancel ? `Descarga cancelada: ${ok} teselas guardadas` : run.fail ? `Listo: ${ok} teselas guardadas, ${run.fail} fallaron (¿sin Internet o el proveedor bloquea la descarga?)` : `Listo: zona “${o.name}” guardada (${total} teselas)`, run.fail && !run.cancel ? "err" : "ok");
  if (ui.go) ui.go.disabled = false; if (ui.after) ui.after();
  buildLayersPanel(); drawMapSoon();
}

/* ───────────────────────── arranque ───────────────────────── */
try { const th = localStorage.getItem("meshportal:theme"); document.documentElement.dataset.theme = ["light", "dark", "hc", "night"].includes(th) ? th : "dark"; } catch (e) { document.documentElement.dataset.theme = "dark"; }
matchMedia("(prefers-color-scheme:dark)").addEventListener("change", () => S.view === "map" && drawMap());
scheduleRefresh("all");
probeNet(); mqEnsure();
// Si ya hay un puerto autorizado, ofrecerlo; no se conecta solo sin que lo pidas.
/* ───────────────────────── diálogos: Escape, foco y vuelta al lugar ─────────────────────────
   Hasta acá los diálogos solo se cerraban con el mouse, y el tabulador se iba por detrás a la
   pantalla de atrás. Esto vale para todos de una vez, sin tocar cada uno: se usa el cierre
   propio de cada diálogo (un clic en el fondo), así se respeta la limpieza que hace cada uno
   —por ejemplo apagar la cámara del lector de QR—. */
const SEL_FOCO = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const dlgArriba = () => { const d = document.querySelectorAll("body > .modal"); return d.length ? d[d.length - 1] : null; };
const focosDe = (d) => [...d.querySelectorAll(SEL_FOCO)].filter((x) => x.getClientRects().length);
let focoPrevio = null;

document.addEventListener("keydown", (e) => {
  const d = dlgArriba(); if (!d) return;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    d.dispatchEvent(new MouseEvent("click", { bubbles: true })); /* cada diálogo sabe cómo cerrarse */
    return;
  }
  if (e.key !== "Tab") return;
  const f = focosDe(d); if (!f.length) return;
  const primero = f[0], ultimo = f[f.length - 1], aca = d.contains(document.activeElement);
  if (e.shiftKey && (!aca || document.activeElement === primero)) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && (!aca || document.activeElement === ultimo)) { e.preventDefault(); primero.focus(); }
}, true);

/* Al abrirse un diálogo el foco entra solo; al cerrarse vuelve a donde estaba. */
new MutationObserver((cambios) => {
  for (const c of cambios) {
    for (const n of c.addedNodes) {
      if (n.nodeType !== 1 || !n.classList || !n.classList.contains("modal")) continue;
      focoPrevio = document.activeElement;
      requestAnimationFrame(() => { const f = focosDe(n); (f[0] || n).focus({ preventScroll: true }); });
    }
    for (const n of c.removedNodes) {
      if (n.nodeType !== 1 || !n.classList || !n.classList.contains("modal")) continue;
      if (dlgArriba()) continue; /* todavía queda otro abierto */
      const v = focoPrevio; focoPrevio = null;
      if (v && v.isConnected && v.getClientRects().length) requestAnimationFrame(() => v.focus({ preventScroll: true }));
    }
  }
}).observe(document.body, { childList: true });

window.__mesh = S;
window.__ui = { setView, renderMain, startDemo };
window.__conn = { connectNet, makeNetTransport, testNet, diagNode };
window.__pb = { NMesh, NConfig, NModule, NAdmin, NChannel, NPort, NApp, NClient, NLocal, create, toBinary, fromBinary, startDevice };

function afterNodeInfo(ni) {
  const dm = ni.deviceMetrics, p = ni.position;
  if (dm) recordTele(ni.num, "device", msgToObj(Protobuf.Telemetry.DeviceMetricsSchema, dm), ni.lastHeard ? ni.lastHeard * 1000 : Date.now());
  if (p && (p.latitudeI || p.longitudeI) && !(S.tracks.get(ni.num) || []).length) addTrackPoint(ni.num, p.latitudeI / 1e7, p.longitudeI / 1e7, p.altitude, ni.lastHeard ? ni.lastHeard * 1000 : Date.now());
}
