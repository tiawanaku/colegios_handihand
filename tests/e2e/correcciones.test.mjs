// HU-08: sección Correcciones (Chromium real contra la API real, con login).
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancar, sinScrollHorizontal, kpiTotal } from "./servidor.mjs";

let s;
before(async () => { s = await arrancar("correcciones", { puerto: 9950 }); });
after(async () => { await s?.cerrar(); });

/** Un colegio de la vista con datos que cumplen las reglas del registro (sin MANANA) para corregir. */
let valido;
const colegioValido = async () => (valido ??= (await s.api("unidades?page_size=200")).json.results
  .find((u) => u.nombre.startsWith("U.E. DEMO 01") && !u.turnos.includes("MANANA") && u.distrito_municipal));
const idDe = async (q) => (await s.api(`unidades?q=${encodeURIComponent(q)}`)).json.results[0].id;
const opciones = (page) => page.locator("#c-buscar-lista [role=option]");
const errorDe = (page, campo) => page.locator(`#c-${campo}-error`);

/** Abre la sección y espera el formulario del colegio `id`. */
async function abrir(id, ctxOpts) {
  const page = await s.open(`?vista=correcciones&ue=${id}`, ctxOpts);
  await page.locator("#form-correccion").waitFor({ state: "visible" });
  return page;
}

