# Novedades

Las fechas son de publicación. La aplicación Android siempre se firma con **la misma clave**,
así que cada versión se instala encima de la anterior y conserva mensajes, nodos y ajustes.

---

## Mantenimiento — 11 de noviembre de 2026

No cambia el portal ni las aplicaciones (siguen en 1.11); cambia el puente de Python y las
comprobaciones automáticas.

### Las comprobaciones automáticas de GitHub, en verde y al día

- **Se fue el flujo «Python Package using Conda»**, que fallaba siempre. Era una plantilla genérica
  de GitHub para proyectos armados con Conda: buscaba un archivo `environment.yml` que este
  proyecto no tiene ni necesita. Estaba borrado desde el 24 de octubre; los avisos de falla de
  hoy salieron al volver a ejecutar a mano dos corridas viejas, que siempre usan el archivo de
  aquel día.
- **En su lugar hay una comprobación que sí sirve: «Puente MQTT (Python)».** Prueba el puente en
  Windows y en Linux, con Python 3.8 y 3.14, y revisa que todo el código Python compile y no
  tenga errores de programación.
- Los tres flujos usan las acciones actuales (ya no avisan «Node.js 20 is deprecated»), el portal
  se compila con Node 22 (Node 20 dejó de tener soporte) y cada flujo tiene solo permiso de
  lectura sobre el repositorio.

### Puente de Python 1.11

- **Arreglo:** cuando la salida del puente iba a un archivo o a otro programa en Windows (por
  ejemplo `python puente-mqtt.py > registro.txt`, o una tarea programada), una letra que Windows
  no podía escribir cortaba el pedido en curso: el portal no recibía el motivo de la falla y el
  problema no quedaba anotado en `/estado`. Abierto desde su ventana o con el botón del portal
  funcionaba bien. Ahora anota primero y escribe después, y nunca se corta por una letra.
- **Prueba nueva** `puente-mqtt/pruebas/t_puente_solo.py`: 29 comprobaciones con un servidor MQTT
  de mentira, sin Internet ni programas extra. Fue la que encontró el problema de arriba.

### Otros

- `.gitattributes`: los archivos `.bat` y `.vbs` conservan sus finales de línea de Windows.

---

## 1.11 — 3 de noviembre de 2026

### Instructivo de la aplicación para Windows

Nuevo PDF de 50 páginas y 23 capítulos, con capturas del programa real: requisitos y
controladores USB, instalación paso a paso (aviso de SmartScreen, instalador, versión portable),
conexión por USB, Bluetooth y red, todas las pantallas, el puente MQTT integrado, la bandeja del
sistema y los avisos de Windows, copias de seguridad, actualización, desinstalación, dónde quedan
los datos y solución de problemas. Está en `publicado/` y su origen en `docs/instructivo-windows/`.

### La app de Android se ajusta a la pantalla del celular

En un teléfono (412 px de ancho, como la mayoría) varias pantallas no entraban: la barra de arriba
ocupaba dos renglones, las pestañas de *Configuración del módulo* llenaban media pantalla y las
tablas de Nodos y Telemetría medían tres veces el ancho del teléfono. Ahora:

- **Barra de arriba en un solo renglón** (de 85 a 48 px): menú, hora UTC y local, el botón rojo
  **SOS** (el de EMERGENCIAS, abreviado) y los tres botones de estado. Entra desde 340 px; por
  debajo de 390 px la hora se muestra sin segundos. El botón del puente de Python no aparece en
  pantallas de celular, donde ese puente no puede funcionar.
- **Pestañas deslizables** en Configuración del módulo, del dispositivo y Ajustes: un solo
  renglón que se desliza con el dedo, con la pestaña elegida a la vista y un degradado que avisa
  que hay más (de 267 a 42 px en Módulo).
- **Nodos como tarjetas**: nombre, estado y función arriba; última vez, señal, saltos, batería y
  distancia abajo. Un selector elige el orden. Siguen dibujándose solo las visibles, así que
  conservan la fluidez con cientos de nodos.
