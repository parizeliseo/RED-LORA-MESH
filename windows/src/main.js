"use strict";
/*
 * OPEN SOURCE PARIZ para Windows.
 *
 * Es el mismo portal, pero como programa propio: su ventana, su ícono en el menú Inicio y en la
 * barra de tareas, y su lugar en la bandeja del sistema para seguir recibiendo mensajes con la
 * ventana cerrada. Lo que en el navegador tenía trabas, acá lo resuelve el programa:
 *
 *  - USB y Bluetooth sin depender de qué navegador uses, con su propio selector y el PIN.
 *  - Red hacia el nodo sin el permiso CORS: el escaneo prueba los puertos de verdad.
 *  - Puente MQTT incluido: ya no hace falta instalar Python.
 *  - Avisos de Windows que traen la ventana al tocarlos; las alertas hacen parpadear el ícono.
 *  - Imprimir o guardar en PDF directo.
 */
const { app, BrowserWindow, Menu, Tray, Notification, ipcMain, shell, dialog, session, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const red = require("./red");
const { crearPuente } = require("./puente");

const NOMBRE = "OPEN SOURCE PARIZ";
const ID_APP = "ar.pariz.portal.escritorio";
const RAIZ = path.join(__dirname, "..");
const PORTAL = path.join(RAIZ, "app", "index.html");
const ICONO = path.join(RAIZ, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
const ICONO_BANDEJA = path.join(RAIZ, "build", process.platform === "win32" ? "tray.ico" : "tray.png");
const ICONO_AVISO = path.join(RAIZ, "build", "icon.png"); /* los avisos de Windows se ven mejor con PNG */

/* ── una sola copia abierta: si se abre otra, se muestra la que ya estaba ── */
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId(ID_APP); /* sin esto Windows no muestra los avisos con el nombre del programa */
app.commandLine.appendSwitch("enable-experimental-web-platform-features"); /* Bluetooth web completo */

let ventana = null, bandeja = null, saliendo = false, avisoBandejaDado = false;
const registro = [];
function log(t) { const l = new Date().toISOString().slice(11, 19) + " " + t; registro.push(l); if (registro.length > 500) registro.shift(); if (!app.isPackaged) console.log(l); }

/* ── preferencias propias del programa (no las del portal, que viven en el portal) ── */
const RUTA_PREF = () => path.join(app.getPath("userData"), "preferencias.json");
let pref = { aBandeja: true, ventana: null, maximizada: false };
function leerPref() { try { pref = { ...pref, ...JSON.parse(fs.readFileSync(RUTA_PREF(), "utf8")) }; } catch (e) { /* primera vez */ } }
function guardarPref() { try { fs.writeFileSync(RUTA_PREF(), JSON.stringify(pref, null, 1)); } catch (e) { /* sin permiso de escritura */ } }

/* ── puente MQTT ── */
const puente = crearPuente((t) => log("puente: " + t));

/* ── ventana ── */
function crearVentana() {
  const b = pref.ventana || {};
  ventana = new BrowserWindow({
    title: NOMBRE,
    icon: ICONO,
    width: b.width || 1400, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 900, minHeight: 600,
    backgroundColor: "#0a1324", /* el fondo del tema oscuro: sin destello blanco al abrir */
    show: false,
    autoHideMenuBar: true, /* el menú aparece con Alt; el portal ya tiene su propia navegación */
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, /* minimizada sigue recibiendo, reintentando y consultando el nodo */
      spellcheck: false,
    },
  });
  if (pref.maximizada) ventana.maximize();
  ventana.once("ready-to-show", () => { if (!process.argv.includes("--oculta")) ventana.show(); });

  const wc = ventana.webContents;

  /* enlaces que salen del portal: al navegador de Windows, nunca dentro del programa */
  wc.setWindowOpenHandler(({ url }) => { abrirFuera(url); return { action: "deny" }; });
  wc.on("will-navigate", (e, url) => { if (url !== wc.getURL() && !url.startsWith("file://")) { e.preventDefault(); abrirFuera(url); } });

  /* Bluetooth: la lista se actualiza a medida que aparecen nodos; se responde una sola vez */
  let btResp = null, btId = 0;
  wc.on("select-bluetooth-device", (e, lista, responder) => {
    e.preventDefault();
    if (!btResp) { btId = ++idSel; esperar(btId).then((v) => { const r = btResp; btResp = null; if (r) r(v || ""); }); }
    btResp = responder;
    wc.send("elegir:bt", btId, lista.map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName })));
  });

  /* guardar tamaño y lugar */
  const recordar = () => { if (!ventana || ventana.isMinimized()) return; pref.maximizada = ventana.isMaximized(); if (!pref.maximizada) pref.ventana = ventana.getBounds(); guardarPref(); };
  ventana.on("resize", recordar); ventana.on("move", recordar);

  /* cerrar con la X: a la bandeja, para seguir recibiendo; Salir es Salir */
  ventana.on("close", (e) => {
    if (saliendo || !pref.aBandeja) return;
    e.preventDefault(); ventana.hide();
    if (!avisoBandejaDado && bandeja && process.platform === "win32") {
      avisoBandejaDado = true;
      bandeja.displayBalloon({ iconType: "info", title: NOMBRE, content: "Sigue funcionando acá abajo y te avisa si llega un mensaje. Para cerrarlo del todo: clic derecho → Salir." });
    }
  });
  ventana.on("focus", () => ventana.flashFrame(false));

  ventana.loadFile(PORTAL);
}

