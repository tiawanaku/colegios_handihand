// HU-02: el encargado da de baja y de alta colegios desde el dashboard (Chromium real contra la API real).
// Login desactivado (COLEGIOS_AUTH=0): la sesión responde rol "encargado". BD propia: las bajas no tocan
// a las otras pruebas. Las pruebas van en orden y comparten el colegio dado de baja.
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 8900 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python3";
const TILES = /openstreetmap\.org|cartocdn\.com/;
let server, browser, tmp, total, elegido; // elegido: { id, nombre } del colegio que se da de baja

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-bajas-"));
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "b.db")}`,
    COLEGIOS_AUTH_DB: `sqlite:///${path.join(tmp, "sistema.db")}`, COLEGIOS_AUTH: "0" };
  execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
  server = spawn(PY, ["-m", "uvicorn", "app.backend.main:app", "--port", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/catalogos`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  total = (await api("estadisticas")).total_unidades;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(query = "", ctxOpts = {}) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  page.errors = [];
  page.posts = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("request", (r) => r.method() === "POST" && page.posts.push(r.url()));
  await page.route(TILES, (r) => r.abort());
  await page.goto(`${BASE}/${query}`);
  await settle(page);
  return page;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const api = async (p) => (await fetch(`${BASE}/api/${p}`)).json();
const settle = (page) => page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
const kpiTotal = async (page) => Number((await page.locator(".kpi b").first().innerText()).replace(/\./g, ""));
const enMapa = (page, id) => page.evaluate((id) => ultimoGeojson.features.some((f) => String(f.properties.id) === String(id)), id);
async function buscar(page, texto) {
  await page.evaluate(() => (document.querySelector("#panel-filtros").open = true)); // en celular empieza plegado
  await page.fill("#q", texto);
  await page.waitForTimeout(400); // el buscador espera 300 ms antes de pedir
  await settle(page);
}
const enListado = async (page, nombre) => {
  await buscar(page, nombre);
  return (await page.locator("#tabla tbody td:first-child").allInnerTexts()).includes(nombre);
};

async function abrirFicha(page, nombre) {
  await buscar(page, nombre);
  await page.locator("#tabla tbody tr", { hasText: nombre }).first().click();
  await page.locator("#detalle[open]").waitFor();
}

test("dar de baja exige confirmación: sin confirmar no cambia nada", async () => {
  const page = await open();
  assert.equal(await kpiTotal(page), total);
  await page.locator("#bajas").waitFor({ state: "visible" });
  assert.equal(await page.locator("#bajas-estado").innerText(), "No hay colegios dados de baja");
  const r = (await api("unidades?page_size=1&orden=-estudiantes_total")).results[0];
  elegido = { id: r.id, nombre: r.nombre };
  await abrirFicha(page, elegido.nombre);

  await page.click("#detalle [data-accion=baja]");
  const paso = page.locator("#detalle-confirmar");
  await paso.waitFor({ state: "visible" });
  assert.match(await paso.innerText(), new RegExp(`Dar de baja «${reEsc(elegido.nombre)}»`));
  assert.equal(await page.evaluate(() => document.activeElement.id), "detalle-motivo", "el foco va al paso de confirmación");
  assert.ok(await page.locator("#detalle-acciones").isHidden());

  // Confirmar sin motivo: avisa y no llama a la API
  await page.click("text=Confirmar baja");
  assert.match(await page.locator("#detalle-error").innerText(), /motivo/);
  assert.equal(await page.locator("#detalle-motivo").getAttribute("aria-invalid"), "true");
  // Cancelar: vuelve la ficha y nada cambió
  await page.click("#detalle-confirmar [data-cancelar]");
  assert.ok(await paso.isHidden());
  assert.ok(await page.locator("#detalle [data-accion=baja]").isVisible());
  assert.deepEqual(page.posts, [], "ninguna petición de baja sin confirmar");
  await page.keyboard.press("Escape");
  await buscar(page, "");
  assert.equal(await kpiTotal(page), total);
  assert.equal((await api("bajas")).length, 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("tras confirmar la baja, desaparece de indicadores, mapa y listado y aparece en «dados de baja»", async () => {
  const page = await open();
  assert.ok(await enMapa(page, elegido.id), "antes de la baja está en el mapa");
  await abrirFicha(page, elegido.nombre);
  await page.click("#detalle [data-accion=baja]");
  await page.fill("#detalle-motivo", "Cierre definitivo <b>2026</b>");
  await page.click("text=Confirmar baja");
  await page.locator("#detalle").waitFor({ state: "hidden" });
  assert.deepEqual(page.posts, [`${BASE}/api/unidades/${elegido.id}/baja`]);
  await page.locator("#aviso").waitFor({ state: "visible" });
  assert.match(await page.locator("#aviso").innerText(), /se dio de baja/);
  await settle(page);

  assert.ok(!(await enListado(page, elegido.nombre)), "no está en el listado");
  await buscar(page, "");
  assert.equal(await kpiTotal(page), total - 1, "el KPI total baja en 1");
  assert.ok(!(await enMapa(page, elegido.id)), "no está en el mapa");

  const fila = page.locator("#tabla-bajas tbody tr", { hasText: elegido.nombre });
  assert.equal(await fila.count(), 1);
  assert.match(await fila.innerText(), /Cierre definitivo <b>2026<\/b>/, "el motivo se muestra como texto");
  assert.equal(await page.locator("#bajas-count").innerText(), "(1)");

  // La ficha de un colegio dado de baja lo dice y ofrece dar de alta
  await fila.locator("[data-ver]").click();
  await page.locator("#detalle[open]").waitFor();
  assert.match(await page.locator(".baja-info").innerText(), /^Dado de baja el .+ · Cierre definitivo <b>2026<\/b>$/);
  assert.ok(await page.locator("#detalle [data-accion=alta]").isVisible());
  assert.equal(await page.locator("#detalle [data-accion=baja]").count(), 0);
  await page.keyboard.press("Escape");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("un error al dar de baja se muestra en el diálogo sin cerrarlo", async () => {
  const page = await open();
  const otro = (await api("unidades?page_size=1")).results[0];
  await page.route(/\/api\/unidades\/\d+\/baja$/, (r) => r.fulfill({ status: 409, contentType: "application/json", body: '{"detail":"ya"}' }));
  await abrirFicha(page, otro.nombre);
  await page.click("#detalle [data-accion=baja]");
  await page.fill("#detalle-motivo", "prueba");
  await page.click("text=Confirmar baja");
  await page.locator("#detalle-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#detalle-error").innerText(), /ya estaba dado de baja/);
  assert.ok(await page.locator("#detalle[open]").isVisible(), "el diálogo sigue abierto");
  await page.route(/\/api\/unidades\/\d+\/baja$/, (r) => r.abort());
  await page.click("text=Confirmar baja");
  await page.waitForFunction(() => /conectar con el servidor/.test(document.querySelector("#detalle-error").textContent));
  await page.context().close();
});

test("dar de alta (con confirmación) lo restituye en indicadores, mapa y listado", async () => {
  const page = await open("", { viewport: { width: 390, height: 844 } }); // también en celular
  const fila = page.locator("#tabla-bajas tbody tr", { hasText: elegido.nombre });
  await fila.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal con la sección de bajas a 390 px");
  await fila.locator("[data-alta]").click();
  const paso = page.locator("#bajas-confirmar");
  await paso.waitFor({ state: "visible" });
  assert.match(await paso.innerText(), new RegExp(`Dar de alta «${reEsc(elegido.nombre)}»`));
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Confirmar alta");
  await page.click("#bajas-confirmar [data-cancelar]");
  assert.ok(await paso.isHidden());
  assert.deepEqual(page.posts, [], "cancelar no llama a la API");

  await fila.locator("[data-alta]").click();
  await page.click("text=Confirmar alta");
  await page.locator("#aviso").waitFor({ state: "visible" });
  assert.match(await page.locator("#aviso").innerText(), /se dio de alta/);
  await page.locator("#bajas-estado", { hasText: "No hay colegios dados de baja" }).waitFor();
  await settle(page);
  assert.equal(await kpiTotal(page), total, "el KPI total vuelve");
  assert.ok(await enMapa(page, elegido.id), "vuelve al mapa");
  assert.ok(await enListado(page, elegido.nombre), "vuelve al listado");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal a 390 px");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("con rol de consulta no aparecen acciones ni sección de bajas", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(TILES, (r) => r.abort());
  await page.route(/\/api\/auth\/sesion$/, (r) => r.fulfill({ contentType: "application/json",
    body: JSON.stringify({ requerida: true, usuario: "lectora", nombre: "Lectora", rol: "consulta" }) }));
  await page.goto(`${BASE}/`);
  await settle(page);
  assert.ok(await page.locator("#bajas").isHidden());
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  assert.equal(await page.locator("#detalle [data-accion]").count(), 0);
  await ctx.close();
});
