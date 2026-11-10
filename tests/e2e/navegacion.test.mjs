// HU-03 (barra lateral) y HU-07 (sección Estadísticas), en Chromium real contra la API real.
// Login desactivado (COLEGIOS_AUTH=0): aquí se prueba la navegación, no la sesión.
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 9200 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python3";
const TILES = /openstreetmap\.org|cartocdn\.com/;
const OPCIONES = ["Dashboard", "Registro", "Correcciones", "Agenda", "Personal", "Estadísticas"];
const VISTAS = ["dashboard", "registro", "correcciones", "agenda", "personal", "estadisticas"];
let server, browser, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-nav-"));
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "n.db")}`,
    COLEGIOS_AUTH_DB: `sqlite:///${path.join(tmp, "sistema.db")}`, COLEGIOS_AUTH: "0" };
  execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
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

async function open(query = "", ctxOpts = {}) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.route(TILES, (r) => r.abort());
  await page.goto(`${BASE}/${query}`);
  await settle(page);
  return page;
}

const api = async (p) => (await fetch(`${BASE}/api/${p}`)).json();
const settle = (page) => page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
const kpiTotal = async (page) => Number((await page.locator(".kpi b").first().innerText()).replace(/\./g, ""));
const visibles = (page) => page.evaluate((vs) => vs.filter((v) => !document.querySelector(`#vista-${v}`).hidden), VISTAS);
const actual = (page) => page.locator("#nav a[aria-current=page]").innerText();
const sinScrollHorizontal = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const sumaDep = (page) => page.evaluate(() => charts["ch-dep"].data.datasets[0].data.reduce((a, b) => a + b, 0));

test("HU-03: la barra lateral muestra las seis opciones y el Dashboard marcado por defecto", async () => {
  const page = await open();
  assert.deepEqual(await page.locator("#nav a").allInnerTexts(), OPCIONES);
  assert.ok(await page.locator("#nav").isVisible());
  assert.ok(await page.locator("#menu").isHidden(), "en escritorio no hace falta el botón de menú");
  assert.equal(await actual(page), "Dashboard");
  assert.equal(await page.locator("#nav a[aria-current]").count(), 1);
  assert.deepEqual(await visibles(page), ["dashboard"]);
  assert.ok(!page.url().includes("vista="), "la vista por defecto no va en la URL");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-03: elegir cada opción abre su sección, la marca y la guarda en la URL; los filtros sólo en Dashboard y Estadísticas", async () => {
  const page = await open("?dependencia=FISCAL");
  for (const [i, nombre] of OPCIONES.entries()) {
    await page.click(`#nav a:text-is("${nombre}")`);
    assert.equal(await actual(page), nombre);
    assert.deepEqual(await visibles(page), [VISTAS[i]]);
    const u = new URL(page.url());
    assert.equal(u.searchParams.get("vista"), VISTAS[i] === "dashboard" ? null : VISTAS[i]);
    assert.equal(u.searchParams.get("dependencia"), "FISCAL", "la sección no pierde los filtros");
    const conFiltros = ["dashboard", "estadisticas"].includes(VISTAS[i]);
    assert.equal(await page.locator(".filters").isVisible(), conFiltros, `filtros en ${nombre}`);
    assert.equal(await page.locator("#kpis").isVisible(), conFiltros, `indicadores en ${nombre}`);
    assert.equal(await page.evaluate(() => document.activeElement.id), `vista-${VISTAS[i]}`, "el foco pasa a la sección");
  }
  // las secciones del sprint 3 ya no son "próximamente": muestran su contenido
  const contenido = { correcciones: "#c-buscar", agenda: "#ag-calendario table.mes", personal: "#personal-cuerpo" };
  for (const [v, sel] of Object.entries(contenido)) {
    await page.click(`#nav a[data-vista=${v}]`);
    await page.locator(sel).waitFor({ state: "visible" });
    assert.doesNotMatch(await page.locator(`#vista-${v}`).innerText(), /próximo sprint/);
  }
  // atrás y adelante del navegador recorren las secciones visitadas
  await page.goBack();
  assert.equal(await actual(page), "Agenda");
  await page.goForward();
  assert.equal(await actual(page), "Personal");
  // los enlaces del sprint 2 (?vista=modificacion) abren Correcciones
  const vieja = await open("?vista=modificacion");
  assert.equal(await actual(vieja), "Correcciones");
  await vieja.context().close();
  // teclado: Tab llega a las opciones y Enter las abre
  await page.locator("#nav a[data-vista=estadisticas]").focus();
  await page.keyboard.press("Enter");
  assert.equal(await actual(page), "Estadísticas");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-03: una URL compartida con la sección la abre en otro navegador", async () => {
  const page = await open();
  await page.click("#nav a[data-vista=estadisticas]");
  await page.check('#f-dependencia input[value="CONVENIO"]');
  await settle(page);
  assert.match(page.url(), /vista=estadisticas/);
  const copia = await open(new URL(page.url()).search); // otro contexto: sin historial ni estado
  assert.equal(await actual(copia), "Estadísticas");
  assert.deepEqual(await visibles(copia), ["estadisticas"]);
  assert.ok(await copia.isChecked('#f-dependencia input[value="CONVENIO"]'));
  assert.equal(await kpiTotal(copia), (await api("estadisticas?dependencia=CONVENIO")).total_unidades);
  // los enlaces de la barra llevan el mismo estado (abrir en otra pestaña da la misma vista)
  assert.match(await copia.locator("#nav a[data-vista=registro]").getAttribute("href"), /dependencia=CONVENIO&vista=registro/);
  for (const v of ["registro", "correcciones", "agenda", "personal"]) {
    const p = await open(`?vista=${v}`);
    assert.equal(await p.locator("#nav a[aria-current]").getAttribute("data-vista"), v);
    assert.ok(await p.locator(".filters").isHidden());
    await p.context().close();
  }
  const rara = await open("?vista=nada");
  assert.equal(await actual(rara), "Dashboard", "una vista desconocida abre el Dashboard");
  await Promise.all([page, copia, rara].map((p) => p.context().close()));
});

