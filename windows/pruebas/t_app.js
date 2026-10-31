/* Prueba completa de la aplicación de escritorio: el portal adentro del programa, haciendo cada
   cosa que el programa le agrega. Uso: xvfb-run -a node pruebas/t_app.js */
const { _electron: electron } = require("/opt/npm-tools/node_modules/playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ok = (b) => (b ? "✓" : "✗");
let fallas = 0;
const chequeo = (nombre, cond, detalle) => { if (!cond) fallas++; console.log(ok(cond) + " " + nombre + (detalle !== undefined ? " · " + (typeof detalle === "string" ? detalle : JSON.stringify(detalle)) : "")); };

(async () => {
  const raiz = path.join(__dirname, "..");
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), "pariz-prueba-"));
  const app = await electron.launch({
    executablePath: path.join(raiz, "node_modules/electron/dist/electron"),
    args: [raiz, "--no-sandbox", "--user-data-dir=" + datos], env, timeout: 60000,
  });
  const errores = [];
  const win = await app.firstWindow();
  win.on("pageerror", (e) => errores.push(String(e).slice(0, 160)));
  await win.waitForTimeout(3000);

  /* 1) red nativa: conectar al nodo por red sin CORS */
  const con = await win.evaluate(async () => {
    try { await window.__conn.connectNet("127.0.0.1:8111", false, "Nodo por red"); } catch (e) { return "ERR " + e.message; }
    await new Promise((r) => setTimeout(r, 5000));
    const S = window.__mesh, m = S.nodes.get(S.me);
    return { conectado: !!S.device, nodo: m && m.user ? m.user.longName : null, nodos: S.nodes.size };
  });
  chequeo("conectar por red (WiFi) con la red del programa", con && con.conectado && con.nodo, con);

  /* 2) escaneo: con la red del programa se habla también con el nodo que el navegador bloquea (8102) */
  const esc = await win.evaluate(async () => {
    const ports = [8111, 8101, 8102, 8103, 8104, 8199].map((p) => ({ port: p, tls: false }));
    const t0 = Date.now();
    const r = await window.__net.scanNetwork(["127.0.0.1"], ports, () => {}, null);
    return { nodos: r.nodes.map((x) => x.port).sort(), otros: r.otros.map((x) => x.port + " " + x.why), seg: Math.round((Date.now() - t0) / 100) / 10 };
  });
  chequeo("buscar nodos en la red", esc.nodos.includes(8111) && esc.nodos.includes(8101) && esc.nodos.includes(8103), esc);
  chequeo("el nodo sin permiso CORS (8102) ya no queda afuera", esc.nodos.includes(8102), esc.nodos);

  /* 3) MQTT por el puente integrado hacia un servidor que solo atiende TCP (como el oficial) */
  const mq = await win.evaluate(async () => {
    const S = window.__mesh, c = S.mq.cfg;
    c.enabled = true;
    c.servers.forEach((s) => { s.enabled = false; });
    c.servers[2] = { ...c.servers[2], name: "Servidor TCP local", host: "127.0.0.1", port: 1883, tls: false, url: "", user: "", pass: "", enabled: true };
    localStorage.setItem("meshportal:net", JSON.stringify(c));
    location.reload();
    return true;
  });
  await win.waitForTimeout(9000);
  const mq2 = await win.evaluate(() => { const r = window.__mesh.mq.srv[2]; return { estado: r.st, via: r.client && r.client.url, error: r.err }; });
  chequeo("MQTT hacia un servidor solo-TCP a través del puente integrado", mq2.estado === "on" && /localhost:9001|127\.0\.0\.1:9001/.test(mq2.via || ""), mq2);

  /* 4) eventos del programa hacia el portal: menú «Ir a», bandeja, avisos tocados */
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("evento", "ir", "map"));
  await win.waitForTimeout(700);
  chequeo("menú Ir a → Mapa", (await win.evaluate(() => window.__mesh.view)) === "map");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("evento", "parte"));
  await win.waitForTimeout(700);
  chequeo("bandeja → Parte de situación", await win.evaluate(() => !!document.querySelector(".partebox")));
  await win.keyboard.press("Escape"); await win.waitForTimeout(300);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("evento", "emergencia"));
  await win.waitForTimeout(700);
  chequeo("bandeja → Emergencias", await win.evaluate(() => /EMERGENCIA|Emergencia|emergencia/.test((document.querySelector("body > .modal") || {}).innerText || "")));
  await win.keyboard.press("Escape"); await win.waitForTimeout(300);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("evento", "abrir-conv", "ch0"));
  await win.waitForTimeout(700);
  chequeo("aviso tocado → abre la conversación", await win.evaluate(() => window.__mesh.view === "messages" && window.__mesh.conv === "ch0"));

  /* 5) sin leer en el título de la ventana */
  /* llegan 3 mensajes a otro canal mientras se mira el canal 0 */
  await win.evaluate(() => { window.__mesh.conv = "ch0"; window.__mesh.unread.ch1 = 3; window.__ui.setView("messages"); });
  await win.waitForTimeout(600);
  const titulo = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  chequeo("mensajes sin leer en el título", titulo === "(3) OPEN SOURCE PARIZ", titulo);
  /* se abre ese canal: quedan leídos y el título vuelve */
  await win.evaluate(() => { window.__mesh.conv = "ch1"; window.__ui.setView("messages"); });
  await win.waitForTimeout(600);
  const titulo2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  chequeo("al leerlos el título vuelve", titulo2 === "OPEN SOURCE PARIZ", titulo2);

  /* 6) aviso de Windows: no debe romper nada (en Linux de prueba no se ve) */
  const aviso = await win.evaluate(() => { try { window.__escritorio.aviso("alerta", "ch0", "🚨 ALERTA de prueba", "texto"); return "enviado"; } catch (e) { return "ERR " + e.message; } });
  chequeo("aviso de alerta", aviso === "enviado", aviso);

  /* 7) imprimir → guardar como PDF (se responde el diálogo automáticamente) */
  const pdf = path.join(datos, "prueba.pdf");
  await app.evaluate(({ dialog }, ruta) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: ruta });
  }, pdf);
  await app.evaluate(({ shell }) => { shell.showItemInFolder = () => {}; });
  await win.evaluate(() => window.__escritorio.imprimir("<!doctype html><title>Acta</title><h1>Libro de guardia</h1><p>Prueba de impresión con acentos: árbol, ñandú.</p>", "Acta de guardia"));
  const hayPdf = fs.existsSync(pdf) ? fs.readFileSync(pdf).slice(0, 5).toString() : "";
  chequeo("imprimir → guardar como PDF", hayPdf === "%PDF-", fs.existsSync(pdf) ? Math.round(fs.statSync(pdf).size / 1024) + " KB" : "no se creó");

  /* 8) selector de puerto USB: aparece, se puede cancelar y no deja nada colgado */
  const usb = win.evaluate(async () => { try { await navigator.serial.requestPort(); return "eligió"; } catch (e) { return e.name; } });
  await win.waitForTimeout(1200);
  const sel = await win.evaluate(() => { const m = document.querySelector("body > .modal"); return m ? m.innerText.split("\n").slice(0, 3).join(" | ") : null; });
  chequeo("selector de puerto USB aparece", sel && /puerto USB/.test(sel), sel);
  await win.keyboard.press("Escape");
  chequeo("cancelar el selector USB con Escape", (await usb) === "NotFoundError", await usb);

  /* 9) cerrar la ventana la deja en la bandeja (el programa sigue vivo) */
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(800);
  const tras = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { existe: !!w, visible: w ? w.isVisible() : null }; });
  chequeo("cerrar con la X → sigue en la bandeja", tras.existe && tras.visible === false, tras);

  /* 10) copia de seguridad dentro del programa */
  const copia = await win.evaluate(() => { const c = window.__copia.copiaArmar(); return { origen: c.origen, claves: c.claves }; });
  chequeo("copia de seguridad sabe que es la app de Windows", copia.origen === "aplicación de Windows", copia);

  chequeo("sin errores de JavaScript", errores.length === 0, errores);
  console.log("\n" + (fallas ? fallas + " FALLAS" : "TODO BIEN"));
  await app.evaluate(({ app }) => app.exit(0));
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
