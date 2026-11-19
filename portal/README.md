# Portal — código fuente

El portal se entrega como **un único archivo HTML** con todo adentro (código, estilos, imágenes y
descriptores de protocolo). Eso permite copiarlo a una computadora sin internet y abrirlo con doble
clic.

## Compilar

```bash
npm install
node build.mjs
# resultado en dist/portal-meshtastic.html
```

`build.mjs` empaqueta con esbuild, incrusta el CSS y la imagen de fondo, y estampa la fecha de
compilación que después se ve en el menú lateral, en *Versión del software*.

## Qué hay en `src/`

| Ruta | Qué es |
|---|---|
| `app.js` | Toda la aplicación: conexión, mensajes, nodos, mapa, topología, MQTT, ajustes. |
| `style.css` | Estilos, incluidos los temas claro, oscuro, alto contraste y nocturno. |
| `template.html` | Plantilla donde se incrustan el CSS y el código. |
| `pb/` | Descriptores de protocolo del firmware 2.8. |
| `meta.json`, `es_*.json` | Metadatos de los campos de configuración y sus textos en castellano. |

## Pruebas

Necesitan Python 3 con Playwright (`pip install playwright==1.63.0 && playwright install chromium`)
y el portal ya compilado:

```bash
node build.mjs
python3 pruebas/t_pantallas.py   # las 46 pantallas en PC y en dos teléfonos
python3 pruebas/t_carga.py       # 10.000 nodos y 50.000 mensajes, con tiempos máximos
python3 pruebas/t_almacen.py     # historial: paso desde la versión vieja, bloques, copia y restauración
python3 pruebas/t_conectado.py   # conectado a un nodo simulado (pruebas/nodo_falso.mjs)
```

`SIN_MINIFICAR=1 node build.mjs` arma el portal sin comprimir, para medir con las herramientas del
navegador.

## Cuánto guarda

| Qué | Tope |
|---|---|
| Mensajes | 50.000 |
| Eventos | 20.000 |
| Telemetría | 2.000 por nodo de radio, 300 por nodo solo MQTT |
| Rutas medidas | 200 |
| Nodos | 5.000 de fábrica, hasta 20.000 (Ajustes) |

El historial va en IndexedDB (base `lora-mesh-datos`), por bloques de 2.000; los ajustes, en
`localStorage`.
