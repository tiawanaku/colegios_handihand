#!/usr/bin/env node
// Resume la evidencia de harvest.mjs + run_rea.sh en out/REPORTE.md
// Uso: node summarize.mjs [OUT_DIR=./out]
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] || "./out");
const read = (p) => { try { const j = JSON.parse(fs.readFileSync(path.join(OUT, p), "utf8")); return j.data ?? j; } catch { return null; } };
const nr = (p) => read(p)?.normalized_result ?? null;
const lines = [];
const h = (t) => lines.push("", t, "");
const seg = (x) => (typeof x === "string" ? x : x.kind === "property" ? x.name : "[]");
const shapeLine = (props = []) => props.map((p) => `${p.path.map(seg).join(".").replace(/\.\[\]/g, "[]")}:${p.types.join("|")}`).slice(0, 25).join(", ");

lines.push("# Reporte de ingeniería inversa", "", `Generado: ${new Date().toISOString()}`);

// 1. inventario de endpoints (harvest)
const inv = read("harvest/endpoints.json");
if (inv) {
  h(`## Endpoints observados (${inv.base}) — ${inv.endpoints.length} rutas, ${inv.requests} peticiones`);
  lines.push("| Método | Ruta | Tipo | Estado | Registros | Queries vistas |", "|---|---|---|---|---|---|");
  for (const e of inv.endpoints.filter((x) => !/^(image|font|stylesheet)$/.test(x.resourceType)))
    lines.push(`| ${e.method} | \`${e.path}\` | ${(e.contentType || "").split(";")[0]} | ${e.status} | ${e.count ?? e.items ?? e.features ?? ""} | ${e.queries.slice(0, 4).map((q) => `\`${q}\``).join(" ")} |`);
  const shaped = inv.endpoints.filter((e) => e.shape);
  if (shaped.length) {
    h("### Forma de las respuestas JSON");
    for (const e of shaped) lines.push(`- \`${e.method} ${e.path}\``, "  ```json", "  " + JSON.stringify(e.shape).slice(0, 1500), "  ```");
  }
}

// 2. UI (harvest/pages/*.ui.json)
const pagesDir = path.join(OUT, "harvest/pages");
if (fs.existsSync(pagesDir)) {
  h("## Inventario de UI");
  for (const f of fs.readdirSync(pagesDir).filter((x) => x.endsWith(".ui.json"))) {
    const ui = JSON.parse(fs.readFileSync(path.join(pagesDir, f), "utf8"));
    lines.push(`### ${ui.title || "(sin título)"} — ${ui.url}`);
    if (ui.headings.length) lines.push(`- Títulos: ${ui.headings.slice(0, 40).join(" · ")}`);
    for (const s of ui.selects) lines.push(`- Filtro \`select#${s.id || s.name}\`: ${s.options.slice(0, 30).map((o) => o[1]).join(", ")}${s.options.length > 30 ? " …" : ""}`);
    if (ui.inputs.length) lines.push(`- Inputs: ${ui.inputs.map((i) => `${i.type}#${i.id || i.name}${i.placeholder ? ` ("${i.placeholder}")` : ""}`).join(", ")}`);
    if (ui.buttons.length) lines.push(`- Botones/pestañas: ${[...new Set(ui.buttons)].slice(0, 40).join(" · ")}`);
    lines.push(`- Scripts: ${ui.scripts.join(", ") || "—"}`, `- CSS: ${ui.styles.join(", ") || "—"}`, `- Canvas (gráficos): ${ui.canvases}`, "");
  }
}

// 3. REA inspect-web-page
const page = nr("rea/02-inspect-web-page.json");
if (page) {
  h(`## REA · inspect-web-page — ${page.target.url}`);
  lines.push(`Navegador: ${page.browser.product} · completitud: ${page.completeness.status}`);
  lines.push("", "| Método | URL | Tipo | Estado | MIME | Iniciador | Forma JSON |", "|---|---|---|---|---|---|---|");
  for (const r of page.network.requests)
    lines.push(`| ${r.method} | \`${r.url}\` | ${r.resource_type} | ${r.status ?? ""} | ${r.mime_type ?? ""} | ${r.initiator?.url ? `${path.basename(r.initiator.url)}:${r.initiator.line}` : r.initiator?.type ?? ""} | ${shapeLine(r.body_shapes?.response?.properties)} |`);
  lines.push("", `Scripts: ${page.scripts.items.map((s) => `\`${s.url}\` (${s.length} B${s.source_map_url ? ", sourcemap" : ""})`).join(", ")}`);
  const st = page.storage;
  if (st) lines.push(`Storage: localStorage=[${st.local_storage_keys.join(", ")}] sessionStorage=[${st.session_storage_keys.join(", ")}] IndexedDB=[${st.indexed_db_names.join(", ")}]`);
}

// 4. REA analyze-web-bundle
const bundle = nr("rea/03-analyze-web-bundle.json");
if (bundle) {
  h("## REA · analyze-web-bundle");
  const o = bundle.observations;
  lines.push(`Scripts analizados: ${bundle.capture.scripts_analyzed} · rutas: ${o.routes.length} · endpoints candidatos: ${o.endpoints.length} · source maps: ${o.source_maps.status}`);
  for (const e of o.endpoints) lines.push(`- ${JSON.stringify(e).slice(0, 300)}`);
  for (const r of o.routes) lines.push(`- ruta: ${JSON.stringify(r).slice(0, 300)}`);
}

// 5. REA HAR
const har = nr("rea/07-har.json");
if (har) {
  h(`## REA · inspect-web-network-capture (HAR, ${har.total_records} registros)`);
  const byPath = new Map();
  for (const rec of har.records) {
    const { request, response } = rec.reported;
    let u; try { u = new URL(request.url); } catch { continue; }
    const k = `${request.method} ${u.origin}${u.pathname}`;
    const e = byPath.get(k) || { n: 0, status: new Set(), mime: response.content?.mimeType, bytes: 0 };
    e.n++; e.status.add(response.status); e.bytes += response.content?.size || 0;
    byPath.set(k, e);
  }
  lines.push("| Petición | Veces | Estado | MIME | Bytes |", "|---|---|---|---|---|");
  for (const [k, e] of [...byPath].sort()) lines.push(`| \`${k}\` | ${e.n} | ${[...e.status].join(",")} | ${e.mime ?? ""} | ${e.bytes} |`);
}

// 6. JS application
const js = nr("rea/06-js-application.json");
if (js?.graph) {
  h("## REA · analyze-javascript-application");
  const kinds = {};
  for (const n of js.graph.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  lines.push(`Nodos del grafo: ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

// 7. datos de colegios encontrados
const dataDir = path.join(OUT, "harvest/data");
if (fs.existsSync(dataDir)) {
  h("## Archivos de datos cosechados");
  const files = fs.readdirSync(dataDir);
  const byExt = {};
  for (const f of files) byExt[path.extname(f)] = (byExt[path.extname(f)] || 0) + 1;
  lines.push(Object.entries(byExt).map(([k, v]) => `${k}: ${v}`).join(" · "));
  lines.push("", "Importar al sistema: `python -m app.backend.importer recon/out/harvest/data/*.json recon/out/harvest/data/*.pdf --fuente cuidados`");
}

fs.writeFileSync(path.join(OUT, "REPORTE.md"), lines.join("\n") + "\n");
console.log(`Reporte: ${path.join(OUT, "REPORTE.md")} (${lines.length} líneas)`);
