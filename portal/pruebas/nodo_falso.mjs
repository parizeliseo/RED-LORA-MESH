/* Nodo LoRa Mesh de mentira con la API web del firmware (la que usa el portal para conectarse por
   WiFi). Sirve para probar el portal conectado de verdad, sin hardware: entrega su configuración,
   una libreta de nodos, confirma los mensajes que se le mandan y genera tráfico (mensajes de otros
   nodos, telemetría y posiciones).

   No se ejecuta directo: comun.py lo arma con esbuild junto con los protobuf del portal.
   Uso (ya armado): node nodo_falso.cjs <puerto> [mensajes por segundo] [nodos en la libreta]   */
import http from "node:http";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import * as Mesh from "../src/pb/mesh_pb.js";
import * as Ch from "../src/pb/channel_pb.js";
import * as Cfg from "../src/pb/config_pb.js";
import * as Tel from "../src/pb/telemetry_pb.js";
import { PortNum } from "../src/pb/portnums_pb.js";

const PUERTO = +(process.argv[2] || 8111), POR_SEG = +(process.argv[3] || 2), LIBRETA = +(process.argv[4] || 40);
const YO = 0x1a2b3c4d, ahora = () => Math.floor(Date.now() / 1000);
const cola = [];
let idPaquete = 5000, idFrom = 1;
const fr = (caso, valor) => create(Mesh.FromRadioSchema, { id: idFrom++, payloadVariant: { case: caso, value: valor } });
const usuario = (num, nombre, corto) => create(Mesh.UserSchema, { id: "!" + num.toString(16).padStart(8, "0"), longName: nombre, shortName: corto, hwModel: 43 });
const otros = Array.from({ length: LIBRETA }, (_, i) => 0x50000000 + i);

function paquete(from, to, puerto, payload, extra = {}) {
  return create(Mesh.MeshPacketSchema, {
    from, to, channel: 0, id: idPaquete++, rxTime: ahora(), rxSnr: 6.5, rxRssi: -88, hopStart: 3, hopLimit: 3,
    payloadVariant: { case: "decoded", value: create(Mesh.DataSchema, { portnum: puerto, payload, ...extra }) },
  });
}
function configurar(idPedido) {
  cola.push(fr("myInfo", create(Mesh.MyNodeInfoSchema, { myNodeNum: YO, rebootCount: 1, minAppVersion: 30200 })));
  cola.push(fr("metadata", create(Mesh.DeviceMetadataSchema, { firmwareVersion: "2.8.1.prueba", hwModel: 43, hasWifi: true, hasBluetooth: true })));
  cola.push(fr("nodeInfo", create(Mesh.NodeInfoSchema, { num: YO, user: usuario(YO, "Nodo de prueba", "PRUE"), lastHeard: ahora() })));
  otros.forEach((num, i) => cola.push(fr("nodeInfo", create(Mesh.NodeInfoSchema, {
    num, user: usuario(num, "Vecino " + i, "V" + String(i).padStart(3, "0")), lastHeard: ahora() - i * 60, snr: 4 - (i % 10), hopsAway: i % 3,
    position: create(Mesh.PositionSchema, { latitudeI: Math.round((-40.157 + i * 0.002) * 1e7), longitudeI: Math.round((-71.35 + (i % 7) * 0.003) * 1e7), altitude: 800 + i }),
  }))));
  cola.push(fr("config", create(Cfg.ConfigSchema, { payloadVariant: { case: "lora", value: create(Cfg.Config_LoRaConfigSchema, { region: 6, usePreset: true, hopLimit: 3, txEnabled: true }) } })));
  cola.push(fr("config", create(Cfg.ConfigSchema, { payloadVariant: { case: "device", value: create(Cfg.Config_DeviceConfigSchema, { role: 0 }) } })));
  cola.push(fr("channel", create(Ch.ChannelSchema, { index: 0, role: Ch.Channel_Role.PRIMARY, settings: create(Ch.ChannelSettingsSchema, { name: "PRUEBA", psk: new Uint8Array([1]) }) })));
  for (let i = 1; i < 8; i++) cola.push(fr("channel", create(Ch.ChannelSchema, { index: i, role: Ch.Channel_Role.DISABLED })));
  cola.push(fr("configCompleteId", idPedido));
}
function recibido(tr) {
  const v = tr.payloadVariant;
  if (v.case === "wantConfigId") return configurar(v.value);
  if (v.case !== "packet") return;
  const p = v.value, d = p.payloadVariant.case === "decoded" ? p.payloadVariant.value : null;
  if (!d) return;
  /* el nodo confirma todo lo que se le manda: así el portal lo marca "enviado ✓" */
  const ack = create(Mesh.RoutingSchema, { variant: { case: "errorReason", value: 0 } });
  cola.unshift(fr("packet", paquete(YO, YO, PortNum.ROUTING_APP, toBinary(Mesh.RoutingSchema, ack), { requestId: p.id }))); /* adelante: si no, esperaría detrás del tráfico */
  enviados++;
}
let enviados = 0, generados = 0;
setInterval(() => { /* tráfico de la red: mensajes, telemetría y posiciones de los vecinos */
  if (!conectado || cola.length > 200) return; /* como la radio real: si el portal no da abasto, no se acumula sin fin */
  for (let k = 0; k < Math.max(1, Math.round(POR_SEG / 4)); k++) {
    const de = otros[generados % otros.length];
    cola.push(fr("packet", paquete(de, 0xffffffff, PortNum.TEXT_MESSAGE_APP, new TextEncoder().encode("Mensaje de prueba " + generados + " desde la red"))));
    if (generados % 5 === 0) {
      const t = create(Tel.TelemetrySchema, { time: ahora(), variant: { case: "deviceMetrics", value: create(Tel.DeviceMetricsSchema, { batteryLevel: 50 + (generados % 50), voltage: 3.9, channelUtilization: 12, airUtilTx: 2, uptimeSeconds: generados }) } });
      cola.push(fr("packet", paquete(de, 0xffffffff, PortNum.TELEMETRY_APP, toBinary(Tel.TelemetrySchema, t))));
    }
    generados++;
  }
}, 250);
let conectado = false;
http.createServer((req, res) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Allow-Private-Network": "true" };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  if (req.url.startsWith("/api/v1/toradio")) {
    const partes = []; req.on("data", (c) => partes.push(c));
    req.on("end", () => { try { const b = Buffer.concat(partes); if (b.length) { conectado = true; recibido(fromBinary(Mesh.ToRadioSchema, new Uint8Array(b))); } } catch (e) { console.error("toradio:", e.message); } res.writeHead(200, h); res.end(); });
    return;
  }
  if (req.url.startsWith("/api/v1/fromradio")) {
    const m = cola.shift();
    res.writeHead(200, { ...h, "Content-Type": "application/x-protobuf" });
    return res.end(m ? Buffer.from(toBinary(Mesh.FromRadioSchema, m)) : Buffer.alloc(0));
  }
  if (req.url.startsWith("/estado-prueba")) { res.writeHead(200, { ...h, "Content-Type": "application/json" }); return res.end(JSON.stringify({ enviados, generados, enCola: cola.length })); }
  res.writeHead(200, h); res.end("nodo de prueba");
}).listen(PUERTO, "127.0.0.1", () => console.log("nodo de prueba escuchando en 127.0.0.1:" + PUERTO));
