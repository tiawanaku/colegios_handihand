#!/usr/bin/env node
// Cosechador del dashboard de educación de cuidados.elalto.gob.bo (o cualquier origen).
//
// 1. Abre las páginas semilla en Chromium y graba un HAR completo (content embebido).
// 2. Explora la UI: enlaces internos, pestañas/botones de filtro y cada opción de <select>,
//    para disparar todas las peticiones XHR/fetch que el dashboard hace.
// 3. Guarda cada respuesta JSON/GeoJSON/PDF/XLSX/CSV en out/harvest/data/.
// 4. Sondea endpoints candidatos (raíz DRF, ?format=json, rutas de reporte) y sigue
//    paginación tipo DRF ("next") u ?page=N.
// 5. Extrae datos embebidos en la página (variables globales con arrays/GeoJSON, capas Leaflet).
// 6. Escribe out/harvest/endpoints.json con el inventario de la API.
//
// Uso: node harvest.mjs [--base https://cuidados.elalto.gob.bo] [--out ./out/harvest]
//                       [--max-requests 400] [--delay 400] [--headed]
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const BASE = (args.base || "https://cuidados.elalto.gob.bo").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;
const OUT = path.resolve(args.out || "./out/harvest");
const MAX_REQ = Number(args["max-requests"] || 400);
const DELAY = Number(args.delay || 400);
const SEEDS = (args.seeds || "/educacion/dashboard/,/,/educacion/").split(",").map((p) => BASE + p);

