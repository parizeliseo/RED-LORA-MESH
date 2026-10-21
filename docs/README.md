# Instructivos

Acá está el **origen** de los dos instructivos en PDF que se publican en `publicado/`.

| Carpeta | Genera |
|---|---|
| `instructivo-portal/` | Instructivo del portal para computadora. |
| `instructivo-app/` | Instructivo de la aplicación Android. |

En cada una: `content*.py` es el texto por capítulos, `img/` las capturas y `build_*.py` arma el
PDF (requiere `playwright` y `pypdf`).

```bash
cd instructivo-portal && python3 build_manual.py
cd instructivo-app    && python3 build_app.py
```

Las capturas se generan con los guiones de prueba del propio portal, así que siempre muestran la
versión real y no maquetas.
