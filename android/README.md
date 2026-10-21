# Aplicación Android — OPEN SOURCE PARIZ

La app muestra el portal en un visor web y le da lo que el navegador de Android no tiene:
Bluetooth, USB serie, acceso a la red local, archivos, impresión y avisos.

## Qué hay acá

| Ruta | Qué es |
|---|---|
| `app/AndroidManifest.xml` | Paquete `ar.pariz.portal`, minSdk 24, targetSdk 34. |
| `app/java/.../MainActivity.java` | Visor del portal, permisos, archivos, impresión y el puente con JavaScript. |
| `app/java/.../BleManager.java` | Bluetooth LE: búsqueda, emparejado, MTU y cola de operaciones GATT. |
| `app/java/.../UsbSerial.java` | USB-OTG: CP210x, CH34x y CDC-ACM a 115200 8N1. |
| `app/java/.../NetBridge.java` | Red hecha por Android: sondeo TCP real y pedidos HTTP al nodo. |
| `app/java/.../WsBridge.java` | Puente MQTT integrado en `ws://127.0.0.1:9001`. |
| `app/java/.../Notifier.java` | Avisos por conversación; las alertas usan el sonido de alarma. |
| `app/java/.../KeepAliveService.java` | Notificación fija que mantiene viva la conexión. |
| `app/shim.js` | Da `navigator.bluetooth`, `navigator.serial` y la red nativa al portal. |
| `app/build.sh` | Compilación completa sin Android Studio. |
| `herramientas/alinear.py` | Alineado tipo `zipalign -P 16`. |

## Por qué la red la hace Android

El portal se sirve desde una dirección `https://` interna del visor web. Desde ahí, el visor pone
trabas para hablarle a equipos de la red local por `http://`. Pidiéndoselo a Android esas trabas
no existen, y además se puede probar un puerto de verdad con una conexión TCP, en vez de
adivinar con consultas web. Por eso buscar el nodo en la red es más rápido y confiable en la app
que en la computadora.

Los certificados propios del nodo se aceptan **solo en direcciones de red privada**
(192.168.x, 10.x, 172.16–31.x, 127.x y nombres `.local`). Nunca en internet.

## Compilar

```bash
bash app/build.sh
```

Herramientas: apktool 2.10.0 (trae `aapt2`), dex2jar 2.4.24 (trae `dx`), uber-apk-signer 1.3.0 y
`android.jar` de la API 34. El código se compila con `-source 8 -target 8`.

## Clave de firma

**No está en este repositorio y no debe estarlo.** Se guarda aparte, en privado. Todas las
versiones se firman con la misma clave para que la instalación encima de la anterior conserve los
datos del teléfono.
