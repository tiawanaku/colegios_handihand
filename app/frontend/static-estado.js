// Bajas y altas de colegios en la página estática publicada en claude.ai: se guardan en la base compartida
// del artifact (capacidad `db`), así todos los que abren la página ven los mismos cambios. Reproduce las
// reglas del backend (POST /api/unidades/{id}/baja|alta): confirmar:true, motivo obligatorio, 404 y 409.
// Fuera de claude.ai (archivo suelto, otro hosting) no hay base: la página queda de solo consulta.
function crearEstadoArtifact(api) {
  let db = null, uid = null;
  const error = (status, mensaje) => Object.assign(new Error(mensaje), { status });

  const listo = (async () => {
    db = (await window.claude?.use?.("db")) ?? null;
    if (!db) return false;
    const user = await window.claude.use("user");
    uid = user ? await user.id() : null;
    // primera carga antes de mostrar nada; después, cambios de otros visitantes en vivo
    await new Promise((resolver) => {
      db.collection("bajas").onSnapshot((snap) => {
        api.setBajas(snap.docs.map((d) => [Number(d.id), d.data()]));
        resolver();
        window.dispatchEvent(new Event("colegios:bajas"));
      }, () => resolver());
    });
    return true;
  })();

  async function registrar(id, accion, motivo) {
    await db.collection("historial").add({ ue_id: id, accion, motivo: motivo ?? null, usuario: uid || "anónimo", fecha: new Date().toISOString() });
  }

  return {
    disponible: () => listo,
    async post(path, body) {
      const m = /^unidades\/(\d+)\/(baja|alta)$/.exec(path);
      if (!m || !(await listo)) throw error(404, "No disponible");
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