function mostrar() {
  if (!ventana) return;
  if (ventana.isMinimized()) ventana.restore();
  ventana.show(); ventana.focus();
}
function aPortal(nombre, a, b) { if (ventana) ventana.webContents.send("evento", nombre, a, b); }

function abrirFuera(url) {
  if (/^(https?:|mailto:|geo:)/i.test(String(url))) shell.openExternal(url).catch(() => {});
}

/* ── selectores: el programa pregunta, el portal dibuja, la respuesta vuelve por acá ── */
let idSel = 0;
const pendientes = new Map();
function esperar(id) { return new Promise((res) => pendientes.set(id, res)); }
ipcMain.on("elegido", (_e, id, valor) => { const r = pendientes.get(id); if (r) { pendientes.delete(id); r(valor); } });

function permisos() {
  const s = session.defaultSession;
  const PERMITIDOS = new Set(["notifications", "media", "geolocation", "serial", "bluetooth", "clipboard-sanitized-write", "fullscreen"]);
  s.setPermissionRequestHandler((_wc, permiso, cb) => cb(PERMITIDOS.has(permiso)));
  s.setPermissionCheckHandler((_wc, permiso) => PERMITIDOS.has(permiso));
  s.setDevicePermissionHandler((d) => d.deviceType === "serial" || d.deviceType === "bluetooth");

  /* USB: Windows lista los puertos COM; si se enchufa uno con el selector abierto, aparece solo */
  let actual = null;
  s.on("select-serial-port", (e, lista, wc, responder) => {
    e.preventDefault();
    const id = ++idSel;
    actual = { id, lista: lista.slice(), wc };
    wc.send("elegir:puerto", id, actual.lista);
    esperar(id).then((v) => { actual = null; responder(v || ""); });
  });
  s.on("serial-port-added", (_e, p) => { if (actual) { actual.lista.push(p); actual.wc.send("elegir:puerto", actual.id, actual.lista); } });
  s.on("serial-port-removed", (_e, p) => { if (actual) { actual.lista = actual.lista.filter((x) => x.portId !== p.portId); actual.wc.send("elegir:puerto", actual.id, actual.lista); } });

  /* Bluetooth en Windows: el nodo pide un PIN para emparejar */
  if (typeof s.setBluetoothPairingHandler === "function") {
    s.setBluetoothPairingHandler((d, responder) => {
      const id = ++idSel;
      if (ventana) ventana.webContents.send("elegir:pin", id, { pairingKind: d.pairingKind, pin: d.pin || "" });
      esperar(id).then((v) => {
        if (!v) return responder({ confirmed: false });
        if (d.pairingKind === "providePin") return responder({ confirmed: true, pin: String(v) });
        responder({ confirmed: true });
      });
    });
  }

  /* descargas (CSV, Excel, respaldos, copias): Windows pregunta dónde guardar, empezando en Descargas */
  s.on("will-download", (_e, item) => {
    item.setSaveDialogOptions({ title: "Guardar archivo", defaultPath: path.join(app.getPath("downloads"), item.getFilename()) });
  });
}

/* ── lo que pide el portal ── */
ipcMain.handle("app:version", () => ({ version: app.getVersion(), electron: process.versions.electron, sistema: os.type() + " " + os.release(), datos: app.getPath("userData") }));

ipcMain.handle("red:probe", (_e, host, puerto, ms) => red.probe(host, puerto, ms));
ipcMain.handle("red:redes", () => red.redesLocales().catch(() => []));
ipcMain.handle("red:vecinos", () => red.vecinos().catch(() => []));
ipcMain.handle("red:http", async (_e, url, metodo, cuerpo, ms) => {
  try { return await red.pedir(url, metodo, cuerpo, ms); }
  catch (e) { return { falla: true, mensaje: e.message, kind: e.kind || "red" }; }
});