- **Telemetría como tarjetas**: cada nodo con una grilla de 3 × 3 valores con su nombre.
- **Libro de guardia como tarjetas**: tipo, nodo, hora, canal y detalle.
- Las tarjetas se usan hasta 820 px, así que también sirven en tablets.
- El **detalle de telemetría** ya no se pasa de ancho: el gráfico estiraba toda la página.
- La hora y el selector del gráfico se ajustan; ninguna pantalla se sale de 360 ni de 412 px.

### El mapa de calles dejaba de verse

OpenStreetMap exige que quien pide el mapa se identifique, y el portal pedía las teselas sin
identificarse: en la app de Android y en la de Windows el mapa de calles (el de fábrica) se veía
lleno de carteles *«Access blocked»*. Ahora las dos apps piden las teselas por su propia red,
identificándose como `OPEN-SOURCE-PARIZ/<versión>`, y al actualizar borran las teselas del cartel
que hubieran quedado guardadas. En el navegador, donde el portal abierto como archivo no puede
identificarse, el mapa de fábrica pasa a ser el Político de CARTO, con los mismos datos de
OpenStreetMap.

### La dirección del servidor oficial ya no se ve

En *Configuración del módulo → MQTT* y en *Ajustes → Internet y MQTT*, el campo del servidor
oficial mostraba su dirección. Ahora aparece vacío con el texto *Servidor oficial de la red*, y si no
se toca, al guardar se conserva la dirección original.

### Instructivos

- Capturas nuevas de la app de Android, y explicación de la barra, las pestañas y las tarjetas.
- El instructivo del portal explica por qué el mapa de calles no anda desde el navegador.

---

## 1.10 — 1 de noviembre de 2026

### El puente MQTT dice si de verdad está conectado

Antes el botón decía *Puente: activo* apenas el puente escuchaba, aunque ningún servidor estuviera
conectado o el servidor hubiera rechazado la clave. Ahora los dos puentes (el integrado en la
aplicación de Windows y `puente-mqtt.py`) miran lo que pasa sin modificarlo:

- Leen la **respuesta del servidor al saludo MQTT**: aceptado, o rechazado y por qué (usuario o
  clave incorrectos, no autorizado, servidor no disponible…), en MQTT 3.1.1 y 5.
- **Cuentan los mensajes** recibidos y enviados, los datos y la última actividad de cada servidor.
- **Explican los problemas en castellano**: servidor que no existe, que no contesta, que rechaza
  el puerto, certificado inválido, TLS pedido a un puerto sin TLS, o corte con su duración. Si el
  mismo problema se repite porque el portal reintenta, se cuenta en vez de repetirse.
- Lo informan en `http://127.0.0.1:9001/estado`, que solo puede leer el portal.
- Detectan conexiones muertas en silencio (*keepalive* de TCP).

**En el portal**, el botón del puente muestra el estado real: *Puente: conectado* (verde),
*conectando…* (ámbar), *con problemas* (rojo), *listo* (azul) o *Iniciar puente*. Al pasar el mouse
lista cada servidor; al tocarlo abre el panel **Puente MQTT**, que se actualiza solo con cada
servidor, sus mensajes y los últimos problemas. En *Ajustes → MQTT* un servidor dice *por el
puente de esta PC* con sus mensajes, y si falla muestra el motivo que vio el puente en lugar de un
genérico *no se pudo conectar*.

**En la aplicación de Windows**, además:

- El **ícono de la bandeja** y el de la **barra de tareas** llevan un punto verde, ámbar o rojo.
- El **tooltip** de la bandeja resume el estado y el **menú** lista cada servidor con sus mensajes,
  o el último problema. *Ver el estado del puente…* abre el panel.
- Si con la ventana cerrada **se cortan todos los servidores**, avisa por Windows con el motivo
  (como mucho cada 5 minutos) y vuelve a avisar cuando se reconecta.
