# Frontend: lógica y contrato con la API

El frontend (`app/frontend/`) es JS plano, sin build: `index.html`, `app.js`, `styles.css` y `config.js`, más Leaflet y Chart.js en `vendor/`. Se puede servir desde cualquier servidor estático y apuntarlo a cualquier backend que cumpla el contrato de abajo.

## Cómo conectarlo a su propia base de datos

**Opción A: reutilizar el backend FastAPI.** Basta con que su BD exponga una tabla o vista `unidad_educativa` con las columnas de `docs/02-modelo-datos.md`:

```bash
COLEGIOS_DB="postgresql://usuario:clave@host/bd" uvicorn app.backend.main:app
```

Ejemplo de vista para mapear sus nombres de columna (PostgreSQL):

```sql
CREATE VIEW unidad_educativa AS
SELECT ue.id,
       COALESCE(ue.rue, 'id:' || ue.id)  AS clave,
       ue.rue                             AS codigo_rue,
       ue.nombre,
       UPPER(ue.dependencia)              AS dependencia,      -- FISCAL | CONVENIO | PRIVADA | COMUNITARIA
       ue.entidad_convenio                AS tipo_convenio,
       ue.subsistema,
       ue.niveles,                                             -- 'INICIAL,PRIMARIA,SECUNDARIA'
       ue.turnos,                                              -- 'MANANA,TARDE'
       ue.distrito                        AS distrito_municipal,
       NULL::text AS distrito_educativo, ue.zona, ue.direccion, ue.telefono, ue.director, ue.area,
       ST_Y(ue.geom) AS lat, ST_X(ue.geom) AS lon,
       m.total AS estudiantes_total, m.mujeres AS estudiantes_mujeres, m.hombres AS estudiantes_hombres,
       m.docentes, 'BD municipal' AS fuente, now() AS actualizado
FROM unidades ue LEFT JOIN matricula m ON m.ue_id = ue.id;
```

**Opción B: un backend propio.** Hay que implementar los endpoints de abajo y declarar la URL en `config.js`:

```js
window.COLEGIOS_CONFIG = { apiBase: "https://mi-servidor/api" };
```

## Contrato (lo que `app.js` necesita)

Filtros comunes, repetibles y combinados con AND entre filtros y OR dentro de cada uno: `dependencia`, `nivel`, `turno`, `distrito` y `q` (texto). Ejemplo: `?dependencia=FISCAL&dependencia=CONVENIO&distrito=8&q=san`.

| Endpoint | Respuesta mínima |
|---|---|
| `GET /catalogos` | `{dependencias: [str], niveles: [str], turnos: [str], distritos: [int], fuentes: [str]}` |
| `GET /estadisticas?<filtros>` | `{total_unidades, por_dependencia: {DEP: n}, por_nivel: {NIVEL: n}, por_distrito: {"8": {DEP: n}}, estudiantes: {total}, ratio_estudiante_docente}` |
| `GET /geojson?<filtros>` | `FeatureCollection` de puntos con `properties: {id, nombre, dependencia}` |
| `GET /unidades?<filtros>&page&page_size&orden` | `{count, results: [{id, nombre, distrito_municipal, dependencia, direccion, niveles, turnos, estudiantes_total}]}`. `orden` puede ser `nombre`, `distrito_municipal`, `dependencia` o `estudiantes_total`, con `-` delante para orden descendente |
| `GET /unidades/{id}` | Registro completo (los campos vacíos no se muestran) |
| `GET /export.{csv,xlsx,pdf}?<filtros>` | Archivo (los botones sólo arman el enlace) |

`niveles` y `turnos` son strings separados por comas con códigos (`INICIAL`, `MANANA`, …). Las etiquetas legibles salen del diccionario `LABEL` de `app.js`; un código desconocido se muestra tal cual.

## Decisiones de la lógica (mantenerlas al reutilizarla)

1. **Estado único sincronizado con la URL** (`state`, `readUrl()` y `writeUrl()`). Los filtros, la página y el orden viven en la URL, así que un enlace compartido abre exactamente la misma vista.
2. **Una petición viva por canal** (`api(channel, …)` con `AbortController`). Si el usuario cambia los filtros rápido, la petición anterior se cancela y una respuesta vieja nunca pisa a la nueva.
3. **Todo dato de la BD pasa por `esc()`** antes de llegar al HTML, incluidos los tooltips de Leaflet (`bindTooltip` interpreta HTML). Los labels de Chart.js se dibujan en canvas y no necesitan escape.
4. **Recarga mínima**: al cambiar filtros se recargan los KPIs, el mapa y la tabla; al paginar u ordenar, sólo la tabla.
5. **Estados visibles**: carga (`aria-busy`), error (`#estado`), tabla vacía y mapa sin coordenadas.
6. **Accesibilidad**: filas navegables con teclado (Tab + Enter), encabezados ordenables con `aria-sort` y el diálogo de detalle con `aria-labelledby`.
7. **Mapa con `preferCanvas`**: aguanta miles de marcadores.

## Pruebas

```bash
npm install && npm run test:e2e   # 7 pruebas en Chromium: XSS, carreras, URL, teclado, errores, vacíos
pytest -q                         # API
```
