# Puente MQTT para Windows

Algunos servidores MQTT solo ofrecen TCP, y un navegador solo habla WebSocket. Este puente, escrito
en Python y sin dependencias, traduce entre los dos para que el portal de la computadora llegue
también a esos servidores.

**La aplicación Android no lo necesita:** ya lo trae integrado.

## Uso

1. Instalar Python desde python.org, marcando *Add Python to PATH*.
2. Dejar todos los archivos de esta carpeta juntos.
3. Doble clic en `instalar-boton-puente.bat` (una sola vez).
4. En el portal, tocar **Iniciar puente**.

`iniciar-puente.bat` lo levanta a mano y `detener-puente.bat` lo cierra.
Para probar qué servidores responden: `python puente-mqtt.py --probar`.
