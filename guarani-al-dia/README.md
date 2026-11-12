# Guaraní al día

Aplicación Android **libre y gratuita** para estudiantes de cualquier universidad o instituto que
use **SIU Guaraní**. Trae tu Guaraní completo adentro de la app, lo revisa sola cada cierto tiempo
y te avisa al celular cuando se carga una nota, se abre una inscripción o cambia cualquier cosa.

- Funciona con **cualquier SIU Guaraní 3 (autogestión)**: elegís tu institución de la lista o
  pegás la dirección de la tuya.
- **Varias cuentas**: una por facultad o institución, o más de un usuario en la misma. La app las
  revisa a todas.
- La contraseña se puede **guardar en el teléfono, cifrada**, o no guardarse nunca.
- Entra tanto con el formulario propio de Guaraní como con el **usuario institucional** (ingreso
  único SAML/CAS, como en UTN-FRBA o UNQ).

> No es una aplicación oficial del SIU ni de ninguna institución. La hizo un estudiante, y el
> código está abierto para que cualquiera lo revise.

## Descargar

| Archivo | Qué es |
|---|---|
| [`publicado/Guarani-al-dia-1.2.apk`](publicado/Guarani-al-dia-1.2.apk) | La aplicación, lista para instalar (Android 8.0 o más nuevo). |

Descargá el `.apk` en el celular, abrilo desde *Archivos* y permití la instalación desde esta
fuente. No está en Google Play. Cada versión se firma con la misma clave, así que se instala encima
de la anterior y conserva tus cuentas, datos y ajustes.

## Primeros pasos

1. Abrí la app y tocá **Agregar mi cuenta**.
2. En **Institución o facultad** escribí parte del nombre (por ejemplo *UTN*, *UNC* o *IUGNA*) y
   elegila. Si la tuya no aparece, pegá en **Dirección** la dirección de tu Guaraní: la que ves en
   el navegador cuando entrás a autogestión (por ejemplo `https://…/autogestion/`).
3. Poné tu **usuario** (DNI, legajo o e-mail, según tu institución) y tu **contraseña**.
4. Elegí si querés **guardar la contraseña en el teléfono** y tocá **Agregar cuenta y revisar**.
5. Aceptá las notificaciones y, en Ajustes, tocá **Permitir que funcione en segundo plano**, para
   que el ahorro de batería no frene las revisiones.

Para sumar otra facultad o institución, tocá **+ Nueva** en Ajustes (o **+ Cuenta** en el
tablero). Con dos o más cuentas aparece arriba del tablero un selector para pasar de una a otra.

La primera revisión de cada cuenta **no avisa nada**: toma una foto de cómo está tu Guaraní hoy.
Desde la segunda, avisa todo lo que cambie.

## ¿Guardar o no la contraseña?

| | Con la contraseña guardada | Sin guardarla |
|---|---|---|
| Revisión en segundo plano | Siempre: si la sesión vence, la app vuelve a entrar sola. | Mientras dure la sesión que abriste en la pestaña Guaraní. Cuando vence, te avisa que hay que volver a entrar. |
| Dónde queda | Cifrada en el teléfono con el **Android Keystore**. Nunca sale del teléfono, salvo hacia la dirección de Guaraní de esa cuenta (o hacia el ingreso único al que Guaraní te manda). | En ningún lado. |

También podés decidirlo después: si entrás a mano desde la pestaña **Guaraní**, la app te pregunta
si querés guardar la contraseña (*Guardar*, *Ahora no* o *Nunca para esta cuenta*). Las copias de
seguridad de Android están desactivadas para la app, así que la contraseña no viaja a la nube. Para
borrarla, destildá la opción en la cuenta o borrá la cuenta.

## Instituciones incluidas

Estas direcciones se comprobaron una por una contra el sitio real (12 de noviembre de 2026): todas
responden como SIU Guaraní autogestión para alumnos.