ipcMain.handle("puente:abrir", async () => { const r = await puente.abrir(); actualizarBandeja(); return r; });

ipcMain.handle("abrir-enlace", (_e, url) => { abrirFuera(url); return true; });

ipcMain.on("aviso", (_e, tipo, conv, titulo, texto) => {
  if (!Notification.isSupported()) return;
  const alerta = tipo === "alerta";
  const n = new Notification({
    title: titulo, body: texto, icon: ICONO_AVISO, silent: false,
    urgency: alerta ? "critical" : "normal",
    timeoutType: alerta ? "never" : "default", /* una alerta queda hasta que se atienda */
  });
  n.on("click", () => { mostrar(); aPortal("abrir-conv", conv); });
  n.show();
  if (alerta && ventana && !ventana.isFocused()) ventana.flashFrame(true);
});

ipcMain.on("no-leidos", (_e, n) => {
  if (!ventana) return;
  ventana.setTitle(n > 0 ? "(" + n + ") " + NOMBRE : NOMBRE);
  if (bandeja) bandeja.setToolTip(n > 0 ? NOMBRE + " · " + n + " sin leer" : NOMBRE);
});

/* imprimir o guardar en PDF: se arma en una ventana aparte, sin mostrarla */
ipcMain.handle("imprimir", async (_e, html, titulo) => {
  const tmp = path.join(os.tmpdir(), "pariz-imprimir-" + Date.now() + ".html");
  fs.writeFileSync(tmp, html, "utf8");
  const v = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } });
  try {
    await v.loadFile(tmp);
    const { response } = await dialog.showMessageBox(ventana, {
      type: "question", title: "Imprimir", message: titulo || NOMBRE,
      detail: "¿Querés guardarlo como PDF o mandarlo a una impresora?",
      buttons: ["Guardar como PDF", "Imprimir…", "Cancelar"], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 0) {
      const nombre = (titulo || "documento").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) + ".pdf";
      const { canceled, filePath } = await dialog.showSaveDialog(ventana, { title: "Guardar como PDF", defaultPath: path.join(app.getPath("downloads"), nombre), filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (!canceled && filePath) {
        const pdf = await v.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { marginType: "default" } });
        fs.writeFileSync(filePath, pdf);
        shell.showItemInFolder(filePath);
      }
    } else if (response === 1) {
      await new Promise((res) => v.webContents.print({ silent: false, printBackground: true }, () => res()));
    }
  } finally {
    v.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
  return true;
});

/* ── bandeja del sistema ── */
function actualizarBandeja() {
  if (!bandeja) return;
  const est = puente.estado();
  const inicio = process.platform === "win32" ? app.getLoginItemSettings().openAtLogin : false;
  bandeja.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir " + NOMBRE, click: mostrar },
    { type: "separator" },
    { label: "🚨 Emergencias…", click: () => { mostrar(); aPortal("emergencia"); } },
    { label: "Parte de situación…", click: () => { mostrar(); aPortal("parte"); } },
    { type: "separator" },
    { label: est.activo ? "Puente MQTT: activo" + (est.conexiones ? " (" + est.conexiones + " conexiones)" : "") : "Puente MQTT: apagado", enabled: false },
    { label: "Iniciar con Windows (en la bandeja)", type: "checkbox", checked: inicio, visible: process.platform === "win32", click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--oculta"] }); } },
    { label: "Cerrar la ventana la deja en la bandeja", type: "checkbox", checked: pref.aBandeja, click: (i) => { pref.aBandeja = i.checked; guardarPref(); } },
    { type: "separator" },
    { label: "Salir", click: salir },
  ]));
}
function crearBandeja() {
  try { bandeja = new Tray(nativeImage.createFromPath(ICONO_BANDEJA)); } catch (e) { log("sin bandeja: " + e.message); return; }
  bandeja.setToolTip(NOMBRE);
  bandeja.on("click", mostrar);
  bandeja.on("double-click", mostrar);
  actualizarBandeja();
  setInterval(actualizarBandeja, 15000); /* refresca el estado del puente */
}

