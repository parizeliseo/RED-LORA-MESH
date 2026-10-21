#!/usr/bin/env python3
"""
Puente local para OPEN SOURCE PARIZ  (versión multi-servidor).

Los navegadores no pueden abrir una conexión MQTT por TCP. Este programa escucha en tu PC
(ws://localhost:9001) y reenvía todo, sin tocarlo, al servidor MQTT que pida el portal.
Una sola ventana del puente atiende a TODOS los servidores a la vez:

    ws://localhost:9001/<servidor>/<puerto>/<tls|tcp>

El portal arma esa dirección solo para cada uno de los 6 lugares de servidor; no hay que
configurar nada en el navegador.

Uso (solo necesita Python 3.8 o más nuevo, no instala nada):
    python puente-mqtt.py                       abre el puente para todos los servidores conocidos
    python puente-mqtt.py --probar              prueba cada servidor (TCP/TLS y MQTT) y termina
    python puente-mqtt.py --permitir mi.servidor.com   permite además otro servidor (se puede repetir)
    python puente-mqtt.py --escuchar 9001       cambia el puerto local
    python puente-mqtt.py servidor.com 1883 [--tls]    modo viejo: el puerto raíz "/" va a ese servidor

Dejalo abierto mientras usás el portal; se cierra con Ctrl+C.
Seguridad: solo escucha en esta computadora (127.0.0.1) y solo reenvía a los servidores de la
lista y a los puertos MQTT habituales (1883, 8883, 8886, 8884); cualquier otro destino se rechaza.
"""
import asyncio, base64, hashlib, ssl, struct, sys, time

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# servidor -> puertos MQTT por TCP permitidos
CONOCIDOS = {
    "mqtt.meshtastic.org": (8883, 1883),
    "broker.hivemq.com": (1883, 8883),
    "broker.emqx.io": (1883, 8883),
    "test.mosquitto.org": (1883, 8883, 8886, 8884),
    "mqtt.eclipseprojects.io": (1883, 8883),
    "mqtt.flespi.io": (8883, 1883),
}
# para --probar: usuario y clave de prueba si el servidor los pide
PRUEBA = {
    "mqtt.meshtastic.org": ("meshdev", "large4cats"),
    "mqtt.flespi.io": ("FlespiToken 0", ""),   # sin token real: solo comprueba que el servidor responde
}
PUERTOS_OK = (1883, 8883, 8886, 8884)
OFICIAL = ("mqtt.meshtastic.org", 8883, True)


def parse():
    a = sys.argv[1:]
    cfg = {"listen": 9001, "probar": False, "extra": [], "raiz": None}
    if "--probar" in a:
        cfg["probar"] = True; a.remove("--probar")
    while "--permitir" in a:
        i = a.index("--permitir"); cfg["extra"].append(a[i + 1].lower()); del a[i:i + 2]
    if "--escuchar" in a:
        i = a.index("--escuchar"); cfg["listen"] = int(a[i + 1]); del a[i:i + 2]
    tls = "--tls" in a
    a = [x for x in a if x != "--tls"]
    if a:
        port = int(a[1]) if len(a) > 1 else 1883
        cfg["raiz"] = (a[0].lower(), port, tls or port in (8883, 8886, 8884))
        cfg["extra"].append(a[0].lower())
    else:
        cfg["raiz"] = OFICIAL
    return cfg


def destino_ok(host, port, extra):
    if host in extra:
        return True
    return port in CONOCIDOS.get(host, ()) or (host in CONOCIDOS and port in PUERTOS_OK)


def ruta(path, cfg):
    """'/host/port/tls' -> (host, port, tls); '/' -> servidor raíz. None si es inválida."""
    p = [x for x in path.split("?")[0].split("/") if x]
    if not p:
        return cfg["raiz"]
    try:
        host = p[0].lower()
        port = int(p[1]) if len(p) > 1 else 8883
        modo = p[2].lower() if len(p) > 2 else ("tls" if port != 1883 else "tcp")
        if modo not in ("tls", "tcp"):
            return None
        return host, port, modo == "tls"
    except ValueError:
        return None


