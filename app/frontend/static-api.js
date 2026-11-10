// API en el navegador: mismo contrato que app/backend/main.py (docs/04-frontend.md), sobre un arreglo
// de unidades educativas ya cargado. Sirve para desplegar el dashboard como sitio estático
// (GitHub Pages, un artifact, un USB) sin servidor:
//   window.COLEGIOS_CONFIG = { staticApi: createStaticApi(filas) };
// Las exportaciones CSV/XLSX/PDF necesitan el backend y no existen en este modo.
function createStaticApi(filas) {
  // Colegios dados de baja (id → {fecha, motivo, usuario}); los carga static-estado.js cuando hay dónde
  // guardarlos. Igual que el backend: no salen en listados, mapa, estadísticas ni catálogos.
  let bajas = new Map();
  // Colegios registrados en la página (ids ≥ 1.000.000, `registrado: true`): se mezclan con los demás en todo.
  let registros = [], metaRegistros = new Map(); // id → {usuario, fecha} para la ficha
  // Correcciones (id → campos corregidos; null = campo vaciado), personal, actividades e historial: también de la base.
  let correcciones = new Map(), personal = [], actividades = [], historial = [];
  let todas = filas, rows = filas;
  const corregir = (r) => {
    const c = correcciones.get(r.id);
    if (!c) return r;
    const u = { ...r };
    for (const [k, v] of Object.entries(c)) { if (v == null) delete u[k]; else u[k] = v; }
    return u;
  };
  const actualizar = () => {
    todas = registros.length ? [...filas, ...registros] : filas;
    if (correcciones.size) todas = todas.map(corregir);
    rows = todas.filter((r) => !bajas.has(r.id));
  };
  const lista = (csv) => (csv ? String(csv).split(",").filter(Boolean) : []);
  const up = (v) => String(v).toUpperCase();
  const sinDato = (v) => (v == null || v === "" ? "SIN DATO" : v);
  const count = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
  const obj = (map) => Object.fromEntries(map);

  function filtrar(p) {
    const deps = p.getAll("dependencia").map(up);
    const dists = p.getAll("distrito").map(Number);
    const exactos = ["nivel:niveles", "turno:turnos", "subsistema:subsistema"]
      .map((s) => s.split(":")).map(([param, campo]) => [campo, p.getAll(param).map(up)]).filter(([, v]) => v.length);
    const q = (p.get("q") || "").trim().toLocaleLowerCase("es");
    return rows.filter((r) =>
      (!deps.length || deps.includes(r.dependencia)) &&
      (!dists.length || dists.includes(r.distrito_municipal)) &&
      exactos.every(([campo, vals]) => lista(r[campo]).some((x) => vals.includes(x))) &&
      (!q || ["nombre", "direccion", "zona", "codigo_rue"].some((c) => String(r[c] ?? "").toLocaleLowerCase("es").includes(q))));
  }

  function estadisticas(sel) {
    const dep = new Map(), niv = new Map(), tur = new Map(), sub = new Map(), dist = new Map(), estDep = new Map();
    let mujeres = 0, hombres = 0, docentes = 0;
    const hayMatricula = sel.some((r) => r.estudiantes_total != null);
    for (const r of sel) {
      const d = sinDato(r.dependencia);
      count(dep, d);
      (lista(r.niveles).length ? lista(r.niveles) : ["SIN DATO"]).forEach((n) => count(niv, n));
      (lista(r.turnos).length ? lista(r.turnos) : ["SIN DATO"]).forEach((t) => count(tur, t));
      (lista(r.subsistema).length ? lista(r.subsistema) : ["SIN DATO"]).forEach((s) => count(sub, s));
      const k = r.distrito_municipal ?? "SIN DATO";
      if (!dist.has(k)) dist.set(k, new Map());
      count(dist.get(k), d);
      count(estDep, d, r.estudiantes_total || 0);
      mujeres += r.estudiantes_mujeres || 0;
      hombres += r.estudiantes_hombres || 0;
      docentes += r.docentes || 0;
    }
    const total = hayMatricula ? [...estDep.values()].reduce((a, b) => a + b, 0) : null;
    const distOrden = [...dist.keys()].sort((a, b) => (typeof a === "string") - (typeof b === "string") || a - b);
    return {
      total_unidades: sel.length,
      por_dependencia: obj(dep), por_nivel: obj(niv), por_turno: obj(tur), por_subsistema: obj(sub),
      por_distrito: Object.fromEntries(distOrden.map((k) => [String(k), obj(dist.get(k))])),
      estudiantes: { total, mujeres: hayMatricula ? mujeres : null, hombres: hayMatricula ? hombres : null,
        por_dependencia: hayMatricula ? obj(estDep) : {} },
      docentes: docentes || null,
      ratio_estudiante_docente: docentes && total ? Math.round((total / docentes) * 10) / 10 : null,
      sin_coordenadas: sel.filter((r) => r.lat == null || r.lon == null).length,
    };
  }

  function catalogos() {
    const set = (f) => [...new Set(rows.flatMap(f))].sort();
    return {
      dependencias: set((r) => (r.dependencia ? [r.dependencia] : [])),
      distritos: [...new Set(rows.map((r) => r.distrito_municipal).filter((d) => d != null))].sort((a, b) => a - b),
      niveles: set((r) => lista(r.niveles)), turnos: set((r) => lista(r.turnos)), subsistemas: set((r) => lista(r.subsistema)),
      campos: { matricula: rows.some((r) => r.estudiantes_total != null) },
      // igual que el backend: listas fijas, salvo los niveles (los que existen en los datos)
      opciones_registro: {
        dependencias: ["FISCAL", "CONVENIO", "PRIVADA"], subsistemas: ["REGULAR", "ALTERNATIVA", "ESPECIAL", "PERMANENTE"],
        turnos: ["MAÑANA", "TARDE", "NOCHE"], niveles: set((r) => lista(r.niveles)),
        distritos: Array.from({ length: 14 }, (_, i) => i + 1), area: { lat: [-16.65, -16.40], lon: [-68.35, -68.05] },
      },
    };
  }

  const ORDENABLES = ["nombre", "distrito_municipal", "dependencia", "estudiantes_total", "codigo_rue"];

  function unidades(p) {
    const orden = p.get("orden") || "nombre";
    const campo = orden.replace(/^-/, "");
    if (!ORDENABLES.includes(campo)) throw new Error("unidades: HTTP 422");
    const dir = orden.startsWith("-") ? -1 : 1;
    const page = Math.max(1, Number(p.get("page")) || 1);
    const size = Math.min(500, Math.max(1, Number(p.get("page_size")) || 50));
    const sel = filtrar(p).sort((a, b) => {
      const [x, y] = [a[campo], b[campo]];
      if (x == null || y == null) return (x == null) - (y == null) || a.id - b.id; // nulos al final
      return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "es")) * dir || a.id - b.id;
    });
    return { count: sel.length, page, page_size: size, results: sel.slice((page - 1) * size, page * size) };
  }

  const SI = ["1", "true", "yes", "on"];
  const http = (path, status) => { throw new Error(`${path}: HTTP ${status}`); };
  const porNombre = (a, b) => { const [x, y] = [a.nombre.toLowerCase(), b.nombre.toLowerCase()]; return x < y ? -1 : x > y ? 1 : a.id - b.id; };
  const esFecha = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number), f = new Date(y, m - 1, d);
    return f.getFullYear() === y && f.getMonth() === m - 1 && f.getDate() === d;
  };

  /** Actividad como la devuelve GET /api/actividades: con el colegio y las personas (nombre, cargo, activo). */
  function actividadCompleta(a) {
    const pers = new Map(personal.map((x) => [x.id, x]));
    const ref = (id) => { const x = pers.get(id); return { id, nombre: x?.nombre ?? null, cargo: x?.cargo ?? null, activo: x?.activo ?? false }; };
    const u = todas.find((r) => r.id === a.ue_id);
    return { id: a.id, ue_id: a.ue_id, colegio: { id: a.ue_id, nombre: u?.nombre ?? null }, tipo: a.tipo, actividad: a.actividad, fecha: a.fecha,
      hora: a.hora, lugar: a.lugar, encargados: a.encargados.map(ref), personal: a.personal.map(ref),
      asistentes_proyectados: a.asistentes_proyectados, observaciones: a.observaciones, estado: a.estado,
      creado: a.creado, creado_por: a.creado_por, actualizado: a.actualizado, actualizado_por: a.actualizado_por };
  }

  function listarActividades(p) {
    const [desde, hasta, ue] = ["desde", "hasta", "ue_id"].map((k) => p.get(k));
    if ((desde != null && !esFecha(desde)) || (hasta != null && !esFecha(hasta))) http("actividades", 422);
    if (desde && hasta) {
      const dia = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; }; // sólo para contar días
      if (dia(hasta) < dia(desde) || dia(hasta) - dia(desde) > 400) http("actividades", 422);
    }
    if (ue != null && !/^-?\d+$/.test(ue)) http("actividades", 422);
    const estado = p.get("estado")?.toUpperCase();
    return actividades
      .filter((a) => (!desde || a.fecha >= desde) && (!hasta || a.fecha <= hasta) && (ue == null || a.ue_id === Number(ue)) && (!estado || a.estado === estado))
      .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora) || a.id - b.id)
      .map(actividadCompleta);
  }

  const ACCIONES_UNIDAD = ["registro", "baja", "alta", "modificacion"];
  const historialDe = (id) => historial.filter((h) => h.ue_id === id && ACCIONES_UNIDAD.includes(h.accion))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
    .map((h) => (h.accion === "modificacion" ? { accion: h.accion, usuario: h.usuario, fecha: h.fecha, cambios: h.cambios }
      : { accion: h.accion, motivo: h.motivo, usuario: h.usuario, fecha: h.fecha }));

  function staticApi(path, params) {
    const p = new URLSearchParams(params ?? "");
    if (path === "personal") return personal.filter((x) => x.activo || SI.includes(String(p.get("incluir_inactivos")).toLowerCase()))
      .sort(porNombre).map(({ id, nombre, cargo, telefono, correo, activo, creado, actualizado }) => ({ id, nombre, cargo, telefono, correo, activo, creado, actualizado }));
    if (path === "actividades") return listarActividades(p);
    const h = /^unidades\/(\d+)\/historial$/.exec(path);
    if (h) return todas.some((r) => r.id === Number(h[1])) ? historialDe(Number(h[1])) : http(path, 404);
    if (path === "catalogos") return catalogos();
    if (path === "estadisticas") return estadisticas(filtrar(p));
    if (path === "unidades") return unidades(p);
    if (path === "geojson") return {
      type: "FeatureCollection",
      features: filtrar(p).filter((r) => r.lat != null && r.lon != null).map((r) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
        properties: { id: r.id, nombre: r.nombre, dependencia: r.dependencia, distrito: r.distrito_municipal, niveles: r.niveles },
      })),
    };
    if (path === "bajas") return todas.filter((r) => bajas.has(r.id))
      .map((r) => ({ id: r.id, nombre: r.nombre, distrito_municipal: r.distrito_municipal ?? null, dependencia: r.dependencia ?? null,
        fecha_baja: bajas.get(r.id).fecha, motivo: bajas.get(r.id).motivo, usuario: bajas.get(r.id).usuario }))
      .sort((a, b) => String(b.fecha_baja).localeCompare(String(a.fecha_baja)));
    const m = /^unidades\/(.+)$/.exec(path);
    if (m) {
      const r = todas.find((x) => String(x.id) === decodeURIComponent(m[1]));
      if (!r) throw new Error(`${path}: HTTP 404`);
      const ficha = metaRegistros.has(r.id) ? { ...r, registro: metaRegistros.get(r.id) } : { ...r };
      const ultima = historialDe(r.id).find((x) => x.accion === "modificacion");
      if (ultima) ficha.modificado = { usuario: ultima.usuario, fecha: ultima.fecha };
      return bajas.has(r.id) ? { ...ficha, baja: bajas.get(r.id) } : ficha;
    }
    throw new Error(`${path}: HTTP 404`);
  }
  staticApi.existe = (id) => todas.some((r) => r.id === id);
  staticApi.estaDeBaja = (id) => bajas.has(id);
  staticApi.setBajas = (mapa) => { bajas = new Map(mapa); actualizar(); };
  staticApi.esDeLosDatos = (id) => filas.some((r) => r.id === id);
  // lista de [unidad, {usuario, fecha}]
  staticApi.setRegistros = (lista) => {
    registros = lista.map(([u]) => u);
    metaRegistros = new Map(lista.map(([u, m]) => [u.id, m]));
    actualizar();
  };
  staticApi.agregarRegistro = (u, meta) => {
    registros = [...registros.filter((x) => x.id !== u.id), u];
    metaRegistros.set(u.id, meta);
    actualizar();
  };
  staticApi.cantidadRegistros = () => registros.length;
  // lista de [id, campos corregidos]
  staticApi.setCorrecciones = (lista) => { correcciones = new Map(lista); actualizar(); };
  staticApi.correccionDe = (id) => correcciones.get(id) ?? null;
  staticApi.setCorreccion = (id, campos) => { correcciones.set(id, campos); actualizar(); };
  staticApi.cantidadCorrecciones = () => correcciones.size;
  staticApi.setPersonal = (lista) => { personal = lista; };
  staticApi.persona = (id) => personal.find((x) => x.id === id) ?? null;
  staticApi.guardarPersona = (x) => { personal = [...personal.filter((y) => y.id !== x.id), x]; };
  staticApi.setActividades = (lista) => { actividades = lista; };
  staticApi.actividad = (id) => actividades.find((x) => x.id === id) ?? null;
  staticApi.guardarActividad = (x) => { actividades = [...actividades.filter((y) => y.id !== x.id), x]; };
  staticApi.actividadCompleta = actividadCompleta;
  staticApi.setHistorial = (lista) => { historial = lista; };
  staticApi.agregarHistorial = (h) => { historial = [...historial, h]; };
  return staticApi;
}
