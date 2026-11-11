# Puente MQTT para Windows

Algunos servidores MQTT solo ofrecen TCP, y un navegador solo habla WebSocket. Este puente, escrito
en Python y sin dependencias, traduce entre los dos para que el portal de la computadora llegue
también a esos servidores.

**La aplicación para Windows y la de Android no lo necesitan:** ya lo traen integrado.

## Uso

1. Instalar Python desde python.org, marcando *Add Python to PATH*.
2. Dejar todos los archivos de esta carpeta juntos.
3. Doble clic en `instalar-boton-puente.bat` (una sola vez).
4. En el portal, tocar **Iniciar puente**.

`iniciar-puente.bat` lo levanta a mano y `detener-puente.bat` lo cierra.
Para probar qué servidores responden: `python puente-mqtt.py --probar`.

## Ver si está conectado

Desde la versión 1.10 el puente mira lo que pasa sin modificarlo: lee la respuesta del servidor al
saludo MQTT (si aceptó el usuario y la clave), cuenta los mensajes que van y vienen y anota los
últimos problemas explicados en castellano. El portal lo lee de `http://127.0.0.1:9001/estado` y lo
muestra en el botón del puente (verde, ámbar o rojo) y en el panel **Puente MQTT**.

```json
{ "puente": "Python", "version": "1.11", "activo": true, "conectados": 1,
  "conexiones": [{ "servidor": "…", "puerto": 1883, "tls": false, "mqtt": "conectado",
                   "recibidos": 23, "enviados": 0, "bytesRx": 851, "bytesTx": 86, "desde": 0, "ultimo": 0 }],
  "errores": [{ "t": 0, "servidor": "…", "puerto": 8884, "veces": 3,
                "texto": "El servidor «…» no dejó entrar: usuario o clave incorrectos" }] }
```

Es el mismo formato que usa el puente integrado en la aplicación de Windows.

## Seguridad

- Escucha solo en esta computadora (`127.0.0.1`).
- Solo reenvía a los servidores de su lista (y a los que agregues con `--permitir`).
- **Solo atiende al portal:** rechaza las conexiones y los pedidos de estado que vengan de una página
  de Internet (se mira el encabezado `Origin`). El portal abierto como archivo sí puede usarlo.

## Probarlo

```
python pruebas/t_puente_solo.py
```

Levanta un servidor MQTT de mentira en la misma computadora, abre el puente en un puerto libre y le
habla como el portal. No necesita Internet, navegador ni instalar nada, y anda en Windows, Linux y
macOS con Python 3.8 o más nuevo. Termina con `TODO BIEN` si las 29 comprobaciones dieron bien.
GitHub la corre sola en cada cambio (pestaña **Actions** → *Puente MQTT (Python)*).

`pruebas/t_puente_portal.py` es la prueba completa con el portal en un navegador y un servidor
Mosquitto real; necesita Playwright y Mosquitto instalados.
