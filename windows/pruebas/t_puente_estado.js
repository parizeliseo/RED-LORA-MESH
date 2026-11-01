/*
 * El puente contra un servidor MQTT de verdad (Mosquitto), mirando lo que informa en /estado.
 * Necesita Mosquitto en 127.0.0.1 con tres puertas:
 *   1883 libre · 8884 con usuario "operador" y clave "secreto123" · 8883 TLS con certificado casero
 * Antes: npm install --no-save mqtt@5 (el cliente MQTT de la prueba; el programa no lo usa).
 * Uso: node pruebas/t_puente_estado.js            prueba el puente de la aplicación (con el 9001 libre)
 *      PUENTE=externo node pruebas/t_puente_estado.js   prueba el que ya esté abierto en el 9001, p. ej.
 *        python puente-mqtt.py --permitir 127.0.0.1 --permitir localhost --permitir servidor-que-no-existe.invalid
 */
const mqtt = require("mqtt");
const http = require("http");
const { execSync } = require("child_process");
const { crearPuente } = require("../src/puente");
let fallas = 0;
const chequeo = (n, c, d) => { if (!c) fallas++; console.log((c ? "✓ " : "✗ ") + n + (d !== undefined ? " · " + (typeof d === "string" ? d : JSON.stringify(d)) : "")); };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const leer = (origen) => new Promise((res) => http.get({ host: "127.0.0.1", port: 9001, path: "/estado", headers: origen ? { Origin: origen } : {} },
  (r) => { let t = ""; r.on("data", (d) => (t += d)); r.on("end", () => res({ status: r.statusCode, cors: r.headers["access-control-allow-origin"], json: (() => { try { return JSON.parse(t); } catch (e) { return null; } })() })); }));
const cliente = (ruta, op = {}) => mqtt.connect("ws://127.0.0.1:9001" + ruta, { wsOptions: { headers: { Origin: "null" } }, reconnectPeriod: 0, connectTimeout: 8000, ...op });

(async () => {
  let cambios = 0;
  const externo = process.env.PUENTE === "externo";
  const p = externo ? { cerrar() {} } : crearPuente(() => {}, () => cambios++);
  if (!externo) chequeo("el puente abre", (await p.abrir()).ok);
  else chequeo("hay un puente abierto", (await leer("null")).status === 200, (await leer("null")).json && (await leer("null")).json.puente);

  /* 1) conexión buena: el puente ve el saludo aceptado y cuenta mensajes */
  const c = cliente("/127.0.0.1/1883/tcp");
  await new Promise((res, rej) => { c.on("connect", res); c.on("error", rej); });
  await new Promise((res) => c.subscribe("prueba/#", res));
  for (let i = 0; i < 3; i++) c.publish("prueba/portal", "mensaje " + i);
  execSync("mosquitto_pub -h 127.0.0.1 -p 1883 -t prueba/otro -m uno && mosquitto_pub -h 127.0.0.1 -p 1883 -t prueba/otro -m dos");
  await esperar(600);
  let e = (await leer("null")).json;
  const k = e.conexiones[0] || {};
  chequeo("ve que el servidor aceptó la conexión", e.conectados === 1 && k.mqtt === "conectado", { mqtt: k.mqtt, servidor: k.servidor + ":" + k.puerto });
  chequeo("cuenta los mensajes enviados", k.enviados === 3, k.enviados);
  chequeo("cuenta los mensajes recibidos", k.recibidos === 5, k.recibidos);
  chequeo("cuenta los datos", k.bytesTx > 0 && k.bytesRx > 0, { tx: k.bytesTx, rx: k.bytesRx });
  if (!externo) chequeo("avisa cada cambio", cambios >= 3, cambios);

  /* 2) usuario o clave mal */
  const m = cliente("/127.0.0.1/8884/tcp", { username: "operador", password: "mal" });
  await new Promise((res) => { m.on("error", res); m.on("connect", res); });
  await esperar(300); m.end(true);
  e = (await leer("null")).json;
  chequeo("explica la clave equivocada", e.errores.some((x) => /8884/.test(x.puerto) && /no dejó entrar: (no autorizado|usuario o clave)/.test(x.texto)), e.errores[0] && e.errores[0].texto);

  /* 3) usuario y clave bien */
  const b = cliente("/127.0.0.1/8884/tcp", { username: "operador", password: "secreto123" });
  await new Promise((res, rej) => { b.on("connect", res); b.on("error", rej); });
  await esperar(300);
  e = (await leer("null")).json;
  chequeo("con la clave correcta entra", e.conectados === 2, e.conexiones.map((x) => x.puerto + ":" + x.mqtt));

  /* 4) TLS con certificado casero, 5) puerto cerrado, 6) servidor que no existe */
  const intentar = async (ruta) => { const x = cliente(ruta); await new Promise((res) => { x.on("error", res); x.on("connect", res); setTimeout(res, 14000); }); x.end(true); await esperar(200); return (await leer("null")).json.errores[0].texto; };
  const t1 = await intentar("/localhost/8883/tls");
  chequeo("explica el certificado inválido", /certificado de seguridad de «localhost» no es válido/.test(t1), t1);
  const t2 = await intentar("/127.0.0.1/8886/tcp");
  chequeo("explica el puerto cerrado", /rechazó la conexión en el puerto 8886/.test(t2), t2);
  const t3 = await intentar("/servidor-que-no-existe.invalid/1883/tcp");
  chequeo("explica el servidor que no existe", /No se encuentra el servidor/.test(t3), t3);
  const t4 = await intentar("/127.0.0.1/1883/tls");
  chequeo("explica TLS en un puerto sin TLS", /no usa TLS/.test(t4), t4);

  /* 7) el estado no se le muestra a una página de Internet */
  const w = await leer("https://pagina-cualquiera.com");
  chequeo("el estado no se muestra a páginas de Internet", w.status === 403 && !w.cors, w.status);
  const f = await leer("file://");
  chequeo("el portal abierto como archivo sí lo ve", f.status === 200 && f.cors === "file://");

  /* 8) el servidor se cae con la conexión abierta */
  execSync("for p in $(ss -ltnp | grep ':1883 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill $p; done");
  await esperar(1500);
  e = (await leer("null")).json;
  chequeo("explica que el servidor cortó", e.conectados === 0 && e.errores.some((x) => /cerró la conexión|cortó la conexión/.test(x.texto)), e.errores[0] && e.errores[0].texto);

  [c, b].forEach((x) => x.end(true));
  p.cerrar();
  console.log("\n" + (fallas ? fallas + " FALLAS" : "TODO BIEN"));
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
