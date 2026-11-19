#!/usr/bin/env python3
"""Prueba del almacén grande (IndexedDB) del portal: mudanza desde el formato de la versión 1.11,
guardado por bloques, reapertura, copia de seguridad, restauración en otro navegador, un cambio
en un mensaje viejo, y el caso de un navegador sin IndexedDB. Uso: python pruebas/t_almacen.py"""
import sys, time, json, os, tempfile
from playwright.sync_api import sync_playwright
from comun import PORTAL, chequeo, final, sin_red
ME = 0x2aa3b4c5
COPIA = os.path.join(tempfile.gettempdir(), "copia-prueba-portal.json")
ACTIVAR = """async (me) => { const S = window.__mesh; S.me = me; S.demo = false; window.__datos.loadCache(); for (let i = 0; i < 200; i++) { if (window.__datos.estado().cacheLeido && window.__datos.estado().evLeidos) break; await new Promise(r => setTimeout(r, 50)); } return window.__datos.estado(); }"""
LLENAR = """([me, nm, nn]) => { const S = window.__mesh, ahora = Date.now();
  for (let i = 0; i < nn; i++) S.nodes.set(0x30000000 + i, { num: 0x30000000 + i, user: { longName: "Nodo " + i, shortName: "N" + i }, lastHeard: Math.floor(ahora / 1000), viaMqtt: i % 2 === 0, pos: { lat: -40 - i / 1e4, lon: -71 } });
  for (let i = 0; i < nm; i++) S.msgs.push({ id: 700000000 + i, t: ahora + i, from: i % 5 ? 0x30000000 + (i % nn) : me, to: 0xffffffff, ch: 0, text: "mensaje " + i + " ñandú 🛰", mine: i % 5 === 0, st: i % 5 === 0 ? "ok" : null });
  for (let k = 0; k < 40; k++) { const h = []; for (let j = 0; j < 1500; j++) h.push({ t: ahora - (1500 - j) * 60000, batteryLevel: j % 100, voltage: 3.9 }); S.tele.set(0x30000000 + k, { dev: { last: h[h.length - 1], t: ahora, hist: h } }); window.__datos.marcarTele(0x30000000 + k); }
  for (let i = 0; i < 12000; i++) S.events.push({ t: ahora + i, kind: "msg", num: null, name: "", text: "evento " + i }); window.__datos.evPersist();
  return { msgs: S.msgs.length, nodos: S.nodes.size, eventos: S.events.length }; }"""