| Institución | Dirección |
|---|---|
| IUGNA — Instituto Universitario de Gendarmería Nacional | `https://siu.iugna.edu.ar/autogestion/` |
| UNC — Universidad Nacional de Córdoba | `https://autogestion.guarani.unc.edu.ar/` |
| UNLP — Universidad Nacional de La Plata | `https://autogestion.guarani.unlp.edu.ar/` |
| UNR — Universidad Nacional de Rosario | `https://autogestion-guarani.unr.edu.ar/` |
| UNT — Universidad Nacional de Tucumán | `https://guarani.unt.edu.ar/autogestion/` |
| UNSJ — Universidad Nacional de San Juan | `https://autogestion.guarani.unsj.edu.ar/` |
| UNSE — Universidad Nacional de Santiago del Estero | `https://autogestion.guarani.unse.edu.ar/unse/` |
| UNJu — Universidad Nacional de Jujuy | `https://alumnos.unju.edu.ar/unju/` |
| UNRN — Universidad Nacional de Río Negro | `https://guarani.unrn.edu.ar/g3w3/` |
| UNQ — Universidad Nacional de Quilmes | `https://autogestion.uvq.edu.ar/unq/` |
| UNVM — Universidad Nacional de Villa María | `https://autogestiong3.unvm.edu.ar/unvm/` |
| UNTREF — Universidad Nacional de Tres de Febrero | `https://autogestion.untref.edu.ar/` |
| UNAJ — Universidad Nacional Arturo Jauretche | `https://guarani.unaj.edu.ar/autogestion/` |
| UNCA — Universidad Nacional de Catamarca | `https://guarani.unca.edu.ar/autogestion/` |
| UNaF — Universidad Nacional de Formosa | `https://guarani.unf.edu.ar/autogestion/` |
| UNIPE — Universidad Pedagógica Nacional | `https://guarani.unipe.edu.ar/autogestion/` |
| UNRaf — Universidad Nacional de Rafaela | `https://guarani.unraf.edu.ar/autogestion/` |
| UNDEF — Instituto Universitario Aeronáutico (IUA) | `https://autogestion.iua.edu.ar/` |
| UNDEF — Facultad de Ingeniería del Ejército (FIE) | `https://www.fie.undef.edu.ar/siu/3w/` |
| IUSE — Instituto Universitario de Seguridad | `https://autogestion.iuse.edu.ar/` |
| UBA — Ciclo Básico Común (CBC) | `https://guarani.uba.ar/cbc/` |
| UBA — Facultad de Agronomía | `https://guarani.agro.uba.ar/agro/` |
| UBA — Facultad de Farmacia y Bioquímica | `https://guarani.ffyb.uba.ar/ffyb/` |
| UBA — Facultad de Ciencias Veterinarias | `https://guarani.fvet.uba.ar/veterinaria/` |
| UTN — Facultad Regional Buenos Aires (grado) | `https://guarani.frba.utn.edu.ar/autogestion/grado/` |
| UTN — Facultad Regional Concepción del Uruguay | `https://guarani.frcu.utn.edu.ar/autogestion/` |