- El registro de diagnóstico incluye cada conexión y los últimos problemas.

### Seguridad del puente de Python

`puente-mqtt.py` ahora **rechaza las conexiones que vienen de páginas de Internet**, como ya hacía
el puente de la aplicación. Antes cualquier página abierta en el navegador podía usarlo para
llegar a los servidores de su lista.

### Otros

- La dirección del servidor oficial nunca se muestra: en el panel, la bandeja y los avisos se
  llama *servidor oficial de la red*.
- El puente de Python ya no ensucia su ventana con errores cuando le llega algo que no es un
  pedido web (por ejemplo, un intento de conexión segura).

Probado contra un servidor MQTT real (Mosquitto) con acceso libre, con usuario y clave, y con TLS
de certificado casero: conexión aceptada, clave equivocada, puerto cerrado, servidor inexistente,
certificado inválido, TLS en puerto sin TLS, y servidor que se cae y vuelve. No probado con
hardware real ni con un servidor de Internet desde Windows.

---

## 1.9 — 31 de octubre de 2026

### Buscar el nodo partiendo de la red de la PC (aplicación de Windows)

Antes había que saber la red y escribirla (o adivinar entre `192.168.1` y `192.168.0`). Ahora
la aplicación le pregunta a Windows a qué redes está conectada la PC y arranca desde ahí:

- **Redes de esta PC**: cada adaptador con su tipo (WiFi o cable), la IP de la PC, la red y
  cuántas direcciones tiene; la que sale a Internet va marcada. Los adaptadores virtuales
  (VirtualBox, VMware, Hyper-V, VPN, Bluetooth, contenedores) se reconocen por el nombre o por
  la placa de red virtual, quedan al final y no se revisan salvo que se pida.
- **Buscar en la red de esta PC**, un solo botón. Arma el rango con la IP y la máscara reales:
  redes de hasta /22 (1022 direcciones) enteras; si es más grande, el tramo /24 de la PC. La
  propia PC no se revisa.
- **Placas ESP32**: al terminar lee la tabla de vecinos de Windows (`arp -a`) y marca con
  **ESP32** los equipos cuya placa de red es de Espressif, el fabricante del chip de la
  Heltec V3. Lista aparte las placas ESP32 que están en la red pero no contestaron como nodo,
  con un botón para probar sus puertos.
- **Más rápida**: la tabla de vecinos dice qué direcciones tienen un equipo, así la primera
  pasada es corta y solo se vuelve a esperar a los equipos que existen. En la red de prueba:
  253 direcciones en 2,5 s (antes 12 s), y un nodo que perdía los primeros intentos de
  conexión se encontró igual.
- Los resultados quedan justo debajo del botón; la carga manual de redes y puertos pasó a
  *Otras redes y puertos*, plegado.

### Un router ya no pasa por nodo

Sin las trabas de CORS (aplicación de Windows y de Android), un equipo que contesta *200* a
cualquier dirección —muchos routers, impresoras y cámaras— se confirmaba como nodo. Ahora un
nodo tiene que contestar la API sin cuerpo o en binario, nunca con una página web; esos equipos
salen como *«es una página web, no un nodo»*. En el navegador se aplica lo mismo cuando el
equipo deja leer su respuesta.

### Otros

- La tapa del instructivo del portal decía *Versión 1.0, 19 de octubre* desde la primera
  entrega. Ahora dice la versión y la fecha reales.
- El flujo de Windows instala las dependencias del portal sin scripts: una librería ejecutaba
  `npx only-allow pnpm`, que en Windows fallaba.

---

## 1.8 — 31 de octubre de 2026

### Aplicación para Windows

El portal ahora también es un **programa propio para Windows 10 y 11** (64 bits), con instalador
y versión portable. Es el mismo portal con todas sus funciones, pero no depende del navegador:

