"use strict";
/*
 * Lo que el programa le ofrece al portal. Corre antes que el portal y en un mundo aparte: el
 * portal no puede tocar nada del sistema, solo usar estas funciones.
 *
 *  window.__escritorio  avisos de Windows, impresión, enlaces, puente MQTT y eventos del programa
 *  window.__nativeNet   red hecha por el programa (mismo contrato que en la app de Android, más
 *                       redes() y vecinos() para que la búsqueda de nodos parta de la red de la PC)
 *
 * Además dibuja los selectores que en Chrome dibuja el navegador: qué puerto USB usar, qué nodo
 * Bluetooth, y el PIN de emparejamiento. Usan las mismas clases que los diálogos del portal, así
 * se ven igual, se cierran con Escape y el tabulador no se escapa.
 */
const { contextBridge, ipcRenderer } = require("electron");

/* ── eventos del programa hacia el portal (menú, bandeja, avisos tocados) ── */
const oyentes = new Map();
ipcRenderer.on("evento", (_e, nombre, a, b) => {
  const l = oyentes.get(nombre); if (!l) return;
  for (const f of l) { try { f(a, b); } catch (e) { /* un oyente roto no frena a los demás */ } }
});

contextBridge.exposeInMainWorld("__escritorio", {
  plataforma: process.platform,
  version: () => ipcRenderer.invoke("app:version"),
  imprimir: (html, titulo) => ipcRenderer.invoke("imprimir", String(html || ""), String(titulo || "")),
  abrirEnlace: (url) => ipcRenderer.invoke("abrir-enlace", String(url || "")),
  aviso: (tipo, conv, titulo, texto) => ipcRenderer.send("aviso", String(tipo || ""), String(conv || ""), String(titulo || ""), String(texto || "")),
  puente: () => ipcRenderer.invoke("puente:abrir"),
  noLeidos: (n) => ipcRenderer.send("no-leidos", n | 0),
  enEvento: (nombre, f) => {
    if (typeof f !== "function") return;
    if (!oyentes.has(nombre)) oyentes.set(nombre, new Set());
    oyentes.get(nombre).add(f);
  },
});

/* ── red: los errores viajan como objeto simple para que el portal pueda leer .kind ── */
contextBridge.exposeInMainWorld("__nativeNet", {
  probe: (host, port, ms) => ipcRenderer.invoke("red:probe", String(host), port | 0, ms | 0),
  /* redes de esta PC (adaptador, IP, máscara y el rango a revisar) y la tabla de vecinos (ARP) */
  redes: () => ipcRenderer.invoke("red:redes"),
  vecinos: () => ipcRenderer.invoke("red:vecinos"),
  http: async (url, metodo, cuerpo, ms) => {
    const r = await ipcRenderer.invoke("red:http", String(url), String(metodo || "GET"), cuerpo ? new Uint8Array(cuerpo) : null, ms | 0);
    if (r && r.falla) throw { message: r.mensaje || "error de red", kind: r.kind || "red" }; // eslint-disable-line no-throw-literal
    return r;
  },
});

/* ───────────────────────── selectores ───────────────────────── */
function el(tag, attrs, ...hijos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const h of hijos.flat()) if (h != null && h !== false) e.append(h.nodeType ? h : document.createTextNode(String(h)));
  return e;
}
let estilos = false;
function ponerEstilos() {
  if (estilos) return; estilos = true;
  document.head.append(el("style", {}, `
    .esc-lista{display:flex;flex-direction:column;gap:6px;max-height:min(52vh,420px);overflow:auto;margin:10px 0 4px}
    .esc-it{display:flex;align-items:center;gap:10px;text-align:left;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;cursor:pointer}
    .esc-it:hover,.esc-it:focus-visible{border-color:var(--acc)}
    .esc-it[aria-selected=true]{border-color:var(--acc);background:var(--sel);box-shadow:inset 3px 0 0 var(--acc)}
    .esc-it b{display:block;font-size:14px}.esc-it small{display:block;color:var(--mut);font-size:12px;margin-top:2px}
    .esc-it .esc-tag{margin-left:auto;flex:none;font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;background:var(--acc);color:var(--accink)}
    .esc-vacio{padding:14px;border:1px dashed var(--line);border-radius:10px;color:var(--mut);font-size:13px;line-height:1.45}
    .esc-busca{display:flex;align-items:center;gap:8px;color:var(--mut);font-size:12px}
    .esc-busca i{width:8px;height:8px;border-radius:50%;background:var(--acc);animation:esc-lat 1.1s ease-in-out infinite}
    @keyframes esc-lat{0%,100%{opacity:.25}50%{opacity:1}}
    .esc-pin{font:600 26px/1 ui-monospace,Consolas,monospace;letter-spacing:.3em;text-align:center;width:100%;margin-top:8px}
    .esc-pie{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
  `));
}

