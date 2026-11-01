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
 * Además de reenviar, el puente MIRA lo que pasa (sin modificarlo) para poder decir si de verdad
 * está conectado: lee la respuesta del servidor al saludo MQTT (CONNACK: aceptado, o rechazado y
 * por qué) y cuenta los mensajes que van y vienen. Todo eso se ve en
 *
 *     http://127.0.0.1:9001/estado      (JSON; solo lo puede leer el portal)
 *
 * Seguridad:
 *  - Escucha solo en 127.0.0.1: desde otra computadora de la red no se puede usar.
 *  - Solo reenvía a puertos MQTT (1883, 8883, 8886, 8884). No sirve para llegar a otra cosa.
 *  - Solo atiende al portal: rechaza conexiones que vengan de una página de Internet
 *    (se mira el encabezado Origin). Sí acepta el portal abierto como archivo en un navegador.
 *    El estado tampoco se le muestra a una página de Internet.
 */
const http = require("http");
const net = require("net");
const tls = require("tls");
const { WebSocketServer } = require("ws");

const PUERTOS_MQTT = new Set([1883, 8883, 8886, 8884]);
const PUERTO_LOCAL = 9001;
const MAX_ERRORES = 12;

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

/* Respuesta del servidor al saludo MQTT. MQTT 3.1.1 usa 1 a 5; MQTT 5 usa códigos desde 0x80. */
const CONNACK = {
  1: "el servidor no acepta esta versión de MQTT", 2: "el servidor rechazó el identificador del cliente",
  3: "el servidor no está disponible ahora", 4: "usuario o clave incorrectos", 5: "no autorizado (revisá usuario y clave)",
  0x84: "el servidor no acepta esta versión de MQTT", 0x85: "el servidor rechazó el identificador del cliente",
  0x86: "usuario o clave incorrectos", 0x87: "no autorizado (revisá usuario y clave)", 0x88: "el servidor no está disponible ahora",
  0x89: "el servidor está ocupado", 0x8a: "el servidor bloqueó a este cliente",
};

/** Traduce un error de red a algo que se entienda. */
function errorEnCastellano(e, d, alAbrir) {
  const c = (e && e.code) || "", srv = "«" + d.host + "»";
  /* pedirle TLS a un servidor sin TLS: suele cortar sin decir nada en medio del saludo */
  if (alAbrir && d.tls && (c === "ECONNRESET" || /before secure TLS connection/i.test((e && e.message) || "")))
    return "El servidor " + srv + " cortó al empezar la conexión segura: en el puerto " + d.port + " probablemente no usa TLS (probá sin TLS" + (d.port !== 1883 ? ", puerto 1883" : "") + ")";
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "No se encuentra el servidor " + srv + ": revisá que esté bien escrito y que haya Internet";
  if (c === "ECONNREFUSED") return "El servidor " + srv + " rechazó la conexión en el puerto " + d.port;
  if (c === "ETIMEDOUT" || c === "TIEMPO") return "El servidor " + srv + " no respondió en el puerto " + d.port + " (bloqueado por un firewall, o el servidor está caído)";
  if (c === "ECONNRESET" || c === "EPIPE") return "El servidor " + srv + " cortó la conexión";
  if (c === "ENETUNREACH" || c === "EHOSTUNREACH") return "No hay camino hasta " + srv + ": esta computadora no tiene Internet";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(c)) return "El certificado de seguridad de " + srv + " no es válido (" + c + ")";
  if (c === "EPROTO" || /wrong version number|packet length too long|unknown protocol/i.test((e && e.message) || ""))
    return "En el puerto " + d.port + " el servidor " + srv + " no usa TLS: probá sin TLS" + (d.port !== 1883 ? " (puerto 1883)" : "");
  return "No se pudo conectar con " + srv + ": " + ((e && e.message) || c || "error desconocido");
}

/*
 * Lector de paquetes MQTT sobre un flujo de bytes. No guarda los mensajes: solo mira el tipo de
 * cada paquete (y los primeros bytes del CONNACK) y salta el resto, así no gasta memoria aunque
 * pasen mensajes grandes.
 */
