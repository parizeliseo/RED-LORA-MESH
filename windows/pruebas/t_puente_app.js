/*
 * El estado del puente integrado, en la aplicación: chip del portal, ícono, tooltip y menú de la
 * bandeja, panel abierto desde la bandeja y avisos de Windows cuando se corta con la ventana oculta.
 * Necesita Mosquitto en 127.0.0.1:1883 (ver t_puente_estado.js). Uso: xvfb-run -a node pruebas/t_puente_app.js
 */
const { _electron: electron } = require("/opt/npm-tools/node_modules/playwright");
const path = require("path"); const fs = require("fs"); const os = require("os"); const { execSync, spawn } = require("child_process");
const MOSQ = process.env.MOSQ || "mosquitto-prueba"; /* carpeta con m.conf (ver t_puente_estado.js) */
let fallas = 0;
const chequeo = (n, c, d) => { if (!c) fallas++; console.log((c ? "✓ " : "✗ ") + n + (d !== undefined ? " · " + (typeof d === "string" ? d : JSON.stringify(d)) : "")); };
const mosq = (on) => { if (on) spawn("sh", ["-c", "cd " + MOSQ + " && exec mosquitto -c m.conf >> mosq.log 2>&1"], { detached: true, stdio: "ignore" }).unref(); else execSync("for p in $(ss -ltnp | grep ':1883 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done"); };
const CFG = { v: 3, enabled: true, probeOn: false, servers: [{ host: "mqtt.meshtastic.org", port: 8883, tls: true, enabled: false },
  { name: "Mosquitto de prueba", host: "127.0.0.1", port: 1883, tls: false, url: "", enabled: true }, { enabled: false }, { enabled: false }, { enabled: false }, { enabled: false }] };
(async () => {
  const raiz = path.join(__dirname, ".."); const env = { ...process.env }; delete env.NODE_OPTIONS;
  const app = await electron.launch({ executablePath: path.join(raiz, "node_modules/electron/dist/electron"),
    args: [raiz, "--no-sandbox", "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "pz-pa-"))], env, timeout: 60000 });
  const win = await app.firstWindow(); const errores = []; win.on("pageerror", (e) => errores.push(String(e).slice(0, 160)));
  await app.evaluate(({ BrowserWindow, Notification }) => {
    BrowserWindow.getAllWindows()[0].setSize(1366, 860);
    global.__avisos = []; Notification.isSupported = () => true; /* en Linux sin servicio de avisos daría falso */
    Notification.prototype.show = function () { global.__avisos.push(this.title + " | " + this.body); };
  });
  await win.waitForTimeout(2000);
  const b0 = await app.evaluate(() => global.__pruebas.bandeja());
  /* con la configuración de fábrica el portal prueba los servidores públicos: si no los alcanza, el ícono ya muestra el problema */
  chequeo("al abrir: menú del puente sin conexiones", b0.menu.some((l) => /Puente MQTT: listo|Último problema/.test(l)), { icono: b0.nivelBandeja || "normal", menu: b0.menu.filter((l) => /Puente|problema/.test(l)) });
  await win.evaluate((c) => { localStorage.setItem("meshportal:net", JSON.stringify(c)); localStorage.setItem("meshportal:theme", "dark"); }, CFG);
  await win.reload(); await win.waitForTimeout(1000); await win.evaluate(() => window.__ui.startDemo());
  await win.waitForFunction(() => /Puente: conectado/.test((document.querySelector(".bridgechip") || {}).innerText || ""), null, { timeout: 40000 });
  chequeo("chip del portal: conectado", true);
  await win.waitForTimeout(800);
  const b1 = await app.evaluate(() => global.__pruebas.bandeja());
  chequeo("ícono de la bandeja en verde", b1.nivelBandeja === "ok", b1.nivelBandeja);
  chequeo("punto verde en la barra de tareas (solo Windows)", process.platform !== "win32" || b1.nivelBarra === "ok", process.platform === "win32" ? b1.nivelBarra : "no es Windows: no aplica");
  chequeo("tooltip de la bandeja", /MQTT conectado a 127\.0\.0\.1 por el puente/.test(b1.tooltip), b1.tooltip.replace(/\n/g, " | "));
  chequeo("menú de la bandeja con cada servidor", b1.menu.some((l) => /🟢 127\.0\.0\.1:1883 — hace/.test(l)) && b1.menu.some((l) => /1 de 1 conectados/.test(l)), b1.menu.filter((l) => /Puente|127/.test(l)));
  /* "Ver el estado del puente…" de la bandeja abre el panel */
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("evento", "puente-panel"));
  await win.waitForSelector(".puentebox", { timeout: 5000 });
  const tp = await win.innerText(".puentebox");
  chequeo("la bandeja abre el panel del puente", /Integrado en la aplicación/.test(tp) && /Conectado a 1 servidor/.test(tp));
  await win.screenshot({ path: path.join(__dirname, "puente_panel_app.png") });
  await win.keyboard.press("Escape");
  /* se corta con la ventana oculta: aviso de Windows */
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  mosq(false); await win.waitForTimeout(3000);
  const b2 = await app.evaluate(() => ({ ...global.__pruebas.bandeja(), avisos: global.__avisos }));
  chequeo("al cortarse: ícono en rojo o ámbar", b2.nivelBandeja === "error" || b2.nivelBandeja === "espera", b2.nivelBandeja);
  chequeo("al cortarse con la ventana oculta: aviso de Windows", b2.avisos.some((a) => /Se cortó la conexión MQTT/.test(a)), b2.avisos);
  mosq(true);
  let b3 = null;
  for (let i = 0; i < 60; i++) { await win.waitForTimeout(1500); b3 = await app.evaluate(() => ({ ...global.__pruebas.bandeja(), avisos: global.__avisos })); if (b3.nivelBandeja === "ok") break; }
  chequeo("la bandeja y los avisos no muestran el nombre prohibido", !/meshtastic/i.test(JSON.stringify([b0, b1, b2])), b0.menu.filter((l) => /oficial/.test(l)));
  chequeo("vuelve solo: ícono verde otra vez", b3.nivelBandeja === "ok", b3.nivelBandeja);
  chequeo("aviso de que volvió", b3.avisos.some((a) => /MQTT conectado de nuevo/.test(a)), b3.avisos);
  chequeo("sin errores de JavaScript", errores.length === 0, errores);
  console.log("\n" + (fallas ? fallas + " FALLAS" : "TODO BIEN"));
  await app.evaluate(({ app }) => app.exit(0)); process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
