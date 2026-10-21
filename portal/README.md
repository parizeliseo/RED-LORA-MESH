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