test("HU-08: buscar muestra coincidencias mientras se escribe y se elige con el teclado o el ratón", async () => {
  const page = await s.open("?vista=correcciones");
  const pedidos = [];
  page.on("request", (r) => r.url().includes("/api/unidades?q=") && pedidos.push(new URL(r.url()).searchParams.get("q")));
  const input = page.locator("#c-buscar");
  assert.equal(await input.getAttribute("role"), "combobox");
  await input.pressSequentially("demo 01", { delay: 30 });
  await opciones(page).first().waitFor();
  assert.deepEqual(pedidos, ["demo 01"], "espera a que se deje de escribir: una sola búsqueda");
  assert.equal(await input.getAttribute("aria-expanded"), "true");
  assert.match(await page.locator("#c-buscar-estado").innerText(), /coincidencias/);
  const textos = await opciones(page).allInnerTexts();
  assert.ok(textos.length >= 2 && textos.every((t) => /DEMO 01/.test(t)), "todas las opciones coinciden");
  // flechas: la opción activa se anuncia con aria-activedescendant; Enter la elige
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  const activa = await input.getAttribute("aria-activedescendant");
  assert.equal(await page.getAttribute(`#${activa}`, "aria-selected"), "true");
  const elegido = (await page.locator(`#${activa} span`).first().innerText()).trim();
  assert.equal(elegido, textos[1].split("\n")[0].trim());
  await input.press("Enter");
  await page.locator("#form-correccion").waitFor({ state: "visible" });
  assert.equal(await input.getAttribute("aria-expanded"), "false");
  assert.equal(await page.inputValue("#c-nombre"), elegido, "abre el registro del colegio elegido");
  const id = await idDe(elegido);
  assert.match(page.url(), new RegExp(`ue=${id}`), "el colegio abierto queda en la URL");
  // Escape cierra la lista sin elegir; con el ratón también se elige
  await input.fill("");
  await input.pressSequentially("demo 02", { delay: 20 });
  await opciones(page).first().waitFor();
  await input.press("Escape");
  assert.ok(await page.locator("#c-buscar-lista").isHidden());
  await input.press("ArrowDown");
  await opciones(page).nth(2).click();
  await page.locator("#correccion-titulo", { hasText: /DEMO 02/ }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "c-buscar", "el foco se queda en el buscador");
  // sin coincidencias
  await input.fill("zzzz sin colegio");
  await page.locator("#c-buscar-estado", { hasText: "Ningún colegio coincide." }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-08: abre el registro con todos los datos, corrige varios campos y el cambio se ve en todo y en la bitácora", async () => {
  const { id, nombre } = await colegioValido();
  const antes = (await s.api(`unidades/${id}`)).json;
  const page = await s.open("");
  const total = await kpiTotal(page);
  await page.click("#nav a[data-vista=correcciones]");
  await page.fill("#c-buscar", nombre);
  await opciones(page).first().click();
  await page.locator("#form-correccion").waitFor({ state: "visible" });
  // todos los datos del registro, en el mismo formulario del registro (con su mapa y marcador)
  assert.equal(await page.inputValue("#c-nombre"), antes.nombre);
  assert.equal(await page.inputValue("#c-dependencia"), antes.dependencia);
  assert.equal(await page.inputValue("#c-distrito_municipal"), String(antes.distrito_municipal));
  assert.equal(await page.inputValue("#c-direccion"), antes.direccion);
  assert.equal(Number(await page.inputValue("#c-lat")), antes.lat);
  const nivelesMarcados = await page.locator("#c-niveles input:checked").evaluateAll((l) => l.map((i) => i.value));
  assert.deepEqual(nivelesMarcados.sort(), antes.niveles.split(",").sort());
  for (const campo of ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono", "lat", "lon"])
    assert.equal(await page.locator(`label[for=c-${campo}]`).count(), 1, `${campo} con etiqueta`);
  assert.ok((await page.locator("#c-mapa").boundingBox()).height > 200, "mapa visible para mover la ubicación");
  assert.equal(await page.locator("#c-mapa .marcador-registro").count(), 1, "marcador en la ubicación actual");
  await page.locator("#bitacora-estado", { hasText: "todavía no tiene cambios" }).waitFor();
  // corregir varios campos: sólo los cambiados viajan en el PATCH
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  const nuevoNombre = "U.E. Corregida <i>E2E</i>";
  const distrito = antes.distrito_municipal === 14 ? 13 : 14;
  await page.fill("#c-nombre", nuevoNombre);
  await page.fill("#c-zona", "Villa Esperanza");
  await page.fill("#c-telefono", "2-2840000");
  await page.selectOption("#c-distrito_municipal", String(distrito));
  await page.fill("#c-lat", "-16.5011");
  await page.fill("#c-lon", "-68.1999");
  assert.deepEqual(await page.evaluate(() => [formularios.c.marcador.getLatLng().lat, formularios.c.marcador.getLatLng().lng]), [-16.5011, -68.1999]);
  await page.click("#c-guardar");
  await page.locator("#correccion-ok").waitFor({ state: "visible" });
  await s.settle(page);
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0]).sort(), ["distrito_municipal", "lat", "lon", "nombre", "telefono", "zona"]);
  assert.equal(patches[0].distrito_municipal, distrito, "el distrito va como entero");
  assert.match(await page.locator("#correccion-ok").innerText(), /Se guardaron 6 cambios/);
  assert.equal(await page.locator("#correccion-titulo").innerText(), `Corregir «${nuevoNombre}»`);
  // bitácora: quién, cuándo, antes → después
  await page.locator("#bitacora-lista li").first().waitFor();
  const entrada = await page.locator("#bitacora-lista li").first().innerText();
  assert.match(entrada, new RegExp(`Corrección · ${s.usuario} · \\d`));
  assert.ok(entrada.includes(`Nombre\t${antes.nombre}\t${nuevoNombre}`), entrada);
  assert.ok(entrada.includes(`Distrito\tD-${antes.distrito_municipal}\tD-${distrito}`));
  assert.ok(entrada.includes("Zona\t—\tVilla Esperanza"));
  assert.equal(await page.locator("#bitacora-lista i, #correccion-titulo i").count(), 0, "los datos nunca se interpretan como HTML");
  // dashboard: listado, filtros, mapa, indicadores y ficha
  await page.click("#nav a[data-vista=dashboard]");
  assert.equal(await kpiTotal(page), total, "corregir no cambia el total");
  await page.check(`#f-distrito input[value="${distrito}"]`);
  await s.settle(page);
  await page.fill("#q", "Corregida");
  await page.waitForTimeout(400);
  await s.settle(page);
  assert.equal(await page.locator("#tabla tbody tr").count(), 1);
  assert.match(await page.locator("#tabla tbody tr").innerText(), /U\.E\. Corregida <i>E2E<\/i>/);
  const punto = await page.evaluate((id) => ultimoGeojson.features.find((f) => f.properties.id === id)?.geometry.coordinates, id);
  assert.deepEqual(punto, [-68.1999, -16.5011], "el mapa usa la ubicación corregida");
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  const ficha = await page.locator("#detalle-body").innerText();
  assert.match(ficha, new RegExp(`Corregido por ${s.usuario}`));
  assert.match(ficha, /Villa Esperanza[\s\S]*2-2840000/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-08: errores: validación del registro completo, sin cambios, 422 por campo, dado de baja (409) y sin sesión", async () => {
  const id = await idDe("DEMO 033");
  const page = await abrir(id);
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  // las mismas reglas del registro, en el navegador
  await page.fill("#c-nombre", "");
  await page.locator("#c-niveles input:checked").evaluateAll((l) => l.forEach((i) => i.click()));
  await page.fill("#c-lat", "-16.2");
  await page.click("#c-guardar");
  assert.equal(await errorDe(page, "nombre").innerText(), "Escriba el nombre del colegio");
  assert.equal(await errorDe(page, "niveles").innerText(), "Elija al menos un nivel");
  assert.equal(await errorDe(page, "lat").innerText(), "La ubicación está fuera del área de la ciudad");
  assert.equal(await page.evaluate(() => document.activeElement.id), "c-nombre");
  assert.match(await page.locator("#correccion-estado").innerText(), /Revise los datos del colegio/);
  // descartar vuelve a los datos guardados; guardar así avisa que no hay cambios
  await page.click("#c-limpiar");
  assert.notEqual(await page.inputValue("#c-nombre"), "");
  assert.ok(await errorDe(page, "nombre").isHidden());
  await page.click("#c-guardar");
  assert.equal(await page.locator("#correccion-estado").innerText(), "No hay cambios para guardar.");
  assert.deepEqual(patches, [], "nada se envía con errores de cliente o sin cambios");
  // respuestas del servidor: 422 por campo y "No hay cambios para guardar"
  let respuesta = { status: 422, body: { detail: "Revise los datos del colegio", errores: { direccion: "No puede pasar de 255 caracteres" } } };
  await page.route(/\/api\/unidades\/\d+$/, (r) => (r.request().method() !== "PATCH" ? r.continue()
    : r.fulfill({ status: respuesta.status, contentType: "application/json", body: JSON.stringify(respuesta.body) })));
  await page.fill("#c-direccion", "Otra dirección");
  await page.click("#c-guardar");
  await errorDe(page, "direccion").waitFor({ state: "visible" });
  assert.equal(await errorDe(page, "direccion").innerText(), "No puede pasar de 255 caracteres");
  assert.equal(await page.getAttribute("#c-direccion", "aria-invalid"), "true");
  respuesta = { status: 422, body: { detail: "Revise los datos del colegio", errores: { general: "No hay cambios para guardar" } } };
  await page.click("#c-guardar");
  await page.locator("#correccion-estado", { hasText: /^No hay cambios para guardar$/ }).waitFor();
  respuesta = { status: 403, body: { detail: "Se requiere el rol de encargado" } };
  await page.click("#c-guardar");
  await page.locator("#correccion-estado", { hasText: "no tiene permiso" }).waitFor();
  await page.unroute(/\/api\/unidades\/\d+$/);
  // otro usuario lo dio de baja mientras se corregía: 409
  assert.equal((await s.api(`unidades/${id}/baja`, { method: "POST", body: { confirmar: true, motivo: "Cierre" } })).status, 200);
  await page.click("#c-guardar");
  await page.locator("#correccion-estado", { hasText: "Reactive el colegio antes de corregirlo." }).waitFor();
  assert.equal(await page.inputValue("#c-direccion"), "Otra dirección", "un error no borra lo escrito");
  // al reabrirlo se avisa que está dado de baja
  const otra = await abrir(id);
  assert.match(await otra.locator("#correccion-estado").innerText(), /dado de baja[\s\S]*Reactive el colegio antes de corregirlo/);
  await otra.context().close();
  await s.api(`unidades/${id}/alta`, { method: "POST", body: { confirmar: true } });
  // sin sesión no se puede editar
  assert.equal((await s.api(`unidades/${id}`, { method: "PATCH", body: { nombre: "x" }, sesion: false })).status, 401);
  const anonima = await s.open(`?vista=correcciones&ue=${id}`, {}, { sesion: false });
  await anonima.waitForURL(/\/login\.html$/);
  await anonima.context().close();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-08: un turno guardado como MANANA se muestra como Mañana y la corrección lo deja válido", async () => {
  const conManana = (await s.api("unidades?turno=MANANA&page_size=1")).json.results[0];
  const page = await abrir(conManana.id);
  assert.ok(await page.isChecked('#c-turnos input[value="MAÑANA"]'));
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  await page.fill("#c-telefono", "2-2111111");
  await page.click("#c-guardar");
  await page.locator("#correccion-ok").waitFor({ state: "visible" });
  assert.equal(patches[0].telefono, "2-2111111");
  assert.ok(patches[0].turnos.includes("MAÑANA"), "el turno se guarda como en el registro");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-08: en celular el formulario y la bitácora caben sin scroll horizontal, en tema claro y oscuro", async () => {
  const { id } = await colegioValido();
  for (const colorScheme of ["light", "dark"]) {
    const page = await abrir(id, { viewport: { width: 390, height: 844 }, colorScheme });
    await page.locator("#bitacora-lista li").first().waitFor();
    assert.ok(await sinScrollHorizontal(page), `sin scroll horizontal (${colorScheme})`);
    const b = await page.locator("#c-mapa").boundingBox();
    assert.ok(b.width > 250 && b.x + b.width <= 390, "el mapa cabe en la pantalla");
    await page.fill("#c-buscar", "demo");
    await opciones(page).first().waitFor();
    assert.ok(await sinScrollHorizontal(page), `lista de coincidencias sin scroll horizontal (${colorScheme})`);
    const [fondo, bg] = await page.evaluate(() => [getComputedStyle(document.querySelector("#c-buscar")).backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()]);
    assert.equal(bg, colorScheme === "dark" ? "#11161c" : "#f4f6f9");
    assert.equal(fondo, colorScheme === "dark" ? "rgb(17, 22, 28)" : "rgb(244, 246, 249)");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

test("HU-08: un colegio con datos de origen incompletos muestra los campos a completar antes de guardar", async () => {
  const { id } = await colegioValido();
  const ficha = (await s.api(`unidades/${id}`)).json;
  const page = await s.open("?vista=correcciones");
  // como llegan algunos colegios de la vista: sin distrito, dependencia comunitaria y subsistema con coma
  await page.route(new RegExp(`/api/unidades/${id}$`), (r) => (r.request().method() !== "GET" ? r.continue()
    : r.fulfill({ contentType: "application/json", body: JSON.stringify({ ...ficha, distrito_municipal: null, dependencia: "COMUNITARIA", subsistema: "REGULAR,ALTERNATIVA" }) })));
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  await page.fill("#c-buscar", ficha.nombre);
  await opciones(page).first().click();
  await page.locator("#form-correccion").waitFor({ state: "visible" });
  assert.match(await page.locator("#correccion-estado").innerText(), /Complete los datos marcados para poder guardar/);
  assert.equal(await errorDe(page, "distrito_municipal").innerText(), "Elija un distrito del 1 al 14");
  assert.equal(await errorDe(page, "dependencia").innerText(), "Elija la dependencia: fiscal, de convenio o privada");
  assert.equal(await errorDe(page, "subsistema").innerText(), "Elija un subsistema válido");
  assert.ok(await errorDe(page, "nombre").isHidden());
  assert.equal(await page.evaluate(() => document.activeElement.id), "c-buscar", "no le quita el foco al buscador");
  await page.click("#c-guardar");
  assert.deepEqual(patches, [], "no se envía hasta completar");
  await page.selectOption("#c-distrito_municipal", "5");
  await page.selectOption("#c-dependencia", "FISCAL");
  await page.selectOption("#c-subsistema", "REGULAR");
  await page.click("#c-guardar");
  await page.locator("#correccion-ok").waitFor({ state: "visible" });
  assert.deepEqual(patches, [{ dependencia: "FISCAL", subsistema: "REGULAR", distrito_municipal: 5 }]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
