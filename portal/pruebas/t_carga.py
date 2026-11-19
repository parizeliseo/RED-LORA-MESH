#!/usr/bin/env python3
"""Prueba de carga: el portal con 10.000 nodos, 50.000 mensajes, telemetría de 300 nodos y
20.000 novedades. Mide cuánto tarda en abrir cada pantalla, cuánto tarda en dibujarse el mapa
y qué tan fluido sigue mientras entran cientos de novedades de nodos por segundo (como pasa con
MQTT). Los topes son holgados: una computadora de GitHub sin placa de video es mucho más lenta
que una PC común. Uso: python pruebas/t_carga.py [nodos mensajes]"""
import sys, time
from playwright.sync_api import sync_playwright
from comun import PORTAL, CARGAR, chequeo, final, sin_red
NODOS = int(sys.argv[1]) if len(sys.argv) > 1 else 10000
MSGS = int(sys.argv[2]) if len(sys.argv) > 2 else 50000
ABRIR = """async ([v, sub]) => { const fr = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); await fr();
  const t0 = performance.now(); window.__ui.setView(v, sub || undefined); document.body.offsetHeight; await fr();
  return { ms: Math.round(performance.now() - t0), elementos: document.getElementsByTagName("*").length }; }"""
RAFAGA = """async ([k, porSeg]) => {
  const S = window.__mesh, nums = [...S.nodes.keys()], tiempos = []; let ult = performance.now(), corre = true;
  const paso = () => { const n = performance.now(); tiempos.push(n - ult); ult = n; if (corre) requestAnimationFrame(paso); }; requestAnimationFrame(paso);
  const lote = Math.max(1, Math.round(porSeg / 50));
  for (let i = 0; i < k; i += lote) { for (let j = i; j < i + lote && j < k; j++) window.__ui.upsertNode(nums[(j * 7) % nums.length], { lastHeard: Math.floor(Date.now() / 1000), snr: -3 + (j % 5) }); await new Promise(r => setTimeout(r, 20)); }
  await new Promise((r) => setTimeout(r, 600)); corre = false; tiempos.sort((a, b) => a - b);
  return { tipico: Math.round(tiempos[tiempos.length >> 1]), p95: Math.round(tiempos[Math.floor(tiempos.length * 0.95)]) }; }"""
VISTAS = [("messages", None), ("nodes", None), ("map", None), ("topo", None), ("tele", None), ("guardia", None), ("console", None), ("settings", "portal.perf"), ("settings", "portal.copia")]
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1366, "height": 860}); sin_red(pg)
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.on("dialog", lambda d: d.accept())
    pg.goto(PORTAL); pg.evaluate("() => window.__ui.startDemo()"); pg.wait_for_timeout(1000)
    print("datos de prueba:", pg.evaluate(CARGAR, [NODOS, MSGS, 300, 20000]))
    pg.evaluate("() => { window.__mesh.map.L.base = ''; window.__ui.setView('settings'); }"); pg.wait_for_timeout(300)
    lentas = []
    for v, sub in VISTAS:
        pg.evaluate(ABRIR, [v, sub]); r = pg.evaluate(ABRIR, [v, sub]); etq = v + ("/" + sub if sub else "")
        print("   %-22s %5d ms · %d elementos" % (etq, r["ms"], r["elementos"]))
        if r["ms"] > 1500: lentas.append("%s %d ms" % (etq, r["ms"]))
        if r["elementos"] > 15000: lentas.append("%s con %d elementos" % (etq, r["elementos"]))
    chequeo("todas las pantallas abren en menos de 1,5 s y sin miles de elementos de más", not lentas, lentas)
    pg.evaluate("() => window.__ui.setView('map')"); pg.wait_for_timeout(1000)
    t = pg.evaluate("() => { const t = []; for (let i = 0; i < 15; i++) { window.__mesh.map.cx += 30; const a = performance.now(); window.__ui.drawMap(); t.push(performance.now() - a); } t.sort((a, b) => a - b); return [Math.round(t[7]), Math.round(t[14])]; }")
    chequeo("el mapa se dibuja rápido y sin picos", t[0] < 150 and t[1] < 600, "típico %d ms · peor %d ms" % tuple(t))
    for v in ("messages", "nodes", "map"):
        pg.evaluate("v => window.__ui.setView(v)", v); pg.wait_for_timeout(800)
        r = pg.evaluate(RAFAGA, [1500, 400])
        chequeo("%s sigue fluido con 400 novedades de nodos por segundo" % v, r["tipico"] < 80, "cuadro típico %d ms · 95 %% bajo %d ms" % (r["tipico"], r["p95"]))
    t = pg.evaluate("async () => { const t0 = performance.now(); window.__mesh.msgq = 'carga número 12'; window.__ui.setView('messages'); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); window.__mesh.msgq = ''; return Math.round(performance.now() - t0); }")
    chequeo("buscar entre %d mensajes" % MSGS, t < 1500, "%d ms" % t)
    chequeo("sin errores de JavaScript", not errs, errs[:3])
    b.close()
sys.exit(final())
