# RED LORA MESH — OPEN SOURCE PARIZ

[![Compilar el portal](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/compilar-portal.yml/badge.svg)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/compilar-portal.yml)
[![Aplicación de Windows](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/windows.yml/badge.svg)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/windows.yml)
[![Puente MQTT (Python)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/python.yml/badge.svg)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/python.yml)
[![Guaraní al día (Android)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/guarani.yml/badge.svg)](https://github.com/parizeliseo/RED-LORA-MESH/actions/workflows/guarani.yml)

Sistema de comunicaciones por radio **LoRa Mesh** para uso en terreno, sin depender de internet
ni de ningún servidor propio. Consta de tres piezas que hacen lo mismo:

- **El portal**: un único archivo HTML que se abre en el navegador de una computadora.
- **La aplicación para Windows**: el mismo portal como programa propio, con el puente MQTT
  incluido, avisos de Windows y lugar en la bandeja del sistema. Ver [`windows/`](windows/).
- **La aplicación Android**: el mismo portal como app, que se conecta al nodo por Bluetooth,
  cable USB-OTG o WiFi.

Los tres manejan un módulo de radio LoRa Mesh (probado con **Heltec V3**, firmware 2.8.x).

---

## Descargar y usar

Todo lo listo para usar está en [`publicado/`](publicado/):

| Archivo | Qué es |
|---|---|
| [`portal-lora-mesh.html`](publicado/portal-lora-mesh.html) | El portal para PC. Un solo archivo: se abre con doble clic. |
| [`OPEN-SOURCE-PARIZ-app-1.11.apk`](publicado/OPEN-SOURCE-PARIZ-app-1.11.apk) | La aplicación Android (7.0 o más nuevo). |
| [`Instructivo-portal-OPEN-SOURCE-PARIZ.pdf`](publicado/Instructivo-portal-OPEN-SOURCE-PARIZ.pdf) | Instructivo completo del portal, con capturas. |
| [`Instructivo-app-Android-OPEN-SOURCE-PARIZ.pdf`](publicado/Instructivo-app-Android-OPEN-SOURCE-PARIZ.pdf) | Instructivo completo de la aplicación. |
| [`Instructivo-app-Windows-OPEN-SOURCE-PARIZ.pdf`](publicado/Instructivo-app-Windows-OPEN-SOURCE-PARIZ.pdf) | Instructivo completo de la aplicación para Windows: instalación y uso, paso a paso. |

**En la computadora:** descargá el `.html`, abrilo con **Chrome, Edge, Brave u Opera**
y conectá el nodo. Para conectarte **por red (WiFi o LAN)** sirve cualquier navegador,
Firefox y Safari incluidos; lo único que esos dos no tienen es USB y Bluetooth.

Qué cambió en cada versión: [`CHANGELOG.md`](CHANGELOG.md).

**Aplicación para Windows 10 y 11:** el instalador pesa 116 MB, más que el límite de GitHub
para guardarlo en el repositorio. Lo arma y lo prueba GitHub en una computadora con Windows en
cada cambio: pestaña **Actions** → *Aplicación de Windows* → la última ejecución en verde →
**Artifacts**. Detalles en [`windows/README.md`](windows/README.md).

**En el celular:** descargá el `.apk`, abrilo desde *Archivos* y permití la instalación desde
esta fuente. No está en Google Play.

---

## Qué hace

- Mensajes por radio a canales o a un nodo puntual, con reintentos automáticos, respuestas
  citadas y reacciones con emoji.
- Lista de nodos con filtros y favoritos, y una ficha por nodo con señal, batería, vecinos,
  rutas medidas y gráficos de evolución. Los gráficos **marcan los huecos**: si el nodo estuvo
  callado un rato largo, ese tramo va punteado en vez de una línea llena, para no hacer creer que
  hubo mediciones donde no las hubo.
- Mapa con los nodos, su altura y su estado, con **descarga de zonas para usar sin señal**.
- **Topología** de la red que separa lo medido de lo inferido: nunca afirma que existe un enlace
  directo si los datos no lo confirman.
- Botón de **EMERGENCIAS** que manda la misma alerta a todos los canales.
- Semáforo de estado, registro de eventos y **libro de guardia** exportable a PDF y Excel.
- **MQTT** con hasta seis servidores, activables de a uno; el mensaje sale por el primero
  disponible en vez de repetirse por todos.
- Avisos del sistema (notificaciones de Android o de Windows) con la app en segundo plano.
- **GPS del celular o de la PC** para nodos que no tienen GPS propio.
- Canales compartibles por **código QR**, compatibles con otras aplicaciones LoRa Mesh.
- Configuración completa del nodo: radio, canales, dispositivo y módulos; respaldo y restauración.
- **Buscador de mensajes** en todas las conversaciones y **parte de situación** para leer por radio.
- **Copia de seguridad del portal**: lleva mensajes, nodos, servidores y guardia a otro navegador,
  a otra PC o a la aplicación de Windows.

Todo funciona **sin internet**. La conexión a internet solo agrega los servidores MQTT y los
mapas en línea.

---

## Estructura del repositorio

```
portal/            Código fuente del portal (JavaScript, se compila a un solo HTML)
  src/             Código, estilos, plantilla y descriptores de protocolo
  build.mjs        Compilación con esbuild
android/           Aplicación Android
  app/             Manifiesto, código Java, recursos y script de compilación
  herramientas/    Utilidad de alineado del APK
windows/           Aplicación para Windows (Electron): ventana, bandeja, puente y red propios
puente-mqtt/       Puente MQTT de Python, para el portal en el navegador (las apps ya lo traen)
publicado/         Archivos listos para usar: portal, APK e instructivos
docs/              Fuentes de los tres instructivos (texto, capturas y generador)
guarani-al-dia/    Proyecto aparte: app Android para SIU Guaraní, cualquier institución (ver abajo)
```

### Otro proyecto en este repositorio: Guaraní al día

[`guarani-al-dia/`](guarani-al-dia/) no tiene relación con la red LoRa: es una app Android libre
para estudiantes de **cualquier institución que use SIU Guaraní**. Trae Guaraní completo adentro,
admite varias cuentas (una por facultad o institución), puede guardar la contraseña cifrada en el
teléfono y avisa cuando cargan una nota, se abre una inscripción o cambia algo. El APK está en
[`guarani-al-dia/publicado/`](guarani-al-dia/publicado/) y todo lo demás, en su
[README](guarani-al-dia/README.md).

---

## Compilar

### Portal

Requiere Node.js 18 o más nuevo.

```bash
cd portal
npm install
node build.mjs
# resultado en dist/portal-meshtastic.html
```

### Aplicación Android

Se compila **sin Android Studio**: `aapt2` + `javac` + `dx` + alineado + firma.
El detalle de las herramientas está en [`android/README.md`](android/README.md).

```bash
cd android/app
bash build.sh
```

> La **clave de firma no está en este repositorio** y no debe estarlo. Es la que permite que una
> versión nueva se instale encima de la anterior conservando los datos. Se guarda aparte, en
> privado. Si se pierde, las futuras versiones no podrán instalarse encima y habrá que
> desinstalar la app, perdiendo lo guardado en el teléfono.

### Aplicación para Windows

Requiere Node.js 20 o más nuevo. Se arma en Windows o en Linux, sin Wine.

```bash
cd portal && npm ci --ignore-scripts && cd ..
cd windows
npm ci
npm run dist     # instalador y portable en windows/dist/
```

### Instructivos

```bash
cd docs/instructivo-portal   # o docs/instructivo-app, o docs/instructivo-windows
python3 build_manual.py      # o build_app.py
```

---

## Estado de las pruebas

Conviene ser claro sobre esto:

- El **portal** se prueba de forma automatizada contra un nodo simulado: mensajes, reintentos,
  MQTT, mapa, topología, guardia, rendimiento y escaneo de red.
- La **aplicación Android** se prueba con un puente simulado que reproduce lo que hace el
  teléfono (Bluetooth, USB, red, avisos y GPS), y el código Java compila limpio.
- La **aplicación para Windows** se arma y se prueba en una computadora con Windows de GitHub
  en cada cambio: abre el programa, revisa las nueve pantallas, el puente MQTT, la red propia y el
  selector USB, y lo instala y desinstala en silencio. Los dos puentes MQTT (el de la aplicación
  y el de Python) se prueban además contra un servidor Mosquitto real: conexión aceptada, clave
  equivocada, certificado inválido, puerto cerrado y servidor que se cae y vuelve.
- El **puente MQTT de Python** se prueba en cada cambio en computadoras de GitHub con Windows y
  con Linux, con Python 3.8 (el más viejo que soporta) y 3.14: que solo atienda al portal, que
  solo reenvíe a los servidores permitidos, que no toque los mensajes y que `/estado` diga la
  verdad. La prueba (`puente-mqtt/pruebas/t_puente_solo.py`) no necesita Internet ni instalar nada.
- **Lo que todavía no se probó en hardware real** es cualquiera de las dos aplicaciones contra un
  nodo físico: el teléfono por Bluetooth o USB-OTG, y en Windows los puertos COM reales y el
  emparejamiento Bluetooth con PIN. Si encontrás algo que no funciona, es el lugar más probable.

---

## Licencia

Publicado bajo **GPL-3.0** (ver [`LICENSE`](LICENSE)). Incluye componentes de terceros con esa
misma licencia; si lo redistribuís, mantené la licencia y entregá el código fuente.

Esta herramienta no está asociada ni respaldada por ningún organismo. Se entrega tal cual, sin
garantía. **No reemplaza a los servicios de emergencia.**
