// HU-09: sección Agenda y actividades en la ficha del colegio (Chromium real contra la API real, con login).
// El navegador usa la zona de La Paz (UTC-4): una fecha "YYYY-MM-DD" leída como UTC caería el día anterior.
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { arrancar, sinScrollHorizontal } from "./servidor.mjs";

let s, ana, beto, ines, colegioA, colegioB;
const hoyLaPaz = new Intl.DateTimeFormat("en-CA", { timeZone: "America/La_Paz" }).format(new Date()); // YYYY-MM-DD
const [Y, M] = hoyLaPaz.split("-").map(Number);
const dos = (n) => String(n).padStart(2, "0");
const MES = `${Y}-${dos(M)}`;
const FECHA = `${MES}-20`;
const SIGUIENTE = M === 12 ? `${Y + 1}-01` : `${Y}-${dos(M + 1)}`;

before(async () => {
  s = await arrancar("agenda", { puerto: 10100 });
  const alta = async (nombre, cargo) => (await s.api("personal", { method: "POST", body: { nombre, cargo } })).json.persona;
  ana = await alta("Ana Encargada", "Coordinadora");
  beto = await alta("Beto Apoyo", "Técnico");
  ines = await alta("Inés Voluntaria", "Psicóloga");
  const lista = (await s.api("unidades?page_size=200")).json.results;
  [colegioA, colegioB] = [lista.find((u) => u.nombre === "U.E. DEMO 041"), lista.find((u) => u.nombre === "U.E. DEMO 042")];
});
after(async () => { await s?.cerrar(); });

const celda = (page, fecha) => page.locator(`#ag-calendario td[data-fecha="${fecha}"]`);
const nueva = (body) => s.api("actividades", { method: "POST", body: { tipo: "VISITA", hora: "10:00", lugar: "Dirección", encargados: [ana.id], ...body } });

