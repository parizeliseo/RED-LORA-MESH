/*
 * Prueba de humo del programa ya armado: lo abre, entra a la ventana y revisa que todo responda.
 * Está pensada para correr en Windows (la corre GitHub en cada cambio), pero también anda en Linux.
 *
 *   node pruebas/humo.js [ruta-al-ejecutable]
 *
 * Por defecto usa dist/win-unpacked/OPEN SOURCE PARIZ.exe en Windows. Los fusibles de seguridad
 * del programa bloquean el depurador de Node, así que se entra a la ventana por el protocolo de
 * depuración de Chromium (--remote-debugging-port), que es independiente.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const http = require("http");
let pw; try { pw = require("playwright-core"); } catch (e) { pw = require("/opt/npm-tools/node_modules/playwright"); }
const WebSocket = require("ws");

const RAIZ = path.join(__dirname, "..");
const EXE = process.argv[2] || process.env.EJECUTABLE || path.join(RAIZ, "dist", "win-unpacked", "OPEN SOURCE PARIZ.exe");
const PUERTO_DEP = 9333;
let fallas = 0;
const chequeo = (n, c, d) => { if (!c) fallas++; console.log((c ? "✓ " : "✗ ") + n + (d !== undefined ? " · " + (typeof d === "string" ? d : JSON.stringify(d)) : "")); };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const pedir = (url) => new Promise((res) => { http.get(url, (r) => { let t = ""; r.on("data", (d) => (t += d)); r.on("end", () => res({ status: r.statusCode, texto: t })); }).on("error", (e) => res({ status: 0, texto: e.message })); });
const wsCon = (url, origen) => new Promise((res) => {
  const w = new WebSocket(url, ["mqtt"], { headers: origen ? { Origin: origen } : {} });
  const fin = (r) => { try { w.terminate(); } catch (e) {} res(r); };
  w.on("unexpected-response", (_q, r) => fin(r.statusCode)); w.on("open", () => fin(101)); w.on("error", (e) => fin(e.message)); setTimeout(() => fin("tiempo"), 8000);
});

(async () => {
  console.log("programa:", EXE);
  chequeo("el ejecutable existe", fs.existsSync(EXE));
  if (!fs.existsSync(EXE)) process.exit(1);

  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "pariz-humo-"));
  const args = ["--remote-debugging-port=" + PUERTO_DEP, "--user-data-dir=" + datos];
  if (process.platform === "linux") args.push("--no-sandbox");
  const proc = spawn(EXE, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "--inspect=9229" } });
  let salida = ""; proc.stdout.on("data", (d) => (salida += d)); proc.stderr.on("data", (d) => (salida += d));
  const cerrar = () => {
    try { if (process.platform === "win32") execSync("taskkill /pid " + proc.pid + " /T /F", { stdio: "ignore" }); else proc.kill("SIGKILL"); } catch (e) { /* ya cerrado */ }
  };

  let nav = null;
  for (let i = 0; i < 60 && !nav; i++) { await esperar(500); try { nav = await pw.chromium.connectOverCDP("http://127.0.0.1:" + PUERTO_DEP); } catch (e) { /* todavía no */ } }
  chequeo("el programa abre su ventana", !!nav);
  if (!nav) { console.log(salida.slice(-2000)); cerrar(); process.exit(1); }
  let pg = null;
  for (let i = 0; i < 20 && !pg; i++) { pg = nav.contexts()[0].pages().find((p) => /index\.html$/.test(p.url())); if (!pg) await esperar(500); }
  chequeo("carga el portal desde adentro del paquete", !!pg && /app\.asar/.test(pg.url()), pg && pg.url().replace(/^.*resources/, "…resources"));
  const errores = []; pg.on("pageerror", (e) => errores.push(String(e).slice(0, 180)));
  await esperar(3500);

  const r = await pg.evaluate(() => ({
    escritorio: !!window.__escritorio, red: !!window.__nativeNet, serie: "serial" in navigator, bluetooth: !!navigator.bluetooth,
    version: (document.body.innerText.match(/Portal:\s*[\d.]+[^\n]*/) || [""])[0].replace(/\s+/g, " "),
    puente: !!(window.__mesh && window.__mesh.bridge && window.__mesh.bridge.up),
  }));
  chequeo("el portal reconoce la aplicación de Windows", r.escritorio && r.red && /Windows/.test(r.version), r.version);
  chequeo("USB y Bluetooth disponibles", r.serie && r.bluetooth);
  const info = await pg.evaluate(() => window.__escritorio.version());
  chequeo("datos del programa", !!info.version, info.version + " · Electron " + info.electron + " · " + info.sistema);

  /* puente MQTT integrado */
  const p1 = await pedir("http://127.0.0.1:9001/");
  chequeo("el puente MQTT escucha en 127.0.0.1:9001", p1.status === 200 && /Puente MQTT/.test(p1.texto), p1.status + " " + p1.texto);
  chequeo("el portal ve el puente activo", r.puente);
  chequeo("el puente rechaza páginas de Internet", (await wsCon("ws://127.0.0.1:9001/broker.hivemq.com/1883/tcp", "https://pagina-cualquiera.com")) === 403);
  chequeo("el puente rechaza puertos que no son MQTT", (await wsCon("ws://127.0.0.1:9001/127.0.0.1/80/tcp", "file://")) === 403);

  /* red del programa */
  const red = await pg.evaluate(async () => ({ abierto: await window.__nativeNet.probe("127.0.0.1", 9001, 1500), cerrado: await window.__nativeNet.probe("127.0.0.1", 9, 1500) }));
  chequeo("la red del programa prueba puertos de verdad", red.abierto.ok === true && red.cerrado.ok === false, red);

  /* redes de la PC y tabla de vecinos: en Windows sale de os.networkInterfaces() y de arp.exe */
  const rd = await pg.evaluate(async () => ({ redes: await window.__nativeNet.redes(), vecinos: await window.__nativeNet.vecinos() }));
  const utiles = rd.redes.filter((x) => !x.virtual);
  chequeo("lee las redes de la PC", utiles.length > 0 && utiles.every((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x.ip) && x.tramos.length && x.direcciones > 0),
    rd.redes.map((x) => x.nombre + " " + x.ip + "/" + x.prefijo + " → " + x.tramos.join(",") + (x.virtual ? " (virtual)" : "") + (x.principal ? " (principal)" : "")));
  chequeo("lee la tabla de vecinos", Array.isArray(rd.vecinos) && rd.vecinos.every((v) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(v.mac)), rd.vecinos.length + " vecinos" + (rd.vecinos[0] ? " · ej. " + rd.vecinos[0].ip + " " + rd.vecinos[0].mac : ""));

  /* fusibles: aunque se pidió --inspect por NODE_OPTIONS, no debe haber depurador de Node */
  chequeo("los fusibles bloquean el depurador de Node", (await pedir("http://127.0.0.1:9229/json")).status === 0);

  /* todas las pantallas en modo demo */
  await pg.evaluate(() => window.__ui.startDemo()); await esperar(1500);
  const vistas = ["messages", "nodes", "map", "topo", "tele", "guardia", "settings", "console", "emerg"], malas = [];
  for (const v of vistas) {
    await pg.evaluate((x) => window.__ui.setView(x), v); await esperar(600);
    const t = await pg.evaluate(() => { const h = document.querySelector("#main h2, #main h1"); return h ? h.innerText : ""; });
    if (!t) malas.push(v);
  }
  chequeo("las nueve pantallas se dibujan", malas.length === 0, malas.length ? malas : vistas.length + " pantallas");
  await pg.evaluate(() => window.__ui.setView("settings", "portal.copia")); await esperar(500);
  chequeo("copia de seguridad del portal", await pg.evaluate(() => /Copia de seguridad del portal/.test(document.querySelector("#main").innerText)));
  await pg.evaluate(() => window.__ui.setView("guardia")); await esperar(500);
  await pg.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Parte de situación/.test(b.innerText)).click()); await esperar(500);
  chequeo("parte de situación", await pg.evaluate(() => /PARTE DE SITUACIÓN/.test((document.querySelector("textarea.parte") || {}).value || "")));
  await pg.keyboard.press("Escape"); await esperar(300);

  /* selector de puerto USB propio */
  await pg.evaluate(() => window.__ui.setView("messages")); await esperar(400);
  const usb = pg.evaluate(async () => { try { await navigator.serial.requestPort(); return "eligió"; } catch (e) { return e.name; } });
  await esperar(1500);
  const sel = await pg.evaluate(() => (document.querySelector("body > .modal") || {}).innerText || "");
  chequeo("selector de puerto USB", /puerto USB/.test(sel), sel.split("\n").filter(Boolean).slice(0, 2).join(" | "));
  await pg.keyboard.press("Escape");
  chequeo("cancelar el selector", (await usb) === "NotFoundError", await usb);

  await pg.evaluate(() => window.__ui.setView("map")); await esperar(1200);
  const captura = path.join(__dirname, "captura-" + process.platform + ".png");
  await pg.screenshot({ path: captura });
  console.log("captura:", captura);

  chequeo("sin errores de JavaScript", errores.length === 0, errores);
  console.log("\n" + (fallas ? fallas + " FALLAS" : "TODO BIEN"));
  await nav.close().catch(() => {});
  cerrar();
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
