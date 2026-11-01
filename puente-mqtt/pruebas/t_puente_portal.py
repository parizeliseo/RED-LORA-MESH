"""Portal en el navegador + puente-mqtt.py + Mosquitto: lo que se ve del puente.

Necesita Mosquitto escuchando en 10.77.0.10 (otra IP que la del puente: Chrome abre de a una las
conexiones WebSocket hacia una misma IP) con 1883 libre y 8884 con usuario "operador" y clave
"secreto123" (ver windows/pruebas/t_puente_estado.js), y el puente abierto con:
    python puente-mqtt.py --permitir 10.77.0.10
Uso: MOSQ=carpeta-con-m.conf python3 pruebas/t_puente_portal.py"""
import json, os, subprocess, sys, time
from playwright.sync_api import sync_playwright
PORTAL = "file://" + os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "portal", "dist", "portal-meshtastic.html"))
MOSQ = os.environ.get("MOSQ", "mosquitto-prueba")  # carpeta con m.conf
SAL = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
fallas = 0
def chequeo(n, c, d=""):
    global fallas
    if not c: fallas += 1
    print(("✓ " if c else "✗ ") + n + (" · " + str(d) if d != "" else ""))
def mosq(on):
    if on: subprocess.Popen("cd %s && exec mosquitto -c m.conf >> mosq.log 2>&1" % MOSQ, shell=True)
    else: subprocess.run("for p in $(ss -ltnp | grep ':1883 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done", shell=True)
    time.sleep(1)
CFG = {"v": 3, "enabled": True, "probeOn": False, "uplink": True, "downlink": True, "servers": [
    {"name": "Oficial", "host": "mqtt.meshtastic.org", "port": 8883, "tls": True, "enabled": False},
    {"name": "Mosquitto de prueba", "host": "10.77.0.10", "port": 1883, "tls": False, "url": "", "enabled": True},
    {"name": "Con clave", "host": "10.77.0.10", "port": 8884, "tls": False, "url": "", "user": "operador", "pass": "mal", "enabled": True},
    {"enabled": False}, {"enabled": False}, {"enabled": False}]}
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1366, "height": 860})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
    pg.goto(PORTAL); pg.evaluate("c => { localStorage.setItem('meshportal:net', JSON.stringify(c)); localStorage.setItem('meshportal:theme', 'dark'); }", CFG); pg.reload(); time.sleep(1); pg.evaluate('() => window.__ui.startDemo()')
    pg.wait_for_function("() => /Puente: conectado/.test((document.querySelector('.bridgechip')||{}).innerText||'')", timeout=40000)
    chip = pg.inner_text(".bridgechip"); tit = pg.get_attribute(".bridgechip", "title")
    chequeo("el chip dice que el puente está conectado", "Puente: conectado" in chip, chip)
    chequeo("el chip tiene el punto verde", pg.evaluate("() => !!document.querySelector('.bridgechip .dot.ok')"))
    chequeo("el tooltip nombra el servidor", "10.77.0.10:1883" in (tit or ""), (tit or "").replace("\n", " | "))
    # Ajustes: el servidor rechazado explica por qué
    pg.evaluate("() => window.__ui.setView('settings', 'portal.net')"); time.sleep(1.5)
    pg.wait_for_function("() => /Por el puente/.test((document.querySelector('#sst2')||{}).innerText||'')", timeout=60000)
    s1 = pg.inner_text("#sst1"); s2 = pg.inner_text("#sst2")
    chequeo("Ajustes: el servidor bueno dice 'por el puente de esta PC'", "por el puente de esta PC" in s1, s1)
    chequeo("Ajustes: el de clave mal explica el rechazo", "no dejó entrar" in s2, s2)
    # mensajes que llegan
    for i in range(4): subprocess.run(["mosquitto_pub", "-h", "10.77.0.10", "-p", "1883", "-t", "msh/ANZ/2/e/DEMOmesh/!a1b2c3d4", "-m", "x%d" % i])
    pg.evaluate("() => window.__ui.setView('messages')"); time.sleep(0.5)
    pg.click(".bridgechip"); pg.wait_for_selector(".puentebox"); time.sleep(2.5)
    txt = pg.inner_text(".puentebox")
    chequeo("panel: estado general", "Conectado a 1 servidor" in txt, txt.split("\n")[1] if "\n" in txt else txt)
    chequeo("panel: el servidor y su nombre", "10.77.0.10:1883" in txt and "Mosquitto de prueba" in txt)
    rec = pg.evaluate("() => { const b = [...document.querySelectorAll('.puentebox .pbnum span')].find(s => /recibidos/.test(s.innerText)); return b ? +b.querySelector('b').innerText : -1; }")
    chequeo("panel: cuenta los mensajes recibidos", rec >= 4, rec)
    chequeo("panel: últimos problemas explicados", "no dejó entrar: no autorizado" in txt)
    todo = (txt + " " + (pg.get_attribute(".bridgechip", "title") or "") + " " + pg.evaluate("() => document.body.innerText")).lower()
    chequeo("el nombre prohibido no aparece en pantalla (el oficial se llama 'servidor oficial de la red')", "meshtastic" not in todo, [l for l in txt.split("\n") if "oficial" in l][:2])
    pg.screenshot(path=os.path.join(SAL, "puente_panel.png"))
    # se actualiza solo
    for i in range(3): subprocess.run(["mosquitto_pub", "-h", "10.77.0.10", "-p", "1883", "-t", "msh/ANZ/2/e/DEMOmesh/!a1b2c3d4", "-m", "y%d" % i])
    time.sleep(3)
    rec2 = pg.evaluate("() => { const b = [...document.querySelectorAll('.puentebox .pbnum span')].find(s => /recibidos/.test(s.innerText)); return b ? +b.querySelector('b').innerText : -1; }")
    chequeo("panel: se actualiza solo", rec2 >= rec + 3, "%d → %d" % (rec, rec2))
    pg.keyboard.press("Escape"); time.sleep(0.4)
    chequeo("Escape cierra el panel", pg.query_selector(".puentebox") is None)
    # el servidor se cae
    mosq(False); time.sleep(7)
    chip2 = pg.inner_text(".bridgechip")
    chequeo("si el servidor se cae, el chip lo muestra", "Puente: con problemas" in chip2 or "conectando" in chip2, chip2)
    pg.screenshot(path=os.path.join(SAL, "puente_chip_problema.png"), clip={"x": 560, "y": 0, "width": 806, "height": 60})
    pg.click(".bridgechip"); pg.wait_for_selector(".puentebox"); time.sleep(1)
    t2 = pg.inner_text(".puentebox")
    chequeo("panel: explica el corte", "cerró la conexión" in t2 or "cortó" in t2 or "rechazó la conexión" in t2, [l for l in t2.split("\n") if "servidor «" in l][:2])
    pg.keyboard.press("Escape")
    # vuelve solo
    mosq(True)
    try:
        pg.wait_for_function("() => /Puente: conectado/.test(document.querySelector('.bridgechip').innerText)", timeout=90000); vuelve = True
    except Exception: vuelve = False
    chequeo("cuando el servidor vuelve, se reconecta solo y el chip vuelve a verde", vuelve, pg.inner_text(".bridgechip"))
    pg.screenshot(path=os.path.join(SAL, "puente_chip_ok.png"), clip={"x": 560, "y": 0, "width": 806, "height": 60})
    chequeo("sin errores de JavaScript", not errs, errs)
    b.close()
print("\n" + ("%d FALLAS" % fallas if fallas else "TODO BIEN"))
sys.exit(1 if fallas else 0)
