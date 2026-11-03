// HU-04: registrar colegios nuevos desde la sección Registro (Chromium real contra la API real, con login).
// BD propia: los registros no tocan a las otras pruebas.
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PORT = 9500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PY = process.env.PYTHON || "python3";
const TILES = /openstreetmap\.org|cartocdn\.com/;
const USUARIO = "e2e-reg", CLAVE = "clave-registro-123";
const NOMBRE = "U.E. Nuevo Horizonte E2E <img src=x onerror=window.__xss=1>";
let server, browser, tmp, cookie;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "colegios-registro-"));
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "r.db")}`,
    COLEGIOS_AUTH_DB: `sqlite:///${path.join(tmp, "sistema.db")}`, COLEGIOS_AUTH: "1", COLEGIOS_SECRET: "e2e" };
  execFileSync(PY, ["-c", `
import sys
from app.backend import auth
from sqlmodel import Session
auth.init_auth_db()
with Session(auth.auth_engine) as s:
    s.add(auth.Usuario(usuario=sys.argv[1], nombre="Registradora E2E", clave_hash=auth.hash_clave(sys.argv[2])))
    s.commit()`, USUARIO, CLAVE], { cwd: ROOT, env });
  execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
  server = spawn(PY, ["-m", "uvicorn", "app.backend.main:app", "--port", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/auth/sesion`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: USUARIO, clave: CLAVE }),
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get("set-cookie").split(";")[0];
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(query = "?vista=registro", ctxOpts = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const [name, value] = cookie.split(/=(.*)/);
  await ctx.addCookies([{ name, value, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.posts = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/unidades") && page.posts.push(r.postDataJSON()));
  await page.route(TILES, (r) => r.abort());
  await page.goto(`${BASE}/${query}`);
  await settle(page);
  if (query.includes("vista=registro")) await page.locator("#form-registro").waitFor({ state: "visible" });
  return page;
}

const api = async (p) => (await fetch(`${BASE}/api/${p}`, { headers: { cookie } })).json();
const settle = (page) => page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");
const kpiTotal = async (page) => Number((await page.locator(".kpi b").first().innerText()).replace(/\./g, ""));
const errorDe = (page, campo) => page.locator(`#r-${campo}-error`);

/** Llena los datos obligatorios (sin ubicación ni niveles/turnos, que cada prueba decide). */
async function llenarDatos(page, nombre = NOMBRE) {
  await page.fill("#r-nombre", nombre);
  await page.selectOption("#r-dependencia", "CONVENIO");
  await page.selectOption("#r-distrito_municipal", "7");
  await page.fill("#r-direccion", "  Av. Juan Pablo II, n.º 100  ");
  await page.fill("#r-zona", "Villa Adela");
}

test("HU-04: el formulario muestra las opciones del catálogo con etiquetas legibles", async () => {
  const page = await open();
  const op = (await api("catalogos")).opciones_registro;
  assert.deepEqual((await page.locator("#r-dependencia option").allInnerTexts()).slice(1), ["Fiscal (pública)", "De convenio", "Privada"]);
  assert.equal(await page.inputValue("#r-subsistema"), "REGULAR", "subsistema regular por defecto");
  assert.equal(await page.locator("#r-distrito_municipal option").count(), op.distritos.length + 1);
  assert.deepEqual(await page.locator("#r-turnos label").allInnerTexts(), ["Mañana", "Tarde", "Noche"]);
  assert.equal(await page.locator("#r-niveles input").count(), op.niveles.length);
  for (const campo of ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono", "lat", "lon"])
    assert.equal(await page.locator(`label[for=r-${campo}]`).count(), 1, `${campo} con etiqueta`);
  assert.ok((await page.locator("#r-mapa").boundingBox()).height > 200, "mapa para elegir la ubicación");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-04: sin niveles ni turnos, o con la ubicación fuera del área, no deja guardar y explica el motivo (sin llamar al servidor)", async () => {
  const page = await open();
  await page.click("#r-guardar");
  assert.equal(await errorDe(page, "nombre").innerText(), "Escriba el nombre del colegio");
  assert.equal(await page.evaluate(() => document.activeElement.id), "r-nombre", "el foco va al primer campo con error");
  assert.equal(await page.getAttribute("#r-nombre", "aria-invalid"), "true");
  assert.match(await page.getAttribute("#r-nombre", "aria-describedby"), /r-nombre-error/);
  assert.match(await page.locator("#registro-estado").innerText(), /Revise los datos del colegio/);
  await llenarDatos(page);
  assert.ok(await errorDe(page, "nombre").isHidden(), "corregir el campo quita su error");
  await page.fill("#r-lat", "-16.30"); // al norte del área de la ciudad
  await page.fill("#r-lon", "-68.20");
  await page.click("#r-guardar");
  assert.equal(await errorDe(page, "niveles").innerText(), "Elija al menos un nivel");
  assert.equal(await errorDe(page, "turnos").innerText(), "Elija al menos un turno");
  assert.equal(await errorDe(page, "lat").innerText(), "La ubicación está fuera del área de la ciudad");
  assert.ok(await errorDe(page, "lon").isHidden(), "la longitud sí está dentro del área");
  assert.equal(await page.locator("#r-niveles input").first().getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator("#r-turnos input").first().getAttribute("aria-describedby"), "r-turnos-error");
  for (const campo of ["nombre", "dependencia", "distrito_municipal", "direccion"]) assert.ok(await errorDe(page, campo).isHidden(), campo);
  await page.fill("#r-lat", "");
  await page.fill("#r-lon", "");
  await page.locator("#r-niveles label", { hasText: "Primaria" }).first().click();
  await page.locator("#r-turnos label", { hasText: "Tarde" }).click();
  await page.click("#r-guardar");
  assert.equal(await errorDe(page, "lat").innerText(), "Marque la ubicación en el mapa");
  assert.ok(await errorDe(page, "niveles").isHidden());
  assert.deepEqual(page.posts, [], "ningún POST con errores de cliente");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-04: los errores del servidor (422 por campo, 403, red, 401) se muestran", async () => {
  const page = await open();
  await llenarDatos(page, "U.E. Rechazada");
  await page.locator("#r-niveles label", { hasText: "Secundaria" }).first().click();
  await page.locator("#r-turnos label", { hasText: "Mañana" }).click();
  await page.fill("#r-lat", "-16.52");
  await page.fill("#r-lon", "-68.20");
  let respuesta = { status: 422, body: { detail: "Revise los datos del colegio", errores: { nombre: "Ya existe un colegio con ese nombre", otra_cosa: "Dato raro" } } };
  await page.route(/\/api\/unidades$/, (r) => (respuesta === "red" ? r.abort()
    : r.fulfill({ status: respuesta.status, contentType: "application/json", body: JSON.stringify(respuesta.body) })));
  await page.click("#r-guardar");
  await errorDe(page, "nombre").waitFor({ state: "visible" });
  assert.equal(await errorDe(page, "nombre").innerText(), "Ya existe un colegio con ese nombre");
  assert.equal(await page.getAttribute("#r-nombre", "aria-invalid"), "true");
  assert.match(await page.locator("#registro-estado").innerText(), /Dato raro/, "un error sin campo va al aviso general");
  respuesta = { status: 403, body: { detail: "Sin permiso" } };
  await page.click("#r-guardar");
  await page.locator("#registro-estado", { hasText: "permiso" }).waitFor();
  respuesta = "red";
  await page.click("#r-guardar");
  await page.locator("#registro-estado", { hasText: "No se pudo conectar" }).waitFor();
  assert.equal(await page.inputValue("#r-nombre"), "U.E. Rechazada", "un error no borra lo escrito");
  assert.equal(page.posts.length, 3);
  respuesta = { status: 401, body: { detail: "Sesión requerida" } };
  await page.click("#r-guardar");
  await page.waitForURL(/\/login\.html$/);
  await page.context().close();
  // sin sesión la API no deja registrar
  const r = await fetch(`${BASE}/api/unidades`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("HU-04: guardar un colegio válido lo muestra en indicadores, mapa, listado y su ficha", async () => {
  const page = await open("");
  const total = await kpiTotal(page);
  await page.click("#nav a[data-vista=registro]");
  await page.locator("#form-registro").waitFor({ state: "visible" });
  await llenarDatos(page);
  await page.locator("#r-niveles label", { hasText: "Inicial" }).first().click();
  await page.locator("#r-niveles label", { hasText: "Primaria" }).first().click();
  await page.locator("#r-turnos label", { hasText: "Mañana" }).click();
  await page.locator("#r-turnos label", { hasText: "Noche" }).click();
  // un clic en el centro del mapa marca la ubicación y llena latitud y longitud
  await page.locator("#r-mapa").click();
  const [lat, lon] = [Number(await page.inputValue("#r-lat")), Number(await page.inputValue("#r-lon"))];
  assert.ok(lat > -16.65 && lat < -16.40 && lon > -68.35 && lon < -68.05, `ubicación dentro del área (${lat}, ${lon})`);
  assert.equal(await page.locator("#r-mapa .marcador-registro").count(), 1);
  // escribir la ubicación mueve el marcador
  await page.fill("#r-lat", "-16.5123");
  await page.fill("#r-lon", "-68.1777");
  assert.deepEqual(await page.evaluate(() => [marcadorRegistro.getLatLng().lat, marcadorRegistro.getLatLng().lng]), [-16.5123, -68.1777]);
  await page.click("#r-guardar");
  await page.locator("#registro-ok").waitFor({ state: "visible" });
  await settle(page);
  assert.equal(page.posts.length, 1);
  const body = page.posts[0];
  assert.equal(body.distrito_municipal, 7, "el distrito va como entero");
  assert.equal(body.direccion, "Av. Juan Pablo II, n.º 100");
  assert.equal(body.telefono, null, "teléfono vacío va como null");
  assert.deepEqual(body.turnos, ["MAÑANA", "NOCHE"]);
  assert.match(await page.locator("#registro-ok").innerText(), /quedó registrado/);
  assert.equal(await page.inputValue("#r-nombre"), "", "el formulario se limpia");
  assert.equal(await page.locator("#r-mapa .marcador-registro").count(), 0);
  // ver el colegio desde el aviso: su ficha
  await page.click("#registro-ok [data-ver]");
  await page.locator("#detalle[open]").waitFor();
  assert.equal(await page.locator("#detalle-titulo").innerText(), NOMBRE);
  assert.match(await page.locator("#detalle-body").innerText(), /Registrado en este sistema por e2e-reg/);
  assert.match(await page.locator("#detalle-body").innerText(), /De convenio[\s\S]*Villa Adela/);
  await page.keyboard.press("Escape");
  // indicadores, listado (búsqueda) y mapa
  await page.click("#nav a[data-vista=dashboard]");
  assert.equal(await kpiTotal(page), total + 1, "KPI total sube en 1");
  const id = (await api(`unidades?q=${encodeURIComponent("Nuevo Horizonte")}`)).results[0].id;
  assert.ok(id >= 1_000_000);
  assert.ok(await page.evaluate((id) => ultimoGeojson.features.some((f) => f.properties.id === id), id), "aparece en el mapa");
  await page.fill("#q", "Nuevo Horizonte");
  await page.waitForTimeout(400);
  await settle(page);
  assert.equal(await page.locator("#tabla tbody tr").count(), 1);
  assert.match(await page.locator("#tabla tbody tr").innerText(), /Nuevo Horizonte E2E <img/);
  assert.equal(await page.evaluate(() => window.__xss), undefined, "el nombre nunca se interpreta como HTML");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-04: el formulario funciona en celular, sin scroll horizontal, en tema claro y oscuro", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const page = await open("?vista=registro", { viewport: { width: 390, height: 844 }, colorScheme });
    await page.click("#r-guardar");
    await errorDe(page, "nombre").waitFor({ state: "visible" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `sin scroll horizontal (${colorScheme})`);
    const b = await page.locator("#r-mapa").boundingBox();
    assert.ok(b.width > 250 && b.x + b.width <= 390, "el mapa cabe en la pantalla");
    const [fondo, card] = await page.evaluate(() => [getComputedStyle(document.querySelector("#r-nombre")).backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()]);
    assert.equal(card, colorScheme === "dark" ? "#11161c" : "#f4f6f9");
    assert.equal(fondo, colorScheme === "dark" ? "rgb(17, 22, 28)" : "rgb(244, 246, 249)", "los campos usan el color del tema");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test("HU-04: la validación del navegador da los mismos errores y mensajes que el servidor", async () => {
  const page = await open();
  const valido = { nombre: "U.E. Paridad", dependencia: "FISCAL", subsistema: "REGULAR", distrito_municipal: 3, direccion: "Calle 1",
    zona: null, telefono: null, niveles: ["PRIMARIA"], turnos: ["MAÑANA"], lat: -16.5, lon: -68.2 };
  const casos = [
    {}, [], "texto", { ...valido, nombre: "  " }, { ...valido, nombre: 5 }, { ...valido, nombre: "x".repeat(201) },
    { ...valido, direccion: "y".repeat(256) }, { ...valido, zona: "z".repeat(201) }, { ...valido, telefono: "1".repeat(51) }, { ...valido, telefono: 70000000 },
    { ...valido, dependencia: "COMUNITARIA" }, { ...valido, dependencia: null }, { ...valido, subsistema: "OTRO" }, { ...valido, subsistema: "" },
    { ...valido, distrito_municipal: "3" }, { ...valido, distrito_municipal: 15 }, { ...valido, distrito_municipal: 0 }, { ...valido, distrito_municipal: true },
    { ...valido, niveles: [] }, { ...valido, niveles: "PRIMARIA" }, { ...valido, niveles: ["A,B"] }, { ...valido, niveles: [" "] }, { ...valido, niveles: ["n".repeat(101)] },
    { ...valido, turnos: [] }, { ...valido, turnos: ["SIESTA"] }, { ...valido, turnos: [1] },
    { ...valido, lat: null }, { ...valido, lat: "-16.5" }, { ...valido, lon: -68.36 }, { ...valido, lat: -16.39, lon: -68.04 },
    { ...valido, nombre: "", niveles: [], turnos: [], lat: -17 },
  ];
  const op = (await api("catalogos")).opciones_registro;
  for (const caso of casos) {
    const r = await fetch(`${BASE}/api/unidades`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(caso) });
    assert.equal(r.status, 422, JSON.stringify(caso).slice(0, 80));
    const servidor = (await r.json()).errores;
    const navegador = await page.evaluate(([b, op]) => validarRegistro(b, op), [caso, op]);
    assert.deepEqual(navegador, servidor, JSON.stringify(caso).slice(0, 80));
  }
  // en minúsculas y en los extremos del área también es válido en ambos lados
  const extremo = { ...valido, dependencia: "privada", subsistema: "especial", turnos: ["tarde", "TARDE"], lat: -16.65, lon: -68.05 };
  assert.deepEqual(await page.evaluate(([b, op]) => validarRegistro(b, op), [extremo, op]), {});
  const r = await fetch(`${BASE}/api/unidades`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(extremo) });
  assert.equal(r.status, 201);
  await page.context().close();
});