- **USB y Bluetooth siempre**, con selectores propios. El de USB muestra los puertos COM, marca
  como *probable nodo* los chips de las placas conocidas (CP210x de la Heltec V3, CH340/CH9102,
  ESP32 con USB propio, nRF52) y, si hay uno solo, ya lo deja elegido. El de Bluetooth se va
  llenando a medida que aparecen nodos, y el PIN de emparejamiento lo pide la aplicación.
- **Red hecha por el programa**, no por la página: el escaneo prueba los puertos de verdad. En
  las pruebas encontró los cinco nodos simulados en 4 segundos —en el navegador tardaba 23 y
  dejaba afuera al que no daba permiso CORS— y la conexión por WiFi no depende de ese permiso.
- **Puente MQTT incluido**: ya no hace falta instalar Python. Usa el mismo contrato que
  `puente-mqtt.py`, escucha solo en esta computadora, solo reenvía a puertos MQTT y rechaza
  pedidos de páginas de Internet. Probado contra un servidor MQTT por TCP: conexión, suscripción
  y mensaje de ida y vuelta.
- **Bandeja del sistema**: cerrar la ventana no cierra el programa, que sigue recibiendo y
  avisando. Desde la bandeja: Emergencias, Parte de situación, estado del puente, *Iniciar con
  Windows* (arranca oculto en la bandeja) y Salir.
- **Avisos de Windows** que traen la ventana al tocarlos y abren la conversación; las alertas
  quedan en pantalla y hacen parpadear el ícono en la barra de tareas. Los mensajes sin leer se
  ven en el título: *(3) OPEN SOURCE PARIZ*.
- **Imprimir o guardar como PDF** directo, menú con atajos (Ctrl+1 a Ctrl+6, Ctrl+P para el
  parte), el instructivo incluido para leer sin Internet y un registro de diagnóstico.
- Seguridad: la ventana corre aislada, los enlaces externos se abren en el navegador de Windows y
  los fusibles de Electron impiden usar el programa como Node suelto o pasarle opciones de
  depuración. Verificado: aunque se le pida `--inspect`, no abre el depurador.

Se arma desde Linux sin Wine (el `.exe` recibe su ícono y sus datos con un editor de recursos en
JavaScript) y **GitHub lo arma y lo prueba en una computadora con Windows en cada cambio**: abre
el programa, revisa las nueve pantallas, el puente, la red y el selector USB, y lo instala y
desinstala en silencio. El instalador queda para descargar en la pestaña *Actions*.

### Copia de seguridad del portal

Todo lo que guarda el portal vive en cada navegador o cada aplicación por separado: al cambiar de
PC o pasar a la aplicación de Windows se empezaba de cero. Ahora *Ajustes → Copia de seguridad
del portal* guarda un `.json` con los mensajes, los nodos, la telemetría, los servidores MQTT,
las conexiones, los favoritos, el libro de guardia, los parámetros de emergencia, los mensajes
programados, los sonidos y las zonas del mapa, y lo restaura en otro lado. Muestra de cuándo es la
copia y qué trae antes de reemplazar nada, y rechaza un archivo que no sea una copia. Probado de
ida y vuelta, con acentos, y comprobado que no se lleva nada ajeno al portal.

### Pantallas

- **Nodos en el celular**: los filtros ocupaban toda la pantalla y la lista quedaba abajo, fuera
  de la vista: se entraba a *Nodos* y no se veía ningún nodo. En pantallas angostas los filtros se
  pliegan ahora detrás de un botón **Filtros**, que cuenta los que están puestos.
- La **estrella de favorito** medía 22 px de alto y el botón **Leyenda** del mapa 17 px: los dos
  pasaron a 28, el mínimo cómodo para el dedo.
- En el celular, los botones de zoom del mapa **tapaban el crédito de OpenStreetMap**; ahora va a
  su izquierda, entero.

### Corrección sobre versiones anteriores

