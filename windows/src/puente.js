"use strict";
/*
 * Puente MQTT integrado.
 *
 * El portal habla MQTT por WebSocket, pero muchos servidores (entre ellos el oficial de la red
 * LoRa Mesh) solo atienden MQTT por TCP. Este puente escucha en esta misma computadora y reenvía
 * cada conexión, sin tocarla, al servidor que pida el portal:
 *
 *     ws://localhost:9001/<servidor>/<puerto>/<tls|tcp>
 *
 * Es el mismo contrato que el puente de Python (puente-mqtt.py), así que el portal no cambia nada:
 * lo detecta solo y se pone en verde. La diferencia es que ya no hace falta instalar Python.
 *
 * Seguridad:
 *  - Escucha solo en 127.0.0.1: desde otra computadora de la red no se puede usar.
 *  - Solo reenvía a puertos MQTT (1883, 8883, 8886, 8884). No sirve para llegar a otra cosa.
 *  - Solo atiende al portal: rechaza conexiones que vengan de una página de Internet
 *    (se mira el encabezado Origin). Sí acepta el portal abierto como archivo en un navegador.
 */
const http = require("http");
const net = require("net");
const tls = require("tls");
const { WebSocketServer } = require("ws");

const PUERTOS_MQTT = new Set([1883, 8883, 8886, 8884]);
const PUERTO_LOCAL = 9001;

/** Origen permitido: la propia aplicación o el portal abierto como archivo. Nunca una web. */
function origenOk(origin) {
  if (!origin) return true; /* clientes que no mandan Origin (no son navegadores) */
  const o = String(origin).toLowerCase();
  return o === "null" || o.startsWith("file://") || o.startsWith("app://");
}

/** '/host/puerto/tls' -> { host, port, tls } o null */
function ruta(url) {
  const partes = String(url || "/").split("?")[0].split("/").filter(Boolean);
  if (!partes.length) return { host: "mqtt.meshtastic.org", port: 8883, tls: true };
  const host = decodeURIComponent(partes[0]).toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return null;
  const port = partes[1] ? parseInt(partes[1], 10) : 8883;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const modo = (partes[2] || (port === 1883 ? "tcp" : "tls")).toLowerCase();
  if (modo !== "tls" && modo !== "tcp") return null;
  return { host, port, tls: modo === "tls" };
}

function crearPuente(log) {
  const registro = typeof log === "function" ? log : () => {};
  let servidor = null;
  let estado = { activo: false, error: "", conexiones: 0, total: 0 };
  const abiertas = new Set();

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protos) => (protos.has("mqtt") ? "mqtt" : false),
  });

  function rechazar(socket, codigo, texto) {
    try {
      socket.write("HTTP/1.1 " + codigo + "\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n" + texto);
    } catch (e) { /* ya cerrado */ }
    try { socket.destroy(); } catch (e) { /* nada */ }
  }

  function alUpgrade(req, socket, cabeza) {
    if (!origenOk(req.headers.origin)) {
      registro("rechazado (origen web): " + req.headers.origin);
      return rechazar(socket, "403 Forbidden", "Solo el portal puede usar este puente");
    }
    const d = ruta(req.url);
    if (!d) return rechazar(socket, "400 Bad Request", "Ruta inválida. Usá /servidor/puerto/tls");
    if (!PUERTOS_MQTT.has(d.port)) {
      registro("rechazado (puerto no MQTT): " + d.host + ":" + d.port);
      return rechazar(socket, "403 Forbidden", "Solo se reenvía a puertos MQTT (1883, 8883, 8886, 8884)");
    }
    /* primero se abre la conexión con el servidor; si falla, el portal recibe un error y prueba otra vía */
    let listo = false;
    const remoto = d.tls
      ? tls.connect({ host: d.host, port: d.port, servername: d.host })
      : net.connect({ host: d.host, port: d.port });
    const tope = setTimeout(() => { if (!listo) { remoto.destroy(); rechazar(socket, "504 Gateway Timeout", "El servidor no respondió"); } }, 12000);
    remoto.once(d.tls ? "secureConnect" : "connect", () => {
      listo = true; clearTimeout(tope);
      wss.handleUpgrade(req, socket, cabeza, (ws) => enlazar(ws, remoto, d));
    });
    remoto.once("error", (e) => {
      clearTimeout(tope);
      if (!listo) { registro("no se pudo abrir " + d.host + ":" + d.port + " · " + e.message); rechazar(socket, "502 Bad Gateway", "No se pudo llegar al servidor"); }
    });
  }

  function enlazar(ws, remoto, d) {
    estado.conexiones++; estado.total++;
    abiertas.add(ws);
    registro("conectado → " + d.host + ":" + d.port + (d.tls ? " (TLS)" : " (TCP)"));
    remoto.setNoDelay(true);
    ws.on("message", (datos) => { if (!remoto.destroyed) remoto.write(datos); });
    remoto.on("data", (datos) => { if (ws.readyState === 1) ws.send(datos, { binary: true }); });
    const cerrar = () => {
      if (!abiertas.has(ws)) return;
      abiertas.delete(ws); estado.conexiones--;
      try { remoto.destroy(); } catch (e) { /* nada */ }
      try { ws.terminate(); } catch (e) { /* nada */ }
      registro("cerrado " + d.host + ":" + d.port);
    };
    ws.on("close", cerrar); ws.on("error", cerrar);
    remoto.on("close", cerrar); remoto.on("error", cerrar);
  }

  function abrir() {
    if (servidor) return Promise.resolve({ ok: true });
    return new Promise((res) => {
      const s = http.createServer((req, resp) => {
        /* el portal pregunta "¿estás?" con un pedido común */
        resp.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "null", "Cache-Control": "no-store" });
        resp.end("Puente MQTT funcionando");
      });
      s.on("upgrade", alUpgrade);
      s.once("error", (e) => {
        estado.activo = false;
        estado.error = e.code === "EADDRINUSE"
          ? "El puerto " + PUERTO_LOCAL + " ya lo está usando otro programa (¿el puente de Python abierto?)"
          : e.message;
        registro("no se pudo abrir el puente: " + estado.error);
        servidor = null;
        res({ ok: false, error: estado.error });
      });
      s.listen(PUERTO_LOCAL, "127.0.0.1", () => {
        servidor = s; estado.activo = true; estado.error = "";
        registro("puente MQTT escuchando en 127.0.0.1:" + PUERTO_LOCAL);
        res({ ok: true });
      });
    });
  }

  function cerrar() {
    for (const ws of abiertas) { try { ws.terminate(); } catch (e) { /* nada */ } }
    abiertas.clear(); estado.conexiones = 0;
    if (servidor) { try { servidor.close(); } catch (e) { /* nada */ } }
    servidor = null; estado.activo = false;
  }

  return { abrir, cerrar, estado: () => ({ ...estado }) };
}

module.exports = { crearPuente, ruta, origenOk, PUERTOS_MQTT, PUERTO_LOCAL };
