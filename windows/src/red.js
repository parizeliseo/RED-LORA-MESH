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
 *   redes()                          -> redes IPv4 de esta PC con el rango a revisar (solo Windows)
 *   vecinos()                        -> tabla ARP: IP, MAC y fabricante de la placa (solo Windows)
 */
const net = require("net");
const http = require("http");
const https = require("https");
const os = require("os");
const AGENTE = "OPEN-SOURCE-PARIZ/" + (() => { try { return require("../package.json").version; } catch (e) { return "?"; } })() + " (Windows; +https://github.com/parizeliseo/RED-LORA-MESH)";
const fs = require("fs");
const dgram = require("dgram");
const { execFile } = require("child_process");

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
      /* el nodo habla protobuf; el resto (teselas del mapa) son imágenes. OpenStreetMap exige que la
         aplicación se identifique: sin esto responde con un cartel de "Access blocked". */
      headers: { Accept: u.pathname.startsWith("/api/") ? "application/x-protobuf" : "image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5", "User-Agent": AGENTE },
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

/* ───────────── redes de esta PC y vecinos, para que la búsqueda de nodos no tenga que adivinar ───────────── */

/* Adaptadores que no llevan al nodo: máquinas virtuales, VPN, Bluetooth, contenedores */
const VIRTUAL = /virtualbox|vbox|vmware|vmnet|vethernet|hyper-v|default switch|wsl|docker|podman|tailscale|zerotier|hamachi|wireguard|nordlynx|openvpn|tap-|\btun|utun|npcap|loopback|bluetooth|radmin|virbr|veth|br-[0-9a-f]|anyconnect|fortinet|globalprotect|pangp/i;
/* …y por la placa de red virtual que inventan (VirtualBox, VMware, Hyper-V, Parallels, QEMU, Docker) */
const MAC_VIRTUAL = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|00:1c:42|52:54:00|02:42:)/i;
const tipoDe = (nombre) => (/wi-?fi|wlan|wireless|inal[aá]mbric|^wl/i.test(nombre) ? "WiFi" : /ethernet|^eth|^en[op]?\d|^en\d|lan|área local|area local|cable/i.test(nombre) ? "Cable" : "Red");
const aNum = (ip) => ip.split(".").reduce((a, n) => a * 256 + (+n), 0);
const aIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/* IP con la que esta PC sale a Internet. connect() en UDP solo consulta la tabla de rutas del
   sistema: no manda ningún paquete. Sin ruta (PC sin Internet) devuelve null. */
function ipDeSalida() {
  return new Promise((res) => {
    const s = dgram.createSocket("udp4");
    const fin = (v) => { try { s.close(); } catch (e) { /* ya cerrado */ } res(v); };
    const t = setTimeout(() => fin(null), 1000);
    s.on("error", () => { clearTimeout(t); fin(null); });
    try { s.connect(53, "8.8.8.8", () => { clearTimeout(t); let a = null; try { a = s.address().address; } catch (e) { /* sin ruta */ } fin(a); }); } catch (e) { clearTimeout(t); fin(null); }
  });
}

/* Rango a revisar de una red. Hasta /22 (1022 direcciones) se revisa entera; si es más grande
   (una /16 son 65.000 direcciones) se revisa solo el tramo /24 de esta PC. Se devuelve en tramos
   de a /24 con el formato que entiende el portal: 192.168.1.1-254. */
function rangoDe(ip, prefijo) {
  const recortada = prefijo < 22, p = recortada ? 24 : Math.min(prefijo, 30);
  const tam = 2 ** (32 - p), red0 = Math.floor(aNum(ip) / tam) * tam;
  const desde = red0 + 1, hasta = red0 + tam - 2, tramos = [];
  for (let a = desde; a <= hasta; ) {
    const fin24 = Math.floor(a / 256) * 256 + 255, b = Math.min(hasta, fin24);
    const pa = aIp(a).split("."), pb = aIp(b).split(".");
    tramos.push(pa.slice(0, 3).join(".") + "." + pa[3] + "-" + pb[3]);
    a = b + 1;
  }
  return { tramos, direcciones: hasta - desde + 1, red: aIp(red0) + "/" + p, recortada };
}