/* ── menú (aparece con Alt) ── */
function crearMenu() {
  const ir = (v, sub) => () => { mostrar(); aPortal("ir", v, sub); };
  const instructivo = path.join(process.resourcesPath || RAIZ, "Instructivo-portal-OPEN-SOURCE-PARIZ.pdf");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Archivo", submenu: [
      { label: "Copia de seguridad del portal…", click: ir("settings", "portal.copia") },
      { label: "Parte de situación…", accelerator: "CmdOrCtrl+P", click: () => { mostrar(); aPortal("parte"); } },
      { type: "separator" },
      { label: "Cerrar ventana (sigue en la bandeja)", accelerator: "CmdOrCtrl+W", click: () => ventana && ventana.close() },
      { label: "Salir", accelerator: "CmdOrCtrl+Q", click: salir },
    ] },
    { label: "Ir a", submenu: [
      { label: "Mensajes", accelerator: "CmdOrCtrl+1", click: ir("messages") },
      { label: "Mapa", accelerator: "CmdOrCtrl+2", click: ir("map") },
      { label: "Nodos", accelerator: "CmdOrCtrl+3", click: ir("nodes") },
      { label: "Topología", accelerator: "CmdOrCtrl+4", click: ir("topo") },
      { label: "Telemetría", accelerator: "CmdOrCtrl+5", click: ir("tele") },
      { label: "Novedades y guardia", accelerator: "CmdOrCtrl+6", click: ir("guardia") },
      { type: "separator" },
      { label: "Ajustes", accelerator: "CmdOrCtrl+,", click: ir("settings") },
    ] },
    { label: "Ver", submenu: [
      { label: "Pantalla completa", role: "togglefullscreen", accelerator: "F11" },
      { type: "separator" },
      { label: "Agrandar", role: "zoomIn", accelerator: "CmdOrCtrl+=" },
      { label: "Achicar", role: "zoomOut", accelerator: "CmdOrCtrl+-" },
      { label: "Tamaño normal", role: "resetZoom", accelerator: "CmdOrCtrl+0" },
      { type: "separator" },
      { label: "Volver a cargar", role: "reload", accelerator: "F5" },
    ] },
    { label: "Ayuda", submenu: [
      { label: "Instructivo (PDF)", enabled: fs.existsSync(instructivo), click: () => shell.openPath(instructivo) },
      { label: "Página del proyecto", click: () => abrirFuera("https://github.com/parizeliseo/RED-LORA-MESH") },
      { type: "separator" },
      { label: "Carpeta de datos del programa", click: () => shell.openPath(app.getPath("userData")) },
      { label: "Guardar registro de diagnóstico…", click: guardarRegistro },
      { label: "Herramientas de diagnóstico", accelerator: "F12", click: () => ventana && ventana.webContents.toggleDevTools() },
      { type: "separator" },
      { label: "Acerca de " + NOMBRE, click: acercaDe },
    ] },
  ]));
}
async function guardarRegistro() {
  const { canceled, filePath } = await dialog.showSaveDialog(ventana, { title: "Guardar registro", defaultPath: path.join(app.getPath("downloads"), "registro-open-source-pariz.txt") });
  if (canceled || !filePath) return;
  const e = puente.estado();
  const cab = [NOMBRE + " " + app.getVersion(), "Electron " + process.versions.electron + " · " + os.type() + " " + os.release() + " " + os.arch(),
    "Puente MQTT: " + (e.activo ? "activo" : "apagado") + (e.error ? " (" + e.error + ")" : "") + " · conexiones abiertas " + e.conexiones + " · total " + e.total, ""];
  fs.writeFileSync(filePath, cab.concat(registro).join("\r\n"), "utf8");
  shell.showItemInFolder(filePath);
}
function acercaDe() {
  dialog.showMessageBox(ventana, {
    type: "info", title: "Acerca de " + NOMBRE, message: NOMBRE + " " + app.getVersion(),
    detail: "Sistema LoRa Mesh para Windows.\nMensajes, mapa, topología, telemetría y libro de guardia por USB, Bluetooth o red, sin Internet.\n\nPublicado bajo licencia GPL-3.0.\nhttps://github.com/parizeliseo/RED-LORA-MESH\n\nNo reemplaza a los servicios de emergencia.",
    buttons: ["Cerrar"], noLink: true,
  });
}

function salir() { saliendo = true; puente.cerrar(); app.quit(); }

/* ── arranque ── */
app.on("second-instance", () => mostrar());
app.on("before-quit", () => { saliendo = true; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") salir(); });

app.whenReady().then(async () => {
  leerPref();
  permisos();
  crearMenu();
  await puente.abrir(); /* si el puerto está ocupado, el portal lo explica al tocar «Iniciar puente» */
  crearVentana();
  crearBandeja();
  log(NOMBRE + " " + app.getVersion() + " iniciado");
});

module.exports = { _paraPruebas: { puente, pendientes } };
