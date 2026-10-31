/* Prueba el puente MQTT integrado como lo usa el portal: WebSocket con protocolo "mqtt" hacia un
   servidor MQTT por TCP. Además prueba que rechace lo que no debe pasar. */
const WebSocket = require("/root/winapp/node_modules/ws");
const { crearPuente } = require("../src/puente");

/* paquetes MQTT 3.1.1 mínimos */
const str = (t) => { const b = Buffer.from(t); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]); };
const largo = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; o.push(d); } while (n); return Buffer.from(o); };
const pkt = (tipo, cuerpo) => Buffer.concat([Buffer.from([tipo]), largo(cuerpo.length), cuerpo]);
const CONNECT = pkt(0x10, Buffer.concat([str("MQTT"), Buffer.from([4, 2, 0, 30]), str("prueba-puente")]));
const SUBSCRIBE = pkt(0x82, Buffer.concat([Buffer.from([0, 1]), str("msh/prueba/#"), Buffer.from([0])]));
const PUBLISH = pkt(0x30, Buffer.concat([str("msh/prueba/eco"), Buffer.from("hola desde el puente")]));

function probar(url, origen) {
  return new Promise((res) => {
    const ws = new WebSocket(url, ["mqtt"], { headers: origen ? { Origin: origen } : {} });
    const visto = [];
    const fin = (r) => { try { ws.terminate(); } catch (e) {} res(r); };
    ws.on("unexpected-response", (_q, r) => fin({ rechazado: r.statusCode }));
    ws.on("error", (e) => fin({ error: e.message }));
    ws.on("open", () => { visto.push("abierto(" + ws.protocol + ")"); ws.send(CONNECT); });
    ws.on("message", (d) => {
      const t = d[0] >> 4;
      if (t === 2) { visto.push("CONNACK=" + d[3]); ws.send(SUBSCRIBE); }
      else if (t === 9) { visto.push("SUBACK"); ws.send(PUBLISH); }
      else if (t === 3) {
        let i = 1; while (d[i] & 128) i++; i++;            /* saltar el largo variable */
        const lt = d.readUInt16BE(i), topico = d.slice(i + 2, i + 2 + lt).toString(), dato = d.slice(i + 2 + lt).toString();
        visto.push("PUBLISH recibido en " + topico + ": «" + dato + "»"); fin({ ok: true, visto });
      }
    });
    setTimeout(() => fin({ ok: false, visto, motivo: "tiempo agotado" }), 6000);
  });
}

(async () => {
  const p = crearPuente(() => {});
  console.log("abrir:", await p.abrir());
  console.log("estado:", p.estado());

  const http = await fetch("http://127.0.0.1:9001/").then((r) => r.status + " " + r.statusText).catch((e) => "falla " + e.message);
  console.log("¿estás? (lo que pregunta el portal):", http);

  console.log("\nportal (origen file://) → servidor TCP 127.0.0.1:1883:");
  console.log("  ", await probar("ws://127.0.0.1:9001/127.0.0.1/1883/tcp", "file://"));
  console.log("portal sin Origin (como la app):");
  console.log("  ", await probar("ws://127.0.0.1:9001/127.0.0.1/1883/tcp", null));

  console.log("\nlo que debe rechazar:");
  console.log("  una página de Internet:", await probar("ws://127.0.0.1:9001/127.0.0.1/1883/tcp", "https://pagina-cualquiera.com"));
  console.log("  un puerto que no es MQTT (22):", await probar("ws://127.0.0.1:9001/127.0.0.1/22/tcp", "file://"));
  console.log("  una ruta inválida:", await probar("ws://127.0.0.1:9001/a b/xx/zz", "file://"));
  console.log("  un servidor que no existe:", await probar("ws://127.0.0.1:9001/no-existe.invalid/1883/tcp", "file://"));

  console.log("\nsegunda copia en el mismo puerto (otro programa ya lo usa):");
  const p2 = crearPuente(() => {});
  console.log("  ", await p2.abrir());
  p.cerrar();
  console.log("tras cerrar:", p.estado());
  process.exit(0);
})();
