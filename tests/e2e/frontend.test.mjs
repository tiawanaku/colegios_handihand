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
const TILES = /openstreetmap\.org|cartocdn\.com/;
const TILE_PNG = path.join(ROOT, "app/frontend/vendor/leaflet/images/layers.png"); // cualquier PNG sirve de tile
const USUARIO = "e2e", CLAVE = "clave-e2e-123";
let server, browser, tmp, cookie;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-e2e-"));
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "e2e.db")}`,
    COLEGIOS_AUTH_DB: `sqlite:///${path.join(tmp, "usuarios.db")}`, COLEGIOS_AUTH: "1", COLEGIOS_SECRET: "e2e" };
  execFileSync(PY, ["-c", `
import sys
from app.backend import auth
from sqlmodel import Session
auth.init_auth_db()
with Session(auth.auth_engine) as s:
    s.add(auth.Usuario(usuario=sys.argv[1], nombre="Usuaria E2E", clave_hash=auth.hash_clave(sys.argv[2])))
    s.commit()`, USUARIO, CLAVE], { cwd: ROOT, env });
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
    try { if ((await fetch(`${BASE}/api/auth/sesion`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: USUARIO, clave: CLAVE }),
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0]; // colegios_sesion=...
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Página con sesión iniciada (la cookie del login hecho en before). */
async function open(query = "") {
  const ctx = await browser.newContext();
  const [name, value] = cookie.split(/=(.*)/);
  await ctx.addCookies([{ name, value, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  await page.route(TILES, (r) => r.abort()); // sin red externa en CI
  await page.goto(`${BASE}/${query}`);
  await settle(page);
  return page;
}

const api = (p) => fetch(`${BASE}/api/${p}`, { headers: { cookie } });
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
  await page.context().close();
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
  await page.context().close();
});

test("filtros sincronizan URL, KPIs y enlaces de exportación", async () => {
  const page = await open();
  await page.check('#f-dependencia input[value="CONVENIO"]');
  await settle(page);
  const stats = await (await api("estadisticas?dependencia=CONVENIO")).json();
  assert.equal(await kpiTotal(page), String(stats.total_unidades));
  assert.match(page.url(), /dependencia=CONVENIO/);
  assert.match(await page.locator('[data-export="xlsx"]').getAttribute("href"), /export\.xlsx\?dependencia=CONVENIO/);
  assert.ok((await badges(page)).every((b) => b === "De convenio"));
  await page.click("#limpiar");
  await settle(page);
  assert.equal(await kpiTotal(page), "182");
  assert.ok(!page.url().includes("?"));
  await page.context().close();
});

test("una URL compartida restaura filtros, página y orden", async () => {
  const page = await open("?dependencia=FISCAL&page=2&orden=-estudiantes_total");
  assert.ok(await page.isChecked('#f-dependencia input[value="FISCAL"]'));
  assert.match(await page.locator("#pageinfo").innerText(), /^Página 2 de/);
  assert.equal(await page.locator('th[data-orden="estudiantes_total"]').getAttribute("aria-sort"), "descending");
  const nums = (await page.locator("#tabla tbody td.num").allInnerTexts()).map((t) => Number(t.replace(/\./g, "")));
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  await page.context().close();
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
  await page.context().close();
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
  await page.context().close();
});

test("sin resultados y errores del servidor se muestran al usuario", async () => {
  const page = await open("?q=zzzzzz");
  assert.match(await page.locator("#tabla tbody").innerText(), /Ninguna unidad/);
  assert.ok(await page.locator("#map-vacio").isVisible());
  await page.route(/\/api\/estadisticas/, (r) => r.fulfill({ status: 500, body: "boom" }));
  await page.fill("#q", "");
  await page.locator("#estado").waitFor({ state: "visible" });
  assert.match(await page.locator("#estado").innerText(), /HTTP 500/);
  await page.context().close();
});

test("login: sin sesión redirige, credenciales malas avisan, las buenas entran y Salir cierra", async () => {
  const page = await browser.newPage();
  await page.route(TILES, (r) => r.abort());
  await page.goto(`${BASE}/?dependencia=FISCAL`);
  assert.match(page.url(), /\/login\.html$/);
  assert.equal((await fetch(`${BASE}/api/unidades`)).status, 401);
  await page.fill("#usuario", USUARIO);
  await page.fill("#clave", "incorrecta");
  await page.click("button[type=submit]");
  await page.locator("#login-error").waitFor({ state: "visible" });
  assert.match(await page.locator("#login-error").innerText(), /incorrectos/);
  assert.equal(await page.inputValue("#clave"), "");
  await page.fill("#clave", CLAVE);
  await page.press("#clave", "Enter");
  await page.waitForURL(`${BASE}/`);
  await settle(page);
  assert.equal(await kpiTotal(page), "182");
  await page.locator(".sesion").waitFor({ state: "visible" });
  assert.equal(await page.locator("#sesion-nombre").innerText(), "Usuaria E2E");
  await page.click("#salir");
  await page.waitForURL(/\/login\.html$/);
  await page.goto(`${BASE}/`);
  assert.match(page.url(), /\/login\.html$/, "tras salir, el dashboard vuelve a pedir login");
  await page.context().close();
});

/** Página con sesión cuyo mapa base responde según `tiles(route)`. */
async function openConTiles(tiles, { sinLeaflet = false, noReferrer = false } = {}) {
  const ctx = await browser.newContext();
  const [name, value] = cookie.split(/=(.*)/);
  await ctx.addCookies([{ name, value, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.pedidos = [];
  await page.route(TILES, (r) => { page.pedidos.push({ url: r.request().url(), referer: r.request().headers().referer }); return tiles(r); });
  if (sinLeaflet) await page.route(/leaflet\.js$/, (r) => r.abort());
  if (noReferrer) { // como un nginx con "Referrer-Policy: no-referrer": OSM respondería 403
    await page.route(`${BASE}/`, async (r) => {
      const resp = await r.fetch();
      await r.fulfill({ response: resp, headers: { ...resp.headers(), "referrer-policy": "no-referrer" } });
    });
  }
  await page.goto(`${BASE}/`);
  await settle(page);
  return page;
}

const imgsDeTiles = (page) => page.locator("#map img.leaflet-tile-loaded").count();

test("mapa: muestra el mapa base de OpenStreetMap y lo pide con Referer aunque el sitio diga no-referrer", async () => {
  const page = await openConTiles((r) => r.fulfill({ path: TILE_PNG, contentType: "image/png" }), { noReferrer: true });
  await page.waitForFunction(() => document.querySelectorAll("#map img.leaflet-tile-loaded").length > 0);
  assert.ok(page.pedidos.every((p) => p.url.includes("tile.openstreetmap.org")), "sólo OSM mientras funcione");
  assert.ok(page.pedidos.every((p) => p.referer?.startsWith(BASE)), "OSM exige Referer");
  assert.equal(await page.locator(".rotulo-distrito").count(), 0);
  assert.ok((await page.locator("#map").boundingBox()).height > 300, "el contenedor del mapa tiene alto");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("mapa: si OpenStreetMap rechaza los tiles, usa CARTO", async () => {
  const page = await openConTiles((r) => (/openstreetmap/.test(r.request().url())
    ? r.fulfill({ status: 403, body: "Referer is required" })
    : r.fulfill({ path: TILE_PNG, contentType: "image/png" })));
  await page.waitForFunction(() => [...document.querySelectorAll("#map img.leaflet-tile-loaded")].some((i) => i.src.includes("cartocdn")));
  assert.equal(await page.locator("#map img[src*=openstreetmap]").count(), 0, "la capa de OSM se retira");
  await page.context().close();
});

test("mapa: sin ningún mapa base dibuja rótulos de distrito y sigue mostrando los puntos", async () => {
  const page = await openConTiles((r) => r.abort());
  await page.locator(".rotulo-distrito").first().waitFor();
  assert.ok(await page.locator("#map.sin-mapa-base").count());
  assert.equal(await imgsDeTiles(page), 0);
  assert.ok(await page.locator("#map-vacio").isHidden());
  await page.context().close();
});

test("mapa: si Leaflet no carga, avisa y el resto del dashboard funciona", async () => {
  const page = await openConTiles((r) => r.abort(), { sinLeaflet: true });
  assert.match(await page.locator("#map-vacio").innerText(), /No se pudo cargar el mapa/);
  assert.equal(await kpiTotal(page), "182");
  assert.equal(await page.locator("#tabla tbody tr").count(), 25);
  await page.context().close();
});
