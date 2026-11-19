#!/usr/bin/env python3
"""El portal conectado a un nodo (de mentira, con la misma API web del firmware) por red:
recibe la configuración y la libreta, guarda los mensajes que llegan, manda un mensaje y lo ve
confirmado, y al cerrar y volver a abrir conserva todo el historial. Uso: python pruebas/t_conectado.py"""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
from comun import PORTAL, chequeo, final, sin_red, nodo_de_prueba
PUERTO = 8111
CONECTAR = """async (puerto) => { try { await window.__conn.connectNet("127.0.0.1:" + puerto, false, "Nodo de prueba"); } catch (e) { return "ERR " + e.message; }
  for (let i = 0; i < 100; i++) { const S = window.__mesh; if (S.me && S.nodes.size > 30 && window.__datos.estado().cacheLeido) break; await new Promise(r => setTimeout(r, 100)); }
  return true; }"""
ESTADO = """() => { const S = window.__mesh; return { me: S.me, nodos: S.nodes.size, msgs: S.msgs.length, canal: (S.channels[0] && S.channels[0].settings || {}).name, tele: S.tele.size, conectado: !!S.device, ...window.__datos.estado() }; }"""
nodo = nodo_de_prueba(PUERTO, por_seg=4, libreta=40)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(); pg = ctx.new_page(); sin_red(pg)
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.on("dialog", lambda d: d.accept())
        pg.goto(PORTAL); pg.wait_for_timeout(1000)
        r = pg.evaluate(CONECTAR, PUERTO)
        chequeo("conecta al nodo por la red", r is True, r)
        pg.wait_for_timeout(6000)
        e = pg.evaluate(ESTADO)
        chequeo("recibe la configuración, el canal y la libreta de nodos", e["me"] == 0x1a2b3c4d and e["nodos"] >= 41 and e["canal"] == "PRUEBA", e)
        chequeo("van llegando mensajes y telemetría de la red", e["msgs"] >= 20 and e["tele"] >= 1, e)
        # mandar un mensaje y verlo confirmado
        pg.evaluate("() => window.__ui.setView('messages')"); pg.wait_for_timeout(500)
        pg.fill("#msgin", "Hola desde la prueba del portal"); pg.press("#msgin", "Enter"); pg.wait_for_timeout(4000)
        st = pg.evaluate("() => { const m = window.__mesh.msgs.filter(x => x.mine && x.text === 'Hola desde la prueba del portal'); return m.length ? m[m.length - 1].st : null; }")
        chequeo("un mensaje enviado queda confirmado (enviado ✓)", st == "ok", st)
        pg.wait_for_timeout(7000)  # el guardado corre a los 5 s
        antes = pg.evaluate(ESTADO)
        guardados = pg.evaluate("async () => ((await window.__datos.almLeerLista('meshportal:' + window.__mesh.me + ':msgs')) || []).length")
        chequeo("los mensajes quedan guardados en el almacén grande", guardados >= antes["msgs"] - 40 and guardados > 20, "%d guardados de %d" % (guardados, antes["msgs"]))
        mio = pg.evaluate("async () => ((await window.__datos.almLeerLista('meshportal:' + window.__mesh.me + ':msgs')) || []).filter(m => m.mine).map(m => m.st)")
        chequeo("y el enviado se guardó como confirmado", "ok" in mio, mio)
        # cerrar y volver a abrir
        pg.close(); pg = ctx.new_page(); sin_red(pg); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        pg.goto(PORTAL); pg.wait_for_timeout(1000)
        r = pg.evaluate(CONECTAR, PUERTO); pg.wait_for_timeout(3000)
        despues = pg.evaluate(ESTADO)
        chequeo("al volver a abrir y conectar está el historial anterior", despues["msgs"] >= guardados, "%d antes · %d ahora" % (guardados, despues["msgs"]))
        repes = pg.evaluate("() => { const v = new Set(), r = []; for (const m of window.__mesh.msgs) { if (v.has(m.id)) r.push(m.id); v.add(m.id); } return r.length; }")
        chequeo("sin mensajes repetidos al juntar lo guardado con lo nuevo", repes == 0, repes)
        chequeo("sin errores de JavaScript", not errs, errs[:3])
        b.close()
finally:
    nodo.kill()
sys.exit(final())