// Rutas candidatas. Las URLs con barra final (/educacion/api/reporte/pdf/, /gamea/reportes/exportar/pdf/)
// sugieren Django; si es Django REST Framework la raíz del router lista todos los endpoints.
const CANDIDATES = [
  "/educacion/api/", "/educacion/api/?format=json", "/api/", "/api/?format=json",
  "/educacion/api/reporte/pdf/", "/educacion/api/reporte/excel/", "/educacion/api/reporte/xlsx/",
  "/educacion/api/unidades/", "/educacion/api/unidades-educativas/", "/educacion/api/unidadeseducativas/",
  "/educacion/api/colegios/", "/educacion/api/instituciones/", "/educacion/api/distritos/",
  "/educacion/api/dependencias/", "/educacion/api/niveles/", "/educacion/api/estadisticas/",
  "/educacion/api/dashboard/", "/educacion/api/mapa/", "/educacion/api/geojson/",
  "/gamea/reportes/exportar/pdf/", "/gamea/reportes/exportar/excel/", "/gamea/api/",
  "/swagger/", "/swagger.json", "/api/schema/", "/openapi.json", "/redoc/", "/robots.txt", "/sitemap.xml",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
const endpoints = new Map(); // key method+path -> info
const exportLinks = new Set(); // enlaces de descarga (PDF/Excel/CSV) vistos en la UI
let requestCount = 0;

function shapeOf(v, depth = 0) {
  if (depth > 4) return typeof v;
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return v === null ? "null" : typeof v;
}

function extFor(ct, url) {
  if (/json/.test(ct)) return ".json";
  if (/pdf/.test(ct)) return ".pdf";
  if (/spreadsheet|excel/.test(ct)) return ".xlsx";
  if (/csv/.test(ct)) return ".csv";
  if (/javascript/.test(ct)) return ".js";
  if (/html/.test(ct)) return ".html";
  return path.extname(new URL(url).pathname) || ".bin";
}

async function record(response) {
  const req = response.request();
  const url = req.url();
  if (!url.startsWith(ORIGIN)) return;
  const ct = (response.headers()["content-type"] || "").toLowerCase();
  const type = req.resourceType();
  const u = new URL(url);
  const key = `${req.method()} ${u.pathname}`;
  const info = endpoints.get(key) || { method: req.method(), path: u.pathname, queries: [], status: response.status(), contentType: ct, resourceType: type, files: [] };
  if (u.search && !info.queries.includes(u.search)) info.queries.push(u.search);
  if (req.postData()) info.postData = (info.postData || []).concat(req.postData().slice(0, 2000));
  endpoints.set(key, info);
  if (!/json|pdf|spreadsheet|excel|csv|geo/.test(ct) && !["xhr", "fetch"].includes(type)) return;
  try {
    const body = await response.body();
    const file = path.join(OUT, "data", `${u.pathname.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root"}_${sha(url + (req.postData() || ""))}${extFor(ct, url)}`);
    await fs.writeFile(file, body);
    info.files.push(path.relative(OUT, file));
    if (/json/.test(ct)) {
      const json = JSON.parse(body.toString("utf8"));
      info.shape ??= shapeOf(json);
      if (Array.isArray(json)) info.items = json.length;
      else if (json && typeof json === "object") {
        if ("count" in json) info.count = json.count;
        if (json.next) info.next = json.next;
        if (json.features) info.features = json.features.length;
      }
    }
  } catch { /* cuerpos de redirect o vacíos */ }
}

async function explore(page, url, visited) {
  if (visited.has(url) || requestCount > MAX_REQ) return;
  visited.add(url);
  console.log("→", url);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  } catch (e) { console.warn("  ! goto", e.message); return; }
  await sleep(DELAY * 3);
  const name = sha(url);
  await fs.writeFile(path.join(OUT, "pages", `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(OUT, "pages", `${name}.png`), fullPage: true }).catch(() => {});

  // datos embebidos: globals con arrays grandes o GeoJSON, capas Leaflet, <script type=application/json>
  const embedded = await page.evaluate(() => {
    const out = { globals: {}, leaflet: [], jsonScripts: [] };
    const builtins = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)).concat(["window", "self", "document", "top", "parent", "frames"]));
    for (const k of Object.keys(window)) {
      if (builtins.has(k)) continue;
      try {
        const v = window[k];
        if ((Array.isArray(v) && v.length > 3 && typeof v[0] === "object") || (v && v.type === "FeatureCollection")) out.globals[k] = JSON.parse(JSON.stringify(v));
      } catch {}
    }
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && v._layers && v.eachLayer) v.eachLayer((l) => {
          if (l.getLatLng) out.leaflet.push({ latlng: l.getLatLng(), popup: l.getPopup?.()?.getContent?.()?.toString?.(), tooltip: l.getTooltip?.()?.getContent?.()?.toString?.(), options: Object.fromEntries(Object.entries(l.options || {}).filter(([, x]) => typeof x !== "object")) });
          if (l.toGeoJSON && l.feature) out.leaflet.push({ feature: l.feature });
        });
      } catch {}
    }
    document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((s) => out.jsonScripts.push(s.textContent.slice(0, 500000)));
    return out;
  });
  if (Object.keys(embedded.globals).length || embedded.leaflet.length || embedded.jsonScripts.length)
    await fs.writeFile(path.join(OUT, "data", `embedded_${name}.json`), JSON.stringify(embedded, null, 1));

  // inventario de UI (para replicar filtros/menús)
  const ui = await page.evaluate(() => ({
    title: document.title,
    headings: [...document.querySelectorAll("h1,h2,h3,h4,.card-title")].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 100),
    selects: [...document.querySelectorAll("select")].map((s) => ({ id: s.id, name: s.name, options: [...s.options].map((o) => [o.value, o.text.trim()]) })),
    inputs: [...document.querySelectorAll("input")].map((i) => ({ id: i.id, name: i.name, type: i.type, placeholder: i.placeholder })),
    buttons: [...document.querySelectorAll("button,[role=tab],.nav-link,.btn")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 150),
    links: [...document.querySelectorAll("a[href]")].map((a) => a.href),
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href),
    canvases: document.querySelectorAll("canvas").length,
  }));
  await fs.writeFile(path.join(OUT, "pages", `${name}.ui.json`), JSON.stringify({ url, ...ui }, null, 1));

  // dispara filtros: cada opción de cada <select>
  for (const sel of ui.selects) {
    const locator = sel.id ? page.locator(`select[id="${sel.id}"]`) : sel.name ? page.locator(`select[name="${sel.name}"]`) : null;
    if (!locator) continue;
    for (const [value] of sel.options.slice(0, 40)) {
      if (requestCount > MAX_REQ) break;
      await locator.first().selectOption(value).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(DELAY);
    }
  }
  // pestañas / botones (sin enviar formularios ni seguir enlaces externos)
  const clickables = page.locator("[role=tab], .nav-link, button:not([type=submit]), [data-toggle], [data-bs-toggle]");
  const n = Math.min(await clickables.count(), 60);
  for (let i = 0; i < n && requestCount <= MAX_REQ; i++) {
    const el = clickables.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const href = await el.getAttribute("href").catch(() => null);
    if (href && !href.startsWith("#") && !href.startsWith("javascript")) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(DELAY);
    if (!page.url().startsWith(ORIGIN)) await page.goBack().catch(() => {});
  }
  // enlaces internos de la sección educación
  for (const link of ui.links) {
    if (link.startsWith(ORIGIN) && /\.(pdf|xlsx?|csv|json|geojson)$|export|reporte|descarg/i.test(link)) exportLinks.add(link);
    const u = new URL(link);
    u.hash = "";
    if (u.origin === ORIGIN && /educacion|dashboard|unidad|colegio|reporte/i.test(u.pathname) && !/\.(pdf|xlsx?|csv)$/i.test(u.pathname))
      await explore(page, u.toString(), visited);
  }
}

async function probe(context) {
  const queue = [...exportLinks, ...CANDIDATES.map((p) => BASE + p)];
  for (const info of endpoints.values()) if (info.next) queue.push(info.next);
  const seen = new Set();
  while (queue.length && requestCount <= MAX_REQ) {
    const url = queue.shift();
    if (seen.has(url) || !url.startsWith(ORIGIN)) continue;
    seen.add(url);
    await sleep(DELAY);
    const res = await context.request.get(url, { failOnStatusCode: false, timeout: 30000 }).catch(() => null);
    if (!res) continue;
    const ct = (res.headers()["content-type"] || "").toLowerCase();
    console.log(`  probe ${res.status()} ${url} ${ct}`);
    if (res.status() >= 400) continue;
    const body = await res.body();
    const u = new URL(url);
    const key = `GET ${u.pathname}`;
    const info = endpoints.get(key) || { method: "GET", path: u.pathname, queries: [], status: res.status(), contentType: ct, resourceType: "probe", files: [] };
    if (u.search && !info.queries.includes(u.search)) info.queries.push(u.search);
    endpoints.set(key, info);
    if (/html/.test(ct) && !/format=json/.test(url)) continue;
    const file = path.join(OUT, "data", `probe_${u.pathname.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "root"}_${sha(url)}${extFor(ct, url)}`);
    await fs.writeFile(file, body);
    info.files.push(path.relative(OUT, file));
    if (!/json/.test(ct)) continue;
    let json;
    try { json = JSON.parse(body.toString("utf8")); } catch { continue; }
    info.shape ??= shapeOf(json);
    // raíz DRF: {"unidades": "https://.../unidades/", ...}
    if (json && !Array.isArray(json) && Object.values(json).every((v) => typeof v === "string" && v.startsWith("http")))
      for (const v of Object.values(json)) queue.push(v.includes("format=") ? v : v + (v.includes("?") ? "&" : "?") + "format=json");
    // paginación DRF / genérica
    if (json?.next) queue.push(json.next);
    else if (json && Array.isArray(json.results) && json.count > json.results.length && !u.searchParams.has("page")) {
      const pages = Math.ceil(json.count / json.results.length);
      for (let p = 2; p <= Math.min(pages, 200); p++) { const nu = new URL(url); nu.searchParams.set("page", p); queue.push(nu.toString()); }
    }
  }
}

await fs.mkdir(path.join(OUT, "data"), { recursive: true });
await fs.mkdir(path.join(OUT, "pages"), { recursive: true });
const browser = await chromium.launch({ headless: !args.headed, executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  recordHar: { path: path.join(OUT, "site.har"), content: "embed" },
  viewport: { width: 1440, height: 900 },
  locale: "es-BO",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 colegios-recon",
});
context.on("request", () => requestCount++);
context.on("response", (r) => record(r).catch(() => {}));
const page = await context.newPage();
const visited = new Set();
for (const seed of SEEDS) await explore(page, seed, visited);
await probe(context);
await context.close(); // escribe el HAR
await browser.close();

const inventory = [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path));
await fs.writeFile(path.join(OUT, "endpoints.json"), JSON.stringify({ base: BASE, generated: new Date().toISOString(), requests: requestCount, endpoints: inventory }, null, 1));
console.log(`\n${inventory.length} endpoints, ${requestCount} peticiones. Inventario: ${path.join(OUT, "endpoints.json")}`);
for (const e of inventory.filter((x) => /json|pdf|sheet|csv/.test(x.contentType)))
  console.log(`  ${e.method} ${e.path} [${e.contentType.split(";")[0]}]${e.count != null ? ` count=${e.count}` : ""}${e.items != null ? ` items=${e.items}` : ""}${e.features != null ? ` features=${e.features}` : ""}`);
