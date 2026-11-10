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
  await page.route(/openstreetmap\.org|cartocdn\.com/, (r) => r.abort()); // sin red externa: rótulos de distrito
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
  assert.equal(await page.locator("[data-export], [download], .exports").count(), 0, "sin enlaces de descarga en la versión estática");
  assert.ok((await page.locator(".rotulo-distrito").count()) > 0, "rótulos de distrito sin mapa base");
  await page.check('#f-dependencia input[value="PRIVADA"]');
  await page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  assert.ok((await page.locator("#tabla tbody .badge").allInnerTexts()).every((b) => b === "Privada"));
  assert.deepEqual(page.errors, []);
});

test("la página generada no muestra acciones de encargado (sin sesión ni bajas)", async () => {
  assert.ok(await page.locator("#bajas").isHidden(), "sin sección de colegios dados de baja");
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  assert.equal(await page.locator("#detalle [data-accion], #detalle-confirmar").count(), 0, "sin dar de baja/alta en la ficha");
  await page.keyboard.press("Escape");
  assert.deepEqual(page.errors, []);
});

test("en claude.ai (con base compartida) cualquier visitante da de baja y de alta, y se guarda en la base", async () => {
  const p2 = await browser.newPage();
  p2.errors = [];
  p2.on("pageerror", (e) => p2.errors.push(e.message));
  await p2.addInitScript({ path: path.join(ROOT, "tests/agentes/mock-claude.js") }); // window.claude con db en memoria
  await p2.route(/openstreetmap\.org|cartocdn\.com/, (r) => r.abort());
  const vendor = path.join(ROOT, "app/frontend/vendor");
  await p2.route(/leaflet@1\.9\.4\/dist\/leaflet\.js$/, (r) => r.fulfill({ path: path.join(vendor, "leaflet/leaflet.js"), contentType: "text/javascript" }));
  await p2.route(/chart\.js@4\.4\.1\/dist\/chart\.umd\.js$/, (r) => r.fulfill({ path: path.join(vendor, "chart.umd.js"), contentType: "text/javascript" }));
  await p2.goto(`file://${html}`);
  const ocupada = () => p2.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  await p2.locator("#bajas").waitFor({ state: "visible" });
  await ocupada();
  const total = Number((await p2.locator(".kpi b").first().innerText()).replace(/\D/g, ""));
  const nombre = await p2.locator("#tabla tbody tr td").first().innerText();
  await p2.locator("#tabla tbody tr").first().click();
  await p2.click("#detalle [data-accion=baja]");
  await p2.fill("#detalle-motivo", "Cerró sus puertas");
  await p2.click("text=Confirmar baja");
  await p2.locator("#detalle").waitFor({ state: "hidden" });
  await ocupada();
  assert.equal(Number((await p2.locator(".kpi b").first().innerText()).replace(/\D/g, "")), total - 1, "KPI total baja en 1");
  assert.ok(!(await p2.locator("#tabla tbody").innerText()).includes(nombre), "sale del listado");
  assert.ok((await p2.locator("#tabla-bajas").innerText()).includes(nombre), "aparece en dados de baja");
  const guardado = await p2.evaluate(() => [...window.__store].filter(([k]) => k.startsWith("bajas/") || k.startsWith("historial/")).map(([k, v]) => [k.split("/")[0], v.motivo ?? v.accion]));
  assert.deepEqual(guardado.map((g) => g[0]).sort(), ["bajas", "historial"], "baja e historial en la base compartida");
  await p2.locator("#tabla-bajas tbody tr", { hasText: nombre }).locator("[data-alta]").click();
  await p2.click("text=Confirmar alta");
  await p2.locator("#aviso").waitFor({ state: "visible" });
  await ocupada();
  assert.equal(Number((await p2.locator(".kpi b").first().innerText()).replace(/\D/g, "")), total, "el alta lo restituye");
  assert.deepEqual(p2.errors, []);
  await p2.close();
});

test("HU-04: sin base compartida (archivo suelto) el Registro avisa que no puede guardar y no muestra Guardar", async () => {
  await page.click("#nav a[data-vista=registro]");
  await page.locator("#registro-estado").waitFor({ state: "visible" });
  assert.match(await page.locator("#registro-estado").innerText(), /sólo funciona en la versión con servidor o en la página publicada en claude\.ai/);
  assert.ok(await page.locator("#r-guardar").isHidden(), "sin botón Guardar");
  assert.equal((await local("catalogos")).opciones_registro.distritos.length, 14);
  await page.click("#nav a[data-vista=dashboard]");
  assert.deepEqual(page.errors, []);
});

