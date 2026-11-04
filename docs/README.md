# Instructivos

Acá está el **origen** de los tres instructivos en PDF que se publican en `publicado/`.

| Carpeta | Genera |
|---|---|
| `instructivo-portal/` | Instructivo del portal para computadora. |
| `instructivo-app/` | Instructivo de la aplicación Android. |
| `instructivo-windows/` | Instructivo de la aplicación para Windows (instalación y uso). |

En cada una: `content*.py` es el texto por capítulos, `img/` las capturas y `build_*.py` arma el
PDF (requiere `playwright` y `pypdf`).

```bash
cd instructivo-portal && python3 build_manual.py
cd instructivo-app    && python3 build_app.py
cd instructivo-windows && python3 build_win.py
```

Las capturas se generan con los guiones de prueba del propio portal, así que siempre muestran la
versión real y no maquetas. Las del instructivo de Windows salen del programa de escritorio real
con `windows/pruebas/capturas_instructivo.js`.
