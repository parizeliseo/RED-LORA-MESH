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
const { crearPuente, duracion } = require("./puente");

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
const puente = crearPuente((t) => log("puente: " + t), () => { clearTimeout(tCambioPuente); tCambioPuente = setTimeout(mostrarEstadoPuente, 250); });
let ultimoTooltip = "", ultimoMenu = [];
let tCambioPuente = 0, nivelBandeja = null, nivelBarra = null, conectadosAntes = 0, avisoCorteDado = 0, noLeidos = 0;
const RUTA_BUILD = path.join(RAIZ, "build");
const img = (nombre) => nativeImage.createFromPath(path.join(RUTA_BUILD, nombre)); /* toma solo la versión @2x si la pantalla la necesita */

/* Cómo está el puente, en una palabra: conectado (verde), conectando (ámbar), con error (rojo) o sin uso */
function nivelDe(e) {
  if (!e.activo) return "error";
  if (e.conectados > 0) return "ok";
  if (e.conexiones.some((x) => x.mqtt === "esperando")) return "espera";
  if (e.errores[0] && e.ahora - e.errores[0].t < 120000) return "error";
  return "";
}
/* el servidor oficial se nombra así en pantalla, nunca por su dirección */
const verSrv = (h) => (/meshtastic/i.test(String(h)) ? "servidor oficial de la red" : String(h));
const verTxt = (s) => String(s || "").replace(/[a-z0-9.-]*meshtastic[a-z0-9.-]*/gi, "servidor oficial de la red");
const servTxt = (x) => verSrv(x.servidor) + ":" + x.puerto + (x.tls ? " TLS" : "");
function resumenPuente(e) {
  const ok = e.conexiones.filter((x) => x.mqtt === "conectado");
  if (!e.activo) return "Puente MQTT apagado" + (e.error ? ": " + e.error : "");
  if (ok.length) return "MQTT conectado a " + verSrv(ok[0].servidor) + (ok.length > 1 ? " y " + (ok.length - 1) + " más" : "") + " por el puente";
  if (e.conexiones.length) return "MQTT: conectando a " + verSrv(e.conexiones[0].servidor) + "…";
  if (nivelDe(e) === "error") return "Puente MQTT: " + verTxt(e.errores[0].texto);
  return "Puente MQTT listo, sin servidores conectados";
}
function ponerTooltip() {
  if (!bandeja) return;
  const t = NOMBRE + (noLeidos > 0 ? " · " + noLeidos + " sin leer" : "") + "\n" + resumenPuente(puente.estadoDetallado());
  ultimoTooltip = t.length > 127 ? t.slice(0, 126) + "…" : t; /* Windows corta en 127 */
  bandeja.setToolTip(ultimoTooltip);
}
function mostrarEstadoPuente() {
  const e = puente.estadoDetallado(), nivel = nivelDe(e);
  if (bandeja && nivel !== nivelBandeja) {
    nivelBandeja = nivel;
    try { bandeja.setImage(nivel ? img("tray-" + nivel + ".png") : nativeImage.createFromPath(ICONO_BANDEJA)); } catch (x) { /* sin bandeja */ }
  }
  /* puntito sobre el ícono de la barra de tareas (solo Windows) */
  if (ventana && process.platform === "win32" && nivel !== nivelBarra) {
    nivelBarra = nivel;
    ventana.setOverlayIcon(nivel ? img("estado-" + nivel + ".png") : null, nivel ? resumenPuente(e) : "");
  }
  ponerTooltip();
  actualizarBandeja();
  aPortal("puente", e);
  /* si se cortó todo con la ventana cerrada, avisa (una vez cada 5 minutos como mucho) */
  const oculta = !ventana || !ventana.isVisible() || ventana.isMinimized();
  if (conectadosAntes > 0 && e.conectados === 0 && e.activo && oculta && Date.now() - avisoCorteDado > 300000 && Notification.isSupported()) {
    avisoCorteDado = Date.now();
    const n = new Notification({ title: "Se cortó la conexión MQTT", body: (e.errores[0] && e.ahora - e.errores[0].t < 60000 ? verTxt(e.errores[0].texto) + ". " : "") + "El portal sigue por LoRa y vuelve a intentar solo.", icon: ICONO_AVISO });
    n.on("click", () => { mostrar(); aPortal("puente-panel"); });
    n.show();
  } else if (conectadosAntes === 0 && e.conectados > 0 && avisoCorteDado && oculta && Notification.isSupported()) {
    avisoCorteDado = 0; /* volvió después de un corte avisado: se avisa que volvió */
    new Notification({ title: "MQTT conectado de nuevo", body: resumenPuente(e), icon: ICONO_AVISO, silent: true }).show();
  }
  conectadosAntes = e.conectados;
}

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

