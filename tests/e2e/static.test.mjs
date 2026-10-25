// El modo estático (static-api.js + app/build_static.py) debe responder igual que el backend.
// Compara ambas APIs con muchas combinaciones de filtros y renderiza la página generada.
//   npm run test:e2e        (con COLEGIOS_DB apuntando a otra BD, compara contra esa BD)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 8600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python3";
let server, browser, page, tmp, html;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-static-"));
  const env = { ...process.env, COLEGIOS_AUTH: "0" }; // aquí se compara la API, no el login
  if (!process.env.COLEGIOS_DB) {
    env.COLEGIOS_DB = `sqlite:///${path.join(tmp, "s.db")}`;
    execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
  }
  html = path.join(tmp, "colegios.html");
  execFileSync(PY, ["-m", "app.build_static", html], { cwd: ROOT, env });
  server = spawn(PY, ["-m", "uvicorn", "app.backend.main:app", "--port", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/catalogos`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  page = await browser.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  // Sin red externa: los CDN se sirven con las copias locales de vendor/
  const vendor = path.join(ROOT, "app/frontend/vendor");
  await page.route(/leaflet@1\.9\.4\/dist\/leaflet\.js$/, (r) => r.fulfill({ path: path.join(vendor, "leaflet/leaflet.js"), contentType: "text/javascript" }));
  await page.route(/chart\.js@4\.4\.1\/dist\/chart\.umd\.js$/, (r) => r.fulfill({ path: path.join(vendor, "chart.umd.js"), contentType: "text/javascript" }));
  await page.goto(`file://${html}`);
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const local = (p, q = "") => page.evaluate(([p, q]) => CONFIG.staticApi(p, new URLSearchParams(q)), [p, q]);
const remote = async (p, q = "") => (await fetch(`${BASE}/api/${p}${q ? `?${q}` : ""}`)).json();
const sinFecha = (r) => { const { actualizado, clave, ...rest } = r; return rest; };

test("catálogos idénticos", async () => {
  assert.deepEqual(await local("catalogos"), await remote("catalogos"));
});

test("estadísticas, listado y mapa idénticos para muchas combinaciones de filtros", async () => {
  const c = await remote("catalogos");
  const combos = [""];
  for (const d of c.dependencias) combos.push(`dependencia=${encodeURIComponent(d)}`);
  for (const s of c.subsistemas) combos.push(`subsistema=${encodeURIComponent(s)}`);
  for (const n of c.niveles.slice(0, 6)) combos.push(`nivel=${encodeURIComponent(n)}`);
  for (const t of c.turnos) combos.push(`turno=${encodeURIComponent(t)}`);
  for (const d of c.distritos.slice(0, 4)) combos.push(`distrito=${d}`);
  combos.push(`dependencia=${encodeURIComponent(c.dependencias[0])}&distrito=${c.distritos[0]}&distrito=${c.distritos[1]}`);
  combos.push("q=san", "q=AV", "q=zzzz");
  for (const q of combos) {
    assert.deepEqual(await local("estadisticas", q), await remote("estadisticas", q), `estadisticas?${q}`);
    for (const orden of ["nombre", "-distrito_municipal"]) {
      const qs = `${q}${q ? "&" : ""}page=2&page_size=20&orden=${orden}`;
      const [a, b] = [await local("unidades", qs), await remote("unidades", qs)];
      assert.equal(a.count, b.count, `count ${qs}`);
      assert.deepEqual(a.results.map((r) => r.id), b.results.map((r) => r.id), `orden ${qs}`);
    }
    const [g1, g2] = [await local("geojson", q), await remote("geojson", q)];
    assert.deepEqual(g1.features.map((f) => f.properties.id).sort(), g2.features.map((f) => f.properties.id).sort(), `geojson ${q}`);
  }
  const id = (await remote("unidades", "page_size=1")).results[0].id;
  assert.deepEqual(sinFecha(await local(`unidades/${id}`)), Object.fromEntries(Object.entries(sinFecha(await remote(`unidades/${id}`))).filter(([, v]) => v != null)));
});

test("la página generada renderiza sin errores y sin exportaciones", async () => {
  const total = (await remote("estadisticas")).total_unidades;
  assert.equal(await page.locator(".kpi b").first().innerText(), total.toLocaleString("es-BO"));
  assert.equal(await page.locator(".exports, [download]").count(), 0, "sin enlaces de descarga en la versión estática");
  assert.ok((await page.locator(".rotulo-distrito").count()) > 0, "rótulos de distrito sin mapa base");
  await page.check('#f-dependencia input[value="PRIVADA"]');
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  assert.ok((await page.locator("#tabla tbody .badge").allInnerTexts()).every((b) => b === "Privada"));
  assert.deepEqual(page.errors, []);
});