test("HU-04: en claude.ai se registra un colegio en la base compartida, con las mismas validaciones, y aparece en todo", async () => {
  const p3 = await browser.newPage();
  p3.errors = [];
  p3.on("pageerror", (e) => p3.errors.push(e.message));
  await p3.addInitScript({ path: path.join(ROOT, "tests/agentes/mock-claude.js") });
  await p3.route(/openstreetmap\.org|cartocdn\.com/, (r) => r.abort());
  const vendor = path.join(ROOT, "app/frontend/vendor");
  await p3.route(/leaflet@1\.9\.4\/dist\/leaflet\.js$/, (r) => r.fulfill({ path: path.join(vendor, "leaflet/leaflet.js"), contentType: "text/javascript" }));
  await p3.route(/chart\.js@4\.4\.1\/dist\/chart\.umd\.js$/, (r) => r.fulfill({ path: path.join(vendor, "chart.umd.js"), contentType: "text/javascript" }));
  await p3.goto(`file://${html}`);
  const ocupada = () => p3.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  await p3.locator("#bajas").waitFor({ state: "visible" });
  await ocupada();
  const kpi = async () => Number((await p3.locator(".kpi b").first().innerText()).replace(/\D/g, ""));
  const total = await kpi();
  const registros = () => p3.evaluate(() => [...window.__store].filter(([k]) => k.startsWith("registros/")));
  await p3.click("#nav a[data-vista=registro]");
  await p3.locator("#form-registro").waitFor({ state: "visible" });
  // errores de cliente: nada se guarda
  await p3.fill("#r-nombre", "U.E. Artifact E2E");
  await p3.fill("#r-lat", "-16.2");
  await p3.fill("#r-lon", "-68.2");
  await p3.click("#r-guardar");
  assert.equal(await p3.locator("#r-niveles-error").innerText(), "Elija al menos un nivel");
  assert.equal(await p3.locator("#r-lat-error").innerText(), "La ubicación está fuera del área de la ciudad");
  assert.deepEqual(await registros(), []);
  // la misma regla en la "API" del artifact, aunque alguien salte el formulario
  const rechazo = await p3.evaluate(() => CONFIG.staticEstado.post("unidades", { nombre: "x" }).catch((e) => ({ status: e.status, errores: e.errores })));
  assert.equal(rechazo.status, 422);
  assert.equal(rechazo.errores.turnos, "Elija al menos un turno");
  // alta válida
  await p3.selectOption("#r-dependencia", "PRIVADA");
  await p3.selectOption("#r-distrito_municipal", "4");
  await p3.fill("#r-direccion", "Calle Artifact 9");
  await p3.locator("#r-niveles label", { hasText: "Secundaria" }).first().click();
  await p3.locator("#r-turnos label", { hasText: "Tarde" }).click();
  await p3.fill("#r-lat", "-16.53"); // el mapa siguió a la ubicación anterior, fuera del área
  await p3.fill("#r-lon", "-68.21");
  await p3.click("#r-guardar");
  await p3.locator("#registro-ok").waitFor({ state: "visible" });
  await ocupada();
  const guardados = await registros();
  assert.equal(guardados.length, 1, "un registro en la colección registros");
  const [clave, doc] = guardados[0];
  const id = Number(clave.split("/")[1]);
  assert.ok(id >= 1_000_000);
  assert.equal(doc.unidad.turnos, "TARDE");
  assert.equal(doc.usuario, "u_cliente");
  await p3.click("#registro-ok [data-ver]");
  await p3.locator("#detalle[open]").waitFor();
  assert.equal(await p3.locator("#detalle-titulo").innerText(), "U.E. Artifact E2E");
  assert.match(await p3.locator("#detalle-body").innerText(), /Registrado en este sistema/);
  await p3.keyboard.press("Escape");
  await p3.click("#nav a[data-vista=dashboard]");
  assert.equal(await kpi(), total + 1, "KPI total sube en 1");
  assert.ok(await p3.evaluate((id) => ultimoGeojson.features.some((f) => f.properties.id === id), id), "en el mapa");
  await p3.fill("#q", "Artifact E2E");
  await p3.waitForTimeout(400);
  await ocupada();
  assert.match(await p3.locator("#tabla tbody").innerText(), /U\.E\. Artifact E2E/);
  // otro visitante registra (llega por onSnapshot) y aparece sin recargar
  await p3.evaluate(() => window.claude.use("db").then((db) => db.doc("registros/1000123").set({
    unidad: { nombre: "U.E. Artifact Vecino", dependencia: "FISCAL", subsistema: "REGULAR", distrito_municipal: 2, direccion: "Calle 2",
      niveles: "PRIMARIA", turnos: "MAÑANA", lat: -16.5, lon: -68.2 }, usuario: "otro", fecha: "2026-11-20T10:00:00Z" })));
  await p3.fill("#q", "Artifact");
  await p3.locator("#tabla tbody tr", { hasText: "Artifact Vecino" }).waitFor();
  assert.equal(await p3.locator("#tabla tbody tr").count(), 2);
  // la ficha del artifact tiene la misma forma que la del backend para los mismos datos
  const body = { nombre: "U.E. Paridad", dependencia: "fiscal", subsistema: "regular", distrito_municipal: 5, direccion: " Calle 5 ",
    zona: "", telefono: null, niveles: ["PRIMARIA", "PRIMARIA"], turnos: ["NOCHE", "mañana"], lat: -16.5, lon: -68.2, extra: 1 };
  const estatico = await p3.evaluate((b) => CONFIG.staticEstado.post("unidades", b), body);
  const r = await fetch(`${BASE}/api/unidades`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 201);
  const servidor = await r.json();
  const comparable = (u) => Object.fromEntries(Object.entries(u).filter(([k, v]) => v != null && !["id", "clave", "actualizado"].includes(k))
    .map(([k, v]) => [k, k === "registro" ? Object.keys(v).sort() : v]));
  assert.deepEqual(comparable(estatico.unidad), comparable(servidor.unidad));
  await assert.rejects(local(`unidades/${estatico.id}`), /HTTP 404/, "la página sin base no conoce los registros del artifact");
  assert.deepEqual(comparable(await p3.evaluate((id) => CONFIG.staticApi(`unidades/${id}`), estatico.id)), comparable(servidor.unidad));
  assert.deepEqual(p3.errors, []);
  await p3.close();
});