/* Placas que casi seguro son un nodo, por el fabricante del chip USB */
const CHIPS = {
  "10c4": "Chip CP210x (Heltec V3, T-Beam)", "1a86": "Chip CH340 / CH9102", "303a": "ESP32 con USB propio",
  "0403": "Chip FTDI", "239a": "nRF52 (RAK4631 y similares)", "2886": "Seeed (XIAO, T1000)", "1915": "Nordic nRF52",
};

let abierto = null; /* un selector a la vez */

function cerrarAbierto() { if (abierto) { const a = abierto; abierto = null; a.velo.remove(); } }

function selector({ id, titulo, subtitulo, vacio, buscando, etiquetaOk }) {
  ponerEstilos();
  cerrarAbierto();
  let elegido = null, respondido = false;
  const lista = el("div", { class: "esc-lista", role: "listbox", "aria-label": titulo });
  const ok = el("button", { class: "btn", disabled: true }, etiquetaOk || "Conectar");
  const responder = (valor) => {
    if (respondido) return; respondido = true;
    ipcRenderer.send("elegido", id, valor);
    cerrarAbierto();
  };
  const cancelar = el("button", { class: "btn ghost", onclick: () => responder("") }, "Cancelar");
  ok.addEventListener("click", () => { if (elegido) responder(elegido); });
  const velo = el("div", { class: "modal", onclick: (e) => { if (e.target === velo) responder(""); } },
    el("div", { class: "mbox", role: "dialog", "aria-modal": "true", "aria-label": titulo },
      el("h3", {}, titulo),
      subtitulo ? el("p", { class: "muted" }, subtitulo) : null,
      buscando ? el("div", { class: "esc-busca" }, el("i"), buscando) : null,
      lista,
      el("div", { class: "esc-pie" }, cancelar, ok)));
  document.body.append(velo);
  abierto = { id, velo };

  const pintar = (items) => {
    if (!items.length) { lista.replaceChildren(el("div", { class: "esc-vacio" }, vacio)); ok.disabled = true; elegido = null; return; }
    if (elegido && !items.some((x) => x.valor === elegido)) elegido = null;
    if (!elegido) { /* si hay uno solo, o un solo «probable nodo», ya queda elegido: Enter y listo */
      const probables = items.filter((x) => x.marca);
      if (items.length === 1) elegido = items[0].valor;
      else if (probables.length === 1) elegido = probables[0].valor;
    }
    lista.replaceChildren(...items.map((x) => el("button", {
      class: "esc-it", role: "option", "aria-selected": x.valor === elegido ? "true" : "false",
      onclick: () => { elegido = x.valor; pintar(items); ok.focus(); },
      ondblclick: () => { elegido = x.valor; responder(elegido); },
    }, el("span", {}, el("b", {}, x.nombre), x.detalle ? el("small", {}, x.detalle) : null), x.marca ? el("span", { class: "esc-tag" }, x.marca) : null)));
    ok.disabled = !elegido;
  };
  return { pintar, id };
}

