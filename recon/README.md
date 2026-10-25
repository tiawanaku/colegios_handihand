# Kit de ingeniería inversa (REA + Playwright)

Ejecútalo desde una máquina que **sí** abra https://cuidados.elalto.gob.bo/educacion/dashboard/ en el navegador. Si el sitio sólo carga desde Bolivia, usa una conexión boliviana.

Requisitos: Node 22.19 o superior y Chromium o Chrome. En Linux también hace falta `ps` (procps).

```bash
cd recon
npm install                       # playwright + rea-agents
npx playwright install chromium   # sólo si no tienes Chrome/Chromium
npm run all                       # harvest -> rea -> resumen
```

O paso a paso:

| Paso | Comando | Salida |
|---|---|---|
| 1. Cosecha | `node harvest.mjs [--base URL] [--headed] [--delay 400] [--max-requests 400]` | `out/harvest/site.har`, `data/*.json\|pdf\|xlsx`, `pages/*.html\|png\|ui.json`, `endpoints.json` |
| 2. REA | `bash run_rea.sh [URL] [out/rea]` | `01-targets` … `07-har.json` (Evidence de REA), `scripts/` |
| 3. Resumen | `node summarize.mjs` | `out/REPORTE.md` |
| 4. Importar | `cd .. && python -m app.backend.importer recon/out/harvest/data/* --fuente cuidados` | Datos reales en el dashboard |

Qué hace REA en `run_rea.sh`: `list-browser-targets`, luego `inspect-web-page` (peticiones, iniciador JS, forma de los JSON, consola, accesibilidad y fuentes), `analyze-web-bundle` (endpoints y rutas candidatas en el JS, source maps), `capture-web-screenshot`, `export-web-scripts`, `analyze-javascript-application` (grafo de módulos) e `inspect-web-network-capture` sobre el HAR del harvester.

Variables útiles: `CHROMIUM_PATH`, `CDP_PORT` (por defecto 9333), `OBS_MS` (ventana de observación, por defecto 8000) y `REA` (por ejemplo `REA="npx rea"` si ya está instalado).

**Uso responsable**: el sitio publica datos públicos del municipio. El harvester sólo hace GET, va limitado en velocidad (`--delay`), tiene un tope de peticiones y no envía formularios.

Además, con `npx rea-agents setup` puedes registrar REA como servidor MCP en Claude Code y pedirle al agente: *"usa REA para inspeccionar cómo carga los colegios el dashboard abierto en mi Chrome (CDP 9222)"*.