test("HU-03: al volver al Dashboard el mapa se redimensiona y encuadra los colegios", async () => {
  const page = await open("?vista=estadisticas");
  await page.click("#nav a[data-vista=dashboard]");
  await page.waitForTimeout(200);
  const vista = (p) => p.evaluate(() => [map.getSize().x, document.querySelector("#map").clientWidth, map.getZoom(), map.getBounds().toBBoxString()]);
  const [ancho, contenedor, zoom, bbox] = await vista(page);
  assert.ok(ancho > 300 && ancho === contenedor, "Leaflet conoce el tamaño real del mapa");
  assert.ok((await page.locator("#map").boundingBox()).height > 300);
  const directo = await open(); // mismo encuadre que si se abre el Dashboard de entrada
  const [, , zoomDirecto, bboxDirecto] = await vista(directo);
  assert.equal(zoom, zoomDirecto, "el encuadre pendiente se aplica al mostrar el mapa");
  assert.equal(bbox, bboxDirecto);
  await Promise.all([page, directo].map((p) => p.context().close()));
});

for (const colorScheme of ["light", "dark"]) {
  test(`HU-03: en celular la barra se abre y se cierra con el botón de menú sin tapar el contenido (tema ${colorScheme})`, async () => {
    const page = await open("", { viewport: { width: 390, height: 844 }, colorScheme });
    const menu = page.locator("#menu");
    assert.ok(await menu.isVisible());
    assert.equal(await menu.getAttribute("aria-controls"), "nav");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    assert.ok(await page.locator("#nav").isHidden(), "plegada al entrar");
    // abrir: la barra aparece en el flujo de la página y empuja el contenido (no lo tapa)
    await menu.click();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    assert.ok(await page.locator("#nav").isVisible());
    assert.equal(await page.evaluate(() => document.activeElement.dataset.vista), "dashboard", "el foco va a la opción actual");
    const [nav, contenido] = await Promise.all(["#nav", ".content"].map((s) => page.locator(s).boundingBox()));
    assert.ok(contenido.y >= nav.y + nav.height, "el contenido queda debajo de la barra, no tapado");
    assert.notEqual(await page.locator("#nav").evaluate((e) => getComputedStyle(e).position), "fixed");
    assert.ok(await sinScrollHorizontal(page));
    // Escape cierra y devuelve el foco al botón
    await page.keyboard.press("Escape");
    assert.ok(await page.locator("#nav").isHidden());
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "menu");
    // elegir una opción también cierra
    for (const v of ["registro", "correcciones", "agenda", "personal", "estadisticas", "dashboard"]) {
      await menu.click();
      await page.click(`#nav a[data-vista=${v}]`);
      assert.ok(await page.locator("#nav").isHidden(), `se cierra al elegir ${v}`);
      assert.equal(await menu.getAttribute("aria-expanded"), "false");
      assert.deepEqual(await visibles(page), [v]);
      await settle(page);
      assert.ok(await sinScrollHorizontal(page), `sin scroll horizontal en ${v}`);
    }
    // la opción marcada usa el color de acento del tema
    await menu.click();
    const [colorLink, accent] = await page.evaluate(() => [getComputedStyle(document.querySelector("#nav a[aria-current]")).color,
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()]);
    assert.equal(accent, colorScheme === "dark" ? "#7fb2e5" : "#1f4e79");
    assert.equal(colorLink, colorScheme === "dark" ? "rgb(127, 178, 229)" : "rgb(31, 78, 121)");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test("HU-07: los gráficos están en Estadísticas, no en el Dashboard", async () => {
  const page = await open();
  for (const id of ["ch-distrito", "ch-dep", "ch-nivel"]) assert.ok(await page.locator(`#${id}`).isHidden(), `${id} fuera del Dashboard`);
  assert.ok(await page.locator("#map").isVisible());
  assert.ok(await page.locator("#tabla").isVisible());
  assert.equal(await page.evaluate(() => Object.keys(charts).length), 0, "no se dibujan gráficos ocultos");
  await page.click("#nav a[data-vista=estadisticas]");
  for (const id of ["ch-distrito", "ch-dep", "ch-nivel"]) {
    const b = await page.locator(`#${id}`).boundingBox();
    assert.ok(b && b.width > 100 && b.height > 50, `${id} visible y con tamaño`);
  }
  assert.ok(await page.locator("#kpis").isVisible(), "los indicadores acompañan a los gráficos");
  assert.ok(await page.locator("#map").isHidden(), "el mapa queda en el Dashboard");
  assert.ok(await page.locator("#tabla").isHidden(), "el listado queda en el Dashboard");
  assert.equal(await sumaDep(page), await kpiTotal(page));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-07: las estadísticas responden a los filtros", async () => {
  const page = await open("?vista=estadisticas");
  const total = (await api("estadisticas")).total_unidades;
  assert.equal(await sumaDep(page), total);
  await page.check('#f-dependencia input[value="PRIVADA"]');
  await settle(page);
  const privadas = await api("estadisticas?dependencia=PRIVADA");
  assert.equal(await kpiTotal(page), privadas.total_unidades);
  assert.equal(await sumaDep(page), privadas.total_unidades);
  assert.deepEqual(await page.evaluate(() => charts["ch-dep"].data.labels), ["Privada"]);
  const porDistrito = await page.evaluate(() => charts["ch-distrito"].data.datasets.map((d) => d.label));
  assert.deepEqual(porDistrito, ["Privada"]);
  const niveles = await page.evaluate(() => charts["ch-nivel"].data.datasets[0].data.reduce((a, b) => a + b, 0));
  assert.equal(niveles, Object.values(privadas.por_nivel).reduce((a, b) => a + b, 0));
  // un filtro aplicado en el Dashboard también se ve al pasar a Estadísticas
  await page.click("#nav a[data-vista=dashboard]");
  await page.uncheck('#f-dependencia input[value="PRIVADA"]');
  await settle(page);
  await page.click("#nav a[data-vista=estadisticas]");
  assert.equal(await sumaDep(page), total);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
