/* Le pone al .exe el ícono propio y los datos del programa (nombre, versión, autor).
   electron-builder lo hace con rcedit, que en Linux necesita Wine; esto lo hace en JavaScript puro. */
const fs = require("fs");
const path = require("path");

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== "win32") return;
  const R = require("resedit/cjs"); /* resedit 3 es un módulo ES: esta es su entrada para require */
  const { NtExecutable, NtExecutableResource, Resource, Data } = await R.load();
  const info = ctx.packager.appInfo;
  const exe = path.join(ctx.appOutDir, info.productFilename + ".exe");
  const ico = path.join(ctx.packager.projectDir, "build", "icon.ico");

  const binario = NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const recursos = NtExecutableResource.from(binario);

  /* ícono: se reemplaza el grupo principal (el que muestra el Explorador y la barra de tareas) */
  const grupos = Resource.IconGroupEntry.fromEntries(recursos.entries);
  const principal = grupos[0];
  const iconos = Data.IconFile.from(fs.readFileSync(ico)).icons.map((i) => i.data);
  Resource.IconGroupEntry.replaceIconsForResource(recursos.entries, principal ? principal.id : 1, principal ? principal.lang : 1033, iconos);

  /* datos de versión: lo que muestra Propiedades → Detalles y el Administrador de tareas */
  const vi = Resource.VersionInfo.fromEntries(recursos.entries)[0];
  const idioma = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  const [a, b, c] = info.version.split(".").map((x) => parseInt(x, 10) || 0);
  vi.setFileVersion(a, b, c, 0, idioma.lang);
  vi.setProductVersion(a, b, c, 0, idioma.lang);
  vi.setStringValues(idioma, {
    FileDescription: info.productName + " · Sistema LoRa Mesh",
    ProductName: info.productName,
    CompanyName: "Ramón Eliseo Pariz",
    LegalCopyright: "© " + new Date().getFullYear() + " Ramón Eliseo Pariz · GPL-3.0",
    OriginalFilename: info.productFilename + ".exe",
    InternalName: info.productFilename,
    FileVersion: info.version,
    ProductVersion: info.version,
  });
  vi.outputToResourceEntries(recursos.entries);
  recursos.outputResource(binario);
  fs.writeFileSync(exe, Buffer.from(binario.generate()));
  console.log("  • ícono y datos de versión puestos en " + path.basename(exe));
};
