# BD de cuidados: análisis y conexión

Análisis del dump `cuidados.sql` (PostgreSQL 17, pg_dump). Es una base **Django** con `django-simple-history` (tablas `historical*`), `django-guardian` (permisos por objeto), `django-mptt` (`core_gameaestructura`) y borrado lógico (`deleted`, `deleted_by_cascade`).

## Modelo

```
core_tipoinstitucion (9)  ── EDUCACION, SALUD, UNIDAD DE LA MUJER, ...
        │ 1:N
core_institucion (801)    ── nombre_institucion, zona, direccion, distrito, latitud, longitud,
        │                    telefono/celular/whatsapp (jsonb), correo, responsable, deleted
        │ N:M
core_institucionpropiedad (4424) ──> core_catalogogeneral (77): (propiedad, valor, color) por tipo
core_horario · core_institucionfoto · grupos_etarios · tipos_poblacion · tipos_servicio
```

Las características de cada institución son un **EAV**: cada fila de `core_catalogogeneral` es un par (propiedad, valor) asociado a un tipo de institución. Para EDUCACION:

| propiedad | valores | UEs |
|---|---|---|
| DEPENDENCIA | FISCAL · CONVENIO · PRIVADA | 465 · 67 · 59 |
| TIPO | EDUCACIÓN REGULAR · ALTERNATIVA · ESPECIAL · PERMANENTE | 548 · 28 · 12 · 3 |
| SUBSISTEMA | REGULAR · ALTERNATIVA · ESPECIAL | 548 · 31 · 43 (inconsistente, ver abajo) |
| NIVEL EDUCATIVO | 15 valores (Inicial/Primaria/Secundaria comunitaria, adultos, técnico, especial, permanente) | 1 a 6 por UE |
| TURNO | MAÑANA · TARDE · NOCHE | 388 · 180 · 43 |

**Unidades educativas vivas: 591.** Todas tienen coordenadas y 587 tienen distrito (1–14; el distrito 10 no tiene ninguna).

## Conexión

`db/vista_unidad_educativa.sql` crea la vista `unidad_educativa`, que aplana el EAV al modelo del dashboard. El backend la consume sin copiar datos, y basta con un usuario de solo lectura:

```bash
psql -d cuidados -f db/vista_unidad_educativa.sql
psql -d cuidados -c "CREATE ROLE dashboard LOGIN PASSWORD '...'; GRANT SELECT ON unidad_educativa TO dashboard;"
COLEGIOS_DB="postgresql+psycopg://dashboard:...@host/cuidados" uvicorn app.backend.main:app
```

Decisiones de la vista:
- Solo instituciones de tipo `EDUCACION` y con `deleted IS NULL`.
- **Subsistema = TIPO**, no SUBSISTEMA (ver el problema 2).
- `niveles` y `turnos` son listas separadas por comas con los valores **exactos** del catálogo. El backend filtra por ítem exacto, así que `ESPECIAL` no casa con otros niveles ni `PRIMARIA` con `EDUCACIÓN PRIMARIA PARA ADULTOS`.
- `telefono` concatena los arrays jsonb `telefono` y `celular`.
- `actualizado` es la última fecha de `core_historicalinstitucion`.

**Bajas lógicas (HU-02).** La vista no cambia y la BD de cuidados sigue siendo de solo lectura. La baja de un colegio
se guarda en tablas propias de la BD del sistema (`COLEGIOS_AUTH_DB`, la misma de los usuarios):

| Tabla | Columnas |
|---|---|
| `unidad_estado` | `ue_id` (PK, = `unidad_educativa.id`), `activo`, `fecha_baja`, `motivo`, `usuario` |
| `unidad_estado_historial` | `id`, `ue_id`, `accion` (`baja` \| `alta`), `motivo`, `usuario`, `fecha` (UTC) |

El backend (`vista_sin_cambios` en `main.py`, `app/backend/estado.py`) excluye esos ids con `id NOT IN (...)` en unidades,
mapa, estadísticas, catálogos, exportaciones y la página estática. La consulta de los dados de baja es `GET /api/bajas`.
Las tablas se crean al arrancar; si hay que alterar una tabla existente de una BD SQLite (p. ej. agregar `usuario.rol`)
se copia antes a `<archivo>.bak-<fecha>`. En PostgreSQL haga un `pg_dump` antes de desplegar.

**Colegios registrados (HU-04).** Los colegios nuevos que se registran desde el dashboard (`POST /api/unidades`) tampoco
se escriben en `core_*` ni en la vista: van a la tabla propia `unidad_registrada` de la BD del sistema.

