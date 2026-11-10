// HU-10: sección Personal (Chromium real contra la API real, con login).
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancar, sinScrollHorizontal } from "./servidor.mjs";

let s;
before(async () => { s = await arrancar("personal", { puerto: 9800 }); });
after(async () => { await s?.cerrar(); });

const filas = (page) => page.locator("#tabla-personal tbody tr");
const fila = (page, nombre) => page.locator("#tabla-personal tbody tr", { hasText: nombre });

test("HU-10: alta de una persona con nombre y cargo: queda en la lista", async () => {
  const page = await s.open("?vista=personal");
  await page.locator("#personal-estado", { hasText: /No hay personal|persona/ }).waitFor();
  // sin datos: errores por campo, sin llamar al servidor
  let posts = 0;
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/personal") && posts++);
  await page.click("#p-nuevo");
  assert.equal(await page.evaluate(() => document.activeElement.id), "p-nombre", "el foco va al nombre");
  await page.fill("#p-correo", "no-es-correo");
  await page.click("#p-guardar");
  assert.equal(await page.locator("#p-nombre-error").innerText(), "Escriba el nombre");
  assert.equal(await page.locator("#p-cargo-error").innerText(), "Escriba el cargo");
  assert.equal(await page.locator("#p-correo-error").innerText(), "Correo no válido");
  assert.equal(await page.getAttribute("#p-nombre", "aria-invalid"), "true");
  assert.match(await page.getAttribute("#p-nombre", "aria-describedby"), /p-nombre-error/);
  assert.equal(posts, 0);
  // alta válida (el nombre con HTML se muestra como texto)
  await page.fill("#p-nombre", "  Rosa Quispe <b>X</b> ");
  await page.fill("#p-cargo", "Técnica distrital");
  await page.fill("#p-telefono", "71234567");
  await page.fill("#p-correo", "rosa@ejemplo.bo");
  await page.click("#p-guardar");
  await fila(page, "Rosa Quispe").waitFor();
  assert.equal(posts, 1);
  assert.ok(await page.locator("#p-form-card").isHidden(), "el formulario se cierra");
  assert.match(await page.locator("#aviso").innerText(), /Rosa Quispe <b>X<\/b> quedó en la lista/);
  assert.match(await fila(page, "Rosa Quispe").innerText(), /Técnica distrital\s+71234567\s+rosa@ejemplo\.bo\s+Activo/);
  assert.equal(await page.locator("#tabla-personal b").count(), 0, "el nombre nunca se interpreta como HTML");
  const lista = (await s.api("personal")).json;
  assert.equal(lista.find((p) => p.nombre.startsWith("Rosa")).nombre, "Rosa Quispe <b>X</b>", "se guarda sin espacios sobrantes");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-10: editar sus datos y marcarla inactiva; deja de aparecer para nuevas actividades", async () => {
  await s.api("personal", { method: "POST", body: { nombre: "Carlos Mamani", cargo: "Chofer" } });
  await s.api("personal", { method: "POST", body: { nombre: "Beatriz Choque", cargo: "Psicóloga" } });
  const page = await s.open("?vista=personal");
  await fila(page, "Carlos Mamani").waitFor();
  // edición: sólo el campo cambiado va en el PATCH
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  await fila(page, "Carlos Mamani").locator("[data-editar]").click();
  assert.equal(await page.inputValue("#p-nombre"), "Carlos Mamani");
  await page.fill("#p-cargo", "Chofer y logística");
  await page.click("#p-guardar");
  await fila(page, "Chofer y logística").waitFor();
  assert.deepEqual(patches, [{ cargo: "Chofer y logística" }]);
  // guardar sin cambios avisa y no llama al servidor
  await fila(page, "Carlos Mamani").locator("[data-editar]").click();
  await page.click("#p-guardar");
  assert.equal(await page.locator("#p-form-estado").innerText(), "No hay cambios para guardar.");
  assert.equal(patches.length, 1);
  await page.click("#p-cancelar");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.editar), "", "el foco vuelve a Editar");
  // inactivar: sale de la lista de activos, sigue en "Todos" marcada como inactiva
  await fila(page, "Carlos Mamani").locator("[data-activo]").click();
  await fila(page, "Carlos Mamani").waitFor({ state: "detached" });
  assert.deepEqual(patches[1], { activo: false });
  assert.match(await page.locator("#aviso").innerText(), /quedó inactivo/);
  await page.click("#personal-cuerpo [data-ver=todos]");
  await fila(page, "Carlos Mamani").waitFor();
  assert.match(page.url(), /personal=todos/, "el filtro queda en la URL");
  assert.equal(await page.getAttribute("#personal-cuerpo [data-ver=todos]", "aria-pressed"), "true");
  assert.match(await fila(page, "Carlos Mamani").innerText(), /Inactivo/);
  assert.equal(await fila(page, "Carlos Mamani").locator("[data-activo]").innerText(), "Activar");
  // al crear una actividad, el inactivo no se puede elegir
  await page.click("#nav a[data-vista=agenda]");
  await page.click("#ag-nueva");
  await page.locator("#a-encargados label", { hasText: "Beatriz Choque" }).waitFor();
  const elegibles = await page.locator("#a-encargados label").allInnerTexts();
  assert.ok(elegibles.some((t) => t.includes("Beatriz Choque")));
  assert.ok(!elegibles.some((t) => t.includes("Carlos Mamani")), "el personal inactivo no aparece para asignar");
  assert.ok(!(await page.locator("#a-personal").innerText()).includes("Carlos Mamani"));
  // reactivar: vuelve a aparecer
  await page.goBack();
  await fila(page, "Carlos Mamani").locator("[data-activo]").click();
  await page.locator("#aviso", { hasText: "vuelve a estar activo" }).waitFor();
  assert.ok((await s.api("personal")).json.some((p) => p.nombre === "Carlos Mamani"));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-10: los errores del servidor se muestran junto a su campo", async () => {
  const page = await s.open("?vista=personal");
  await page.click("#p-nuevo");
  await page.fill("#p-nombre", "Duplicada");
  await page.fill("#p-cargo", "Cargo");
  let respuesta = { status: 422, body: { detail: "Revise los datos del personal", errores: { cargo: "No puede pasar de 100 caracteres" } } };
  await page.route(/\/api\/personal$/, (r) => (r.request().method() !== "POST" ? r.continue()
    : respuesta === "red" ? r.abort() : r.fulfill({ status: respuesta.status, contentType: "application/json", body: JSON.stringify(respuesta.body) })));
  await page.click("#p-guardar");
  await page.locator("#p-cargo-error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#p-cargo-error").innerText(), "No puede pasar de 100 caracteres");
  assert.equal(await page.evaluate(() => document.activeElement.id), "p-cargo");
  respuesta = "red";
  await page.click("#p-guardar");
  await page.locator("#p-form-estado", { hasText: "No se pudo conectar" }).waitFor();
  assert.equal(await page.inputValue("#p-nombre"), "Duplicada", "un error no borra lo escrito");
  await page.context().close();
});

