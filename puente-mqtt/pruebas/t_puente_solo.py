#!/usr/bin/env python3
"""Prueba del puente MQTT sin nada más que Python: ni navegador, ni Mosquitto, ni Internet.

Levanta un servidor MQTT de mentira en esta computadora, abre puente-mqtt.py en un puerto libre
y le habla como le habla el portal (WebSocket). Comprueba lo que el puente promete:

  - solo atiende al portal: una página de Internet no puede usarlo ni ver su estado;
  - solo reenvía a los servidores permitidos y rechaza rutas inválidas;
  - reenvía los bytes sin tocarlos, en los dos sentidos;
  - /estado dice la verdad: conectado, rechazado por usuario o clave, mensajes que van y vienen,
    y por qué falló lo último.

Uso:  python pruebas/t_puente_solo.py        (sale con 0 si todo dio bien)
Anda igual en Windows, Linux y macOS, con Python 3.8 o más nuevo.
"""
import base64, hashlib, json, os, re, socket, struct, subprocess, sys, threading, time

AQUI = os.path.dirname(os.path.abspath(__file__))
PUENTE = os.path.join(AQUI, "..", "puente-mqtt.py")
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
for _f in (sys.stdout, sys.stderr):  # en Windows la salida a un archivo no es UTF-8: que no falle por un tilde
    try: _f.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

fallas = 0
def chequeo(nombre, bien, detalle=""):
    global fallas
    if not bien: fallas += 1
    print(("ok    " if bien else "FALLA ") + nombre + ((" · " + str(detalle)) if detalle != "" else ""), flush=True)

def puerto_libre():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

# ── servidor MQTT de mentira: acepta a todos menos a la clave "mal", y devuelve lo que se publica ──
def leer_paquete(c):
    cab = c.recv(1)
    if not cab: return None, b""
    largo, mult = 0, 1
    while True:
        b = c.recv(1)
        if not b: return None, b""
        largo += (b[0] & 0x7F) * mult; mult *= 128
        if not b[0] & 0x80: break
    cuerpo = b""
    while len(cuerpo) < largo:
        d = c.recv(largo - len(cuerpo))
        if not d: return None, b""
        cuerpo += d
    return cab[0], cuerpo

def codificar(tipo_y_banderas, cuerpo):
    n, rl = len(cuerpo), bytearray()
    while True:
        d = n % 128; n //= 128
        rl.append(d | (128 if n else 0))
        if not n: break
    return bytes([tipo_y_banderas]) + bytes(rl) + cuerpo

def atender(c):
    try:
        while True:
            cab, cuerpo = leer_paquete(c)
            if cab is None: return
            tipo = cab >> 4
            if tipo == 1:    # CONNECT -> CONNACK (5 = no autorizado si la clave es "mal")
                c.sendall(bytes([0x20, 2, 0, 5 if cuerpo.endswith(b"\x00\x03mal") else 0]))
            elif tipo == 3:  # PUBLISH -> se lo devuelve tal cual
                c.sendall(codificar(cab, cuerpo))
            elif tipo == 12: # PINGREQ -> PINGRESP
                c.sendall(bytes([0xD0, 0]))
            elif tipo == 14: # DISCONNECT
                return
    except OSError:
        pass
    finally:
        try: c.close()
        except OSError: pass

def servidor_de_mentira():
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0)); s.listen(8)
    def aceptar():
        while True:
            try: c, _ = s.accept()
            except OSError: return
            threading.Thread(target=atender, args=(c,), daemon=True).start()
    threading.Thread(target=aceptar, daemon=True).start()
    return s, s.getsockname()[1]