| Tabla | Columnas |
|---|---|
| `unidad_registrada` | `id` (PK sin secuencia: `max(999999, max(id)) + 1`, así los ids empiezan en 1.000.000 y no chocan con `core_institucion.id`), `nombre`, `dependencia`, `subsistema`, `niveles` y `turnos` (listas separadas por comas), `distrito_municipal`, `zona`, `direccion`, `telefono`, `lat`, `lon`, `usuario` (quién lo registró), `creado` (UTC) |

`app/backend/registro.py` valida y guarda; `main.py` los combina con la vista en Python (unidades, mapa, estadísticas,
catálogos, ficha, bajas, exportaciones y la página estática). Las bajas de `unidad_estado` también aplican a ellos.
La tabla se crea al arrancar si no existe (no altera las demás). Si el colegio luego se carga en la BD de cuidados,
quedaría duplicado: hay que darlo de baja en el dashboard.

**Correcciones (HU-08), personal (HU-10) y agenda (HU-09).** También en tablas propias de la BD del sistema, creadas
al arrancar (`init_auth_db`) sin alterar las existentes:

| Tabla | Columnas |
|---|---|
| `unidad_correccion` | `ue_id` (PK, = `unidad_educativa.id`), un valor por campo editable (`nombre`, `dependencia`, `subsistema`, `distrito_municipal`, `direccion`, `zona`, `telefono`, `niveles`, `turnos`, `lat`, `lon`; null = sin corregir, `""` en `zona`/`telefono` = corregido a vacío), `usuario` y `fecha` de la última corrección |
| `unidad_cambio` | `id`, `ue_id`, `campo`, `antes`, `despues` (texto; listas separadas por comas), `usuario`, `fecha` (UTC). Una fila por campo cambiado; las de un mismo guardado comparten usuario y fecha |
| `personal` | `id`, `nombre`, `cargo`, `telefono`, `correo`, `activo`, `creado`, `actualizado`, `usuario` (último cambio) |
| `actividad` | `id`, `ue_id`, `tipo`, `actividad`, `fecha` (`YYYY-MM-DD`), `hora` (`HH:MM`), `lugar`, `encargados` y `personal` (ids de `personal` separados por comas), `asistentes_proyectados`, `observaciones`, `estado`, `creado`, `creado_por`, `actualizado`, `actualizado_por` |

Las correcciones de colegios de la vista no tocan la vista: `vista_sin_cambios` en `main.py` saca de la consulta SQL los
ids dados de baja y los corregidos, y `fuera_de_sql` los vuelve a sumar en Python con lo corregido encima (igual que los
registrados), así filtros, búsqueda, orden y paginación usan los valores corregidos. Un colegio registrado se corrige en
su propia fila de `unidad_registrada`. `app/backend/correcciones.py`, `personal.py` y `actividades.py`.

Cómo probarlo: `COLEGIOS_PG_TEST_URL=... pytest tests/test_postgres_cuidados.py` compara la API con consultas directas al EAV (11 pruebas; todas pasan con este dump).

## Problemas de calidad de datos encontrados

| # | Problema | Cantidad | Qué hace el dashboard |
|---|---|---|---|
| 1 | UEs sin distrito; 2 de ellas con coordenadas fuera de El Alto (id 194 *SAN SIMON*, −16.246/−68.719; id 197 *LEÓN DE JUDÁ*, −68.049) | 4 | Las dibuja, pero encuadra el mapa en El Alto (`areaBounds`). En el gráfico aparecen como "Sin dato" |
| 2 | Los CEA (alternativa) y los centros permanentes también llevan SUBSISTEMA=ESPECIAL | 31 | Se usa TIPO para el subsistema |
| 3 | UEs sin turno | 17 | Aparecen como "Sin dato" en las estadísticas |
| 4 | Nombres repetidos (misma UE en otro turno o sede) | 9 nombres | Se distinguen por `id` |
| 5 | Sin código RUE, sin matrícula ni docentes, sin responsable ni correo; solo 49 con teléfono | — | Se ocultan el KPI de estudiantes, la columna y el orden (`campos.matricula = false`) |

Recomendación: agregar el **código RUE** a `core_institucion`. Permitiría cruzar con el SIE del Ministerio y traer matrícula, docentes y director.

## Seguridad del dump

El archivo incluye `auth_user` (hashes de contraseñas), `django_session` (sesiones activas) y `users_profile`. **No lo suban a ningún repositorio ni lo compartan.** Para el dashboard basta con exportar las tablas `core_*` (`pg_dump -t 'core_*'`), o mejor aún, conectar directo con el usuario de solo lectura sobre la vista.
