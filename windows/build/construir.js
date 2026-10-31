/* Arma el instalador y el portable de Windows.
 *
 * En Windows usa el camino normal de electron-builder. En Linux, electron-builder genera el
 * desinstalador ejecutando el instalador bajo Wine; en macOS, en cambio, usa un lector de NSIS
 * escrito en JavaScript que lo saca del archivo sin ejecutar nada. Fuera de Windows se le pide
 * que use ese lector, así no hace falta Wine.
 *
 * Uso: npm run dist   (prepara el portal y después corre esto)
 */
if (process.platform !== "win32") {
  const mac = require("app-builder-lib/out/util/macosVersion");
  mac.isMacOsCatalina = () => true; /* solo cambia cómo se obtiene el desinstalador de NSIS */
}
const { build, Platform, Arch } = require("electron-builder");
build({ targets: Platform.WINDOWS.createTarget(["nsis", "zip"], Arch.x64), publish: "never" })
  .then((archivos) => { console.log("\nlisto:"); for (const a of archivos) console.log("  " + a); })
  .catch((e) => { console.error(e); process.exit(1); });
