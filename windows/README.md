# Aplicación para Windows

El portal como **programa propio para Windows 10 y 11 (64 bits)**: su ventana, su ícono en el
menú Inicio y en la barra de tareas, y su lugar en la bandeja del sistema para seguir recibiendo
mensajes con la ventana cerrada. Es el mismo portal, con todas sus funciones, armado con
[Electron](https://www.electronjs.org/).

## Qué agrega frente al portal en el navegador

| Función | En el navegador | En la aplicación |
|---|---|---|
| USB y Bluetooth | Solo Chrome, Edge, Brave u Opera | Siempre, con su propio selector; marca los chips de las placas conocidas |
| PIN de Bluetooth | Ventana aparte de Windows | Lo pide la aplicación |
| Buscar nodos en la red | Consultas web; deja afuera a los equipos sin permiso CORS | Prueba los puertos de verdad, sin CORS |
| Puente MQTT | Instalar Python y el puente aparte | **Incluido**, se abre solo |
| Avisos | Con el navegador abierto | Avisos de Windows con la ventana cerrada; las alertas parpadean en la barra de tareas |
| Imprimir | Ventana del navegador | Guardar como PDF directo, o imprimir |

## Descargar

Cada cambio en `main` arma el instalador en una computadora con Windows de GitHub, lo **abre, lo
prueba, lo instala y lo desinstala**, y si todo da bien lo deja para descargar: pestaña
**Actions** → *Aplicación de Windows* → la última ejecución en verde → **Artifacts** →
`OPEN-SOURCE-PARIZ-Windows`. Trae:

- `OPEN-SOURCE-PARIZ-Windows-<versión>-instalador.exe` — el instalador.
- `OPEN-SOURCE-PARIZ-Windows-<versión>-portable.zip` — sin instalar: se descomprime y se abre.

El programa **no está firmado** con un certificado comercial: Windows muestra *«Windows protegió
su PC»*. Se sigue con **Más información → Ejecutar de todas formas**.

## Cómo está hecho

```
src/main.js      ventana, bandeja, menú, avisos, impresión y permisos de USB y Bluetooth
src/preload.js   lo que el programa le ofrece al portal, y los selectores de puerto, nodo y PIN
src/red.js       red hecha por el programa (mismo contrato que la app de Android)
src/puente.js    puente MQTT: WebSocket en 127.0.0.1:9001 → servidor MQTT por TCP
build/           ícono, licencia del instalador y scripts de armado
pruebas/         pruebas del programa (humo.js es la que corre en Windows)
```

El portal reconoce que corre dentro del programa por `window.__escritorio` y usa la red, los
avisos y la impresión del programa. El puente usa el mismo contrato que `puente-mqtt.py`, así que
el portal no necesitó cambios para usarlo.

**Seguridad.** El puente escucha solo en `127.0.0.1`, solo reenvía a puertos MQTT (1883, 8883,
8886, 8884) y rechaza conexiones que vengan de páginas de Internet. La red del programa acepta el
certificado propio del nodo solo en direcciones de la red local. La ventana corre aislada
(`contextIsolation`, `sandbox`), los enlaces externos se abren en el navegador de Windows, y los
fusibles de Electron impiden usar el ejecutable como Node suelto, pasarle opciones por
`NODE_OPTIONS` o cargar código que no esté dentro del paquete.

## Armar

Requiere Node.js 20 o más nuevo. Funciona en Windows y también en Linux, **sin Wine**.

```bash
cd portal && npm ci --ignore-scripts && cd ..
cd windows
npm ci
npm run dist          # prepara el portal y el instructivo, y arma instalador y portable en dist/
npm start             # o abrirlo sin armar, para probar
```

`build/portal.mjs` compila el portal de `../portal` y copia el instructivo de `../publicado`
(se pueden indicar otras carpetas con `PORTAL=` e `INSTRUCTIVO=`). `build/afterPack.js` le pone
al `.exe` el ícono y los datos del programa sin necesitar Windows. Fuera de Windows,
`build/construir.js` le pide a electron-builder que saque el desinstalador de NSIS con su lector
en JavaScript en lugar de ejecutar el instalador bajo Wine.

## Probar

```bash
node pruebas/humo.js                       # abre el programa armado y revisa todo
node pruebas/t_puente.js                   # el puente contra un servidor MQTT por TCP en 1883
```

Lo que **no** se puede probar sin hardware: puertos COM reales, el emparejamiento Bluetooth con
PIN y los avisos de Windows con un nodo de verdad.