/* ── puerto USB ── */
let selPuerto = null;
ipcRenderer.on("elegir:puerto", (_e, id, puertos) => {
  const items = (puertos || []).map((p) => {
    const vid = String(p.vendorId || "").toLowerCase().padStart(4, "0");
    const chip = CHIPS[vid];
    return {
      valor: p.portId,
      nombre: p.portName || p.displayName || "Puerto serie",
      detalle: [p.displayName && p.displayName !== p.portName ? p.displayName : "", chip || ""].filter(Boolean).join(" · "),
      marca: chip ? "probable nodo" : "",
    };
  }).sort((a, b) => (b.marca ? 1 : 0) - (a.marca ? 1 : 0));
  if (!selPuerto || selPuerto.id !== id || !abierto) {
    selPuerto = selector({
      id, titulo: "Elegí el puerto USB del nodo", etiquetaOk: "Conectar",
      subtitulo: "Son los puertos serie que Windows ve en este momento. Si enchufás el nodo ahora, aparece solo.",
      vacio: "No aparece ningún puerto. Revisá que el cable sea de datos (muchos son solo de carga). Si Windows no muestra ningún puerto COM al enchufar el nodo, falta el controlador del chip USB: CP210x (Silicon Labs) para Heltec V3, o CH340 / CH9102 para otras placas.",
    });
  }
  selPuerto.pintar(items);
});

/* ── Bluetooth: la lista se va llenando a medida que aparecen nodos ── */
let selBt = null;
ipcRenderer.on("elegir:bt", (_e, id, equipos) => {
  const items = (equipos || []).map((d) => ({
    valor: d.deviceId,
    nombre: String(d.deviceName || "").replace(/meshtastic/gi, "LoRa Mesh") || "Equipo sin nombre",
    detalle: d.deviceId,
  }));
  if (!selBt || selBt.id !== id || !abierto) {
    selBt = selector({
      id, titulo: "Elegí el nodo por Bluetooth", etiquetaOk: "Conectar",
      subtitulo: "Aparecen los nodos LoRa Mesh cercanos con el Bluetooth encendido. Si el tuyo no aparece, desconectalo del celular o de otra PC.",
      buscando: "Buscando nodos cercanos…",
      vacio: "Todavía no apareció ningún nodo. Esperá unos segundos con el nodo encendido y cerca. Revisá que el Bluetooth de esta PC esté activado.",
    });
  }
  selBt.pintar(items);
});

/* ── PIN de emparejamiento Bluetooth ── */
ipcRenderer.on("elegir:pin", (_e, id, d) => {
  ponerEstilos();
  cerrarAbierto();
  let respondido = false;
  const responder = (valor) => { if (respondido) return; respondido = true; ipcRenderer.send("elegido", id, valor); cerrarAbierto(); };
  const pide = d.pairingKind === "providePin";
  const campo = pide ? el("input", { class: "inp esc-pin", inputmode: "numeric", maxlength: 6, autocomplete: "off", "aria-label": "PIN del nodo", placeholder: "123456" }) : null;
  const ok = el("button", { class: "btn", onclick: () => responder(pide ? (campo.value || "").trim() || "123456" : "si") }, pide ? "Emparejar" : "Confirmar");
  if (campo) campo.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.click(); });
  const velo = el("div", { class: "modal", onclick: (e) => { if (e.target === velo) responder(""); } },
    el("div", { class: "mbox", role: "dialog", "aria-modal": "true", "aria-label": "Emparejar por Bluetooth" },
      el("h3", {}, "Emparejar con el nodo"),
      pide
        ? el("p", { class: "muted" }, "Escribí el PIN que muestra la pantalla del nodo. Si el nodo no tiene pantalla, el PIN de fábrica suele ser 123456.")
        : el("p", { class: "muted" }, "Confirmá que el número coincide con el que muestra la pantalla del nodo."),
      d.pin ? el("div", { class: "esc-pin" }, d.pin) : null,
      campo,
      el("div", { class: "esc-pie" }, el("button", { class: "btn ghost", onclick: () => responder("") }, "Cancelar"), ok)));
  document.body.append(velo);
  abierto = { id, velo };
});

ipcRenderer.on("elegir:cerrar", (_e, id) => { if (abierto && abierto.id === id) cerrarAbierto(); });
