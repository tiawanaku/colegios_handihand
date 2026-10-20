// Pruebas end-to-end del dashboard (Chromium real contra la API real).
//   npm install && npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 8090 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python3";
let server, browser, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-e2e-"));
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "e2e.db")}` };
  execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
  // Filas escritas directo en la BD (como llegarán desde una base propia, sin pasar por el normalizador)
  execFileSync(PY, ["-c", `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
cols = "clave,nombre,dependencia,distrito_municipal,lat,lon,actualizado"
c.execute(f"insert into unidad_educativa ({cols}) values ('x1','<img src=x onerror=window.__xss=1>','FISCAL',3,-16.5,-68.19,'2026-01-01')")
c.execute(f"insert into unidad_educativa ({cols}) values ('x2','U.E. ZZ INYECCION','<img src=x onerror=window.__xss=2>',3,-16.51,-68.18,'2026-01-01')")
c.commit()`, path.join(tmp, "e2e.db")]);
  server = spawn(PY, ["-m", "uvicorn", "app.backend.main:app", "--port", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/catalogos`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(query = "") {
  const page = await browser.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort()); // sin red externa en CI
  await page.goto(`${BASE}/${query}`);
  await settle(page);
  return page;
}

const settle = (page) => page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
const kpiTotal = (page) => page.locator(".kpi b").first().innerText();
const badges = (page) => page.locator("#tabla tbody .badge").allInnerTexts();

test("carga sin errores y muestra todas las unidades", async () => {
  const page = await open();
  assert.equal(await kpiTotal(page), "182");
  assert.equal(await page.locator("#tabla tbody tr").count(), 25);
  assert.ok(await page.locator("#map-vacio").isHidden(), "el aviso de mapa vacío no debe verse con datos");
  assert.ok(await page.locator("#estado").isHidden());
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("datos de la BD nunca se interpretan como HTML (tooltip, leyenda, tabla, detalle)", async () => {
  const page = await open();
  await page.evaluate(() => { layer.eachLayer((l) => l.openTooltip()); }); // `layer` es global del script
  await page.fill("#q", "img");
  await settle(page);
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.locator("#legend").innerText(), /<img src=x/);
  assert.match(await page.locator("#detalle-titulo").innerText(), /<img src=x/);
  await page.close();
});

test("filtros sincronizan URL, KPIs y enlaces de exportación", async () => {
  const page = await open();
  await page.check('#f-dependencia input[value="CONVENIO"]');
  await settle(page);
  const stats = await (await fetch(`${BASE}/api/estadisticas?dependencia=CONVENIO`)).json();
  assert.equal(await kpiTotal(page), String(stats.total_unidades));
  assert.match(page.url(), /dependencia=CONVENIO/);
  assert.match(await page.locator('[data-export="xlsx"]').getAttribute("href"), /export\.xlsx\?dependencia=CONVENIO/);
  assert.ok((await badges(page)).every((b) => b === "De convenio"));
  await page.click("#limpiar");
  await settle(page);
  assert.equal(await kpiTotal(page), "182");
  assert.ok(!page.url().includes("?"));
  await page.close();
});

test("una URL compartida restaura filtros, página y orden", async () => {
  const page = await open("?dependencia=FISCAL&page=2&orden=-estudiantes_total");
  assert.ok(await page.isChecked('#f-dependencia input[value="FISCAL"]'));
  assert.match(await page.locator("#pageinfo").innerText(), /^Página 2 de/);
  assert.equal(await page.locator('th[data-orden="estudiantes_total"]').getAttribute("aria-sort"), "descending");
  const nums = (await page.locator("#tabla tbody td.num").allInnerTexts()).map((t) => Number(t.replace(/\./g, "")));
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  await page.close();
});

test("una respuesta lenta y vieja no pisa al filtro más reciente", async () => {
  const page = await open();
  await page.route(/\/api\/unidades\?dependencia=FISCAL&page/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {}); // abortada por el navegador
  });
  await page.check('#f-dependencia input[value="FISCAL"]');
  await page.uncheck('#f-dependencia input[value="FISCAL"]');
  await page.check('#f-dependencia input[value="PRIVADA"]');
  await page.waitForTimeout(2000);
  await settle(page);
  assert.ok((await badges(page)).every((b) => b === "Privada"), "la tabla debe mostrar sólo privadas");
  await page.close();
});

test("teclado: Enter en una fila abre el detalle; ordenar desde el encabezado", async () => {
  const page = await open();
  await page.locator("#tabla tbody tr").first().focus();
  await page.keyboard.press("Enter");
  await page.locator("#detalle[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator('th[data-orden="distrito_municipal"] button').focus();
  await page.keyboard.press("Enter");
  await settle(page);
  assert.equal(await page.locator('th[data-orden="distrito_municipal"]').getAttribute("aria-sort"), "ascending");
  assert.match(page.url(), /orden=distrito_municipal/);
  await page.close();
});

test("sin resultados y errores del servidor se muestran al usuario", async () => {
  const page = await open("?q=zzzzzz");
  assert.match(await page.locator("#tabla tbody").innerText(), /Ninguna unidad/);
  assert.ok(await page.locator("#map-vacio").isVisible());
  await page.route(/\/api\/estadisticas/, (r) => r.fulfill({ status: 500, body: "boom" }));
  await page.fill("#q", "");
  await page.locator("#estado").waitFor({ state: "visible" });
  assert.match(await page.locator("#estado").innerText(), /HTTP 500/);
  await page.close();
});