En la revisión visual de la 1.7, en la de pantallas chicas de la 1.6 y en la medición de fluidez
de la 1.5, las pantallas de **Nodos, Mapa y Ajustes no se midieron de verdad**: las pruebas les
pedían esas pantallas al portal con nombres que no existen (`nodos`, `mapa`, `ajustes` en vez de
`nodes`, `map`, `settings`), y el portal mostraba Mensajes en su lugar. La auditoría de
accesibilidad sí usaba los nombres correctos, así que esa sigue valiendo. Ya están corregidas las
pruebas y medidas las tres pantallas; de ahí salieron los arreglos de arriba. En particular, el
mapa no se abre en 33 ms como decía la 1.5: con 600 nodos le lleva unos 70 ms de dibujo (unos 35 ms
más que con 50 nodos); con redes de tamaño normal queda al ras.

---

## 1.7 — 31 de octubre de 2026

### Buscador de mensajes

El portal guarda hasta 4000 mensajes y no había forma de volver a encontrar algo dicho días
atrás: solo quedaba desplazarse a mano. Ahora hay un buscador debajo de las pestañas de
canales, que busca en **todas las conversaciones a la vez** —canales y mensajes directos—
por el texto o por el nombre, la sigla o el identificador del nodo que lo mandó.

- Sin acentos y sin mayúsculas: buscar `arbol` encuentra `ÁRBOL`.
- Varias palabras exigen que estén **todas**, aunque aparezcan separadas.
- Cada resultado dice quién, en qué canal y cuándo, con lo buscado resaltado.
- Al tocar un resultado abre esa conversación y **salta hasta el mensaje**, que queda marcado
  unos segundos. Funciona aunque el mensaje esté a cientos de posiciones de distancia: la
  lista es virtual y se reposiciona hasta dar con él.

### Parte de situación

En *Novedades y guardia*, un botón arma en el momento un resumen del estado de la red en
texto plano, pensado para **leerlo por radio**, copiarlo en un mensaje o guardarlo con el
acta. Se elige el período, de la última hora a los últimos tres días, y sale con cuatro
partes: la estación propia (batería, uso del canal, enlace con el módulo, Internet y MQTT);
los nodos de la malla con el conteo y después nombre por nombre —primero los que tienen
alerta sin atender, después los caídos, los que están en atención con el motivo y los activos
con batería, señal y saltos—; el movimiento del período; y las observaciones del acta. Se
copia al portapapeles o se descarga como `.txt`. Dentro de la aplicación Android el copiado
usa el portapapeles del teléfono.

### Arreglado

- **El botón de opciones del mensaje quedaba 4 píxeles encima del texto**, en los cinco
  mensajes de prueba y en todos los anchos. Es una regresión de la 1.6: al agrandar el botón
  a 28 px (40 en el celular) el globo seguía reservando los 28 px del botón viejo. Ahora
  reserva 36 y 48. Verificado a 1440, 768, 412, 360 y 320 px: cero superposiciones.
- Las etiquetas `UTC` y `LOCAL` del reloj estaban en 10 px; pasaron a 11.

### Verificación de esta versión

38 pruebas automatizadas en verde (29 del portal, 6 de la aplicación y 3 del escaneo de red),
incluidas las de MQTT contra un broker local; accesibilidad WCAG 2.1 AA sin incumplimientos en
los cuatro temas y las catorce vistas; cero errores de JavaScript en Chromium, Firefox y
WebKit; las nueve pantallas revisadas en los cuatro temas a 1440, 768, 390, 360, 320 y 280 px
sin desbordes, texto cortado ni elementos encimados; y la APK firmada con la clave de siempre.

---

## 1.6 — 28 de octubre de 2026

### Los diálogos se manejan con el teclado

Ninguno de los cuadros de diálogo del portal se podía cerrar sin mouse, y mientras uno estaba
abierto el tabulador se iba por detrás, a la pantalla de atrás. Ahora, para todos a la vez:

- **Escape** cierra el que está arriba de todo, usando el cierre propio de cada uno —así se
  respeta la limpieza que hace cada diálogo, por ejemplo apagar la cámara del lector de QR—.
