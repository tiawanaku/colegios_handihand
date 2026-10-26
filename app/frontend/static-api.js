// API en el navegador: mismo contrato que app/backend/main.py (docs/04-frontend.md), sobre un arreglo
// de unidades educativas ya cargado. Sirve para desplegar el dashboard como sitio estático
// (GitHub Pages, un artifact, un USB) sin servidor:
//   window.COLEGIOS_CONFIG = { staticApi: createStaticApi(filas) };
// Las exportaciones CSV/XLSX/PDF necesitan el backend y no existen en este modo.
function createStaticApi(rows) {
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

  return function staticApi(path, params) {
    const p = new URLSearchParams(params ?? "");
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
    const m = /^unidades\/(.+)$/.exec(path);
    if (m) {
      const r = rows.find((x) => String(x.id) === decodeURIComponent(m[1]));
      if (!r) throw new Error(`${path}: HTTP 404`);
      return r;
    }
    throw new Error(`${path}: HTTP 404`);
  };
}