/** Las redes IPv4 de esta PC, la que sale a Internet primero y las virtuales al final. */
async function redesLocales() {
  const salida = await ipDeSalida(), out = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces() || {})) {
    for (const d of lista || []) {
      if (!(d.family === "IPv4" || d.family === 4) || d.internal || !d.address) continue;
      if (d.address.startsWith("169.254.")) continue; /* sin DHCP: Windows se puso una dirección sola */
      const prefijo = d.cidr ? +d.cidr.split("/")[1] : (d.netmask || "255.255.255.0").split(".").reduce((a, n) => a + ((+n).toString(2).match(/1/g) || []).length, 0);
      out.push({ nombre, tipo: tipoDe(nombre), ip: d.address, mascara: d.netmask, prefijo, virtual: VIRTUAL.test(nombre) || MAC_VIRTUAL.test(d.mac || ""), principal: d.address === salida, ...rangoDe(d.address, prefijo) });
    }
  }
  return out.sort((a, b) => (a.virtual - b.virtual) || (b.principal - a.principal) || (a.tipo === "WiFi" ? -1 : 0) - (b.tipo === "WiFi" ? -1 : 0));
}

/* Prefijos de fabricante (OUI) de Espressif, la marca del chip ESP32 que usan la Heltec V3,
   la T-Beam, la Station G2 y la mayoría de los nodos con WiFi. */
const ESPRESSIF = new Set([
  "18FE34 240AC4 246F28 2462AB 24A160 24B2DE 24D7EB 24DCC3 2C3AE8 2CF432 30AEA4 30C6F7 3C6105 3C71BF",
  "4022D8 409151 4827E2 483FDA 4C11AE 4CEBD6 500291 5443B2 58BF25 5CCF7F 600194 68C63A 70039F 70041D",
  "782184 7C87CE 7C9EBD 7CDFA1 807D3A 840D8E 84CCA8 84F3EB 84F703 8CAAB5 8CCE4E 9097D5 94B97E 98CDAC",
  "98F4AB A020A6 A0764E A4CF12 A4E57C A848FA AC67B2 ACD074 B0B21C B4E62D B8D61A BCDDC2 BCFF4D C049EF",
  "C45BBE C4DD57 C4DEE2 C82B96 C8C9A3 C8F09E CC50E3 CCDBA7 D8A01D D8BFC0 D8F15B DC4F22 DC5475 E09806",
  "E0E2E6 E868E7 E89F6D E8DB84 EC6260 EC94CB ECDA3B ECFABC F008D1 F09E9E F412FA F4CFA2 FCF5C4 348518",
  "34AB95 34B472 485519 48E729 543204 64E833 0CB815 0CDC7E 08B61F 083AF2 08D1F9 10521C 1091A8 349454",
  "3CE90E 441793 744DBD 90380C A842E3 B0A732 D48AFC E05A1B E465B8 F0F5BD 2CBCBB 3030F9 28372F 34865D",
  "48CA43 64B708"
].join(" ").split(" "));
const fabricante = (mac) => (ESPRESSIF.has(mac.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase()) ? "Espressif" : null);

/* La tabla de vecinos del sistema (ARP): quién respondió en la red local y con qué placa de red.
   Después de un barrido trae a todos los equipos vivos, aunque no tengan ningún puerto abierto. */
function tablaArp() {
  return new Promise((res) => {
    if (process.platform === "linux") { try { return res(fs.readFileSync("/proc/net/arp", "utf8")); } catch (e) { return res(""); } }
    execFile(process.platform === "win32" ? "arp.exe" : "arp", process.platform === "win32" ? ["-a"] : ["-an"], { windowsHide: true, timeout: 5000 }, (err, so) => res(err ? "" : String(so || "")));
  });
}
async function vecinos() {
  const txt = await tablaArp(), out = new Map();
  for (const l of txt.split(/\r?\n/)) {
    const ip = (l.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || [])[1];
    let mac = (l.match(/\b([0-9a-f]{1,2}(?:[-:][0-9a-f]{1,2}){5})\b/i) || [])[1];
    if (!ip || !mac) continue;
    mac = mac.split(/[-:]/).map((x) => x.padStart(2, "0")).join(":").toLowerCase();
    if (mac === "ff:ff:ff:ff:ff:ff" || mac === "00:00:00:00:00:00" || mac.startsWith("01:00:5e")) continue;
    out.set(ip, { ip, mac, fabricante: fabricante(mac) });
  }
  return [...out.values()];
}

module.exports = { probe, pedir, privada, redesLocales, vecinos, rangoDe, fabricante };
