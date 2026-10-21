import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
const r = await build({
  entryPoints: ["src/app.js"], bundle: true, minify: true, format: "iife", platform: "browser", write: false, target: "es2020",
  inject: ["./shims/process.js"], alias: { os: "./shims/os.js", path: "./shims/path.js", util: "./shims/util.js" }, logLevel: "warning",
});
let js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const fecha = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
js = js.replace(/__BUILD__/g, fecha);
const fondo = "data:image/jpeg;base64," + readFileSync("src/fondo.jpg").toString("base64");
const css = readFileSync("src/style.css", "utf8").replace("__FONDO__", () => fondo);
const html = readFileSync("src/template.html", "utf8").replace("/*CSS*/", () => css).replace("/*JS*/", () => js);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/portal-meshtastic.html", html);
console.log("OK", (html.length / 1024).toFixed(0) + " KB");