# ── el lado del portal: HTTP y WebSocket a mano ──
def pedir(puerto, ruta, cabeceras=None):
    s = socket.create_connection(("127.0.0.1", puerto), timeout=10)
    extra = "".join("%s: %s\r\n" % kv for kv in (cabeceras or {}).items())
    s.sendall(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n%s\r\n" % (ruta, puerto, extra)).encode())
    datos = b""
    while True:
        try: d = s.recv(65536)
        except socket.timeout: break
        if not d: break
        datos += d
    s.close()
    cab, _, cuerpo = datos.partition(b"\r\n\r\n")
    lineas = cab.decode("latin1").split("\r\n")
    return int(lineas[0].split(" ")[1]), {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in lineas[1:] if ":" in l}, cuerpo.decode("utf-8", "replace")

def estado(puerto):
    return json.loads(pedir(puerto, "/estado")[2])

class Ws:
    """Un WebSocket mínimo, como el que abre el navegador."""
    def __init__(self, puerto, ruta, origen=None):
        self.s = socket.create_connection(("127.0.0.1", puerto), timeout=10)
        clave = base64.b64encode(os.urandom(16)).decode()
        cab = "GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: mqtt\r\n" % (ruta, puerto, clave)
        if origen: cab += "Origin: %s\r\n" % origen
        self.s.sendall((cab + "\r\n").encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            d = self.s.recv(4096)
            if not d: break
            resp += d
        cabecera, _, self.resto = resp.partition(b"\r\n\r\n")
        lineas = cabecera.decode("latin1").split("\r\n")
        self.codigo = int(lineas[0].split(" ")[1]) if len(lineas[0].split(" ")) > 1 else 0
        self.cab = {l.split(":", 1)[0].lower(): l.split(":", 1)[1].strip() for l in lineas[1:] if ":" in l}
        self.cuerpo = self.resto.decode("utf-8", "replace")
        self.acepta_bien = self.cab.get("sec-websocket-accept") == base64.b64encode(hashlib.sha1(clave.encode() + GUID).digest()).decode()

    def _leer(self, n):
        while len(self.resto) < n:
            d = self.s.recv(65536)
            if not d: raise ConnectionError("el puente cerró")
            self.resto += d
        d, self.resto = self.resto[:n], self.resto[n:]
        return d

    def enviar(self, datos, op=2):
        mascara = os.urandom(4); n = len(datos)
        cab = bytes([0x80 | op, 0x80 | n]) if n < 126 else bytes([0x80 | op, 0x80 | 126]) + struct.pack(">H", n)
        self.s.sendall(cab + mascara + bytes(b ^ mascara[i % 4] for i, b in enumerate(datos)))

    def recibir(self):
        h = self._leer(2); op, n = h[0] & 0x0F, h[1] & 0x7F
        if n == 126: n = struct.unpack(">H", self._leer(2))[0]
        elif n == 127: n = struct.unpack(">Q", self._leer(8))[0]
        return op, self._leer(n)

    def cerrar(self):
        try: self.enviar(b"", 8)
        except OSError: pass
        try: self.s.close()
        except OSError: pass

def conectar_mqtt(usuario="", clave=""):
    def s(t): b = t.encode(); return struct.pack(">H", len(b)) + b
    banderas = 0x02 | (0x80 if usuario else 0) | (0x40 if clave else 0)
    return codificar(0x10, s("MQTT") + bytes([4, banderas]) + struct.pack(">H", 30) + s("prueba") + (s(usuario) if usuario else b"") + (s(clave) if clave else b""))

def esperar(condicion, segundos=8):
    fin = time.time() + segundos
    while time.time() < fin:
        try:
            if condicion(): return True
        except Exception:
            pass
        time.sleep(0.1)
    return False

def main():
    srv, p_mqtt = servidor_de_mentira()
    p_puente, p_cerrado = puerto_libre(), puerto_libre()
    entorno = dict(os.environ, PYTHONUNBUFFERED="1")
    # la salida del puente va a un archivo, como cuando se lo abre sin ventana: ahí Windows no usa UTF-8
    registro = open(os.path.join(AQUI, "puente-de-prueba.log"), "wb")
    puente = subprocess.Popen([sys.executable, PUENTE, "--escuchar", str(p_puente), "--permitir", "127.0.0.1"], stdout=registro, stderr=subprocess.STDOUT, env=entorno)
    try:
        chequeo("el puente arranca y escucha", esperar(lambda: pedir(p_puente, "/")[0] == 200, 15))
        cod, _, cuerpo = pedir(p_puente, "/")
        chequeo("la raíz responde que el puente funciona", cod == 200 and "Puente MQTT funcionando" in cuerpo, cuerpo)

        e = estado(p_puente)
        fuente = open(PUENTE, encoding="utf-8").read()
        version = re.search(r'^VERSION = "([^"]+)"', fuente, re.M).group(1)
        chequeo("/estado dice qué puente es y su versión", e.get("puente") == "Python" and e.get("version") == version and e.get("puerto") == p_puente, "%s %s" % (e.get("puente"), e.get("version")))
        chequeo("/estado empieza sin conexiones ni errores", e.get("conectados") == 0 and e.get("conexiones") == [] and e.get("errores") == [])

        # solo el portal
        cod, cab, _ = pedir(p_puente, "/estado", {"Origin": "null"})
        chequeo("el portal abierto como archivo puede ver el estado", cod == 200 and cab.get("access-control-allow-origin") == "null")
        cod, _, _ = pedir(p_puente, "/estado", {"Origin": "https://pagina-de-internet.example"})
        chequeo("una página de Internet NO puede ver el estado", cod == 403, cod)
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_mqtt, "https://pagina-de-internet.example")
        chequeo("una página de Internet NO puede usar el puente", w.codigo == 403, w.codigo); w.cerrar()

        # solo destinos permitidos
        w = Ws(p_puente, "/servidor-no-permitido.example/1883/tcp")
        chequeo("rechaza un servidor que no está en la lista", w.codigo == 403 and "no permitido" in w.cuerpo, "%s %s" % (w.codigo, w.cuerpo)); w.cerrar()
        w = Ws(p_puente, "/broker.hivemq.com/22/tcp")
        chequeo("rechaza un puerto que no es de MQTT", w.codigo == 403, w.codigo); w.cerrar()
        w = Ws(p_puente, "/127.0.0.1/no-es-un-numero/tcp")
        chequeo("rechaza una ruta inválida", w.codigo == 400, w.codigo); w.cerrar()
        w = Ws(p_puente, "/127.0.0.1/%d/otra-cosa" % p_mqtt)
        chequeo("rechaza un modo que no es tls ni tcp", w.codigo == 400, w.codigo); w.cerrar()

        # conexión buena
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_mqtt, "null")
        chequeo("abre el WebSocket hacia un servidor permitido", w.codigo == 101 and w.acepta_bien and w.cab.get("sec-websocket-protocol") == "mqtt", w.codigo)
        w.enviar(conectar_mqtt())
        op, datos = w.recibir()
        chequeo("la respuesta del servidor llega sin tocar", op == 2 and datos == bytes([0x20, 2, 0, 0]), datos.hex())
        chequeo("/estado marca la conexión como conectada", esperar(lambda: estado(p_puente)["conectados"] == 1))
        c = (estado(p_puente)["conexiones"] or [{}])[0]
        chequeo("/estado nombra el servidor, el puerto y el tipo de conexión", c.get("servidor") == "127.0.0.1" and c.get("puerto") == p_mqtt and c.get("tls") is False and c.get("mqtt") == "conectado", c)

        tema, texto = b"msh/prueba", ("mensaje de prueba ñ á " + "x" * 300).encode()
        publicar = codificar(0x30, struct.pack(">H", len(tema)) + tema + texto)
        w.enviar(publicar[:7]); w.enviar(publicar[7:])   # en dos pedazos, como puede pasar en la red
        vuelta = b""
        while len(vuelta) < len(publicar):
            op, datos = w.recibir(); vuelta += datos
        chequeo("un mensaje largo va y vuelve idéntico", vuelta == publicar, "%d bytes" % len(vuelta))
        chequeo("/estado cuenta el mensaje enviado y el recibido", esperar(lambda: (lambda x: x.get("enviados") == 1 and x.get("recibidos") == 1)((estado(p_puente)["conexiones"] or [{}])[0])), (estado(p_puente)["conexiones"] or [{}])[0])

        w.enviar(b"hola", 9)
        op, datos = w.recibir()
        chequeo("responde al ping del navegador", op == 10 and datos == b"hola", op)
        w.cerrar()
        chequeo("al cerrar el portal, la conexión desaparece del estado", esperar(lambda: estado(p_puente)["conectados"] == 0 and estado(p_puente)["conexiones"] == []))
        chequeo("que cierre el portal no se anota como problema", estado(p_puente)["errores"] == [], estado(p_puente)["errores"])

        # clave incorrecta
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_mqtt)
        w.enviar(conectar_mqtt("operador", "mal"))
        op, datos = w.recibir()
        chequeo("el rechazo del servidor llega al portal", datos == bytes([0x20, 2, 0, 5]), datos.hex())
        chequeo("/estado explica el rechazo en castellano", esperar(lambda: any("no dejó entrar" in x["texto"] and "no autorizado" in x["texto"] for x in estado(p_puente)["errores"])), estado(p_puente)["errores"][:1])
        c = next((x for x in estado(p_puente)["conexiones"] if x.get("mqtt") == "rechazado"), {})
        chequeo("la conexión figura como rechazada, no como conectada", c.get("mqtt") == "rechazado" and estado(p_puente)["conectados"] == 0, c.get("mqtt"))
        w.cerrar()

        # servidor que no atiende
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_cerrado)
        chequeo("si el servidor no atiende, el portal recibe un error", w.codigo == 502, w.codigo); w.cerrar()
        err = estado(p_puente)["errores"]
        chequeo("/estado dice que el servidor rechazó la conexión", bool(err) and "rechazó la conexión" in err[0]["texto"] and err[0]["puerto"] == p_cerrado, err[:1])
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_cerrado); w.cerrar()
        err = estado(p_puente)["errores"]
        chequeo("el mismo problema repetido se cuenta, no se repite", bool(err) and err[0].get("veces") == 2 and sum(1 for x in err if x["puerto"] == p_cerrado) == 1, err[:1])

        # el servidor se cae con una conexión abierta
        w = Ws(p_puente, "/127.0.0.1/%d/tcp" % p_mqtt)
        w.enviar(conectar_mqtt()); w.recibir()
        esperar(lambda: estado(p_puente)["conectados"] == 1)
        w.enviar(bytes([0xE0, 0]))   # DISCONNECT: el servidor de mentira corta
        chequeo("si corta el servidor, queda anotado", esperar(lambda: any("cerró la conexión" in x["texto"] for x in estado(p_puente)["errores"])), estado(p_puente)["errores"][:1])
        w.cerrar()

        chequeo("el puente sigue en pie después de todo", puente.poll() is None and pedir(p_puente, "/")[0] == 200)
    finally:
        puente.terminate()
        try: puente.wait(10)
        except Exception: puente.kill()
        registro.close(); srv.close()
        salida = open(registro.name, encoding="utf-8", errors="replace").read()
        try: os.remove(registro.name)
        except OSError: pass
    chequeo("el puente no dejó errores de programa en su salida", "Traceback" not in salida)
    if "Traceback" in salida:
        print("\n── salida del puente ──\n" + salida[-3000:])
    print("\n%s" % ("TODO BIEN" if not fallas else "%d comprobaciones fallaron" % fallas))
    return 1 if fallas else 0

if __name__ == "__main__":
    sys.exit(main())