GUARDAR = """async () => { const t0 = performance.now(); await window.__datos.guardarAhora(); return { ms: Math.round(performance.now() - t0) }; }"""
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context()
    # 1) datos en el formato viejo (localStorage), como los deja la versión 1.11
    pg = ctx.new_page(); sin_red(pg); pg.on("pageerror", lambda e: print("ERROR JS:", e)); pg.on("dialog", lambda d: d.accept())
    pg.goto(PORTAL); pg.wait_for_timeout(500)
    pg.evaluate("""(me) => { const ahora = Date.now(); const msgs = []; for (let i = 0; i < 3000; i++) msgs.push({ id: 100 + i, t: ahora - (3000 - i) * 5000, from: 0x11, to: 0xffffffff, ch: 0, text: "viejo " + i, mine: false });
      localStorage.setItem(`meshportal:${me}:msgs`, JSON.stringify(msgs));
      localStorage.setItem(`meshportal:${me}:nodes`, JSON.stringify([{ num: 0x11, user: { longName: "Nodo viejo", shortName: "VIEJ" }, lastHeard: 1 }]));
      localStorage.setItem(`meshportal:${me}:tele`, JSON.stringify({ tele: { 17: { dev: { last: { batteryLevel: 80 }, t: ahora, hist: [{ t: ahora, batteryLevel: 80 }] } } }, tracks: { 17: [{ t: ahora, lat: -40, lon: -71 }] } }));
      localStorage.setItem("meshportal:events", JSON.stringify([{ t: ahora, kind: "up", num: 17, name: "Nodo viejo", text: "" }]));
      localStorage.setItem("meshportal:net", JSON.stringify({ v: 3, enabled: false })); }""", ME)
    pg.reload(); pg.wait_for_timeout(1500)
    quedan = pg.evaluate("() => Object.keys(localStorage).filter(k => /:(msgs|nodes|tele)$|meshportal:events$/.test(k))")
    chequeo("la mudanza vacía el lugar viejo", quedan == [], quedan)
    chequeo("los ajustes chicos quedan donde estaban", pg.evaluate("() => !!localStorage.getItem('meshportal:net')"))
    e = pg.evaluate(ACTIVAR, ME)
    st = pg.evaluate("() => ({ msgs: window.__mesh.msgs.length, nodo: (window.__mesh.nodes.get(0x11) || {}).user, tele: !!window.__mesh.tele.get(17), ruta: (window.__mesh.tracks.get(17) || []).length, eventos: window.__mesh.events.length })")
    chequeo("después de la mudanza se leen los 3000 mensajes viejos", st["msgs"] == 3000, st)
    chequeo("y el nodo, la telemetría, el recorrido y las novedades", st["nodo"] and st["tele"] and st["ruta"] == 1 and st["eventos"] == 1, st)
    # 2) mucho más de lo que entraba antes
    pg.evaluate(LLENAR, [ME, 47000, 6000])
    t = time.time(); r = pg.evaluate(GUARDAR); g1 = r["ms"]
    pg.evaluate("""async () => { const S = window.__mesh; await window.__datos.saveTele(); }""")
    # un mensaje más: solo debería reescribirse el último bloque
    r2 = pg.evaluate("""async () => { const S = window.__mesh; S.msgs.push({ id: 999999999, t: Date.now() + 3600000, from: 0x11, to: 0xffffffff, ch: 0, text: "uno más", mine: false }); const t0 = performance.now(); await window.__datos.guardarAhora(); return Math.round(performance.now() - t0); }""")
    chequeo("el primer guardado de 50.000 mensajes y 6000 nodos", g1 < 3000, f"{g1} ms")
    chequeo("guardar un mensaje más es rápido (solo el último bloque)", r2 < g1 / 2 + 50, f"{r2} ms (el primero tardó {g1} ms)")
    pg.evaluate("() => new Promise(r => setTimeout(r, 1200))")  # que se guarden las novedades
    # 3) cerrar y volver a abrir
    pg.close(); pg = ctx.new_page(); sin_red(pg); pg.on("pageerror", lambda e: print("ERROR JS:", e)); pg.on("dialog", lambda d: d.accept())
    t0 = time.time(); pg.goto(PORTAL); e = pg.evaluate(ACTIVAR, ME); ms = round((time.time() - t0) * 1000)
    st = pg.evaluate("() => ({ msgs: window.__mesh.msgs.length, nodos: window.__mesh.nodes.size, tele: [...window.__mesh.tele.values()].reduce((a, c) => a + (c.dev ? c.dev.hist.length : 0), 0), eventos: window.__mesh.events.length, ultimo: window.__mesh.msgs[window.__mesh.msgs.length - 1].text })")
    chequeo("al volver a abrir están los 50.001 mensajes", st["msgs"] == 50001 and st["ultimo"] == "uno más", st)
    chequeo("y los 6001 nodos, la telemetría completa y las novedades", st["nodos"] >= 6001 and st["tele"] == 60001 and st["eventos"] == 12001, st)
    print("   abrir y leer todo:", ms, "ms")
    # un cambio en un mensaje viejo (otro bloque, no el último) también tiene que guardarse
    pg.evaluate("""async () => { const m = window.__mesh.msgs[150]; m.reacts = { "👍": [1, 2] }; m.st = "fail"; await window.__datos.guardarAhora(); }""")
    orden = pg.evaluate("() => { const m = window.__mesh.msgs; for (let i = 1; i < m.length; i++) if (m[i].t < m[i-1].t) return i; return -1; }")
    chequeo("los mensajes quedan en orden", orden == -1, orden)
    pg.close(); pg = ctx.new_page(); pg.on("dialog", lambda d: d.accept()); pg.goto(PORTAL); pg.evaluate(ACTIVAR, ME)
    m = pg.evaluate("() => { const m = window.__mesh.msgs[150]; return { st: m.st, r: m.reacts && m.reacts['👍'] }; }")
    chequeo("un cambio en un mensaje viejo queda guardado", m == {"st": "fail", "r": [1, 2]}, m)
    # 4) copia de seguridad en el formato de siempre
    c = pg.evaluate("() => window.__datos.copiaArmar().then(c => ({ tipo: c.tipo, version: c.version, claves: Object.keys(c.datos), msgs: JSON.parse(c.datos['meshportal:%d:msgs']).length, tele: Object.keys(JSON.parse(c.datos['meshportal:%d:tele']).tele).length, texto: JSON.stringify(c).length }))" % (ME, ME))
    chequeo("la copia trae todo y en el formato de 1.11", c["tipo"] == "copia-portal-lora-mesh" and c["version"] == 1 and c["msgs"] == 50001 and c["tele"] >= 41, {k: c[k] for k in ("msgs", "tele", "texto")})
    copia = pg.evaluate("() => window.__datos.copiaArmar().then(c => JSON.stringify(c))")
    open(COPIA, 'w', encoding='utf-8').write(copia)
    b.close()
    # 5) restaurar en otro navegador vacío
    b = p.chromium.launch(); ctx = b.new_context(); pg = ctx.new_page(); pg.on("dialog", lambda d: d.accept()); pg.on("pageerror", lambda e: print("ERROR JS:", e))
    pg.goto(PORTAL); pg.wait_for_timeout(800)
    pg.evaluate("() => window.__ui.setView('settings', 'portal.copia')"); pg.wait_for_timeout(500)
    with pg.expect_navigation(timeout=60000):
        pg.set_input_files("input[type=file][accept*=json]", COPIA)
    pg.wait_for_timeout(1000)
    e = pg.evaluate(ACTIVAR, ME)
    st = pg.evaluate("() => ({ msgs: window.__mesh.msgs.length, nodos: window.__mesh.nodes.size, eventos: window.__mesh.events.length, lsViejo: Object.keys(localStorage).filter(k => /:msgs$/.test(k)).length })")
    chequeo("restaurada en otro navegador: mensajes, nodos y novedades", st["msgs"] == 50001 and st["nodos"] >= 6001 and st["eventos"] == 12001 and st["lsViejo"] == 0, st)
    # 6) la pantalla de copia cuenta lo guardado
    pg.evaluate("() => window.__ui.setView('settings', 'portal.copia')"); pg.wait_for_timeout(2000)
    txt = pg.evaluate("() => document.querySelector('.form').innerText")
    chequeo("la pantalla de copia muestra lo guardado", "50001 mensajes" in txt, txt[:120].replace("\n", " "))
    b.close()
    # 8) sin IndexedDB: todo sigue como antes
    b = p.chromium.launch(); ctx = b.new_context(); ctx.add_init_script("Object.defineProperty(window, 'indexedDB', { get: () => undefined })")
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(PORTAL); e = pg.evaluate(ACTIVAR, ME)
    pg.evaluate("() => { const S = window.__mesh; for (let i = 0; i < 500; i++) S.msgs.push({ id: 5000 + i, t: Date.now() + i, from: 0x11, to: 0xffffffff, ch: 0, text: 'x' + i, mine: false }); }")
    pg.evaluate("() => window.__datos.guardarAhora()")
    n = pg.evaluate("() => JSON.parse(localStorage.getItem('meshportal:%d:msgs') || '[]').length" % ME)
    chequeo("sin IndexedDB guarda en el lugar viejo, sin errores", n == 500 and not errs, (n, errs[:2]))
    b.close()
sys.exit(final())
