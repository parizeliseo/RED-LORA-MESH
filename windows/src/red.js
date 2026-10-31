"use strict";
/*
 * Red hecha por el programa, no por la página.
 *
 * El portal, dentro de un navegador, tiene que pedirle permiso al nodo para hablarle (CORS) y no
 * puede probar si un puerto está abierto: solo adivina con consultas web. Acá los pedidos los hace
 * el propio programa, sin esas trabas. Es el mismo contrato que usa la app de Android:
 *
 *   probe(host, puerto, ms)          -> { ok: true } | { ok: false, err: "timeout" | "red" }
 *   http(url, método, cuerpo, ms)    -> { status, body: Uint8Array }  o error con .kind
 */
const net = require("net");
const http = require("http");
const https = require("https");

/** Direcciones de la red propia: solo ahí se acepta el certificado casero que trae el nodo. */
function privada(host) {
  host = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true;
  const m = host.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return host.endsWith(".local") || !host.includes(".");
}

/** ¿Hay algo escuchando en ese puerto? Conexión TCP de verdad, con tope de tiempo. */
function probe(host, port, ms) {
  return new Promise((res) => {
    const s = new net.Socket();
    let hecho = false;
    const fin = (r) => { if (hecho) return; hecho = true; s.destroy(); res(r); };
    s.setTimeout(Math.max(200, ms | 0 || 1500));
    s.once("connect", () => fin({ ok: true }));
    s.once("timeout", () => fin({ ok: false, err: "timeout" }));
    s.once("error", (e) => fin({ ok: false, err: e && e.code === "ETIMEDOUT" ? "timeout" : "red" }));
    try { s.connect(+port, String(host)); } catch (e) { fin({ ok: false, err: "red" }); }
  });
}

/** Pedido HTTP completo. Lanza un error con .kind = "timeout" | "red" si no se puede. */
function pedir(url, metodo, cuerpo, ms) {
  return new Promise((res, rej) => {
    let u;
    try { u = new URL(url); } catch (e) { const x = new Error("dirección inválida"); x.kind = "red"; return rej(x); }
    if (u.protocol !== "http:" && u.protocol !== "https:") { const x = new Error("solo http o https"); x.kind = "red"; return rej(x); }
    const mod = u.protocol === "https:" ? https : http;
    const datos = cuerpo && cuerpo.length ? Buffer.from(cuerpo) : null;
    const op = {
      method: metodo || "GET",
      headers: { Accept: "application/x-protobuf" },
      timeout: Math.max(200, ms | 0 || 5000),
    };
    if (datos) { op.headers["Content-Type"] = "application/x-protobuf"; op.headers["Content-Length"] = datos.length; }
    if (u.protocol === "https:" && privada(u.hostname)) op.rejectUnauthorized = false; /* certificado propio del nodo */
    const req = mod.request(u, op, (r) => {
      const trozos = []; let total = 0;
      r.on("data", (c) => { total += c.length; if (total <= 4 * 1024 * 1024) trozos.push(c); });
      r.on("end", () => res({ status: r.statusCode, body: new Uint8Array(Buffer.concat(trozos)) }));
      r.on("error", (e) => { const x = new Error(e.message); x.kind = "red"; rej(x); });
    });
    req.on("timeout", () => { req.destroy(); const x = new Error("se agotó el tiempo de espera"); x.kind = "timeout"; rej(x); });
    req.on("error", (e) => { if (e.kind) return rej(e); const x = new Error(e.message || "error de red"); x.kind = e.code === "ETIMEDOUT" ? "timeout" : "red"; rej(x); });
    if (datos) req.write(datos);
    req.end();
  });
}

module.exports = { probe, pedir, privada };