- Mientras está abierto, el tabulador da la vuelta adentro del diálogo y no se escapa.
- Al abrirse, el foco entra solo; al cerrarse, vuelve al botón que lo abrió.

Probado en la ficha de nodo y en los diálogos de conexión: el foco se queda adentro en las 25
pulsaciones de prueba, contra 5 de 25 antes.

### Se puede tocar con el dedo

El botón de opciones de cada mensaje (`⋯`) medía 22 píxeles de alto, por debajo de los 24 que
pide la norma de tamaño mínimo. Pasó a 28 en la computadora y 40 en el celular.

### Revisado en pantallas chicas

Se midieron las siete pantallas del portal a 280, 320, 360 y 768 píxeles de ancho: **ninguna
desborda**. Las tablas anchas —telemetría y libro de guardia— se desplazan de costado dentro de
su propio recuadro, como corresponde, sin arrastrar la página entera.

---

## 1.5 — 28 de octubre de 2026

### Anda en cualquier navegador

La conexión por red usaba `AbortSignal.any` y `AbortSignal.timeout`, funciones recientes
(`any` llegó en Chrome 116, Firefox 124 y Safari 17.4). Donde no existían —un Firefox ESR, un
teléfono con el visor web sin actualizar— **conectarse por WiFi fallaba sin decir nada**: el
portal se quedaba esperando. Ahora el portal las completa él mismo si faltan, y está probado
en los tres motores (Chromium, Firefox y WebKit/Safari), incluso simulando que no existen.

- Firefox y Safari se conectan al nodo por red sin ninguna limitación. USB y Bluetooth siguen
  siendo solo de Chrome, Edge, Brave y Opera, porque esos navegadores no los exponen.
- Si el navegador es tan viejo que no entiende el portal, ya **no queda una pantalla en
  blanco**: a los pocos segundos aparece un cartel que explica qué pasa y qué actualizar, con
  el nombre y la versión del navegador para poder reportarlo. También hay aviso si JavaScript
  está apagado.
- Reglas de estilo que un navegador viejo descarta enteras (`:has()`, `color-mix()`) tienen
  ahora una versión simple antes. Una de ellas dejaba el panel de un nodo por debajo de los
  avisos; otra pintaba de negro una banda de la topología.

### La malla explica por qué no entregó

Cuando la red rechazaba o no podía entregar algo, el motivo quedaba como un objeto mudo en la
consola del navegador. Ahora sale un aviso y queda registrado, en castellano y con qué hacer:
«Se acabaron los reintentos», «Sin ruta al destino», «Límite de uso del aire», «Clave pública
desconocida» y los otros catorce motivos que informa el firmware.

### Telemetría completa

- El portal entendía siete de las **nueve clases de telemetría** del firmware. Las dos que
  faltaban —**tráfico de la malla** y **suelo y agua**— se descartaban sin avisar: si un nodo
  las mandaba, ese paquete se perdía. Ahora se reciben, se grafican y se pueden pedir.
- Los **116 campos** de telemetría tienen nombre en castellano y unidad. Antes había 70 sin
  traducir: rayos, irradiación solar, pH y conductividad del suelo, oxígeno disuelto, canales
  de energía 4 a 8, entradas analógicas, sondas de temperatura, partículas por tamaño,
  formaldehído, índices VOC y NOx, y las estadísticas de tráfico de la malla.
- Las tablas de historial muestran los nombres traducidos en vez de `batteryLevel` o
  `airUtilTx`, con el nombre técnico en el globo de ayuda.

### La topología dejó de trabarse

Elegir un nodo o un enlace rehacía el dibujo entero. Con cientos de nodos eso tardaba un cuarto
de segundo en **cada clic**. Ahora se marca en el sitio: el trabajo bajó de unos 200 ms a 1,4 ms.
Pasados los 120 nodos los nombres largos se muestran solo en el nodo elegido, porque encimados
no se leían y eran la mitad del dibujo.

---

## 1.4 — 23 de octubre de 2026

