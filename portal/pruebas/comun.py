"""Lo que comparten las pruebas del portal: dónde está el portal compilado, el registro de
resultados y la carga de datos de prueba (miles de nodos, mensajes, telemetría y novedades)."""
import os, sys
for _f in (sys.stdout, sys.stderr):
    try: _f.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass
PORTAL = "file://" + os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "dist", "portal-meshtastic.html"))
fallas = 0
def chequeo(nombre, bien, detalle=""):
    global fallas
    if not bien: fallas += 1
    print(("ok    " if bien else "FALLA ") + nombre + ((" · " + str(detalle)) if detalle != "" else ""), flush=True)
def final():
    print("\n" + ("TODO BIEN" if not fallas else "%d comprobaciones fallaron" % fallas))
    return 1 if fallas else 0
def sin_red(pagina):
    """Las pruebas no salen a Internet: los intentos del portal (MQTT, mapas, comprobación de
    conexión) se cortan. Lo que va a esta misma computadora (el nodo de prueba) sí pasa."""
    def filtro(r):
        u = r.request.url
        if "://127.0.0.1" in u or "://localhost" in u: return r.continue_()
        return r.abort()
    for patron in ("https://**/*", "http://**/*"):
        pagina.route(patron, filtro)
    # MQTT y la comprobación de Internet usan WebSocket y otros caminos: se apagan en los ajustes
    pagina.add_init_script("try { if (!localStorage.getItem('meshportal:net')) localStorage.setItem('meshportal:net', JSON.stringify({ v: 3, enabled: false, probeOn: false })); } catch (e) {}")
NODO_FALSO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nodo_falso.mjs")
def nodo_de_prueba(puerto=8111, por_seg=2, libreta=40):
    """Arma el nodo de mentira con esbuild (usa los protobuf del portal) y lo arranca."""
    import subprocess, tempfile, time, urllib.request
    raiz = os.path.dirname(os.path.dirname(NODO_FALSO)); salida = os.path.join(tempfile.gettempdir(), "nodo_falso_portal.cjs")
    esb = os.path.join(raiz, "node_modules", "esbuild", "bin", "esbuild")
    subprocess.run(["node", esb, NODO_FALSO, "--bundle", "--platform=node", "--format=cjs", "--outfile=" + salida, "--log-level=warning"], check=True, cwd=raiz)
    proc = subprocess.Popen(["node", salida, str(puerto), str(por_seg), str(libreta)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try: urllib.request.urlopen("http://127.0.0.1:%d/estado-prueba" % puerto, timeout=1); return proc
        except Exception: time.sleep(0.1)
    proc.kill(); raise RuntimeError("el nodo de prueba no arrancó")
CARGAR = """([NODOS, MSGS, TELE_N, EVENTOS]) => {
  const S = window.__mesh, ahora = Date.now(), me = S.me;
  for (let i = 0; i < NODOS; i++) {
    const num = 0x10000000 + i;
    S.nodes.set(num, { num, user: { longName: "Nodo de prueba " + i, shortName: ("N" + i).slice(-4), hwModel: 43, role: i % 5 }, pos: { lat: -40.15 + (i % 70) * 0.01, lon: -71.35 + Math.floor(i / 70) * 0.01, alt: 900 }, lastHeard: Math.floor(ahora / 1000) - (i * 37) % 86400, snr: -15 + (i % 30), rssi: -120 + (i % 60), hops: i % 6, viaMqtt: i % 20 !== 0, battery: i % 101, voltage: 3.7, chUtil: (i % 40) / 2, airTx: (i % 10) / 3 });
  }
  const nums = [...S.nodes.keys()];
  for (let i = 0; i < MSGS; i++) {
    const from = i % 7 === 0 ? me : nums[(i * 13) % nums.length], dm = i % 11 === 0;
    S.msgs.push({ id: 900000000 + i, t: ahora - (MSGS - i) * 20000, from, to: dm ? (from === me ? nums[(i * 5) % nums.length] : me) : 0xffffffff, ch: i % 2, dm, text: "Mensaje de carga número " + i + " con algo de texto 🛰", mine: from === me, st: from === me ? "ok" : null, snr: -5, rssi: -100, hops: 2 });
  }
  for (const num of nums.slice(0, TELE_N)) {
    const cats = {};
    for (const cat of ["dev", "env"]) { const hist = []; for (let k = 0; k < 400; k++) hist.push({ t: ahora - (400 - k) * 900000, batteryLevel: 50 + (k % 50), voltage: 3.6 + (k % 10) / 50, channelUtilization: k % 30, airUtilTx: k % 5, temperature: 10 + (k % 15), relativeHumidity: 40 + (k % 30) }); cats[cat] = { last: hist[hist.length - 1], t: ahora, hist }; }
    S.tele.set(num, cats);
    const tr = []; for (let k = 0; k < 200; k++) tr.push({ t: ahora - (200 - k) * 600000, lat: -40.15 + k * 0.0005, lon: -71.35 + k * 0.0003, alt: 900, snr: -5 }); S.tracks.set(num, tr);
  }
  for (let i = 0; i < EVENTOS; i++) S.events.push({ t: ahora - (EVENTOS - i) * 30000, kind: ["msg", "down", "up", "lowbatt", "panic"][i % 5], num: nums[i % nums.length], name: "Nodo " + (i % 4000), text: "evento " + i });
  return { nodos: S.nodes.size, msgs: S.msgs.length, eventos: S.events.length };
}"""
