/*
 * Búsqueda de nodos a partir de la red de la PC, contra equipos de verdad en una red virtual
 * (Linux, como root). Uso: xvfb-run -a node pruebas/t_mired.js
 *
 * Red de prueba: un switch virtual 10.77.0.0/24 con la PC en .10 y tres equipos:
 *   .57  nodo con la API web y placa de red Espressif (24:0a:c4:…)
 *   .99  placa ESP32 sin interfaz web (34:85:18:…)
 *   .200 "router": contesta una página web a todo (00:1a:2b:…)
 *
 *   ip link add br77 type bridge && ip addr add 10.77.0.10/24 dev br77 && ip link set br77 up
 *   mk(){ ip netns add $1; ip link add h$1 type veth peer name v$1; ip link set v$1 netns $1
 *         ip link set h$1 master br77; ip link set h$1 up
 *         ip netns exec $1 sh -c "ip link set v$1 address $3; ip addr add $2/24 dev v$1; ip link set v$1 up"; }
 *   mk nodo 10.77.0.57 24:0a:c4:12:34:56; mk espoff 10.77.0.99 34:85:18:aa:bb:cc; mk router 10.77.0.200 00:1a:2b:3c:4d:5e
 *   ip netns exec nodo   node pruebas/equipo.mjs 10.77.0.57 nodo &
 *   ip netns exec router node pruebas/equipo.mjs 10.77.0.200 router &
 */
const { _electron: electron } = require("/opt/npm-tools/node_modules/playwright");
const path = require("path"); const fs = require("fs"); const os = require("os");
let fallas = 0;
const chequeo = (n, c, d) => { if (!c) fallas++; console.log((c ? "✓ " : "✗ ") + n + (d !== undefined ? " · " + (typeof d === "string" ? d : JSON.stringify(d)) : "")); };
(async () => {
  const raiz = path.join(__dirname, ".."); const env = { ...process.env }; delete env.NODE_OPTIONS;
  const app = await electron.launch({ executablePath: path.join(raiz, "node_modules/electron/dist/electron"),
    args: [raiz, "--no-sandbox", "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "pz-mired-"))], env, timeout: 60000 });
  const win = await app.firstWindow(); const errores = []; win.on("pageerror", (e) => errores.push(String(e).slice(0, 160)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await win.waitForTimeout(2500);

  const redes = await win.evaluate(() => window.__nativeNet.redes());
  chequeo("el programa lee las redes de la PC", redes.length >= 2, redes.map((r) => r.nombre + " " + r.ip + "/" + r.prefijo + (r.principal ? " (principal)" : "")));
  const br = redes.find((r) => r.ip === "10.77.0.10");
  chequeo("arma el rango de la red", br && br.tramos[0] === "10.77.0.1-254" && br.direcciones === 254, br && br.tramos);

  await win.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Red \(WiFi \/ LAN\)/.test(x.innerText)); if (b) b.click(); });
  let abierto = await win.evaluate(() => !!document.querySelector(".scanbox"));
  if (!abierto) { await win.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Agregar conexión|Conectar nodo/.test(b.innerText)).click()); await win.waitForTimeout(600); abierto = await win.evaluate(() => !!document.querySelector(".scanbox")); }
  chequeo("se abre la búsqueda en la red", abierto);
  await win.waitForTimeout(800);
  const vista = await win.evaluate(() => ({ txt: document.querySelector(".mired") ? document.querySelector(".mired").innerText : "", pre: [...document.querySelectorAll(".scanbox input.inp")][0].value,
    botones: [...document.querySelectorAll(".scanbox button")].map((b) => b.innerText) }));
  chequeo("muestra las redes de esta PC", /10\.77\.0\.10/.test(vista.txt) && /sale a Internet/.test(vista.txt), vista.txt.replace(/\n/g, " | "));
  chequeo("el cuadro de redes ya trae la red de la PC", /10\.77\.0\.1-254/.test(vista.pre), vista.pre);
  chequeo("botón de buscar en la red de esta PC", vista.botones.some((b) => /Buscar en la red de esta PC|Buscar acá/.test(b)), vista.botones);
  await win.screenshot({ path: path.join(__dirname, "mired_antes.png") });

  /* buscar solo en la red de prueba */
  const t0 = Date.now();
  await win.evaluate(() => { const it = [...document.querySelectorAll(".mired-it")].find((x) => /10\.77\.0\.10/.test(x.innerText)); it.querySelector("button").click(); });
  await win.waitForFunction(() => /Se revisaron|detenida/.test((document.querySelector(".scanbox .scantxt") || {}).innerText || ""), null, { timeout: 120000 });
  const seg = Math.round((Date.now() - t0) / 100) / 10;
  const res = await win.evaluate(() => ({ txt: document.querySelector(".scanbox .scantxt").innerText, lista: document.querySelector(".scanbox .scanres").innerText, cargada: document.querySelectorAll(".modal input.inp")[1].value }));
  console.log(res.txt); console.log(res.lista.replace(/\n/g, " | "));
  chequeo("encuentra el nodo", /10\.77\.0\.57/.test(res.lista) && /Nodos encontrados: 1\./.test(res.txt));
  chequeo("lo marca como placa ESP32", /10\.77\.0\.57\s*ESP32/.test(res.lista));
  chequeo("carga la dirección sola", res.cargada === "10.77.0.57", res.cargada);
  chequeo("el router aparece como otro equipo, sin marca ESP32", /10\.77\.0\.200/.test(res.lista) && !/10\.77\.0\.200\s*ESP32/.test(res.lista));
  chequeo("muestra la placa ESP32 sin interfaz web", /Placas ESP32 en la red \(1\)/.test(res.lista) && /10\.77\.0\.99/.test(res.lista));
  const orden = await win.evaluate(() => { const r = document.querySelector(".scanbox .scanres"), d = document.querySelector(".scanbox details.scanavz"); return { resultadosArriba: !!(r && d && (r.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING)), plegado: d && !d.open }; });
  chequeo("los resultados quedan arriba y lo manual plegado", orden.resultadosArriba && orden.plegado, orden);
  chequeo("no se revisa a sí misma", !/10\.77\.0\.10\b/.test(res.lista));
  chequeo("tarda poco", seg < 6, seg + " s");
  await win.evaluate(() => document.querySelector(".scanbox .blkh").scrollIntoView({ block: "start" })); await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(__dirname, "mired_despues.png") });

  /* probar los puertos de la placa sin web */
  await win.evaluate(() => [...document.querySelectorAll(".scanres button")].find((b) => /Probar puertos/.test(b.innerText)).click());
  await win.waitForFunction(() => /Se revisaron|detenida/.test((document.querySelector(".scanbox .scantxt") || {}).innerText || ""), null, { timeout: 60000 });
  const r2 = await win.evaluate(() => document.querySelector(".scanbox .scantxt").innerText);
  chequeo("probar puertos de la placa", /10\.77\.0\.99/.test(r2), r2.slice(0, 160));
  chequeo("sin errores de JavaScript", errores.length === 0, errores);
  console.log("\n" + (fallas ? fallas + " FALLAS" : "TODO BIEN"));
  await app.evaluate(({ app }) => app.exit(0)); process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error("FALLÓ:", e); process.exit(1); });
