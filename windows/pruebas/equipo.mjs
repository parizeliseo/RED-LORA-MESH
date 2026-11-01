/* Equipo de prueba en la red virtual de t_mired.js: un nodo con la API web, o un "router" que contesta una página web a todo. */
import http from "node:http";
// node equipo.mjs <ip> <nodo|router>
const [ip, tipo] = process.argv.slice(2);
http.createServer((req, res) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept" };
  if (tipo !== "nodo") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>router</html>"); }
  if (req.url.startsWith("/api/v1/toradio")) { res.writeHead(req.method === "OPTIONS" ? 204 : 200, h); return res.end(); }
  if (req.url.startsWith("/api/v1/fromradio")) { res.writeHead(200, { ...h, "Content-Type": "application/x-protobuf" }); return res.end(); }
  res.writeHead(200, h); res.end("nodo");
}).listen(80, ip, () => console.log("escuchando", ip, tipo));
