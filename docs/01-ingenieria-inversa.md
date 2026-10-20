# Ingeniería inversa: `cuidados.elalto.gob.bo/educacion/dashboard/`

## Estado de la investigación

| Fuente | Resultado |
|---|---|
| Acceso directo al sitio desde el entorno de desarrollo | **No disponible**: el dominio no resolvió por DNS (`ENOTFOUND`) desde la nube; probablemente filtrado geográficamente o sólo accesible desde redes bolivianas. |
| Web Archive | Bloqueado por la política de red del entorno. |
| Índices de buscadores | Sí. De ahí salen los hallazgos confirmados de abajo. |
| REA (`rea-agents@6.7.0`) | Instalado y probado de punta a punta contra el sistema replicado (`recon/run_rea.sh`). **Hay que ejecutarlo desde una máquina que llegue al sitio** (ver `recon/README.md`). |

Todo lo que aparece abajo como **confirmado** viene de contenido indexado públicamente. Lo **inferido** es una hipótesis que el kit `recon/` verifica de forma automática.

## Hallazgos confirmados

1. **Plataforma**: "Dashboard GAMEA", el *Sistema Municipal Georreferenciado de Cuidados de El Alto (SMGC)* del Gobierno Autónomo Municipal de El Alto, hecho con apoyo conceptual de la OIT y del Centro de Promoción de la Mujer Gregoria Apaza. Es un mapa de servicios de cuidado con categorías como *Unidades Educativas* y *Centros de Salud*.
2. **Módulo educación** bajo `/educacion/` (dashboard en `/educacion/dashboard/`).
3. **Endpoint de reporte**: `GET /educacion/api/reporte/pdf/` devuelve el PDF **"Reporte de Unidades Educativas"** con las columnas:

   | Nombre | Dist. | Dependencia | Dirección | Nivel |
   |---|---|---|---|---|

   - Valores de *Dependencia*: `FISCAL`, `CONVENIO`, `PRIVADA`.
   - Valores de *Nivel*: inicial, primaria y secundaria comunitaria, educación vocacional y educación primaria y secundaria para adultos (subsistema alternativo).
   - *Dist.* es el número de distrito municipal (por ejemplo, hay unidades de convenio en los distritos 4 y 12).
4. **Endpoint hermano** del módulo general: `GET /gamea/reportes/exportar/pdf/` devuelve el "Reporte de Centros de Atención Completo" con las columnas Nombre, Unidad, Distrito, Dirección y Teléfono. La página principal también ofrece exportar a **Excel** y PDF.

## Arquitectura inferida (la verifica `recon/harvest.mjs`)

- **Backend Django**, probablemente con **Django REST Framework**: hay rutas con barra final (`/educacion/api/reporte/pdf/`, `/gamea/reportes/exportar/pdf/`), una app Django por módulo (`gamea`, `educacion`) y un prefijo `api/` dentro de la app.
  - Si es DRF, `GET /educacion/api/?format=json` devuelve la **raíz del router con todos los endpoints**. El harvester la sigue de forma recursiva, incluida la paginación `next`.
  - El PDF casi seguro se genera en el servidor (ReportLab o WeasyPrint) a partir del mismo queryset que alimenta el mapa. La lista de unidades debería existir también como JSON.
- **Frontend**: un mapa (muy probablemente Leaflet) con marcadores por categoría, más un panel de filtros. El harvester extrae las capas de Leaflet y los globals JS si los datos vienen embebidos en el HTML (algo habitual en plantillas Django con `{{ data|json_script }}`).

## Cómo cerrar los huecos

```bash
cd recon && npm install
node harvest.mjs              # HAR + JSON/PDF/XLSX + inventario de endpoints + UI
bash run_rea.sh               # evidencia REA: red, formas JSON, bundle JS, scripts, HAR
node summarize.mjs            # out/REPORTE.md
cd .. && python -m app.backend.importer recon/out/harvest/data/* --fuente cuidados.elalto.gob.bo
```

`out/REPORTE.md` documenta, con evidencia, los endpoints reales, la forma de cada respuesta JSON, los filtros (opciones de cada `<select>`), los títulos de los gráficos, los scripts y las librerías. El importador acepta JSON (DRF, listas o anidado), GeoJSON, CSV y **el propio PDF del reporte**.

## Fuentes complementarias recomendadas

- **SIE, Ministerio de Educación**, directorio de unidades educativas (`reportes.sie.gob.bo/reporteestadistico/directorio/institucioneducativa/regular`): filtra por dependencia (fiscal, convenio, comunitaria, privada) e incluye el **código RUE**, que es la clave natural del sistema mejorado. También publica la matrícula por nivel, sexo y dependencia.
- **RM 0021/2024 (Minedu)**: las unidades de convenio requieren autorización vigente de la Dirección Departamental y un certificado RUE, que el distrito revisa cada año. Conviene modelarlo como un dato de cumplimiento (ver `03-mejoras.md`).
