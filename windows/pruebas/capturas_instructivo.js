/*
 * Capturas del instructivo de la aplicación de Windows: el programa real, en una ventana de
 * 1366 × 860 (una notebook común), tema oscuro de fábrica.
 * Necesita: la red de prueba de t_mired.js (br77 con el nodo en 10.77.0.57) y Mosquitto en
 * 10.77.0.10:1883. Uso: xvfb-run -a node pruebas/capturas_instructivo.js <carpeta-de-salida>
 */
let pw; try { pw = require("playwright-core"); } catch (e) { pw = require("/opt/npm-tools/node_modules/playwright"); }
const electron = pw._electron;
const path = require("path"); const fs = require("fs"); const os = require("os");
const SAL = process.argv[2] || path.join(__dirname, "capturas");
fs.mkdirSync(SAL, { recursive: true });

const MQTT = { v: 3, enabled: true, probeOn: false, uplink: true, downlink: true, servers: [
  { host: "mqtt.meshtastic.org", port: 8883, tls: true, enabled: false },
  { name: "Servidor de la red local", host: "10.77.0.10", port: 1883, tls: false, url: "", enabled: true },
  { enabled: false }, { enabled: false }, { enabled: false }, { enabled: false }] };

(async () => {
  const raiz = path.join(__dirname, ".."); const env = { ...process.env, LANG: "es_AR.UTF-8", LANGUAGE: "es_AR:es" }; delete env.NODE_OPTIONS;
  const app = await electron.launch({ executablePath: path.join(raiz, "node_modules/electron/dist/electron"),
    args: [raiz, "--no-sandbox", "--lang=es-AR", "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "pz-cap-"))], env, timeout: 60000 });
  const win = await app.firstWindow();
  const errores = []; win.on("pageerror", (e) => errores.push(String(e).slice(0, 160)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 860));
  const espera = (ms) => win.waitForTimeout(ms);
  const foto = async (n) => { await win.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove())); await win.screenshot({ path: path.join(SAL, n + ".png") }); console.log("✓", n); };
  const enviar = (canal, ...a) => app.evaluate(({ BrowserWindow }, [c, args]) => BrowserWindow.getAllWindows()[0].webContents.send(c, ...args), [canal, a]);
  const boton = (re) => win.evaluate((s) => { const b = [...document.querySelectorAll("button")].find((x) => new RegExp(s).test(x.innerText)); if (b) b.click(); return !!b; }, re);
  const vista = (v, sub) => win.evaluate(([a, b]) => window.__ui.setView(a, b), [v, sub || null]);
  await espera(1500);
  /* servidor MQTT de prueba desde el arranque, así el chip del puente no muestra los errores de DNS del entorno */
  await win.evaluate((c) => { localStorage.setItem("meshportal:net", JSON.stringify(c)); }, MQTT);
  await win.reload(); await espera(1000);
  await app.evaluate(() => global.__pruebas.limpiarPuente());
  await win.waitForFunction(() => /Puente: conectado/.test((document.querySelector(".bridgechip") || {}).innerText || ""), null, { timeout: 30000 }).catch(() => console.log("  (inicio: el puente no llegó a conectar)"));
  await espera(1500);

  /* 1) pantalla inicial */
  await foto("w01_inicio");

  /* 2) conectar por red: búsqueda en la red de la PC */
  await boton("^Red \\(WiFi / LAN\\)$"); await espera(1200);
  await win.evaluate(() => { const it = [...document.querySelectorAll(".mired-it")].find((x) => /10\.77\.0\.10/.test(x.innerText)); if (it) it.querySelector("button").click(); });
  await win.waitForFunction(() => /Se revisaron/.test((document.querySelector(".scanbox .scantxt") || {}).innerText || ""), null, { timeout: 60000 });
  await win.evaluate(() => document.querySelector(".scanbox .blkh").scrollIntoView({ block: "start" })); await espera(400);
  await foto("w03_buscar_red");
  await win.evaluate(() => document.querySelector(".modal .mbox").scrollTop = 0); await espera(300);
  await foto("w02_conectar_red");
  await win.keyboard.press("Escape"); await espera(400);

  /* 3) selectores propios de USB, Bluetooth y PIN */
  await enviar("elegir:puerto", 9101, [
    { portId: "1", portName: "COM3", displayName: "Puerto de comunicaciones (COM3)", vendorId: "", productId: "" },
    { portId: "2", portName: "COM7", displayName: "Silicon Labs CP210x USB to UART Bridge (COM7)", vendorId: "10c4", productId: "ea60" }]);
  await espera(700); await foto("w04_usb"); await win.keyboard.press("Escape"); await espera(400);
  await enviar("elegir:bt", 9102, [{ deviceId: "AA:BB:CC:11:22:33", deviceName: "Nodo base 3a1f" }, { deviceId: "AA:BB:CC:44:55:66", deviceName: "Repetidor cerro" }]);
  await espera(700); await foto("w05_bluetooth"); await win.keyboard.press("Escape"); await espera(400);
  await enviar("elegir:pin", 9103, { pairingKind: "providePin", pin: "" });
  await espera(700); await foto("w06_pin"); await win.keyboard.press("Escape"); await espera(400);

  /* 4) con el servidor MQTT de prueba y el modo demo */
  await win.evaluate(() => window.__ui.startDemo());
  await app.evaluate(() => global.__pruebas.limpiarPuente());
  await win.waitForFunction(() => /Puente: conectado/.test((document.querySelector(".bridgechip") || {}).innerText || ""), null, { timeout: 60000 }).catch(() => console.log("  (el puente no llegó a conectar)"));
  await espera(1500);

  await vista("messages"); await espera(900); await foto("w07_mensajes");
  await boton("^Programar mensaje$"); await espera(800); await foto("w08_programar"); await win.keyboard.press("Escape"); await espera(400);
  await win.evaluate(() => document.querySelector(".panicchip").click()); await espera(900); await foto("w09_emergencias"); await win.keyboard.press("Escape"); await espera(400);
  await vista("emerg"); await espera(800); await foto("w10_parametros_emergencia");
  await vista("nodes"); await espera(900); await foto("w11_nodos");
  const otro = await win.evaluate(() => [...window.__mesh.nodes.keys()].find((k) => k !== window.__mesh.me));
  await win.evaluate((n) => window.__ns.openNodeSheet(n), otro); await espera(900); await foto("w12_ficha_nodo");
  await win.evaluate(() => window.__ns.closeNodeSheet()); await espera(300);
  await win.evaluate(() => { window.__mesh.map.L.base = ""; window.__mesh.map.fitted = false; window.__ui.setView("map"); }); await espera(1800); await foto("w13_mapa");
  await vista("topo"); await espera(1800); await foto("w14_topologia");
  await vista("tele"); await espera(900); await foto("w15_telemetria");
  await boton("^Detalle por nodo$"); await espera(1200); await foto("w16_telemetria_detalle");
  await vista("guardia"); await espera(900); await foto("w17_guardia");
  await boton("Parte de situación"); await espera(900); await foto("w18_parte"); await win.keyboard.press("Escape"); await espera(400);
  await vista("settings", "portal.net"); await espera(1200); await foto("w19_mqtt");
  await win.evaluate(() => document.querySelector(".bridgechip").click()); await espera(2500); await foto("w20_puente"); await win.keyboard.press("Escape"); await espera(400);
  await vista("settings", "portal.copia"); await espera(900); await foto("w21_copia");
  await vista("settings", "portal.snd"); await espera(900); await foto("w22_sonidos");
  await vista("settings", "portal.ops"); await espera(900); await foto("w23_modo_operativo");
  await vista("settings", "sys"); await espera(900); await foto("w24_administracion");
  await vista("radio", "radio.lora"); await espera(900); await foto("w25_radio");
  await vista("radio", "radio.channels"); await espera(900); await foto("w26_canales");
  await vista("module", "mod.mqtt"); await espera(900); await foto("w27_modulo_mqtt");

  console.log(errores.length ? "errores: " + JSON.stringify(errores) : "sin errores de JavaScript");
  await app.evaluate(({ app }) => app.exit(0));
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
