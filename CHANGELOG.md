# Novedades

Las fechas son de publicación. La aplicación Android siempre se firma con **la misma clave**,
así que cada versión se instala encima de la anterior y conserva mensajes, nodos y ajustes.

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