### Los gráficos muestran los huecos

Era un error de lectura, no de estética. Si un nodo estaba callado un rato largo, el gráfico unía
los dos extremos con una línea llena y parecía que la batería o la señal habían bajado de a poco,
cuando en realidad **no hubo ninguna medición** en ese tramo. Ahora ese tramo va punteado y
apagado, y el corte se calcula solo: tres veces la mediana del intervalo entre muestras, con un
mínimo de diez minutos.

- Guía vertical al pasar el puntero por el gráfico, con la fecha, la hora y el valor exacto de la
  muestra; en pantalla táctil alcanza con tocar.
- La última medición queda siempre marcada, con un aro del color del fondo para despegarla.
- Las marcas de cada muestra se dibujan solo cuando son pocas (hasta 60), para que una serie larga
  no se convierta en una mancha.
- Las chispas de la ficha de nodo dejaron de deformar el punto final al estirarse, y ahora tienen
  texto alternativo con las muestras, el período, el mínimo, el máximo y el último valor.

### Textos de la interfaz

- Los avisos de error dicen qué pasó y cómo seguir. Por ejemplo, «No se pudo copiar» pasó a ser
  «El navegador no dejó copiar al portapapeles. Seleccioná el texto a mano y copialo con Ctrl+C».
- Las confirmaciones de borrado explican qué se pierde **antes** de preguntar: qué olvida el módulo
  al vaciar su lista de nodos, qué hace falta para volver a tener los mapas sin conexión, y que el
  nodo apagado solo se prende con el botón del módulo.

### Accesibilidad y seguridad

- WCAG 2.1 AA: cero incumplimientos de contraste, etiquetas, nombres de controles y zonas
  desplazables, en los cuatro temas (claro, oscuro, alto contraste y nocturno).
- Arreglada la inyección de fórmulas en los CSV exportados: un nombre de nodo que empieza con `=`
  ya no se ejecuta al abrir el archivo en Excel.
- Una lista interna de mensajes confirmados crecía sin tope en sesiones largas; ahora se poda.

### Limpieza

- Fuera cuatro declaraciones muertas y siete megas de respaldos de trabajo que no son código.
- `portal/package.json` con nombre, versión, licencia y repositorio reales, y con su
  `package-lock.json`.
- Un workflow que compila el portal en cada cambio, en vez de tres plantillas que no corresponden
  a este repositorio.

---

## 1.3 — 21 de octubre de 2026

- La aplicación habla con el nodo por red de forma nativa (Java, no el visor web): conectar por
  WiFi y buscar nodos es más rápido y confiable, y prueba los puertos de verdad con una conexión
  TCP en vez de adivinar con consultas web.
- Buscador de nodos rehecho en dos pasadas: ya no pierde los nodos lentos y explica el motivo
  cuando una dirección no se puede confirmar.
- El campo de redes acepta `192.168.1`, `192.168.1.*`, `192.168.1.0/24` y tramos
  `192.168.1.10-40`, y ofrece un botón para revisar la red entera si escribís una dirección sola.
- Bloques plegables en el panel lateral y versión del portal visible.
- Instructivo nuevo, aparte, dedicado a la aplicación Android.

---

## 1.2 — 21 de octubre de 2026

- Avisos del sistema (Android y Windows) con la aplicación en segundo plano, y alertas de
  emergencia con sonido de alarma.
- GPS del celular o de la PC para nodos que no tienen GPS propio.
- Responder citando y reaccionar con emoji; ficha completa de cada nodo con señal, batería,
  vecinos y rutas medidas.
- Canales compartibles por código QR, compatibles con otras aplicaciones LoRa Mesh.
- Mapa sin conexión por zonas descargables.

---

## 1.1 — octubre de 2026

Primera versión publicada: portal de un solo archivo, aplicación Android, mensajes por radio y por
MQTT, lista de nodos, mapa, topología, botón de emergencias, libro de guardia y configuración
completa del módulo.