test("HU-09: crear una actividad con encargados y personal; se ve en el mes y en la lista en su fecha", async () => {
  const page = await s.open("?vista=agenda");
  await page.locator("#ag-calendario table.mes").waitFor();
  assert.ok((await page.locator("#ag-mes").innerText()).length > 4, "título del mes");
  assert.equal(await page.locator("#ag-calendario thead th").count(), 7);
  assert.equal(await celda(page, hoyLaPaz).getAttribute("aria-current"), "date", "hoy marcado en la zona local");
  const posts = [];
  page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/actividades") && posts.push(r.postDataJSON()));
  await page.click("#ag-nueva");
  await page.locator("#a-encargados label", { hasText: "Ana Encargada" }).waitFor();
  assert.equal(await page.inputValue("#a-fecha"), hoyLaPaz, "por defecto, hoy");
  // sin datos: errores por campo, sin llamar al servidor
  await page.fill("#a-fecha", "");
  await page.click("#a-guardar");
  for (const [campo, msj] of [["ue_id", "Elija el colegio"], ["tipo", "Elija el tipo: taller, visita, reunión u otra"], ["actividad", "Describa la actividad"],
    ["fecha", "Elija una fecha válida"], ["hora", "Elija una hora válida"], ["lugar", "Escriba el lugar"], ["encargados", "Elija al menos un encargado"]])
    assert.equal(await page.locator(`#a-${campo}-error`).innerText(), msj, campo);
  assert.equal(await page.evaluate(() => document.activeElement.id), "a-ue_id");
  assert.equal(await page.locator("#a-encargados input").first().getAttribute("aria-invalid"), "true");
  assert.equal(posts.length, 0);
  // colegio con el buscador (teclado), y el resto de los datos
  await page.locator("#a-ue_id").pressSequentially("DEMO 041", { delay: 20 });
  await page.locator("#a-ue_id-lista [role=option]").first().waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.ok(await page.locator("#a-ue_id-error").isHidden(), "elegir el colegio quita su error");
  assert.ok(await page.locator("#ag-form-card").isVisible(), "Enter en el buscador no envía el formulario");
  await page.selectOption("#a-tipo", "TALLER");
  await page.fill("#a-actividad", "Taller de lectura <b>1</b>");
  await page.fill("#a-fecha", FECHA);
  await page.fill("#a-hora", "09:30");
  await page.fill("#a-lugar", "Biblioteca");
  await page.locator("#a-encargados label", { hasText: "Ana Encargada" }).click();
  await page.locator("#a-personal label", { hasText: "Beto Apoyo" }).click();
  await page.locator("#a-personal label", { hasText: "Inés Voluntaria" }).click();
  await page.fill("#a-asistentes_proyectados", "120");
  await page.fill("#a-observaciones", "Llevar libros\ny cuadernos");
  await page.click("#a-guardar");
  await page.locator("#ag-form-card").waitFor({ state: "hidden" });
  assert.deepEqual(posts, [{ ue_id: colegioA.id, tipo: "TALLER", actividad: "Taller de lectura <b>1</b>", fecha: FECHA, hora: "09:30", lugar: "Biblioteca",
    encargados: [ana.id], personal: [beto.id, ines.id], asistentes_proyectados: 120, observaciones: "Llevar libros\ny cuadernos" }]);
  assert.match(await page.locator("#aviso").innerText(), /quedó en la agenda el .*20 de/);
  // en la cuadrícula del mes, en su día (no el anterior)
  await celda(page, FECHA).locator(".ev").waitFor();
  assert.match(await celda(page, FECHA).locator(".ev").innerText(), /09:30 Taller de lectura <b>1<\/b>/);
  const anterior = `${MES}-19`;
  assert.equal(await celda(page, anterior).locator(".ev").count(), 0);
  assert.equal(await page.locator("#ag-calendario .ev b").count(), 0, "el texto nunca se interpreta como HTML");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act !== undefined), true, "el foco va a la actividad nueva");
  // en la lista por fecha
  await page.click("[data-modo=lista]");
  await page.locator("#ag-lista").waitFor({ state: "visible" });
  assert.ok(await page.locator("#ag-calendario").isHidden());
  assert.match(page.url(), /modo=lista/);
  const dia = page.locator(`#ag-lista section[data-fecha="${FECHA}"]`);
  assert.match(await dia.locator("h3").innerText(), / 20 de /);
  assert.match(await dia.innerText(), /09:30 · Taller · Taller de lectura[\s\S]*Pendiente[\s\S]*U\.E\. DEMO 041 · Biblioteca · Encargados: Ana Encargada/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-09: el detalle muestra encargados, personal, asistentes y observaciones; cambiar el estado actualiza la agenda", async () => {
  const { json: { actividad: a } } = await nueva({ ue_id: colegioA.id, actividad: "Reunión con padres", fecha: `${MES}-12`, encargados: [ana.id], personal: [beto.id],
    asistentes_proyectados: 40, observaciones: "Con el director" });
  const page = await s.open(`?vista=agenda&mes=${MES}`);
  await celda(page, `${MES}-12`).locator(`[data-act="${a.id}"]`).click();
  await page.locator("#actividad[open]").waitFor();
  const detalle = await page.locator("#actividad-body").innerText();
  assert.match(detalle, /Encargados\s+Ana Encargada · Coordinadora/);
  assert.match(detalle, /Personal que acudirá\s+Beto Apoyo · Técnico/);
  assert.match(detalle, /Asistentes proyectados\s+40/);
  assert.match(detalle, /Observaciones\s+Con el director/);
  assert.match(detalle, /Estado\s+Pendiente/);
  assert.match(detalle, new RegExp(`Creada por ${s.usuario}`));
  // cambio de estado
  await page.selectOption("#act-estado", "POSTERGADA");
  await page.click("#act-estado-form [type=submit]");
  await page.locator("#actividad-body dd", { hasText: /^Postergada$/ }).waitFor();
  assert.match(await page.locator("#aviso").innerText(), /quedó como postergada/);
  await page.keyboard.press("Escape");
  await celda(page, `${MES}-12`).locator(".ev.estado-postergada").waitFor();
  assert.equal((await s.api(`actividades?ue_id=${colegioA.id}&estado=POSTERGADA`)).json.length, 1);
  // mismo estado: no hay cambios
  await celda(page, `${MES}-12`).locator(`[data-act="${a.id}"]`).click();
  await page.click("#act-estado-form [type=submit]");
  assert.equal(await page.locator("#act-estado-error").innerText(), "No hay cambios para guardar.");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-09: filtrar por colegio y estado; navegar meses (anterior, siguiente, hoy) con el estado en la URL", async () => {
  await nueva({ ue_id: colegioB.id, actividad: "Visita colegio B", fecha: `${MES}-15` });
  await nueva({ ue_id: colegioB.id, actividad: "Inicio de mes siguiente", fecha: `${SIGUIENTE}-01`, hora: "08:00" });
  const page = await s.open("?vista=agenda");
  await page.locator("#ag-calendario .ev", { hasText: "Visita colegio B" }).waitFor();
  // por colegio
  await page.locator("#ag-colegio").pressSequentially("DEMO 041", { delay: 20 });
  await page.locator("#ag-colegio-lista [role=option]").first().click();
  await page.waitForURL(new RegExp(`colegio=${colegioA.id}`));
  await page.locator("#ag-calendario .ev", { hasText: "Visita colegio B" }).waitFor({ state: "detached" });
  assert.ok((await page.locator("#ag-calendario .ev").count()) >= 1);
  assert.ok(await page.locator("#ag-colegio-quitar").isVisible());
  // por estado (combinado con el colegio)
  await page.selectOption("#ag-estado", "POSTERGADA");
  await page.waitForURL(/estado=POSTERGADA/);
  await page.locator("#ag-calendario .ev", { hasText: "Taller de lectura" }).waitFor({ state: "detached" });
  assert.deepEqual(await page.locator("#ag-calendario .ev").allInnerTexts(), ["10:00 Reunión con padres"]);
  // la URL compartida abre la misma vista, con el nombre del colegio
  const copia = await s.open(new URL(page.url()).search);
  await copia.locator("#ag-calendario .ev").first().waitFor();
  assert.equal(await copia.inputValue("#ag-estado"), "POSTERGADA");
  await copia.waitForFunction(() => document.querySelector("#ag-colegio").value === "U.E. DEMO 041");
  await copia.context().close();
  // quitar filtros
  await page.click("#ag-colegio-quitar");
  await page.selectOption("#ag-estado", "");
  await page.locator("#ag-calendario .ev", { hasText: "Visita colegio B" }).waitFor();
  assert.doesNotMatch(page.url(), /colegio=|estado=/);
  // siguiente mes: la actividad del día 1 queda en el día 1 (sin desfase de zona horaria)
  const titulo = await page.locator("#ag-mes").innerText();
  await page.click("#ag-siguiente");
  await page.waitForURL(new RegExp(`mes=${SIGUIENTE}`));
  await celda(page, `${SIGUIENTE}-01`).locator(".ev", { hasText: "Inicio de mes siguiente" }).waitFor();
  assert.notEqual(await page.locator("#ag-mes").innerText(), titulo);
  await page.click("[data-modo=lista]");
  assert.match(await page.locator(`#ag-lista section[data-fecha="${SIGUIENTE}-01"] h3`).innerText(), / 1 de /);
  await page.click("#ag-anterior");
  await page.waitForURL(new RegExp(`mes=${MES}`));
  await page.click("#ag-siguiente");
  await page.click("#ag-hoy");
  await page.waitForURL((u) => !u.searchParams.has("mes"));
  assert.equal(await page.locator("#ag-mes").innerText(), titulo);
  // atrás del navegador vuelve a la sección anterior, conservando la agenda
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-09: la ficha del colegio muestra sus actividades y abre su detalle", async () => {
  const page = await s.open("");
  await page.fill("#q", "DEMO 041");
  await page.waitForTimeout(400);
  await s.settle(page);
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle[open]").waitFor();
  const lista = page.locator("#detalle-actividades li");
  await lista.first().waitFor();
  const textos = await lista.allInnerTexts();
  assert.ok(textos.some((t) => /20\/\d+\/\d+ 09:30 · Taller · Taller de lectura/.test(t)), textos.join("|"));
  assert.ok(textos.some((t) => /Reunión con padres\s+Postergada/.test(t)));
  assert.ok(!textos.some((t) => t.includes("Visita colegio B")), "sólo las de ese colegio");
  await lista.filter({ hasText: "Reunión con padres" }).locator("[data-act]").click();
  await page.locator("#actividad[open]").waitFor();
  assert.match(await page.locator("#actividad-titulo").innerText(), /Reunión con padres/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // un colegio sin actividades lo dice
  await page.fill("#q", "DEMO 099");
  await page.waitForTimeout(400);
  await s.settle(page);
  await page.locator("#tabla tbody tr").first().click();
  await page.locator("#detalle-actividades", { hasText: "no tiene actividades" }).waitFor();
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-09/HU-10: al editar, el personal ya asignado que se inactivó se muestra marcado y puede quedarse", async () => {
  const { json: { actividad: a } } = await nueva({ ue_id: colegioA.id, actividad: "Visita con Inés", fecha: `${MES}-25`, personal: [ines.id] });
  assert.equal((await s.api(`personal/${ines.id}`, { method: "PATCH", body: { activo: false } })).status, 200);
  const page = await s.open(`?vista=agenda&mes=${MES}`);
  await celda(page, `${MES}-25`).locator(`[data-act="${a.id}"]`).click();
  await page.locator("#actividad-body", { hasText: /Inés Voluntaria · Psicóloga \(inactivo\)/ }).waitFor();
  await page.click("[data-editar-act]");
  await page.locator("#a-personal .marca-inactivo").waitFor();
  assert.equal(await page.inputValue("#a-ue_id"), "U.E. DEMO 041");
  assert.equal(await page.inputValue("#a-fecha"), `${MES}-25`);
  const ines_ = page.locator("#a-personal label", { hasText: "Inés Voluntaria" });
  assert.match(await ines_.innerText(), /\(inactivo\)/);
  assert.ok(await ines_.locator("input").isChecked());
  assert.equal(await page.locator("#a-encargados label", { hasText: "Inés" }).count(), 0, "no se ofrece para otra lista");
  const patches = [];
  page.on("request", (r) => r.method() === "PATCH" && patches.push(r.postDataJSON()));
  await page.fill("#a-lugar", "Patio central");
  await page.click("#a-guardar");
  await page.locator("#ag-form-card").waitFor({ state: "hidden" });
  assert.deepEqual(patches, [{ lugar: "Patio central" }], "sólo lo cambiado");
  const guardada = (await s.api(`actividades?ue_id=${colegioA.id}`)).json.find((x) => x.id === a.id);
  assert.deepEqual(guardada.personal.map((p) => [p.id, p.activo]), [[ines.id, false]]);
  // en una actividad nueva no aparece
  await page.click("#ag-nueva");
  await page.locator("#a-encargados label").first().waitFor();
  assert.equal(await page.locator("#a-personal label", { hasText: "Inés" }).count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test("HU-09: la validación del navegador da los mismos mensajes que el servidor", async () => {
  const page = await s.open("?vista=agenda");
  const ok = { ue_id: colegioA.id, tipo: "taller", actividad: "A", fecha: FECHA, hora: "09:00", lugar: "L", encargados: [ana.id] };
  const casos = [[], "x", {}, { ...ok, ue_id: "1" }, { ...ok, ue_id: 1.5 }, { ...ok, tipo: "fiesta" }, { ...ok, tipo: 3 }, { ...ok, actividad: " " },
    { ...ok, actividad: 5 }, { ...ok, actividad: "a".repeat(201) }, { ...ok, lugar: "" }, { ...ok, lugar: "l".repeat(201) }, { ...ok, fecha: "2026-02-30" },
    { ...ok, fecha: "20/12/2026" }, { ...ok, hora: "24:00" }, { ...ok, hora: "9:00" }, { ...ok, encargados: [] }, { ...ok, encargados: "1" },
    { ...ok, encargados: [ines.id] }, { ...ok, encargados: [99999] }, { ...ok, encargados: ["x"] }, { ...ok, personal: [ines.id] }, { ...ok, personal: "x" },
    { ...ok, asistentes_proyectados: -1 }, { ...ok, asistentes_proyectados: 2.5 }, { ...ok, asistentes_proyectados: "3" }, { ...ok, asistentes_proyectados: 1_000_001 },
    { ...ok, observaciones: "o".repeat(2001) }, { ...ok, observaciones: 4 }, { ...ok, estado: "terminada" }];
  const activos = new Set((await s.api("personal")).json.map((p) => p.id));
  for (const caso of casos) {
    const r = await s.api("actividades", { method: "POST", body: caso });
    assert.equal(r.status, 422, JSON.stringify(caso));
    const navegador = await page.evaluate(([b, ids]) => validarActividad(b, { personaValida: (_, id) => ids.includes(id) }), [caso, [...activos]]);
    assert.deepEqual(navegador, r.json.errores, JSON.stringify(caso));
  }
  for (const valido of [{ ...ok, tipo: "reunión" }, { ...ok, asistentes_proyectados: 1_000_000, personal: null, estado: "realizada" }]) {
    assert.deepEqual(await page.evaluate((b) => validarActividad(b), valido), {});
    assert.equal((await s.api("actividades", { method: "POST", body: valido })).status, 201, JSON.stringify(valido));
  }
  await page.context().close();
});

test("HU-09: sin sesión no se puede ver ni crear la agenda", async () => {
  for (const [p, method, body] of [["actividades", "GET"], ["actividades", "POST", {}], ["actividades/1", "PATCH", { estado: "REALIZADA" }]])
    assert.equal((await s.api(p, { method, body, sesion: false })).status, 401, `${method} ${p}`);
  const page = await s.open("?vista=agenda", {}, { sesion: false });
  await page.waitForURL(/\/login\.html$/);
  await page.context().close();
});

test("HU-09: en celular la agenda (mes, lista, formulario y detalle) cabe sin scroll horizontal, en tema claro y oscuro", async () => {
  for (const colorScheme of ["light", "dark"]) {
    const page = await s.open(`?vista=agenda&mes=${MES}`, { viewport: { width: 390, height: 844 }, colorScheme });
    await page.locator("#ag-calendario .ev").first().waitFor();
    assert.ok(await sinScrollHorizontal(page), `mes (${colorScheme})`);
    const tabla = await page.locator("#ag-calendario table").boundingBox();
    assert.ok(tabla.x + tabla.width <= 390, "la cuadrícula cabe en la pantalla");
    await page.click("[data-modo=lista]");
    assert.ok(await sinScrollHorizontal(page), `lista (${colorScheme})`);
    await page.click("#ag-nueva");
    await page.locator("#a-encargados label").first().waitFor();
    await page.click("#a-guardar");
    assert.ok(await sinScrollHorizontal(page), `formulario (${colorScheme})`);
    await page.click("#a-cancelar");
    await page.locator("#ag-lista [data-act]").first().click();
    await page.locator("#actividad[open]").waitFor();
    assert.ok(await sinScrollHorizontal(page), `detalle (${colorScheme})`);
    const [fondo, card] = await page.evaluate(() => [getComputedStyle(document.querySelector("#actividad")).backgroundColor,
      getComputedStyle(document.documentElement).getPropertyValue("--card").trim()]);
    assert.equal(card, colorScheme === "dark" ? "#1a2129" : "#fff");
    assert.equal(fondo, colorScheme === "dark" ? "rgb(26, 33, 41)" : "rgb(255, 255, 255)");
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});
