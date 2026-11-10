// Bajas, altas, registros y correcciones de colegios, personal y agenda en la página estática publicada en claude.ai:
// se guardan en la base compartida del artifact (capacidad `db`), así todos los que abren la página ven los mismos
// cambios. Reproduce las reglas del backend: POST /api/unidades/{id}/baja|alta (confirmar:true, motivo obligatorio,
// 404 y 409), POST /api/unidades y PATCH /api/unidades/{id} (validarRegistro de app.js, mismos mensajes; 422 con
// `errores` por campo), /api/personal (validarPersona) y /api/actividades (validarActividad).
// Lo que llega de la base lo pudo escribir otro visitante: se sanea antes de usarlo.
// Fuera de claude.ai (archivo suelto, otro hosting) no hay base: la página queda de solo consulta.
function crearEstadoArtifact(api) {
  let db = null, uid = null;
  const error = (status, mensaje, extra) => Object.assign(new Error(mensaje), { status }, extra);
  const invalido = (detail, errores) => error(422, detail, { errores });
  const ID_MINIMO = 1_000_000;
  // sólo estos campos de un registro llegan a la API (lo guardó otro visitante: no se confía en su forma)
  const CAMPOS = ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono", "niveles", "turnos", "lat", "lon"];
  const NUMERICOS = ["lat", "lon", "distrito_municipal"];
  const TIPOS = ["TALLER", "VISITA", "REUNION", "OTRA"], ESTADOS = ["PENDIENTE", "REALIZADA", "POSTERGADA", "CANCELADA"];
  const esObjeto = (b) => !!b && typeof b === "object" && !Array.isArray(b);
  const texto = (v) => (v == null || v === "" ? null : String(v));
  const entero = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const ahora = () => new Date().toISOString();
  const usuario = () => uid || "anónimo";

  /** Un campo de colegio con el tipo que espera la API, o undefined si no sirve. */
  const valorCampo = (c, v) => (NUMERICOS.includes(c) ? (typeof v === "number" && Number.isFinite(v) ? v : undefined)
    : v != null && v !== "" ? String(v) : undefined);

  function unidadDe(id, datos) {
    const u = { id, registrado: true };
    for (const c of CAMPOS) {
      const v = valorCampo(c, datos?.[c]);
      if (v !== undefined) u[c] = v;
    }
    return u;
  }

  /** Campos corregidos: los válidos; null = el campo se vació (sólo zona y teléfono pueden quedar vacíos). */
  function correccionDe(datos) {
    const c = {};
    for (const k of CAMPOS) {
      if (!esObjeto(datos) || !(k in datos)) continue;
      if (datos[k] == null && ["zona", "telefono"].includes(k)) c[k] = null;
      else if (valorCampo(k, datos[k]) !== undefined) c[k] = valorCampo(k, datos[k]);
    }
    return c;
  }

  const metaDe = (doc) => ({ usuario: String(doc?.usuario ?? "anónimo"), fecha: String(doc?.fecha ?? "") });

  function personaDe(id, d) {
    if (!esObjeto(d) || d.nombre == null) return null;
    return { id, nombre: String(d.nombre), cargo: String(d.cargo ?? ""), telefono: texto(d.telefono), correo: texto(d.correo),
      activo: d.activo !== false, creado: String(d.creado ?? ""), actualizado: String(d.actualizado ?? d.creado ?? "") };
  }

  function actividadDe(id, d) {
    if (!esObjeto(d) || !fechaValida(d.fecha) || !entero(d.ue_id)) return null;
    const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(entero).filter(Boolean))] : []);
    const n = Number.isInteger(d.asistentes_proyectados) && d.asistentes_proyectados >= 0 ? d.asistentes_proyectados : null;
    return { id, ue_id: entero(d.ue_id), tipo: TIPOS.includes(d.tipo) ? d.tipo : "OTRA", actividad: String(d.actividad ?? ""),
      fecha: d.fecha, hora: /^([01]\d|2[0-3]):[0-5]\d$/.test(d.hora) ? d.hora : "00:00", lugar: String(d.lugar ?? ""),
      encargados: ids(d.encargados), personal: ids(d.personal), asistentes_proyectados: n, observaciones: texto(d.observaciones),
      estado: ESTADOS.includes(d.estado) ? d.estado : "PENDIENTE", creado: String(d.creado ?? ""), creado_por: String(d.creado_por ?? "anónimo"),
      actualizado: String(d.actualizado ?? d.creado ?? ""), actualizado_por: String(d.actualizado_por ?? d.creado_por ?? "anónimo") };
  }

  function historialDe(d) {
    if (!esObjeto(d) || !entero(d.ue_id)) return null;
    const cambios = Array.isArray(d.cambios) ? d.cambios.filter((c) => esObjeto(c) && CAMPOS.includes(c.campo))
      .map((c) => ({ campo: c.campo, antes: texto(c.antes), despues: texto(c.despues) })) : [];
    return { ue_id: entero(d.ue_id), accion: String(d.accion ?? ""), motivo: texto(d.motivo), usuario: String(d.usuario ?? "anónimo"),
      fecha: String(d.fecha ?? ""), cambios };
  }

  const docsCon = (docs, crear) => docs.map((d) => (entero(d.id) ? crear(entero(d.id), d.data()) : null)).filter(Boolean);

  /** Primera carga de la colección (antes de mostrar nada) y, después, cambios de otros visitantes en vivo. */
  const escuchar = (coleccion, aplicar, evento) => new Promise((resolver) => {
    db.collection(coleccion).onSnapshot((snap) => {
      aplicar(snap.docs);
      resolver();
      window.dispatchEvent(new Event(evento));
    }, () => resolver());
  });

  const listo = (async () => {
    db = (await window.claude?.use?.("db")) ?? null;
    if (!db) return false;
    const user = await window.claude.use("user");
    uid = user ? await user.id() : null;
    await Promise.all([
      escuchar("bajas", (docs) => api.setBajas(docs.map((d) => [Number(d.id), d.data()])), "colegios:bajas"),
      escuchar("registros", (docs) => api.setRegistros(docs
        .filter((d) => Number.isInteger(Number(d.id)) && Number(d.id) >= ID_MINIMO && !api.esDeLosDatos(Number(d.id)))
        .map((d) => [unidadDe(Number(d.id), d.data()?.unidad), metaDe(d.data())])), "colegios:registros"),
      escuchar("correcciones", (docs) => api.setCorrecciones(docs.filter((d) => entero(d.id))
        .map((d) => [entero(d.id), correccionDe(d.data()?.campos)])), "colegios:correcciones"),
      escuchar("personal", (docs) => api.setPersonal(docsCon(docs, personaDe)), "colegios:personal"),
      escuchar("actividades", (docs) => api.setActividades(docsCon(docs, actividadDe)), "colegios:actividades"),
      escuchar("historial", (docs) => api.setHistorial(docs.map((d) => historialDe(d.data())).filter(Boolean)), "colegios:historial"),
    ]);
    return true;
  })();

  async function registrar(id, accion, motivo) {
    await db.collection("historial").add({ ue_id: id, accion, motivo: motivo ?? null, usuario: usuario(), fecha: ahora() });
  }

  /** Id basado en la hora (dos visitantes a la vez no chocan) y libre en lo ya cargado. */
  function nuevoId(existe) {
    let id = Date.now() * 10 + Math.floor(Math.random() * 10);
    while (existe(id)) id++;
    return id;
  }

  async function registrarUnidad(body) {
    const op = api("catalogos").opciones_registro;
    const errores = validarRegistro(body, op); // de app.js: mismas reglas y mensajes que el backend
    if (Object.keys(errores).length) throw invalido("Revise los datos del colegio", errores);
    const id = nuevoId(api.existe);
    const unidad = unidadDe(id, limpiarRegistro(body, op)); // mismos valores limpios que app/backend/registro.py
    const { id: _, registrado, ...datos } = unidad;
    const meta = { usuario: usuario(), fecha: ahora() };
    await db.doc(`registros/${id}`).set({ unidad: datos, ...meta });
    api.agregarRegistro(unidad, meta); // visible ya, sin esperar el aviso de la base
    await registrar(id, "registro");
    return { ok: true, id, unidad: { ...unidad, registro: meta } };
  }

  /** PATCH /api/unidades/{id}: se valida el registro completo resultante; se guardan sólo los campos que cambian. */
  async function corregirUnidad(id, body) {
    if (!api.existe(id)) throw error(404, "Unidad educativa no encontrada");
    if (!esObjeto(body)) throw invalido("Revise los datos del colegio", { general: "Datos no válidos" });
    if (api.estaDeBaja(id)) throw error(409, "Reactive el colegio antes de corregirlo");
    const op = api("catalogos").opciones_registro;
    const actual = api(`unidades/${id}`);
    const enviados = Object.fromEntries(CAMPOS.filter((c) => c in body).map((c) => [c, body[c]]));
    const completo = { ...valoresDe(actual), ...enviados };
    const errores = validarRegistro(completo, op);
    if (Object.keys(errores).length) throw invalido("Revise los datos del colegio", errores);
    const limpio = limpiarRegistro(completo, op);
    const cambios = Object.keys(enviados).map((campo) => ({ campo, antes: texto(actual[campo]), despues: texto(limpio[campo]) }))
      .filter((c) => c.antes !== c.despues);
    if (!cambios.length) throw invalido("Revise los datos del colegio", { general: "No hay cambios para guardar" });
    const campos = { ...(api.correccionDe(id) ?? {}), ...Object.fromEntries(cambios.map((c) => [c.campo, limpio[c.campo] ?? null])) };
    const meta = { usuario: usuario(), fecha: ahora() };
    await db.doc(`correcciones/${id}`).set({ campos, ...meta });
    api.setCorreccion(id, campos); // visible ya, sin esperar el aviso de la base
    const entrada = { ue_id: id, accion: "modificacion", cambios, ...meta };
    await db.collection("historial").add(entrada);
    api.agregarHistorial({ ...entrada, motivo: null });
    return { ok: true, id, unidad: api(`unidades/${id}`), cambios };
  }

  const limpiarPersona = (b) => Object.fromEntries(Object.entries(b)
    .filter(([c]) => ["nombre", "cargo", "telefono", "correo", "activo"].includes(c))
    .map(([c, v]) => [c, c === "activo" ? v : typeof v === "string" ? v.trim() || null : null]));

  async function crearPersona(body) {
    const errores = validarPersona(body);
    if (Object.keys(errores).length) throw invalido("Revise los datos del personal", errores);
    const { activo: _, ...datos } = limpiarPersona(body);
    const id = nuevoId((x) => !!api.persona(x)), fecha = ahora();
    const doc = { telefono: null, correo: null, ...datos, activo: true, creado: fecha, actualizado: fecha, usuario: usuario() };
    await db.doc(`personal/${id}`).set(doc);
    api.guardarPersona(personaDe(id, doc));
    await db.collection("historial").add({ personal_id: id, accion: "personal", usuario: usuario(), fecha });
    return { ok: true, persona: api("personal", "incluir_inactivos=1").find((p) => p.id === id) };
  }

  async function editarPersona(id, body) {
    const actual = api.persona(id);
    if (!actual) throw error(404, "Persona no encontrada");
    const errores = validarPersona(body, true);
    if (Object.keys(errores).length) throw invalido("Revise los datos del personal", errores);
    const cambios = Object.fromEntries(Object.entries(limpiarPersona(body)).filter(([c, v]) => (actual[c] ?? null) !== v));
    if (!Object.keys(cambios).length) throw invalido("Revise los datos del personal", { general: "No hay cambios para guardar" });
    const fecha = ahora();
    const { id: _, ...resto } = actual;
    const doc = { ...resto, ...cambios, actualizado: fecha, usuario: usuario() };
    await db.doc(`personal/${id}`).set(doc);
    api.guardarPersona(personaDe(id, doc));
    await db.collection("historial").add({ personal_id: id, accion: "personal", cambios: Object.keys(cambios), usuario: usuario(), fecha });
    return { ok: true, persona: api("personal", "incluir_inactivos=1").find((p) => p.id === id) };
  }

  /** Valores que se guardan de una actividad (sólo los campos presentes en el cuerpo). */
  function limpiarActividad(b) {
    const a = {};
    const unicos = (v) => [...new Set(v ?? [])];
    if ("ue_id" in b) a.ue_id = b.ue_id;
    if ("tipo" in b) a.tipo = b.tipo.trim().toUpperCase();
    for (const c of ["actividad", "lugar", "fecha", "hora"]) if (c in b) a[c] = b[c].trim();
    if ("encargados" in b) a.encargados = unicos(b.encargados);
    if ("personal" in b) a.personal = unicos(b.personal);
    if ("asistentes_proyectados" in b) a.asistentes_proyectados = b.asistentes_proyectados ?? null;
    if ("observaciones" in b) a.observaciones = b.observaciones?.trim() || null;
    if ("estado" in b && b.estado != null) a.estado = b.estado.trim().toUpperCase();
    return a;
  }

  const colegioValido = (id) => api.existe(id) && !api.estaDeBaja(id);

  async function crearActividad(body) {
    const errores = validarActividad(body, { colegioValido, personaValida: (_, id) => api.persona(id)?.activo === true });
    if (Object.keys(errores).length) throw invalido("Revise los datos de la actividad", errores);
    const id = nuevoId((x) => !!api.actividad(x)), fecha = ahora();
    const doc = { personal: [], asistentes_proyectados: null, observaciones: null, estado: "PENDIENTE", ...limpiarActividad(body),
      creado: fecha, creado_por: usuario(), actualizado: fecha, actualizado_por: usuario() };
    await db.doc(`actividades/${id}`).set(doc);
    api.guardarActividad(actividadDe(id, doc));
    await db.collection("historial").add({ actividad_id: id, accion: "actividad", usuario: usuario(), fecha });
    return { ok: true, actividad: api.actividadCompleta(api.actividad(id)) };
  }

  async function editarActividad(id, body) {
    const actual = api.actividad(id);
    if (!actual) throw error(404, "Actividad no encontrada");
    // las personas inactivas que ya estaban asignadas pueden quedarse; no se pueden agregar
    const personaValida = (lista, pid) => api.persona(pid)?.activo === true || actual[lista].includes(pid);
    const errores = validarActividad(body, { parcial: true, colegioValido, personaValida });
    if (Object.keys(errores).length) throw invalido("Revise los datos de la actividad", errores);
    const igual = (x, y) => (Array.isArray(x) ? [...x].sort().join() === [...y].sort().join() : (x ?? null) === (y ?? null));
    const cambios = Object.fromEntries(Object.entries(limpiarActividad(body)).filter(([c, v]) => !igual(actual[c], v)));
    if (!Object.keys(cambios).length) throw invalido("Revise los datos de la actividad", { general: "No hay cambios para guardar" });
    const fecha = ahora();
    const { id: _, ...resto } = actual;
    const doc = { ...resto, ...cambios, actualizado: fecha, actualizado_por: usuario() };
    await db.doc(`actividades/${id}`).set(doc);
    api.guardarActividad(actividadDe(id, doc));
    await db.collection("historial").add({ actividad_id: id, accion: "actividad", cambios: Object.keys(cambios), usuario: usuario(), fecha });
    return { ok: true, actividad: api.actividadCompleta(api.actividad(id)) };
  }

  async function bajaOAlta(id, accion, body) {
    if (body?.confirmar !== true) throw error(422, "Falta confirmar");
    if (!api.existe(id)) throw error(404, "Unidad educativa no encontrada");
    if (accion === "baja") {
      const motivo = String(body.motivo ?? "").trim();
      if (!motivo || motivo.length > 300) throw error(422, "Motivo obligatorio (máximo 300 caracteres)");
      if (api.estaDeBaja(id)) throw error(409, "Ya estaba dada de baja");
      await db.doc(`bajas/${id}`).set({ fecha: ahora(), motivo, usuario: usuario() });
      await registrar(id, "baja", motivo);
      return { ok: true, id, estado: "baja" };
    }
    if (!api.estaDeBaja(id)) throw error(409, "No estaba dada de baja");
    await db.doc(`bajas/${id}`).delete();
    await registrar(id, "alta");
    return { ok: true, id, estado: "activa" };
  }

  async function enviar(metodo, path, body) {
    if (!(await listo)) throw error(404, "No disponible");
    let m;
    if (metodo === "POST") {
      if (path === "unidades") return registrarUnidad(body);
      if (path === "personal") return crearPersona(body);
      if (path === "actividades") return crearActividad(body);
      if ((m = /^unidades\/(\d+)\/(baja|alta)$/.exec(path))) return bajaOAlta(Number(m[1]), m[2], body);
    }
    if (metodo === "PATCH") {
      if ((m = /^unidades\/(\d+)$/.exec(path))) return corregirUnidad(Number(m[1]), body);
      if ((m = /^personal\/(\d+)$/.exec(path))) return editarPersona(Number(m[1]), body);
      if ((m = /^actividades\/(\d+)$/.exec(path))) return editarActividad(Number(m[1]), body);
    }
    throw error(404, "No disponible");
  }

  return { disponible: () => listo, enviar, post: (path, body) => enviar("POST", path, body) };
}