// ---------------------------------------------------------------- sprint 3: Correcciones, Agenda y Personal
/** Página publicada con la base compartida simulada (tests/agentes/mock-claude.js). */
async function conBase(ctxOpts = {}) {
  const ctx = await browser.newContext({ timezoneId: "America/La_Paz", ...ctxOpts });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.addInitScript({ path: path.join(ROOT, "tests/agentes/mock-claude.js") });
  await p.route(/openstreetmap\.org|cartocdn\.com/, (r) => r.abort());
  const vendor = path.join(ROOT, "app/frontend/vendor");
  await p.route(/leaflet@1\.9\.4\/dist\/leaflet\.js$/, (r) => r.fulfill({ path: path.join(vendor, "leaflet/leaflet.js"), contentType: "text/javascript" }));
  await p.route(/chart\.js@4\.4\.1\/dist\/chart\.umd\.js$/, (r) => r.fulfill({ path: path.join(vendor, "chart.umd.js"), contentType: "text/javascript" }));
  await p.goto(`file://${html}`);
  await p.locator("#bajas").waitFor({ state: "visible" });
  await p.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
  return p;
}
const guardados = (p, coleccion) => p.evaluate((c) => [...window.__store].filter(([k]) => k.startsWith(`${c}/`)), coleccion);
const enviarEstatico = (p, metodo, ruta, body) => p.evaluate(([m, r, b]) => CONFIG.staticEstado.enviar(m, r, b)
  .catch((e) => ({ status: e.status, errores: e.errores, message: e.message })), [metodo, ruta, body]);

test("sprint 3: sin base compartida, Correcciones, Agenda y Personal avisan que sólo funcionan con servidor o en claude.ai", async () => {
  for (const v of ["correcciones", "agenda", "personal"]) {
    await page.click(`#nav a[data-vista=${v}]`);
    const aviso = page.locator(`#${v}-aviso`);
    await aviso.waitFor({ state: "visible" });
    assert.match(await aviso.innerText(), /sólo funcionan en la versión con servidor o en la página publicada en claude\.ai/);
    assert.ok(await page.locator(`#${v}-cuerpo`).isHidden());
  }
  assert.ok(await page.locator("#ag-nueva").isHidden());
  assert.ok(await page.locator("#p-nuevo").isHidden());
  await page.click("#nav a[data-vista=dashboard]");
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  assert.equal(await page.locator("#detalle-actividades").count(), 0, "la ficha no ofrece agenda");
  await page.keyboard.press("Escape");
  assert.deepEqual(page.errors, []);
});

