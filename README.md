# Colegios El Alto: réplica mejorada del dashboard de educación

Ingeniería inversa del módulo educativo de [cuidados.elalto.gob.bo](https://cuidados.elalto.gob.bo/educacion/dashboard/) (unidades educativas **fiscales/públicas, de convenio y privadas**) y un sistema que lo replica y lo amplía.

```
docs/      hallazgos de ingeniería inversa, modelo de datos y mejoras
recon/     kit REA + Playwright para extraer endpoints, UI y datos del sitio original
app/       sistema mejorado: API FastAPI + dashboard (mapa, KPIs, gráficos, tabla, exportaciones)
tests/     pruebas (pytest)
```

## Arranque rápido

```bash
pip install -r requirements.txt
python app/data/make_demo.py                                   # datos FICTICIOS de prueba
python -m app.backend.importer app/data/demo_unidades.csv --fuente DEMO
uvicorn app.backend.main:app --reload                          # http://localhost:8000  ·  API: /docs
pytest -q
```

Datos reales: sigue los pasos de [`recon/README.md`](recon/README.md) y luego:

```bash
rm app/data/colegios.db
python -m app.backend.importer recon/out/harvest/data/* --fuente cuidados.elalto.gob.bo
```

## API

| Endpoint | Descripción |
|---|---|
| `GET /api/unidades` | Lista paginada (`page`, `page_size`, `orden`) |
| `GET /api/unidades/{id}` | Detalle |
| `GET /api/geojson` | Puntos para el mapa |
| `GET /api/estadisticas` | KPIs, dependencia, distrito × dependencia, nivel, turno, matrícula |
| `GET /api/catalogos` | Valores de los filtros |
| `GET /api/export.{csv,xlsx,pdf}` | Exportación (el PDF sigue el formato del "Reporte de Unidades Educativas" original) |

Todos aceptan los filtros `dependencia`, `distrito`, `nivel` y `turno` (repetibles), además de `subsistema`, `q`, `bbox` y `con_coordenadas`.
