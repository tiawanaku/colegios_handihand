# BD de cuidados.elalto.gob.bo: análisis y conexión

Análisis del dump `cuidados.sql` (PostgreSQL 17, pg_dump). Confirma la arquitectura que se había inferido: es **Django** con `django-simple-history` (tablas `historical*`), `django-guardian` (permisos por objeto), `django-mptt` (`core_gameaestructura`) y borrado lógico (`deleted`, `deleted_by_cascade`).

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