test("sprint 3: en claude.ai el personal se registra, edita e inactiva en la base compartida", async () => {
  const p = await conBase();
  await p.click("#nav a[data-vista=personal]");
  await p.locator("#personal-estado", { hasText: "No hay personal activo" }).waitFor();
  await p.click("#p-nuevo");
  await p.click("#p-guardar");
  assert.equal(await p.locator("#p-nombre-error").innerText(), "Escriba el nombre");
  await p.fill("#p-nombre", " Lucía Apaza ");
  await p.fill("#p-cargo", "Trabajadora social");
  await p.fill("#p-correo", "lucia@ejemplo.bo");
  await p.click("#p-guardar");
  await p.locator("#tabla-personal tbody tr", { hasText: "Lucía Apaza" }).waitFor();
  const [[clave, doc]] = await guardados(p, "personal");
  const id = Number(clave.split("/")[1]);
  assert.ok(id > 1e12, "id basado en Date.now()");
  assert.equal(doc.nombre, "Lucía Apaza");
  assert.equal(doc.telefono, null);
  assert.equal(doc.activo, true);
  // mismas reglas y mensajes que el backend
  assert.deepEqual((await enviarEstatico(p, "POST", "personal", { nombre: "", cargo: 5, correo: "x" })).errores,
    { nombre: "Escriba el nombre", cargo: "Debe ser un texto", correo: "Correo no válido" });
  assert.deepEqual((await enviarEstatico(p, "PATCH", `personal/${id}`, { cargo: "Trabajadora social" })).errores, { general: "No hay cambios para guardar" });
  assert.equal((await enviarEstatico(p, "PATCH", "personal/123", { cargo: "x" })).status, 404);
  // editar e inactivar
  await p.locator("#tabla-personal [data-editar]").click();
  await p.fill("#p-telefono", "70000000");
  await p.click("#p-guardar");
  await p.locator("#tabla-personal tbody tr", { hasText: "70000000" }).waitFor();
  await p.locator("#tabla-personal [data-activo]").click();
  await p.locator("#personal-estado", { hasText: "No hay personal activo" }).waitFor();
  assert.equal((await guardados(p, "personal"))[0][1].activo, false);
  assert.ok((await guardados(p, "historial")).length >= 3, "una entrada en historial por cambio");
  // otro visitante agrega a alguien (con HTML en el nombre): llega en vivo y se muestra como texto
  await p.evaluate(() => window.claude.use("db").then((db) => db.doc("personal/1700000000000").set({ nombre: "<img src=x onerror=window.__xss=1>", cargo: "Vecino", activo: true })));
  await p.locator("#tabla-personal tbody tr", { hasText: "<img src=x" }).waitFor();
  assert.equal(await p.evaluate(() => window.__xss), undefined);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test("sprint 3: en claude.ai se corrige un colegio en la base compartida, con las mismas reglas, y se ve en todo y en la bitácora", async () => {
  const p = await conBase();
  const kpi = async () => Number((await p.locator(".kpi b").first().innerText()).replace(/\D/g, ""));
  const total = await kpi();
  const u = (await remote("unidades", "q=DEMO 05&page_size=50")).results.find((x) => !x.turnos.includes("MANANA"));
  await p.click("#nav a[data-vista=correcciones]");
  await p.locator("#c-buscar").pressSequentially(u.nombre, { delay: 10 });
  await p.locator("#c-buscar-lista [role=option]").first().waitFor();
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("Enter");
  await p.locator("#form-correccion").waitFor({ state: "visible" });
  assert.equal(await p.inputValue("#c-nombre"), u.nombre);
  await p.click("#c-guardar");
  assert.equal(await p.locator("#correccion-estado").innerText(), "No hay cambios para guardar.");
  await p.fill("#c-nombre", "U.E. Corregida en el artifact");
  await p.fill("#c-zona", "Zona Nueva");
  await p.click("#c-guardar");
  await p.locator("#correccion-ok").waitFor({ state: "visible" });
  assert.match(await p.locator("#correccion-ok").innerText(), /Se guardaron 2 cambios/);
  await p.locator("#bitacora-lista li", { hasText: "Corrección · u_cliente" }).waitFor();
  assert.ok((await p.locator("#bitacora-lista li").first().innerText()).includes(`Nombre\t${u.nombre}\tU.E. Corregida en el artifact`));
  const [[clave, doc]] = await guardados(p, "correcciones");
  assert.equal(clave, `correcciones/${u.id}`);
  assert.deepEqual(doc.campos, { nombre: "U.E. Corregida en el artifact", zona: "Zona Nueva" });
  // en indicadores, listado y ficha
  await p.click("#nav a[data-vista=dashboard]");
  assert.equal(await kpi(), total);
  await p.fill("#q", "Corregida en el artifact");
  await p.locator("#tabla tbody tr", { hasText: "U.E. Corregida en el artifact" }).waitFor();
  await p.locator("#tabla tbody tr").first().click();
  await p.locator("#detalle[open]").waitFor();
  assert.match(await p.locator("#detalle-body").innerText(), /Corregido por u_cliente[\s\S]*Zona Nueva/);
  await p.keyboard.press("Escape");
  // errores como en el backend: cuerpo no objeto, registro inválido, dado de baja (409), inexistente (404)
  assert.deepEqual((await enviarEstatico(p, "PATCH", `unidades/${u.id}`, [1])).errores, { general: "Datos no válidos" });
  assert.deepEqual((await enviarEstatico(p, "PATCH", `unidades/${u.id}`, { lat: -17 })).errores, { lat: "La ubicación está fuera del área de la ciudad" });
  assert.equal((await enviarEstatico(p, "PATCH", "unidades/999999", { nombre: "x" })).status, 404);
  await enviarEstatico(p, "POST", `unidades/${u.id}/baja`, { confirmar: true, motivo: "prueba" });
  const r409 = await enviarEstatico(p, "PATCH", `unidades/${u.id}`, { nombre: "otra" });
  assert.deepEqual([r409.status, r409.message], [409, "Reactive el colegio antes de corregirlo"]);
  await enviarEstatico(p, "POST", `unidades/${u.id}/alta`, { confirmar: true });
  // misma respuesta que el backend (antes y después con el tipo de la ficha; listas como conjunto; "" = null)
  const otro = (await remote("unidades", "q=DEMO 06&page_size=50")).results.find((x) => !x.turnos.includes("MANANA"));
  const body = { nombre: " U.E. Paridad corrección ", zona: "", telefono: null, distrito_municipal: otro.distrito_municipal === 3 ? 4 : 3,
    niveles: otro.niveles.split(",").reverse(), lat: -16.51, extra: 1 };
  const estatico = await enviarEstatico(p, "PATCH", `unidades/${otro.id}`, body);
  const r = await fetch(`${BASE}/api/unidades/${otro.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  const servidor = await r.json();
  assert.deepEqual(estatico.cambios, servidor.cambios);
  const comparable = (x) => Object.fromEntries(Object.entries(x).filter(([k, v]) => v != null && !["clave", "actualizado", "modificado"].includes(k)));
  assert.deepEqual(comparable(estatico.unidad), comparable(servidor.unidad));
  assert.deepEqual(Object.keys(estatico.unidad.modificado).sort(), Object.keys(servidor.unidad.modificado).sort());
  const hist = await p.evaluate((id) => CONFIG.staticApi(`unidades/${id}/historial`), otro.id);
  const histServidor = await remote(`unidades/${otro.id}/historial`);
  assert.deepEqual(hist.map((h) => Object.keys(h).sort()), histServidor.map((h) => Object.keys(h).sort()));
  assert.deepEqual(hist[0].cambios, histServidor[0].cambios);
  // una corrección de otro visitante con datos raros se sanea
  await p.evaluate((id) => window.claude.use("db").then((db) => db.doc(`correcciones/${id}`).set({ campos: { lat: "x", nombre: "<b>Vecino</b>", otro: 1 } })), otro.id);
  await p.waitForFunction((id) => CONFIG.staticApi(`unidades/${id}`).nombre === "<b>Vecino</b>", otro.id);
  assert.equal(typeof (await p.evaluate((id) => CONFIG.staticApi(`unidades/${id}`).lat, otro.id)), "number");
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

test("sprint 3: en claude.ai se programa una actividad con encargados y personal, se cambia su estado y se ve en la ficha", async () => {
  const p = await conBase({ viewport: { width: 390, height: 844 } });
  const [enc, per] = await Promise.all(["Encargada Uno", "Personal Dos"].map((nombre) => enviarEstatico(p, "POST", "personal", { nombre, cargo: "Cargo" })));
  const u = (await remote("unidades", "q=DEMO 07&page_size=1")).results[0];
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/La_Paz" }).format(new Date());
  const fecha = `${hoy.slice(0, 7)}-01`;
  await p.click("#menu");
  await p.click("#nav a[data-vista=agenda]");
  await p.locator("#ag-calendario table.mes").waitFor();
  await p.click("#ag-nueva");
  await p.locator("#a-encargados label", { hasText: "Encargada Uno" }).waitFor();
  await p.locator("#a-ue_id").pressSequentially(u.nombre, { delay: 10 });
  await p.locator("#a-ue_id-lista [role=option]").first().click();
  await p.selectOption("#a-tipo", "VISITA");
  await p.fill("#a-actividad", "Visita del artifact");
  await p.fill("#a-fecha", fecha);
  await p.fill("#a-hora", "07:45");
  await p.fill("#a-lugar", "Portería");
  await p.locator("#a-encargados label", { hasText: "Encargada Uno" }).click();
  await p.locator("#a-personal label", { hasText: "Personal Dos" }).click();
  await p.click("#a-guardar");
  await p.locator(`#ag-calendario td[data-fecha="${fecha}"] .ev`).waitFor();
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin scroll horizontal a 390 px");
  const [[clave, doc]] = await guardados(p, "actividades");
  assert.ok(Number(clave.split("/")[1]) > 1e12);
  assert.deepEqual([doc.ue_id, doc.tipo, doc.fecha, doc.hora, doc.encargados, doc.personal, doc.estado],
    [u.id, "VISITA", fecha, "07:45", [enc.persona.id], [per.persona.id], "PENDIENTE"]);
  // detalle y cambio de estado
  await p.locator(`#ag-calendario td[data-fecha="${fecha}"] .ev`).click();
  await p.locator("#actividad[open]").waitFor();
  assert.match(await p.locator("#actividad-body").innerText(), /Encargada Uno[\s\S]*Personal Dos/);
  await p.selectOption("#act-estado", "REALIZADA");
  await p.click("#act-estado-form [type=submit]");
  await p.locator("#actividad-body dd", { hasText: /^Realizada$/ }).waitFor();
  await p.keyboard.press("Escape");
  await p.locator(`#ag-calendario td[data-fecha="${fecha}"] .ev.estado-realizada`).waitFor();
  // reglas del backend: personal inactivo no se asigna; rangos y filtros de la lista
  await enviarEstatico(p, "PATCH", `personal/${per.persona.id}`, { activo: false });
  const base = { ue_id: u.id, tipo: "reunión", actividad: "A", fecha, hora: "09:00", lugar: "L", encargados: [enc.persona.id] };
  assert.deepEqual((await enviarEstatico(p, "POST", "actividades", { ...base, personal: [per.persona.id] })).errores, { personal: "Hay personas que no existen o están inactivas" });
  const creada = await enviarEstatico(p, "POST", "actividades", base);
  assert.equal(creada.actividad.tipo, "REUNION");
  const id = (await guardados(p, "actividades")).map(([k]) => Number(k.split("/")[1])).find((x) => x !== creada.actividad.id);
  assert.equal((await enviarEstatico(p, "PATCH", `actividades/${id}`, { lugar: "Otro" })).actividad.personal[0].activo, false, "el inactivo ya asignado se queda");
  await assert.rejects(p.evaluate(() => CONFIG.staticApi("actividades", "desde=2026-01-01&hasta=2028-01-01")), /HTTP 422/);
  assert.equal((await p.evaluate((id) => CONFIG.staticApi("actividades", `ue_id=${id}&estado=REALIZADA`), u.id)).length, 1);
  // en la ficha del colegio
  await p.click("#menu");
  await p.click("#nav a[data-vista=dashboard]");
  await p.evaluate((id) => showDetail(id), u.id);
  await p.locator("#detalle-actividades li", { hasText: "Visita del artifact" }).waitFor();
  assert.equal(await p.locator("#detalle-actividades li").count(), 2);
  // una actividad de otro visitante con datos raros: sin fecha válida se ignora
  await p.evaluate(() => window.claude.use("db").then((db) => db.doc("actividades/1700000000001").set({ ue_id: 1, fecha: "mañana", actividad: "<b>x</b>" })));
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => CONFIG.staticApi.actividad(1700000000001)), null);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});