test("HU-10: la validación del navegador da los mismos mensajes que el servidor", async () => {
  const page = await s.open("?vista=personal");
  const casos = [[], "x", {}, { nombre: " ", cargo: "c" }, { nombre: 5, cargo: "c" }, { nombre: "n".repeat(151), cargo: "c" },
    { nombre: "n", cargo: "c".repeat(101) }, { nombre: "n", cargo: "c", telefono: "1".repeat(51) }, { nombre: "n", cargo: "c", telefono: 7 },
    { nombre: "n", cargo: "c", correo: "a@b" }, { nombre: "n", cargo: "c", correo: "sin arroba.bo" }];
  for (const caso of casos) {
    const r = await s.api("personal", { method: "POST", body: caso });
    assert.equal(r.status, 422, JSON.stringify(caso));
    assert.deepEqual(await page.evaluate((b) => validarPersona(b), caso), r.json.errores, JSON.stringify(caso));
  }
  const { json: { persona } } = await s.api("personal", { method: "POST", body: { nombre: "Paridad", cargo: "c" } });
  for (const caso of [{ activo: "no" }, { nombre: "" }, { correo: "x" }, { cargo: 3 }]) {
    const r = await s.api(`personal/${persona.id}`, { method: "PATCH", body: caso });
    assert.equal(r.status, 422, JSON.stringify(caso));
    assert.deepEqual(await page.evaluate((b) => validarPersona(b, true), caso), r.json.errores, JSON.stringify(caso));
  }
  await page.context().close();
});

test("HU-10: sin sesión no se puede ver ni modificar el personal", async () => {
  for (const [p, method, body] of [["personal", "GET"], ["personal", "POST", { nombre: "x", cargo: "y" }], ["personal/1", "PATCH", { activo: false }]])
    assert.equal((await s.api(p, { method, body, sesion: false })).status, 401, `${method} ${p}`);
  const page = await s.open("?vista=personal", {}, { sesion: false });
  await page.waitForURL(/\/login\.html$/);
  await page.context().close();
});

test("HU-10: en celular la sección cabe sin scroll horizontal, en tema claro y oscuro", async () => {
  await s.api("personal", { method: "POST", body: { nombre: "Nombre muy largo de una persona con varios apellidos", cargo: "Coordinadora de proyectos educativos", correo: "persona.con.correo.largo@ejemplo.org.bo" } });
  for (const colorScheme of ["light", "dark"]) {
    const page = await s.open("?vista=personal&personal=todos", { viewport: { width: 390, height: 844 }, colorScheme });
    await filas(page).first().waitFor();
    assert.ok(await sinScrollHorizontal(page), `lista sin scroll horizontal (${colorScheme})`);
    await page.click("#p-nuevo");
    await page.click("#p-guardar");
    await page.locator("#p-nombre-error").waitFor({ state: "visible" });
    assert.ok(await sinScrollHorizontal(page), `formulario sin scroll horizontal (${colorScheme})`);
    const [fondo, bg] = await page.evaluate(() => [getComputedStyle(document.querySelector("#p-nombre")).backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()]);
    assert.equal(bg, colorScheme === "dark" ? "#11161c" : "#f4f6f9");
    assert.equal(fondo, colorScheme === "dark" ? "rgb(17, 22, 28)" : "rgb(244, 246, 249)");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});
