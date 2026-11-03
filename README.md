# Colegios Handihand: dashboard de unidades educativas

Dashboard de unidades educativas **fiscales/públicas, de convenio y privadas**: mapa, indicadores, gráficos, listado y exportaciones, con acceso por usuario.

```
docs/      modelo de datos, mejoras, contrato del frontend y análisis de la BD real
db/        vista SQL sobre la BD de cuidados (Django/PostgreSQL): de aquí salen los datos
agentes/   COLEGIOS_HANDIHAND (PO), SCRUM_HANDIHAND y equipo DEV1/DEV2, ver docs/06-agentes.md y docs/07-desarrolladores.md
.claude/   agentes dev1-handihand y dev2-handihand y comando /sprint para Claude Code
sprints/   sprints exportados desde la página
app/       API FastAPI + dashboard (mapa, KPIs, gráficos, tabla, exportaciones)
tests/     pruebas: API (pytest) y frontend end-to-end (npm run test:e2e)
```

## Arranque rápido

**Con la BD de cuidados (PostgreSQL)**, que es de donde salen los datos reales: crea la vista y apunta el backend a la BD
(detalles y calidad de datos en [`docs/05-bd-cuidados.md`](docs/05-bd-cuidados.md)):

```bash
pip install -r requirements.txt
psql -d cuidados -f db/vista_unidad_educativa.sql
python -m app.backend.auth crear admin --nombre "Administrador"   # pide la contraseña
COLEGIOS_DB="postgresql+psycopg://usuario:clave@host/cuidados" uvicorn app.backend.main:app
```

**Sin BD (desarrollo)**, con datos ficticios:

```bash
pip install -r requirements.txt
python app/data/make_demo.py                                   # datos FICTICIOS de prueba
python -m app.backend.importer app/data/demo_unidades.csv --fuente DEMO
python -m app.backend.auth crear admin --nombre "Administrador"   # pide la contraseña
uvicorn app.backend.main:app --reload                          # http://localhost:8000  ·  API: /docs
pytest -q
```

## Login

El dashboard y toda la API `/api/*` exigen iniciar sesión (`/login.html`). Los usuarios se guardan en una BD propia
(`COLEGIOS_AUTH_DB`, por defecto `app/data/usuarios.db`), separada de la de cuidados, con contraseñas en scrypt.
La sesión es una cookie `HttpOnly` firmada que dura 8 h; 5 intentos fallidos desde una IP la bloquean 15 min.

```bash
python -m app.backend.auth crear <usuario> [--nombre "Nombre"] [--rol encargado]   # alta
python -m app.backend.auth rol <usuario> encargado|consulta     # cambiar rol
python -m app.backend.auth clave <usuario>                        # cambiar contraseña
python -m app.backend.auth desactivar|activar <usuario>
python -m app.backend.auth listar
```

Roles: `consulta` (por defecto) sólo ve el dashboard; `encargado` además puede dar de baja y reactivar colegios.
`listar` muestra el rol de cada usuario.

La BD del sistema guarda también las bajas lógicas de colegios (`unidad_estado` y su historial `unidad_estado_historial`):
la BD de cuidados no se modifica. Las tablas se crean al arrancar; si una tabla existente necesita una columna nueva,
el archivo SQLite se respalda antes en `<archivo>.bak-<fecha>` (en PostgreSQL, haga un `pg_dump` antes de desplegar).

| Variable | Uso |
|---|---|
| `COLEGIOS_SECRET` | Clave para firmar sesiones. **Defínela en producción**: sin ella se genera una al arrancar y las sesiones se pierden al reiniciar (y no sirven con varios workers). |
| `COLEGIOS_AUTH_DB` | URL de la BD de usuarios (p. ej. `sqlite:////datos/usuarios.db`). |
| `COLEGIOS_AUTH=0` | Desactiva el login (sólo desarrollo). |

La página estática (`app.build_static`) no tiene login: quien tenga el archivo ve los datos incrustados.

## Despliegue

- **Servidor**: `docker build -t colegios . && docker run -p 8000:8000 -v colegios-usuarios:/datos -e COLEGIOS_AUTH_DB=sqlite:////datos/usuarios.db -e COLEGIOS_SECRET=... -e COLEGIOS_DB="postgresql+psycopg://..." colegios`
  (crear usuarios: `docker exec -it <contenedor> python -m app.backend.auth crear admin`)
- **Página estática** (sin servidor, datos incrustados): `COLEGIOS_DB=... python -m app.build_static dist/colegios.html` (con mapa base; `--sin-tiles` para omitirlo)

## API

| Endpoint | Descripción |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/sesion` | Inicio y cierre de sesión |
| `GET /api/unidades` | Lista paginada (`page`, `page_size`, `orden`) |
| `GET /api/unidades/{id}` | Detalle |
| `GET /api/geojson` | Puntos para el mapa |
| `GET /api/estadisticas` | KPIs, dependencia, distrito × dependencia, nivel, turno, matrícula |
| `GET /api/catalogos` | Valores de los filtros |
| `GET /api/export.{csv,xlsx,pdf}` | Exportación (el PDF sigue el formato del "Reporte de Unidades Educativas" original). Sin botones en la interfaz |
| `POST /api/unidades/{id}/baja` · `POST /api/unidades/{id}/alta` | Baja lógica y reactivación con `confirmar: true` (rol encargado) |
| `GET /api/bajas` · `GET /api/unidades/{id}/historial` | Colegios dados de baja e historial de altas y bajas (rol encargado) |

Todos aceptan los filtros `dependencia`, `distrito`, `nivel` y `turno` (repetibles), además de `subsistema`, `q`, `bbox` y `con_coordenadas`.
