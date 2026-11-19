#!/usr/bin/env python3
"""Recorre todas las pantallas y pestañas del portal compilado, en modo demo, en una PC y en dos
celulares: sin errores de JavaScript, sin desbordes de ancho en el celular y sin la palabra que
el portal no debe mostrar. Uso: python pruebas/t_pantallas.py (después de node build.mjs)."""
import sys, time
from playwright.sync_api import sync_playwright
from comun import PORTAL, chequeo, final, sin_red
VISTAS = ["messages", "map", "topo", "nodes", "tele", "console", "emerg", "guardia", "settings", "radio", "device", "module"]
REVISAR = """(movil) => {
  const t = (document.body.innerText + ' ' + [...document.querySelectorAll('[title],[placeholder],[aria-label]')].map(e => (e.title || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')).join(' ') + ' ' + [...document.querySelectorAll('input,textarea')].map(e => e.type === 'password' ? '' : e.value).join(' ')).toLowerCase();
  return { prohibida: t.includes('meshtastic'), ancho: document.documentElement.scrollWidth, vista: window.innerWidth };
}"""
with sync_playwright() as p:
    b = p.chromium.launch()
    for nombre, vp, movil in (("PC 1366×860", {"width": 1366, "height": 860}, False), ("celular 412×915", {"width": 412, "height": 915}, True), ("celular chico 360×740", {"width": 360, "height": 740}, True)):
        ctx = b.new_context(viewport=vp, is_mobile=movil, has_touch=movil, locale="es-AR"); pg = ctx.new_page(); sin_red(pg)
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.on("dialog", lambda d: d.accept())
        pg.goto(PORTAL); pg.wait_for_timeout(800)
        pg.evaluate("() => window.__ui.startDemo()"); pg.wait_for_timeout(1200)
        pantallas, malas, anchas = 0, [], []
        def revisar(etq):
            global pantallas
            r = pg.evaluate(REVISAR, movil)
            if r["prohibida"]: malas.append(etq)
            if movil and r["ancho"] > vp["width"] + 1: anchas.append("%s (%d px)" % (etq, r["ancho"]))
        for v in VISTAS:
            pg.evaluate("v => window.__ui.setView(v)", v); pg.wait_for_timeout(400); pantallas += 1; revisar(v)
            if v in ("settings", "radio", "device", "module"):
                for i in range(pg.evaluate("() => document.querySelectorAll('.tabs .tab').length")):
                    etq = pg.evaluate("i => { const t = document.querySelectorAll('.tabs .tab')[i]; t.click(); return t.innerText; }", i); pg.wait_for_timeout(250)
                    pantallas += 1; revisar(v + "/" + etq)
        pg.evaluate("() => window.__ui.setView('messages')"); pg.wait_for_timeout(300)
        pg.evaluate("() => document.querySelector('.panicchip').click()"); pg.wait_for_timeout(400)
        em = pg.evaluate("() => /ENVIAR ALERTA/.test(document.body.innerText)"); pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
        num = pg.evaluate("() => [...window.__mesh.nodes.keys()].find(k => k !== window.__mesh.me)")
        pg.evaluate("n => window.__ns.openNodeSheet(n)", num); pg.wait_for_timeout(500); revisar("ficha de nodo"); pg.evaluate("() => window.__ns.closeNodeSheet()")
        chequeo("%s: %d pantallas y pestañas sin errores de JavaScript" % (nombre, pantallas), not errs, errs[:3])
        chequeo("%s: la palabra prohibida no aparece" % nombre, not malas, malas[:5])
        chequeo("%s: el cuadro de EMERGENCIAS abre" % nombre, em)
        if movil: chequeo("%s: ninguna pantalla se pasa del ancho" % nombre, not anchas, anchas[:5])
        else: chequeo("%s: muestra la versión del portal" % nombre, pg.evaluate("() => /Portal: \\d+\\.\\d+/.test(document.querySelector('#side').textContent)"))
        ctx.close()
    b.close()
sys.exit(final())