async def read_frame(r):
    h = await r.readexactly(2)
    op, ln = h[0] & 0x0F, h[1] & 0x7F
    masked = h[1] & 0x80
    if ln == 126:
        ln = struct.unpack(">H", await r.readexactly(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", await r.readexactly(8))[0]
    key = await r.readexactly(4) if masked else None
    data = await r.readexactly(ln) if ln else b""
    if key:
        data = bytes(b ^ key[i % 4] for i, b in enumerate(data))
    return op, data


def frame(op, data=b""):
    n = len(data)
    if n < 126:
        head = bytes([0x80 | op, n])
    elif n < 65536:
        head = bytes([0x80 | op, 126]) + struct.pack(">H", n)
    else:
        head = bytes([0x80 | op, 127]) + struct.pack(">Q", n)
    return head + data


def http(w, code, texto):
    cuerpo = texto.encode()
    w.write(("HTTP/1.1 %s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % (code, len(cuerpo))).encode() + cuerpo)


async def handle(r, w, cfg):
    peer = w.get_extra_info("peername")
    try:
        raw = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        lineas = raw.decode("latin1").split("\r\n")
        path = lineas[0].split(" ")[1] if len(lineas[0].split(" ")) > 1 else "/"
        hdr = {}
        for line in lineas[1:]:
            if ":" in line:
                k, v = line.split(":", 1); hdr[k.strip().lower()] = v.strip()
        key = hdr.get("sec-websocket-key")
        if not key:
            http(w, "200 OK", "Puente MQTT funcionando"); await w.drain(); w.close(); return
        dest = ruta(path, cfg)
        if not dest:
            http(w, "400 Bad Request", "Ruta inválida. Usá /servidor/puerto/tls"); await w.drain(); w.close()
            print("rechazado (ruta inválida):", path); return
        host, port, tls = dest
        if not destino_ok(host, port, cfg["extra"]):
            http(w, "403 Forbidden", "Destino no permitido: %s:%d (agregalo con --permitir)" % (host, port)); await w.drain(); w.close()
            print("rechazado (no está en la lista):", host, port); return
        # primero se abre el TCP/TLS; si falla, el navegador recibe un error y prueba otra vía
        ctx = ssl.create_default_context() if tls else None
        tr, tw = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=ctx, server_hostname=host if tls else None), 12)
        acc = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n" % acc
        if "mqtt" in hdr.get("sec-websocket-protocol", ""):
            resp += "Sec-WebSocket-Protocol: mqtt\r\n"
        w.write((resp + "\r\n").encode()); await w.drain()
        print("conectado:", peer[1] if peer else "?", "->", host, port, "TLS" if tls else "TCP")
    except Exception as e:
        print("no se pudo abrir:", repr(e)[:120])
        try:
            http(w, "502 Bad Gateway", "No se pudo llegar al servidor"); await w.drain(); w.close()
        except Exception:
            pass
        return

    async def ws_to_tcp():
        while True:
            op, data = await read_frame(r)
            if op in (0, 1, 2):
                tw.write(data); await tw.drain()
            elif op == 9:
                w.write(frame(10, data)); await w.drain()
            elif op == 8:
                return

    async def tcp_to_ws():
        while True:
            data = await tr.read(16384)
            if not data:
                return
            w.write(frame(2, data)); await w.drain()

    tasks = [asyncio.ensure_future(ws_to_tcp()), asyncio.ensure_future(tcp_to_ws())]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in tasks:
        t.cancel()
    for x in (w, tw):
        try: x.close()
        except Exception: pass
    print("cerrado:", peer[1] if peer else "?", host, port)


def mqtt_connect(user, clave):
    """Paquete CONNECT de MQTT 3.1.1 (para --probar)."""
    def s(t): b = t.encode(); return struct.pack(">H", len(b)) + b
    flags = 0x02 | (0x80 if user else 0) | (0x40 if clave else 0)
    cid = "probe%d" % (int(time.time()) % 100000)
    cuerpo = s("MQTT") + bytes([4, flags]) + struct.pack(">H", 30) + s(cid) + (s(user) if user else b"") + (s(clave) if clave else b"")
    n = len(cuerpo); rl = bytearray()
    while True:
        d = n % 128; n //= 128
        rl.append(d | (128 if n else 0))
        if not n: break
    return bytes([0x10]) + bytes(rl) + cuerpo


CONNACK = {0: "aceptado", 1: "versión no soportada", 2: "identificador rechazado", 3: "servidor no disponible", 4: "usuario o clave incorrectos", 5: "no autorizado"}


async def probar_uno(host, puertos):
    for port in puertos:
        tls = port != 1883
        t0 = time.time()
        try:
            ctx = ssl.create_default_context() if tls else None
            tr, tw = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=ctx, server_hostname=host if tls else None), 8)
        except Exception as e:
            print("  %-26s %-5d %s  sin conexión (%s)" % (host, port, "TLS" if tls else "TCP", type(e).__name__)); continue
        ms = int((time.time() - t0) * 1000)
        u, c = PRUEBA.get(host, ("", ""))
        try:
            tw.write(mqtt_connect(u, c)); await tw.drain()
            d = await asyncio.wait_for(tr.readexactly(4), 8)
            ok = d[0] == 0x20 and d[1] == 2
            est = ("MQTT: " + CONNACK.get(d[3], "código %d" % d[3])) if ok else "respondió algo que no es MQTT"
        except Exception as e:
            est = "conecta pero no responde MQTT (%s)" % type(e).__name__
        tw.close()
        print("  %-26s %-5d %s  %4d ms  %s" % (host, port, "TLS" if tls else "TCP", ms, est))
        return True
    return False


async def probar():
    print("Probando cada servidor (conexión TCP/TLS y saludo MQTT)…\n")
    buenos = 0
    for host, puertos in CONOCIDOS.items():
        if await probar_uno(host, puertos): buenos += 1
    print("\n%d de %d servidores respondieron. (“usuario o clave incorrectos” también cuenta: el servidor está vivo;" % (buenos, len(CONOCIDOS)))
    print("en el portal se cargan el usuario y la clave de cada uno.)")
    if buenos == 0:
        print("Ninguno responde: revisá tu conexión a Internet, el firewall o el antivirus.")


async def main():
    cfg = parse()
    if cfg["probar"]:
        await probar(); return
    try:
        srv = await asyncio.start_server(lambda r, w: handle(r, w, cfg), "127.0.0.1", cfg["listen"])
    except OSError:
        print("El puerto %d ya está en uso: el puente probablemente ya está funcionando. No hace falta abrirlo de nuevo." % cfg["listen"]); return
    print("Puente MQTT listo en ws://localhost:%d" % cfg["listen"])
    print("Atiende a todos los servidores a la vez:")
    for h, p in CONOCIDOS.items():
        print("   %-26s puertos %s" % (h, ", ".join(str(x) for x in p)))
    for h in cfg["extra"]:
        print("   %-26s (permitido por --permitir)" % h)
    print("Ruta sin servidor (ws://localhost:%d/) -> %s:%d" % (cfg["listen"], cfg["raiz"][0], cfg["raiz"][1]))
    print("Dejá esta ventana abierta. Ctrl+C para cerrar.\n")
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