**¿Tu institución no está?** Igual funciona: pegá la dirección en la cuenta. Y si querés que
aparezca en la lista para todos, [pedila acá](https://github.com/parizeliseo/RED-LORA-MESH/issues/new?template=nueva-institucion.yml)
o agregala vos en
[`instituciones.json`](app-android/app/src/main/assets/instituciones.json) con un *pull request*.

Algunas direcciones que suelen circular **no sirven para esta app**:

- Las que muestran **«Guaraní – Autentificación de Usuarios»** son el Guaraní de *gestión*, el que
  usa el personal administrativo, no la autogestión de alumnos.
- Las que funcionan sin `https` (solo `http`): Android bloquea esas conexiones por seguridad.

## Qué tiene

**Cuatro pestañas** (todas siguen a la cuenta elegida):

- **Tablero:** promedio, avance de la carrera, materias aprobadas y finales pendientes; novedades,
  fechas que se vienen, bandeja (mensajes, encuestas, exámenes inscriptos) y el estado de cada
  materia, que la app lee sola de tu historia académica. Deslizá hacia abajo para revisar en el
  momento.
- **Menú:** todas las secciones de tu Guaraní en botones. *Mi cuenta de alumno* sale del menú real
  de tu institución después de entrar (inscripción a materias y exámenes, plan, historia
  académica, datos personales, mensajes…). *Consultas públicas* y *Acceso y ayuda* salen de la
  portada de tu institución (fechas de examen, horarios, validador de certificados, recuperar
  contraseña…).
- **Guaraní:** el sitio completo dentro de la app, con ingreso automático. Se puede hacer todo lo
  que hace la web: inscribirse, descargar certificados (van a *Descargas*) y subir archivos.
- **Ajustes:** cuentas, frecuencia de revisión, avisos y páginas que se vigilan.

**Avisos, en cuatro canales** (cada uno se puede silenciar aparte desde Android). Con varias
cuentas, cada aviso empieza con el nombre de la cuenta.

| Canal | Cuándo llega |
|---|---|
| Notas y actas | Se carga o cambia una nota, una promoción, una regularidad o un acta. Ejemplo: *«Análisis Matemático I: aprobada con 7.»* |
| Inscripciones, períodos y vencimientos | Se abre o cierra una inscripción, aparece una mesa o turno, o un final está por vencer. |
| Otros cambios en Guaraní | Cualquier otra cosa que cambie (se puede apagar en Ajustes). |
| Estado de la sesión | Guaraní no deja entrar (contraseña cambiada, sesión vencida sin contraseña guardada, captcha). Avisa una sola vez. |

![Pestaña Menú](capturas/menu.png)

## Cómo funciona por dentro

- La revisión corre con **WorkManager**: sigue andando con la app cerrada y después de reiniciar el
  teléfono. Revisa las cuentas una detrás de otra, cada 15 minutos a 6 horas.
- Abre Guaraní en un navegador interno invisible que **comparte las cookies** con la pestaña
  Guaraní. Si la sesión venció, completa el formulario de ingreso igual que una persona; si la
  institución usa ingreso único, toca *Acceder* y completa la página de ingreso de la institución.
- Si dos cuentas son del mismo Guaraní, la app **cierra la sesión de una antes de abrir la otra**,
  para no mezclar datos.
- Recorre las páginas del menú del alumno (hasta 30 por cuenta), guarda el texto de cada una y lo
  compara con la revisión anterior, línea por línea. Lo que aparece o desaparece es la novedad.
- En la historia académica reconoce cada materia por su código (*«Física I (95-1124)»*) y saca
  **estado y nota**: entiende `8 (Ocho)`, `Nota: 9` o letras como `A`.
- Nada pasa por servidores propios ni de terceros: la app habla solo con el Guaraní de cada cuenta.

**Límites conocidos:** si Guaraní pide captcha al entrar, hay que hacerlo a mano una vez desde la
pestaña Guaraní. Fechas de Examen y Horarios de Cursadas son buscadores con filtros: se usan desde
el Menú, pero la app no los revisa sola (tus mesas sí, desde tu cuenta). Si tu carrera y otra
propuesta se eligen con un selector dentro de Guaraní, se vigila la que esté seleccionada; para la
otra, sumá su dirección en *Ajustes → Páginas que se vigilan*.

## Código

| Ruta | Qué es |
|---|---|
| `app-android/app/src/main/java/ar/pariz/guarani/MainActivity.kt` | Las cuatro pestañas, cuentas, descargas, subida de archivos, ingreso automático y la oferta de guardar la contraseña. |
| `…/Profiles.kt` | Las cuentas: institución, dirección, usuario y contraseña cifrada; sesiones separadas por cuenta. |
| `…/Instituciones.kt` + `assets/instituciones.json` | La lista de instituciones. |
| `…/Scraper.kt` | Navegador invisible: entra (formulario propio o ingreso único), lee los menús y recorre las páginas. |
| `…/Analyzer.kt` | Compara con la revisión anterior, lee materias y notas, y decide qué avisar. |
| `…/CheckWorker.kt`, `Scheduler.kt` | Revisión periódica de todas las cuentas. |
| `…/Notifier.kt` | Los cuatro canales de notificación. |
| `…/Store.kt`, `Config.kt` | Datos de cada cuenta, fotos de cada página y ajustes generales. |
| `app-android/app/src/main/assets/dashboard.html`, `menu.html` | El tablero y la pestaña Menú. |
| `app-android/app/src/test/…/AnalyzerTest.kt` | Pruebas del lector de notas, de materias y de direcciones. |

Paquete `ar.pariz.guarani`, minSdk 26, targetSdk 35, Kotlin 2.0, Android Gradle Plugin 8.7.

### Compilar

```bash
cd guarani-al-dia/app-android
./gradlew testReleaseUnitTest assembleRelease
```

Necesita JDK 17 o más nuevo y el SDK de Android (API 35). Sin clave queda un APK sin firmar. Para
firmarlo, poné `guarani.keystore` y un `keystore.properties` en `app-android/app/`:

```properties
storePassword=…
keyAlias=guarani
keyPassword=…
```

**La clave de firma no se sube nunca al repositorio** (está en el `.gitignore`). Si se pierde, las
versiones nuevas ya no se pueden instalar encima de las viejas.