function lectorMqtt(alPaquete) {
  let cab = [], faltan = 0, tipo = 0, cuerpo = [];
  return (buf) => {
    let i = 0;
    while (i < buf.length) {
      if (faltan > 0) {
        const n = Math.min(faltan, buf.length - i);
        for (let k = 0; k < n && cuerpo.length < 4; k++) cuerpo.push(buf[i + k]);
        faltan -= n; i += n;
        if (faltan === 0) alPaquete(tipo, cuerpo);
        continue;
      }
      cab.push(buf[i++]);
      if (cab.length === 1) continue;
      if ((cab[cab.length - 1] & 0x80) && cab.length < 5) continue;
      let largo = 0;
      for (let k = cab.length - 1; k >= 1; k--) largo = largo * 128 + (cab[k] & 0x7f);
      tipo = cab[0] >> 4; cab = []; cuerpo = []; faltan = largo;
      if (faltan === 0) alPaquete(tipo, cuerpo);
    }
  };
}

function duracion(ms) {
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + " s";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  return h + " h " + (m % 60) + " min";
}

function crearPuente(log, alCambiar) {
  const registro = typeof log === "function" ? log : () => {};
  const avisar = typeof alCambiar === "function" ? alCambiar : () => {};
  let servidor = null, sigId = 1;
  const estado = { activo: false, error: "", desde: 0, total: 0 };
  const abiertas = new Map(); /* ws -> datos de la conexión */
  const errores = [];

  const anotarError = (d, texto) => {
    registro(texto);
    /* el portal reintenta solo: el mismo problema seguido se cuenta, no se repite */
    const u = errores[0];
    if (u && u.texto === texto && u.servidor === d.host && u.puerto === d.port) { u.t = Date.now(); u.veces = (u.veces || 1) + 1; return; }
    errores.unshift({ t: Date.now(), servidor: d.host, puerto: d.port, texto, veces: 1 });
    errores.length = Math.min(errores.length, MAX_ERRORES);
  };

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
      ? tls.connect({ host: d.host, port: d.port, servername: net.isIP(d.host) ? undefined : d.host })
      : net.connect({ host: d.host, port: d.port });
    const tope = setTimeout(() => {
      if (listo) return;
      remoto.destroy();
      anotarError(d, errorEnCastellano({ code: "TIEMPO" }, d)); avisar();
      rechazar(socket, "504 Gateway Timeout", "El servidor no respondió");
    }, 12000);
    remoto.once(d.tls ? "secureConnect" : "connect", () => {
      listo = true; clearTimeout(tope);
      wss.handleUpgrade(req, socket, cabeza, (ws) => enlazar(ws, remoto, d));
    });
    remoto.once("error", (e) => {
      clearTimeout(tope);
      if (!listo) { anotarError(d, errorEnCastellano(e, d, true)); avisar(); rechazar(socket, "502 Bad Gateway", "No se pudo llegar al servidor"); }
    });
  }

  function enlazar(ws, remoto, d) {
    const c = { id: sigId++, servidor: d.host, puerto: d.port, tls: d.tls, desde: Date.now(), mqtt: "esperando", motivo: "",
      recibidos: 0, enviados: 0, bytesRx: 0, bytesTx: 0, ultimo: Date.now() };
    estado.total++;
    abiertas.set(ws, c);
    registro("conectado → " + d.host + ":" + d.port + (d.tls ? " (TLS)" : " (TCP)"));
    avisar();
    /* TCP: avisa si la conexión se muere en silencio (cable, WiFi o router que se cuelga) */
    remoto.setNoDelay(true); remoto.setKeepAlive(true, 30000);

    const delPortal = lectorMqtt((tipo) => { if (tipo === 3) c.enviados++; });
    const delServidor = lectorMqtt((tipo, cuerpo) => {
      if (tipo === 2) { /* CONNACK: [banderas, código] */
        const rc = cuerpo.length >= 2 ? cuerpo[1] : 0;
        if (rc === 0) { c.mqtt = "conectado"; c.motivo = ""; registro("MQTT aceptado por " + d.host); }
        else { c.mqtt = "rechazado"; c.motivo = CONNACK[rc] || "código " + rc; anotarError(d, "El servidor «" + d.host + "» no dejó entrar: " + c.motivo); }
        avisar();
      } else if (tipo === 3) c.recibidos++;
    });

    ws.on("message", (datos) => {
      if (remoto.destroyed) return;
      c.bytesTx += datos.length; c.ultimo = Date.now();
      try { delPortal(datos); } catch (e) { /* solo es para contar */ }
      remoto.write(datos);
    });
    remoto.on("data", (datos) => {
      c.bytesRx += datos.length; c.ultimo = Date.now();
      try { delServidor(datos); } catch (e) { /* solo es para contar */ }
      if (ws.readyState === 1) ws.send(datos, { binary: true });
    });
    let motivoCierre = null;
    remoto.on("error", (e) => { if (!motivoCierre) motivoCierre = errorEnCastellano(e, d); });
    const cerrar = (quien) => {
      if (!abiertas.has(ws)) return;
      abiertas.delete(ws);
      try { remoto.destroy(); } catch (e) { /* nada */ }
      try { ws.terminate(); } catch (e) { /* nada */ }
      /* si cortó el servidor (no el portal), queda anotado para poder explicarlo */
      if (quien === "servidor" && c.mqtt !== "rechazado")
        anotarError(d, motivoCierre || "El servidor «" + d.host + "» cerró la conexión" + (c.mqtt === "conectado" ? " después de " + duracion(Date.now() - c.desde) : ""));
      registro("cerrado " + d.host + ":" + d.port + " (" + quien + ")");
      avisar();
    };
    ws.on("close", () => cerrar("portal")); ws.on("error", () => cerrar("portal"));
    remoto.on("close", () => cerrar("servidor"));
  }

  function estadoDetallado() {
    const conexiones = [...abiertas.values()].map((x) => ({ ...x })).sort((a, b) => a.desde - b.desde);
    return {
      puente: "aplicación de Windows", puerto: PUERTO_LOCAL, activo: estado.activo, error: estado.error, desde: estado.desde,
      ahora: Date.now(), total: estado.total, conectados: conexiones.filter((x) => x.mqtt === "conectado").length,
      conexiones, errores: errores.slice(),
    };
  }

  function abrir() {
    if (servidor) return Promise.resolve({ ok: true });
    return new Promise((res) => {
      const s = http.createServer((req, resp) => {
        const origen = req.headers.origin;
        if ((req.url || "").split("?")[0] === "/estado") {
          /* el estado dice a qué servidores se conecta el portal: no se le muestra a una página web */
          if (!origenOk(origen)) { resp.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }); return resp.end("Solo el portal puede ver el estado"); }
          resp.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": origen || "null", "Cache-Control": "no-store" });
          return resp.end(JSON.stringify(estadoDetallado()));
        }
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
        servidor = null; avisar();
        res({ ok: false, error: estado.error });
      });
      s.listen(PUERTO_LOCAL, "127.0.0.1", () => {
        servidor = s; estado.activo = true; estado.error = ""; estado.desde = Date.now();
        registro("puente MQTT escuchando en 127.0.0.1:" + PUERTO_LOCAL);
        avisar();
        res({ ok: true });
      });
    });
  }

  function cerrar() {
    for (const ws of abiertas.keys()) { try { ws.terminate(); } catch (e) { /* nada */ } }
    abiertas.clear();
    if (servidor) { try { servidor.close(); } catch (e) { /* nada */ } }
    servidor = null; estado.activo = false;
  }

  return {
    abrir, cerrar, estadoDetallado,
    /* resumen corto, para la bandeja y el registro */
    estado: () => { const d = estadoDetallado(); return { activo: d.activo, error: d.error, conexiones: d.conexiones.length, conectados: d.conectados, total: d.total }; },
  };
}

module.exports = { crearPuente, ruta, origenOk, lectorMqtt, errorEnCastellano, duracion, PUERTOS_MQTT, PUERTO_LOCAL };
