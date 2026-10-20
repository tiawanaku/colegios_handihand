# Modelo de datos

Tabla `unidad_educativa` (definida en `app/backend/models.py`):

| Campo | Tipo | Origen o equivalencia | Notas |
|---|---|---|---|
| `clave` | str, única | `rue:<RUE>` o `n:<nombre>\|d:<distrito>` | Deduplica entre fuentes |
| `codigo_rue` | str | SIE (RUE) | Clave oficial del Ministerio |
| `nombre` | str | "Nombre" del reporte | Normalizado en MAYÚSCULAS |
| `dependencia` | enum | "Dependencia" | `FISCAL` (pública), `CONVENIO`, `PRIVADA`, `COMUNITARIA` |
| `tipo_convenio` | str | — | Entidad del convenio (Fe y Alegría, Iglesia, …) |
| `subsistema` | enum | inferido de nivel | `REGULAR`, `ALTERNATIVA`, `ESPECIAL` |
| `niveles` | csv | "Nivel" | `INICIAL,PRIMARIA,SECUNDARIA,ALTERNATIVA,ESPECIAL,TECNICA` |
| `turnos` | csv | — | `MANANA,TARDE,NOCHE` |
| `distrito_municipal` | int | "Dist." | 1–14 (más los rurales) |
| `distrito_educativo` | str | SIE | Dirección distrital de educación El Alto 1/2/3… |
| `zona`, `direccion`, `telefono`, `director`, `area` | str | "Dirección" / SIE | |
| `lat`, `lon` | float | mapa (marcadores Leaflet) | Corrige lat/lon invertidas y descarta valores fuera de Bolivia |
| `estudiantes_total/mujeres/hombres`, `docentes` | int | SIE | Indicadores |
| `fuente`, `actualizado` | str, datetime | — | Trazabilidad |

## Reglas de normalización (`app/backend/normalize.py`)

- Más de 60 alias de columna (`Dist.`, `distrito`, `unidad_educativa`, `latitud`, `y`, …) se mapean a un mismo campo.
- *Dependencia*: "Fiscal de convenio" se clasifica como `CONVENIO`; "pública", "estatal" o "municipal" como `FISCAL`; "particular" como `PRIVADA`.
- *Nivel* y *Turno* se convierten en conjuntos normalizados, sin acentos ni variantes.
- Al reimportar, los campos vacíos no pisan datos existentes. Eso permite combinar el PDF (nombre y dependencia), el mapa (coordenadas) y el SIE (RUE y matrícula).
