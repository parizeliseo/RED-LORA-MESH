/* Prepara lo que va adentro de la aplicación: el portal compilado y el instructivo.
   Por defecto toma el portal de ../portal y el instructivo de ../publicado (la estructura del
   repositorio). Se pueden indicar otras carpetas con las variables PORTAL e INSTRUCTIVO. */
import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, "..");
const portal = resolve(process.env.PORTAL || join(raiz, "..", "portal"));
const html = join(portal, "dist", "portal-meshtastic.html");
const pdfNombre = "Instructivo-portal-OPEN-SOURCE-PARIZ.pdf";
const pdf = resolve(process.env.INSTRUCTIVO || join(raiz, "..", "publicado", pdfNombre));

if (!existsSync(join(portal, "build.mjs"))) {
  console.error("No encuentro el código del portal en " + portal + ". Indicá la carpeta con PORTAL=...");
  process.exit(1);
}
console.log("compilando el portal en " + portal + " …");
execSync("node build.mjs", { cwd: portal, stdio: "inherit" });
mkdirSync(join(raiz, "app"), { recursive: true });
copyFileSync(html, join(raiz, "app", "index.html"));
console.log("portal copiado a app/index.html (" + Math.round(statSync(html).size / 1024) + " KB)");

mkdirSync(join(raiz, "recursos"), { recursive: true });
if (existsSync(pdf)) {
  copyFileSync(pdf, join(raiz, "recursos", pdfNombre));
  console.log("instructivo copiado (" + Math.round(statSync(pdf).size / 1024) + " KB)");
} else if (!existsSync(join(raiz, "recursos", pdfNombre))) {
  console.error("Falta el instructivo en " + pdf + ". Indicá dónde está con INSTRUCTIVO=...");
  process.exit(1);
}