ipcMain.handle("puente:abrir", async () => { const r = await puente.abrir(); mostrarEstadoPuente(); return r; });
ipcMain.handle("puente:estado", () => puente.estadoDetallado());

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
  noLeidos = n; ponerTooltip();
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
  const e = puente.estadoDetallado();
  const ahora = Date.now(), hace = (t) => duracion(ahora - t);
  const marca = { conectado: "🟢", esperando: "🟡", rechazado: "🔴" };
  const lineas = !e.activo
    ? [{ label: "Puente MQTT: apagado" + (e.error ? " — " + e.error.slice(0, 70) : ""), enabled: false }]
    : [{ label: e.conexiones.length ? "Puente MQTT: " + e.conectados + " de " + e.conexiones.length + " conectados" : "Puente MQTT: listo, sin servidores conectados", enabled: false },
      ...e.conexiones.slice(0, 6).map((x) => ({ label: "   " + (marca[x.mqtt] || "•") + " " + servTxt(x) + " — " +
        (x.mqtt === "conectado" ? "hace " + hace(x.desde) + " · ↓" + x.recibidos + " ↑" + x.enviados + " mensajes" : x.mqtt === "rechazado" ? verTxt(x.motivo) : "esperando al servidor…"), enabled: false })),
      ...(e.errores[0] && ahora - e.errores[0].t < 600000 && !e.conectados ? [{ label: "   Último problema: " + verTxt(e.errores[0].texto).slice(0, 90), enabled: false }] : [])];
  const inicio = process.platform === "win32" ? app.getLoginItemSettings().openAtLogin : false;
  const plantilla = [
    { label: "Abrir " + NOMBRE, click: mostrar },
    { type: "separator" },
    { label: "🚨 Emergencias…", click: () => { mostrar(); aPortal("emergencia"); } },
    { label: "Parte de situación…", click: () => { mostrar(); aPortal("parte"); } },
    { type: "separator" },
    ...lineas,
    { label: "Ver el estado del puente…", click: () => { mostrar(); aPortal("puente-panel"); } },
    { type: "separator" },
    { label: "Iniciar con Windows (en la bandeja)", type: "checkbox", checked: inicio, visible: process.platform === "win32", click: (i) => { app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--oculta"] }); } },
    { label: "Cerrar la ventana la deja en la bandeja", type: "checkbox", checked: pref.aBandeja, click: (i) => { pref.aBandeja = i.checked; guardarPref(); } },
    { type: "separator" },
    { label: "Salir", click: salir },
  ];
  ultimoMenu = plantilla.filter((x) => x.label).map((x) => x.label);
  bandeja.setContextMenu(Menu.buildFromTemplate(plantilla));
}
function crearBandeja() {
  try { bandeja = new Tray(nativeImage.createFromPath(ICONO_BANDEJA)); } catch (e) { log("sin bandeja: " + e.message); return; }
  bandeja.on("click", mostrar);
  bandeja.on("double-click", mostrar);
  mostrarEstadoPuente();
  setInterval(mostrarEstadoPuente, 15000); /* refresca tiempos y contadores del menú */
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
  const e = puente.estadoDetallado();
  const cab = [NOMBRE + " " + app.getVersion(), "Electron " + process.versions.electron + " · " + os.type() + " " + os.release() + " " + os.arch(),
    "Puente MQTT: " + (e.activo ? "activo" : "apagado") + (e.error ? " (" + e.error + ")" : "") + " · " + resumenPuente(e) + " · conexiones en total desde que abrió: " + e.total,
    ...e.conexiones.map((x) => "   " + servTxt(x) + " · " + x.mqtt + (x.motivo ? " (" + x.motivo + ")" : "") + " · desde " + new Date(x.desde).toLocaleTimeString() + " · recibidos " + x.recibidos + " · enviados " + x.enviados),
    ...e.errores.map((x) => "   " + new Date(x.t).toLocaleTimeString() + " " + x.texto), ""];
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
/* para las pruebas automáticas, solo fuera del paquete instalado */
if (!app.isPackaged) global.__pruebas = { bandeja: () => ({ nivelBandeja, nivelBarra, tooltip: ultimoTooltip, menu: ultimoMenu }), limpiarPuente: () => puente.limpiarErrores() };
