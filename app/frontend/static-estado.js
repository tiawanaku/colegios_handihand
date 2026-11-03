// Bajas, altas y registros de colegios en la página estática publicada en claude.ai: se guardan en la base
// compartida del artifact (capacidad `db`), así todos los que abren la página ven los mismos cambios.
// Reproduce las reglas del backend: POST /api/unidades/{id}/baja|alta (confirmar:true, motivo obligatorio,
// 404 y 409) y POST /api/unidades (validarRegistro de app.js, mismos mensajes; 422 con `errores` por campo).
// Fuera de claude.ai (archivo suelto, otro hosting) no hay base: la página queda de solo consulta.
function crearEstadoArtifact(api) {
  let db = null, uid = null;
  const error = (status, mensaje, extra) => Object.assign(new Error(mensaje), { status }, extra);
  const ID_MINIMO = 1_000_000;
  // sólo estos campos de un registro llegan a la API (lo guardó otro visitante: no se confía en su forma)
  const CAMPOS = ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono", "niveles", "turnos", "lat", "lon"];

  function unidadDe(id, datos) {
    const u = { id, registrado: true };
    for (const c of CAMPOS) {
      const v = datos?.[c];
      if (["lat", "lon", "distrito_municipal"].includes(c)) { if (typeof v === "number" && Number.isFinite(v)) u[c] = v; }
      else if (v != null && v !== "") u[c] = String(v);
    }
    return u;
  }

  const metaDe = (doc) => ({ usuario: String(doc?.usuario ?? "anónimo"), fecha: String(doc?.fecha ?? "") });

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
    ]);
    return true;
  })();

  async function registrar(id, accion, motivo) {
    await db.collection("historial").add({ ue_id: id, accion, motivo: motivo ?? null, usuario: uid || "anónimo", fecha: new Date().toISOString() });
  }

  /** Id ≥ 1.000.000 basado en la hora (dos visitantes a la vez no chocan) y libre en los datos ya cargados. */
  function nuevoId() {
    let id = Date.now() * 10 + Math.floor(Math.random() * 10);
    while (api.existe(id)) id++;
    return id;
  }

  async function registrarUnidad(body) {
    const op = api("catalogos").opciones_registro;
    const errores = validarRegistro(body, op); // de app.js: mismas reglas y mensajes que el backend
    if (Object.keys(errores).length) throw error(422, "Revise los datos del colegio", { errores });
    // mismos valores limpios que app/backend/registro.py
    const turnos = new Set(body.turnos.map((t) => t.trim().toUpperCase()));
    const id = nuevoId();
    const unidad = unidadDe(id, {
      nombre: body.nombre.trim(), direccion: body.direccion.trim(), zona: body.zona?.trim() || null, telefono: body.telefono?.trim() || null,
      dependencia: body.dependencia.trim().toUpperCase(), subsistema: body.subsistema == null ? "REGULAR" : body.subsistema.trim().toUpperCase(),
      distrito_municipal: body.distrito_municipal, lat: body.lat, lon: body.lon,
      niveles: [...new Set(body.niveles.map((n) => n.trim()))].join(","), turnos: op.turnos.filter((t) => turnos.has(t)).join(","),
    });
    const { id: _, registrado, ...datos } = unidad;
    const meta = { usuario: uid || "anónimo", fecha: new Date().toISOString() };
    await db.doc(`registros/${id}`).set({ unidad: datos, ...meta });
    api.agregarRegistro(unidad, meta); // visible ya, sin esperar el aviso de la base
    await registrar(id, "registro");
    return { ok: true, id, unidad: { ...unidad, registro: meta } };
  }

  return {
    disponible: () => listo,
    async post(path, body) {
      if (!(await listo)) throw error(404, "No disponible");
      if (path === "unidades") return registrarUnidad(body);
      const m = /^unidades\/(\d+)\/(baja|alta)$/.exec(path);
      if (!m) throw error(404, "No disponible");
      const id = Number(m[1]), accion = m[2];
      if (body?.confirmar !== true) throw error(422, "Falta confirmar");
      if (!api.existe(id)) throw error(404, "Unidad educativa no encontrada");
      if (accion === "baja") {
        const motivo = String(body.motivo ?? "").trim();
        if (!motivo || motivo.length > 300) throw error(422, "Motivo obligatorio (máximo 300 caracteres)");
        if (api.estaDeBaja(id)) throw error(409, "Ya estaba dada de baja");
        await db.doc(`bajas/${id}`).set({ fecha: new Date().toISOString(), motivo, usuario: uid || "anónimo" });
        await registrar(id, "baja", motivo);
        return { ok: true, id, estado: "baja" };
      }
      if (!api.estaDeBaja(id)) throw error(409, "No estaba dada de baja");
      await db.doc(`bajas/${id}`).delete();
      await registrar(id, "alta");
      return { ok: true, id, estado: "activa" };
    },
  };
}
