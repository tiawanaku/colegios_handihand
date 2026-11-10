// Dashboard de unidades educativas. Sin build: JS plano + Leaflet + Chart.js.
// Contrato de la API que consume: docs/04-frontend.md

// ---------------------------------------------------------------- configuración
const CONFIG = {
  apiBase: "/api",             // otro backend: window.COLEGIOS_CONFIG = { apiBase: "https://.../api" }
  pageSize: 25,
  mapCenter: [-16.505, -68.19], // El Alto
  mapZoom: 12,
  // El mapa encuadra sólo los puntos dentro de esta zona (los que caen fuera se dibujan igual):
  // así un par de coordenadas erróneas no alejan el zoom de toda la ciudad.
  areaBounds: [[-16.65, -68.35], [-16.40, -68.05]],
  // Mapas base en orden de preferencia: si uno no carga (bloqueado, sin Referer, sin red) se pasa al
  // siguiente, y sin ninguno se dibujan rótulos de distrito. `tiles: null` desactiva el mapa base.
  tiles: [
    { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap" },
    { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", attribution: "© OpenStreetMap © CARTO" },
  ],
  ...(window.COLEGIOS_CONFIG || {}),
};

const FILTROS = ["dependencia", "subsistema", "nivel", "turno", "distrito"]; // multivalor, en el orden de la UI
const ORDEN_DEFAULT = "nombre";
// Secciones de la barra lateral; los filtros sólo aplican (y sólo se ven) en las que muestran datos.
const VISTAS = ["dashboard", "registro", "correcciones", "agenda", "personal", "estadisticas"];
const VISTA_DEFAULT = "dashboard";
const VISTAS_CON_FILTROS = ["dashboard", "estadisticas"];
// Agenda (HU-09): mismos valores que la API
const TIPOS_ACTIVIDAD = ["TALLER", "VISITA", "REUNION", "OTRA"];
const ESTADOS_ACTIVIDAD = ["PENDIENTE", "REALIZADA", "POSTERGADA", "CANCELADA"];

const COLORS = { FISCAL: "--fiscal", CONVENIO: "--convenio", PRIVADA: "--privada", COMUNITARIA: "--comunitaria" };
const LABEL = {
  FISCAL: "Fiscal (pública)", CONVENIO: "De convenio", PRIVADA: "Privada", COMUNITARIA: "Comunitaria",
  INICIAL: "Inicial", PRIMARIA: "Primaria", SECUNDARIA: "Secundaria", ALTERNATIVA: "Alternativa",
  ESPECIAL: "Especial", TECNICA: "Técnica", MANANA: "Mañana", TARDE: "Tarde", NOCHE: "Noche", "SIN DATO": "Sin dato",
  TALLER: "Taller", VISITA: "Visita", REUNION: "Reunión", OTRA: "Otra",
  PENDIENTE: "Pendiente", REALIZADA: "Realizada", POSTERGADA: "Postergada", CANCELADA: "Cancelada",
  // valores del catálogo de la BD de cuidados (core_catalogogeneral); el resto se muestra en tipo oración
  REGULAR: "Regular", PERMANENTE: "Permanente",
  "INICIAL EN FAMILIA COMUNITARIA": "Inicial", "PRIMARIA COMUNITARIA VOCACIONAL": "Primaria",
  "SECUNDARIA COMUNITARIA PRODUCTIVA": "Secundaria", "EDUCACIÓN PRIMARIA PARA ADULTOS": "Primaria adultos",
  "EDUCACIÓN SECUNDARIA PARA ADULTOS": "Secundaria adultos",
  "PERMANENTE CENTROS Y TALLERES DE APOYO": "Perm. talleres de apoyo", "PERMANENTE COMUNICACIÓN POR RADIO": "Perm. radio",
  "PERMANENTE COMUNICACIÓN POR TELEVISIÓN": "Perm. televisión", "PERMANENTE EDUCACIÓN ADULTO MAYOR": "Perm. adulto mayor",
  "PERMANENTE EDUCACIÓN COMUNITARIA": "Perm. comunitaria",
};
// Orden lógico de la oferta (lo desconocido va al final, alfabético)
const ORDEN = {
  dependencia: ["FISCAL", "CONVENIO", "PRIVADA", "COMUNITARIA"],
  subsistema: ["REGULAR", "ALTERNATIVA", "ESPECIAL", "PERMANENTE"],
  nivel: ["INICIAL", "INICIAL EN FAMILIA COMUNITARIA", "PRIMARIA", "PRIMARIA COMUNITARIA VOCACIONAL",
    "SECUNDARIA", "SECUNDARIA COMUNITARIA PRODUCTIVA", "ALTERNATIVA", "EDUCACIÓN PRIMARIA PARA ADULTOS",
    "EDUCACIÓN SECUNDARIA PARA ADULTOS", "TECNICA", "TÉCNICO AUXILIAR", "TÉCNICO BÁSICO", "TÉCNICO MEDIO", "OPERARIO", "ESPECIAL"],
  turno: ["MANANA", "MAÑANA", "TARDE", "NOCHE"],
};
const porOrden = (lista) => (a, b) => {
  const [i, j] = [lista.indexOf(a), lista.indexOf(b)];
  return (i < 0) - (j < 0) || i - j || String(a).localeCompare(String(b), "es");
};
const KPI_DEP = { FISCAL: "Fiscales", CONVENIO: "De convenio", PRIVADA: "Privadas", COMUNITARIA: "Comunitarias" };

// ---------------------------------------------------------------- utilidades
const $ = (sel) => document.querySelector(sel);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (dep) => cssVar(COLORS[dep] || "--sindato");
const tipoOracion = (s) => { const t = String(s).toLocaleLowerCase("es"); return t.charAt(0).toLocaleUpperCase("es") + t.slice(1); };
const label = (k) => LABEL[k] ?? (k === String(k).toUpperCase() ? tipoOracion(k) : k);
const labels = (csv) => (csv || "").split(",").filter(Boolean).map(label).join(", ");
const fmt = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("es-BO"));
// Todo valor que venga de la BD pasa por esc() antes de tocar innerHTML (incluye tooltips de Leaflet).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// "2026-11-03" sola se leería como UTC (y saldría el día anterior en Bolivia): se toma como hora local
const fmtFecha = (s) => {
  if (!s) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? deIso(s) : new Date(s);
  return isNaN(d) ? String(s) : d.toLocaleDateString("es-BO");
};
const fmtFechaHora = (s) => {
  const d = new Date(s ?? "");
  return isNaN(d) ? String(s ?? "") : d.toLocaleString("es-BO", { dateStyle: "short", timeStyle: "short" });
};
// Fechas de la agenda: siempre con componentes locales (nunca new Date("YYYY-MM-DD"), que es UTC)
const dos = (n) => String(n).padStart(2, "0");
const isoDia = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const deIso = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const fechaValida = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number), f = new Date(y, m - 1, d);
  return f.getFullYear() === y && f.getMonth() === m - 1 && f.getDate() === d;
};
const fechaLarga = (s) => tipoOracion(deIso(s).toLocaleDateString("es-BO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
const mesDeHoy = () => isoDia(new Date()).slice(0, 7);

// ---------------------------------------------------------------- estado (único, sincronizado con la URL)
const state = { vista: VISTA_DEFAULT, q: "", page: 1, orden: ORDEN_DEFAULT, ...Object.fromEntries(FILTROS.map((f) => [f, []])),
  ue: "", // colegio abierto en Correcciones
  agMes: "", agModo: "mes", agColegio: "", agEstado: "", // Agenda ("" en agMes: el mes actual)
  pTodos: false }; // Personal: también los inactivos

function readUrl() {
  const u = new URLSearchParams(location.search);
  state.q = u.get("q") || "";
  for (const f of FILTROS) state[f] = u.getAll(f);
  state.page = Math.max(1, parseInt(u.get("page"), 10) || 1);
  state.orden = u.get("orden") || ORDEN_DEFAULT;
  const vista = u.get("vista") === "modificacion" ? "correcciones" : u.get("vista"); // enlaces del sprint 2
  state.vista = VISTAS.includes(vista) ? vista : VISTA_DEFAULT;
  state.ue = /^\d+$/.test(u.get("ue") || "") ? u.get("ue") : "";
  state.agMes = /^\d{4}-(0[1-9]|1[0-2])$/.test(u.get("mes") || "") ? u.get("mes") : "";
  state.agModo = u.get("modo") === "lista" ? "lista" : "mes";
  state.agColegio = /^\d+$/.test(u.get("colegio") || "") ? u.get("colegio") : "";
  state.agEstado = ESTADOS_ACTIVIDAD.includes(u.get("estado")) ? u.get("estado") : "";
  state.pTodos = u.get("personal") === "todos";
}

/** Parámetros de filtro (sin paginación): los comparten estadísticas, mapa y tabla. */
function filterParams() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  for (const f of FILTROS) state[f].forEach((v) => p.append(f, v));
  return p;
}

function renderFiltrosActivos() {
  const n = FILTROS.reduce((acc, f) => acc + state[f].length, 0) + (state.q.trim() ? 1 : 0);
  $("#filtros-activos").textContent = n ? `(${n} activos)` : "";
}

/** URL de la vista `vista` con el resto del estado actual (la de la barra lateral y la de la página). */
function urlDe(vista) {
  const p = filterParams();
  if (state.page > 1) p.set("page", state.page);
  if (state.orden !== ORDEN_DEFAULT) p.set("orden", state.orden);
  if (vista !== VISTA_DEFAULT) p.set("vista", vista);
  // el estado propio de cada sección sólo viaja en su enlace
  if (vista === "correcciones" && state.ue) p.set("ue", state.ue);
  if (vista === "agenda") {
    if (state.agMes) p.set("mes", state.agMes);
    if (state.agModo !== "mes") p.set("modo", state.agModo);
    if (state.agColegio) p.set("colegio", state.agColegio);
    if (state.agEstado) p.set("estado", state.agEstado);
  }
  if (vista === "personal" && state.pTodos) p.set("personal", "todos");
  const qs = p.toString();
  return qs ? `?${qs}` : location.pathname;
}

/** Los enlaces de la barra lateral conservan filtros, página y orden (abrir en otra pestaña da la misma vista). */
const actualizarNav = () =>
  document.querySelectorAll("#nav a[data-vista]").forEach((a) => a.setAttribute("href", urlDe(a.dataset.vista)));

/** Cambiar de sección crea una entrada en el historial (atrás vuelve a la anterior); filtros y página la reemplazan. */
function writeUrl({ push = false } = {}) {
  renderFiltrosActivos();
  history[push ? "pushState" : "replaceState"](null, "", urlDe(state.vista));
  actualizarNav();
}

// ---------------------------------------------------------------- red
// Una petición viva por canal: si el usuario cambia filtros rápido, la anterior se aborta y
// una respuesta vieja nunca pisa a una nueva.
const inflight = {};
let pending = 0;

async function api(channel, path, params) {
  inflight[channel]?.abort();
  const ctrl = (inflight[channel] = new AbortController());
  setBusy(+1);
  try {
    // Modo estático (static-api.js): misma API, resuelta en el navegador
    if (CONFIG.staticApi) return CONFIG.staticApi(path, params);
    const qs = params ? `?${params}` : "";
    const r = await fetch(`${CONFIG.apiBase}/${path}${qs}`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (r.status === 401) irAlLogin();
    if (!r.ok) throw Object.assign(new Error(`${path}: HTTP ${r.status}`), { status: r.status });
    return await r.json();
  } finally {
    setBusy(-1);
    if (inflight[channel] === ctrl) delete inflight[channel];
  }
}

function setBusy(delta) {
  pending += delta;
  $(".content").setAttribute("aria-busy", String(pending > 0));
}

function showError(err) {
  if (err?.name === "AbortError") return;
  console.error(err);
  const box = $("#estado");
  box.textContent = `No se pudieron cargar los datos (${err.message}). Reintenta en unos segundos.`;
  box.hidden = false;
}

const clearError = () => ($("#estado").hidden = true);

// ---------------------------------------------------------------- filtros
function renderChips(name, values, text = label) {
  const selected = new Set(state[name]);
  $(`#f-${name}`).closest("fieldset").hidden = values.length === 0;
  $(`#f-${name}`).innerHTML = values.map((v) => {
    const val = esc(v);
    return `<label title="${val}"><input type="checkbox" name="${name}" value="${val}"${selected.has(String(v)) ? " checked" : ""}>${esc(text(v))}</label>`;
  }).join("");
}

let conMatricula = true;

function syncInputs() {
  $("#q").value = state.q;
  for (const f of FILTROS)
    document.querySelectorAll(`#f-${f} input`).forEach((i) => (i.checked = state[f].includes(i.value)));
}

async function loadCatalogos() {
  const c = await api("catalogos", "catalogos");
  renderChips("dependencia", [...c.dependencias].sort(porOrden(ORDEN.dependencia)));
  renderChips("subsistema", [...(c.subsistemas || [])].sort(porOrden(ORDEN.subsistema)));
  renderChips("nivel", [...c.niveles].sort(porOrden(ORDEN.nivel)));
  renderChips("turno", [...c.turnos].sort(porOrden(ORDEN.turno)));
  // Datos sin matrícula (p. ej. la BD de cuidados): se ocultan KPI, columna y orden por estudiantes
  conMatricula = c.campos?.matricula !== false;
  document.body.classList.toggle("sin-matricula", !conMatricula);
  renderChips("distrito", c.distritos.map(String), (d) => `D-${d}`);
  $("#legend").innerHTML = c.dependencias
    .map((d) => `<span><i style="background:${color(d)}"></i>${esc(label(d))}</span>`).join("");
  catalogosCargados = true;
  const primeraVez = !opcionesRegistro;
  if (c.opciones_registro) renderOpcionesRegistro((opcionesRegistro = c.opciones_registro));
  actualizarRegistro();
  // una corrección abierta antes de tener las opciones se dibuja ahora
  if (primeraVez && opcionesRegistro && correccion && $("#form-correccion").hidden) mostrarCorreccion(correccion.ficha);
  return c;
}

// ---------------------------------------------------------------- KPIs y gráficos
const charts = {};

function chart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(`#${id}`), config);
}

let ultimasStats = null, graficosAlDia = false;

async function loadStats() {
  const s = (ultimasStats = await api("stats", "estadisticas", filterParams()));
  graficosAlDia = false;
  const dep = s.por_dependencia || {};
  const kpis = [["Unidades educativas", s.total_unidades, "--accent"]];
  for (const [d, title] of Object.entries(KPI_DEP))
    if (d in dep || d !== "COMUNITARIA") kpis.push([title, dep[d] ?? 0, COLORS[d]]);
  if (conMatricula) {
    kpis.push(["Estudiantes", s.estudiantes?.total, "--comunitaria"]);
    kpis.push(["Estudiante / docente", s.ratio_estudiante_docente, "--sindato"]);
  }
  $("#kpis").innerHTML = kpis
    .map(([t, v, c]) => `<div class="kpi" style="--c:var(${c})"><b>${fmt(v)}</b><span>${t}</span></div>`).join("");
  if (state.vista === "estadisticas") drawCharts();
}

/** Los gráficos se dibujan sólo con su sección visible: en un contenedor oculto Chart.js mide 0 × 0. */
function drawCharts() {
  const s = ultimasStats;
  if (!s || graficosAlDia || typeof Chart === "undefined") return;
  graficosAlDia = true;
  const dep = s.por_dependencia || {};
  const deps = Object.keys(dep).sort(porOrden(ORDEN.dependencia));
  chart("ch-dep", {
    type: "doughnut",
    data: { labels: deps.map(label), datasets: [{ data: deps.map((d) => dep[d]), backgroundColor: deps.map(color) }] },
    options: { aspectRatio: 1.8, plugins: { legend: { position: "bottom" } } },
  });

  const distritos = Object.keys(s.por_distrito || {});
  chart("ch-distrito", {
    type: "bar",
    data: {
      labels: distritos.map((d) => (isNaN(d) ? label(d) : `D-${d}`)),
      datasets: deps.map((d) => ({ label: label(d), backgroundColor: color(d), data: distritos.map((k) => s.por_distrito[k][d] || 0) })),
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: "bottom" } } },
  });

  const niveles = Object.keys(s.por_nivel || {}).sort(porOrden(ORDEN.nivel));
  chart("ch-nivel", {
    type: "bar",
    data: { labels: niveles.map(label), datasets: [{ label: "Unidades", data: niveles.map((n) => s.por_nivel[n]), backgroundColor: color() }] },
    options: { aspectRatio: niveles.length > 8 ? 1.1 : 1.8, indexAxis: "y", scales: { x: { ticks: { precision: 0 } } }, plugins: { legend: { display: false } } },
  });
}

// ---------------------------------------------------------------- mapa
let map, layer, ultimoGeojson, sinMapaBase = false, encuadrePendiente = null;

/** Lista de mapas base de la configuración (acepta también una URL suelta, como en versiones anteriores). */
function proveedores() {
  const t = CONFIG.tiles;
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((p) => (typeof p === "string" ? { url: p, attribution: CONFIG.tilesAttribution } : p));
}

function addBaseLayer(lista) {
  capaBase(map, lista, () => {
    sinMapaBase = true;
    $("#map").classList.add("sin-mapa-base");
    if (ultimoGeojson) drawDistritos(ultimoGeojson);
  });
}

/** Prueba los mapas base en orden. Un proveedor se descarta si sus primeros tiles fallan sin que cargue ninguno. */
function capaBase(m, lista, sinNinguno) {
  if (!lista.length) return sinNinguno();
  const [p, ...resto] = lista;
  // referrerPolicy: OpenStreetMap rechaza (403) los tiles pedidos sin Referer, p. ej. tras un
  // proxy con "Referrer-Policy: no-referrer"; así se envía al menos el origen del sitio.
  const tl = L.tileLayer(p.url, { maxZoom: 19, attribution: p.attribution, referrerPolicy: "strict-origin-when-cross-origin" });
  let cargados = 0, fallos = 0;
  tl.on("tileload", () => cargados++);
  tl.on("tileerror", () => {
    if (++fallos < 4 || cargados > 0 || !m.hasLayer(tl)) return;
    tl.remove();
    console.warn(`Mapa base no disponible: ${p.url}`);
    capaBase(m, resto, sinNinguno);
  });
  tl.addTo(m);
}

async function loadMap() {
  if (typeof L === "undefined") { // Leaflet no cargó (CDN bloqueado): el resto del dashboard sigue
    $("#map-vacio").textContent = "No se pudo cargar el mapa (Leaflet).";
    $("#map-vacio").hidden = false;
    return;
  }
  if (!map) {
    // preferCanvas: miles de marcadores sin crear un nodo SVG por cada uno
    map = L.map("map", { preferCanvas: true }).setView(CONFIG.mapCenter, CONFIG.mapZoom);
    addBaseLayer(proveedores());
    // Si el contenedor cambia de tamaño (carga de estilos, rotación, panel de filtros) Leaflet debe
    // recalcularlo; si no, quedan franjas grises sin tiles.
    new ResizeObserver(() => map.invalidateSize()).observe($("#map"));
  }
  const gj = (ultimoGeojson = await api("map", "geojson", filterParams()));
  layer?.remove();
  if (sinMapaBase) drawDistritos(gj);
  layer = L.geoJSON(gj, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, weight: 1, color: "#fff", fillOpacity: 0.9, fillColor: color(f.properties.dependencia) }),
    onEachFeature: (f, l) => l.bindTooltip(esc(f.properties.nombre)).on("click", () => showDetail(f.properties.id)),
  }).addTo(map);
  $("#map-vacio").hidden = gj.features.length > 0;
  const area = L.latLngBounds(CONFIG.areaBounds);
  const dentro = gj.features.map((f) => L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0])).filter((ll) => area.contains(ll));
  const bounds = dentro.length ? L.latLngBounds(dentro) : gj.features.length ? layer.getBounds() : null;
  // con el Dashboard oculto el mapa mide 0: se encuadra al volver a mostrarlo (mostrarVista)
  if (bounds && state.vista !== "dashboard") encuadrePendiente = bounds;
  else if (bounds) { encuadrePendiente = null; map.fitBounds(bounds, { padding: [20, 20], maxZoom: 15 }); }
}

// Sin mapa base (p. ej. donde los tiles están bloqueados): rótulos "D-n" en el centro de cada distrito
let distritosLayer;

function drawDistritos(gj) {
  const acc = new Map();
  for (const f of gj.features) {
    const d = f.properties.distrito;
    if (d == null) continue;
    const a = acc.get(d) || { lat: 0, lon: 0, n: 0 };
    a.lat += f.geometry.coordinates[1]; a.lon += f.geometry.coordinates[0]; a.n++;
    acc.set(d, a);
  }
  distritosLayer?.remove();
  distritosLayer = L.layerGroup([...acc].map(([d, a]) => L.marker([a.lat / a.n, a.lon / a.n], {
    interactive: false, keyboard: false,
    icon: L.divIcon({ className: "rotulo-distrito", html: `D-${esc(d)}`, iconSize: [40, 18] }),
    zIndexOffset: 1000, // encima de los puntos
  }))).addTo(map);
}

// ---------------------------------------------------------------- tabla
async function loadTable() {
  const p = filterParams();
  p.set("page", state.page);
  p.set("page_size", CONFIG.pageSize);
  p.set("orden", state.orden);
  const d = await api("table", "unidades", p);
  const pages = Math.max(1, Math.ceil(d.count / CONFIG.pageSize));
  if (state.page > pages) { // p. ej. URL compartida con una página que ya no existe
    state.page = pages;
    writeUrl();
    return loadTable();
  }
  $("#count").textContent = `(${fmt(d.count)})`;
  $("#tabla tbody").innerHTML = d.results.length
    ? d.results.map((r) => `
      <tr data-id="${esc(r.id)}" tabindex="0">
        <td>${esc(r.nombre)}</td><td>${esc(r.distrito_municipal)}</td>
        <td><span class="badge" style="background:${color(r.dependencia)}">${esc(label(r.dependencia || "SIN DATO"))}</span></td>
        <td>${esc(r.direccion)}</td><td>${esc(labels(r.niveles))}</td>
        <td>${esc(labels(r.turnos))}</td><td class="num">${r.estudiantes_total != null ? fmt(r.estudiantes_total) : ""}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="vacio">Ninguna unidad educativa coincide con los filtros.</td></tr>`;
  $("#pageinfo").textContent = `Página ${state.page} de ${pages}`;
  $("#prev").disabled = state.page <= 1;
  $("#next").disabled = state.page >= pages;
  renderSort();
}

function renderSort() {
  const campo = state.orden.replace(/^-/, "");
  const desc = state.orden.startsWith("-");
  document.querySelectorAll("th[data-orden]").forEach((th) => {
    th.setAttribute("aria-sort", th.dataset.orden === campo ? (desc ? "descending" : "ascending") : "none");
  });
}

// ---------------------------------------------------------------- detalle
async function showDetail(id) {
  try {
    const r = await api("detail", `unidades/${encodeURIComponent(id)}`);
    const est = r.estudiantes_total != null
      ? `${fmt(r.estudiantes_total)}${r.estudiantes_mujeres != null ? ` (M ${fmt(r.estudiantes_mujeres)} / H ${fmt(r.estudiantes_hombres)})` : ""}`
      : null;
    const rows = [
      ["RUE", r.codigo_rue], ["Dependencia", label(r.dependencia || "")], ["Convenio con", r.tipo_convenio],
      ["Subsistema", r.subsistema], ["Niveles", labels(r.niveles)], ["Turnos", labels(r.turnos)],
      ["Distrito", r.distrito_municipal], ["Zona", r.zona], ["Dirección", r.direccion], ["Teléfono", r.telefono],
      ["Director/a", r.director], ["Estudiantes", est], ["Docentes", r.docentes],
    ].filter(([, v]) => v != null && v !== "");
    detalleActual = r;
    const baja = r.baja
      ? `<p class="baja-info">Dado de baja el ${esc(fmtFecha(r.baja.fecha))}${r.baja.motivo ? ` · ${esc(r.baja.motivo)}` : ""}</p>` : "";
    const acciones = esEncargado ? `<div id="detalle-acciones" class="acciones">${r.baja
      ? `<button type="button" data-accion="alta">Dar de alta</button>`
      : `<button type="button" class="peligro" data-accion="baja">Dar de baja</button>`}</div>
      <div id="detalle-confirmar" class="confirmar" role="group" aria-labelledby="detalle-confirmar-texto" hidden></div>` : "";
    const registrado = r.registrado ? `<p class="muted">Registrado en este sistema${r.registro
      ? ` por ${esc(r.registro.usuario)} el ${esc(fmtFecha(r.registro.fecha))}` : ""}.</p>` : "";
    const modificado = r.modificado ? `<p class="muted">Corregido por ${esc(r.modificado.usuario)} el ${esc(fmtFecha(r.modificado.fecha))}.</p>` : "";
    // sus actividades de la agenda (sólo donde hay agenda: servidor o claude.ai)
    const agenda = puedeRegistrar === true ? `<section id="detalle-actividades" class="ficha-actividades" aria-labelledby="detalle-act-titulo">
      <h3 id="detalle-act-titulo">Actividades en la agenda</h3><p class="muted" aria-live="polite"></p><ul></ul></section>` : "";
    $("#detalle-body").innerHTML = `<h2 id="detalle-titulo">${esc(r.nombre)}</h2>${baja}${registrado}${modificado}
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>${acciones}${agenda}`;
    const dlg = $("#detalle");
    if (!dlg.open) dlg.showModal();
    if (agenda) actividadesDeFicha(r.id);
  } catch (e) {
    showError(e);
  }
}

// ---------------------------------------------------------------- bajas y altas (sólo encargado, con servidor)
let detalleActual = null, bajasLista = [], altaOrigen = null, avisoTimer;

/** Paso de confirmación previo a dar de baja o de alta. `pre` distingue el del diálogo y el de la lista. */
function pasoConfirmacion(tipo, nombre, pre) {
  const baja = tipo === "baja";
  return `<form data-tipo="${tipo}" novalidate>
    <p id="${pre}-confirmar-texto"><strong>¿Dar de ${tipo} «${esc(nombre)}»?</strong>
      ${baja ? "Dejará de aparecer en indicadores, mapa, gráficos y listado." : "Volverá a aparecer en indicadores, mapa, gráficos y listado."}</p>
    ${baja ? `<label for="${pre}-motivo">Motivo <span class="muted">(obligatorio)</span></label>
      <textarea id="${pre}-motivo" name="motivo" rows="2" maxlength="300" required aria-describedby="${pre}-error"></textarea>` : ""}
    <p id="${pre}-error" class="error-inline" role="alert" hidden></p>
    <div class="acciones"><button type="submit" class="${baja ? "peligro" : "primario"}">Confirmar ${tipo}</button><button type="button" data-cancelar>Cancelar</button></div>
  </form>`;
}

/** POST o PATCH con cuerpo JSON. El error lleva `status` y, en los 422, `errores` por campo. */
async function enviar(metodo, path, body) {
  // página estática en claude.ai: los cambios se guardan en la base compartida del artifact
  if (CONFIG.staticEstado) return CONFIG.staticEstado.enviar(metodo, path, body);
  let r;
  try {
    r = await fetch(`${CONFIG.apiBase}/${path}`, {
      method: metodo, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("sin conexión"), { status: 0 });
  }
  if (r.status === 401) irAlLogin();
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw Object.assign(new Error(typeof d.detail === "string" ? d.detail : `HTTP ${r.status}`), { status: r.status, errores: d.errores });
  }
  return r.json();
}
const post = (path, body) => enviar("POST", path, body);
/** Código HTTP de un error de api() o enviar() (en la página estática viene en el mensaje). */
const codigoDe = (e) => e?.status ?? (Number(/HTTP (\d+)/.exec(e?.message)?.[1]) || 0);

function mensajeError(e, tipo) {
  if (e.status === 409) return tipo === "baja" ? "Este colegio ya estaba dado de baja. Recarga la página para ver su estado."
    : "Este colegio no estaba dado de baja. Recarga la página para ver su estado.";
  return {
    0: "No se pudo conectar con el servidor. Revisa la conexión y reintenta.",
    403: "Tu usuario no tiene permiso de encargado para esta acción.",
    404: "El colegio ya no existe en la base de datos.",
    422: "Faltan datos: escribe el motivo (hasta 300 caracteres) y confirma.",
  }[e.status] || `No se pudo completar la operación (${e.message}). Reintenta en unos segundos.`;
}

function avisar(texto) {
  const a = $("#aviso");
  a.textContent = texto;
  a.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (a.hidden = true), 6000);
}

/** Envía la baja o el alta confirmada. Devuelve true si salió bien; si no, deja el error en el formulario. */
async function ejecutar(form, id, nombre) {
  const tipo = form.dataset.tipo;
  const error = form.querySelector(".error-inline");
  const body = { confirmar: true };
  if (tipo === "baja") {
    const motivo = form.motivo.value.trim();
    form.motivo.setAttribute("aria-invalid", String(!motivo));
    if (!motivo) {
      error.textContent = "Escribe el motivo de la baja.";
      error.hidden = false;
      form.motivo.focus();
      return false;
    }
    body.motivo = motivo;
  }
  const botones = form.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  form.setAttribute("aria-busy", "true");
  error.hidden = true;
  try {
    await post(`unidades/${encodeURIComponent(id)}/${tipo}`, body);
  } catch (e) {
    error.textContent = mensajeError(e, tipo);
    error.hidden = false;
    return false;
  } finally {
    botones.forEach((b) => (b.disabled = false));
    form.removeAttribute("aria-busy");
  }
  avisar(tipo === "baja" ? `«${nombre}» se dio de baja.` : `«${nombre}» se dio de alta y vuelve a aparecer.`);
  refresh();
  loadBajas();
  return true;
}

function confirmarEnDetalle(tipo) {
  const box = $("#detalle-confirmar");
  box.innerHTML = pasoConfirmacion(tipo, detalleActual.nombre, "detalle");
  box.hidden = false;
  $("#detalle-acciones").hidden = true;
  box.querySelector(tipo === "baja" ? "textarea" : "[type=submit]").focus();
}

function cancelarEnDetalle() {
  $("#detalle-confirmar").hidden = true;
  $("#detalle-confirmar").innerHTML = "";
  $("#detalle-acciones").hidden = false;
  $("#detalle-acciones button").focus();
}

async function loadBajas() {
  const estado = $("#bajas-estado");
  estado.textContent = "Cargando colegios dados de baja…";
  estado.classList.remove("error-inline");
  try {
    bajasLista = await api("bajas", "bajas");
  } catch (e) {
    if (e?.name === "AbortError") return;
    estado.textContent = `No se pudo cargar la lista de colegios dados de baja (${e.message}). Reintenta en unos segundos.`;
    estado.classList.add("error-inline");
    $("#tabla-bajas").hidden = true;
    return;
  }
  $("#bajas-count").textContent = `(${fmt(bajasLista.length)})`;
  estado.textContent = bajasLista.length ? "" : "No hay colegios dados de baja";
  $("#tabla-bajas").hidden = !bajasLista.length;
  $("#tabla-bajas tbody").innerHTML = bajasLista.map((b) => `
    <tr data-id="${esc(b.id)}">
      <td><button type="button" class="enlace" data-ver>${esc(b.nombre)}</button></td><td>${esc(b.distrito_municipal)}</td>
      <td><span class="badge" style="background:${color(b.dependencia)}">${esc(label(b.dependencia || "SIN DATO"))}</span></td>
      <td>${esc(fmtFecha(b.fecha_baja))}</td><td>${esc(b.motivo)}</td>
      <td><button type="button" data-alta>Dar de alta</button></td>
    </tr>`).join("");
}

function confirmarAltaEnLista(btn) {
  const id = btn.closest("tr").dataset.id;
  const b = bajasLista.find((x) => String(x.id) === id);
  const box = $("#bajas-confirmar");
  box.dataset.id = id;
  box.dataset.nombre = b?.nombre ?? "";
  box.innerHTML = pasoConfirmacion("alta", box.dataset.nombre, "bajas");
  box.hidden = false;
  altaOrigen = btn;
  box.querySelector("[type=submit]").focus();
}

function cerrarAltaEnLista() {
  const box = $("#bajas-confirmar");
  box.hidden = true;
  box.innerHTML = "";
}

function bindBajas() {
  const body = $("#detalle-body");
  body.addEventListener("click", (e) => {
    const accion = e.target.closest("[data-accion]");
    if (accion) confirmarEnDetalle(accion.dataset.accion);
    if (e.target.closest("[data-cancelar]")) cancelarEnDetalle();
  });
  body.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await ejecutar(e.target, detalleActual.id, detalleActual.nombre)) $("#detalle").close();
  });
  const card = $("#bajas");
  card.addEventListener("click", (e) => {
    if (e.target.closest("[data-alta]")) confirmarAltaEnLista(e.target.closest("[data-alta]"));
    else if (e.target.closest("[data-ver]")) showDetail(e.target.closest("tr").dataset.id);
    else if (e.target.closest("[data-cancelar]")) {
      cerrarAltaEnLista();
      if (altaOrigen?.isConnected) altaOrigen.focus();
    }
  });
  card.addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#bajas-confirmar");
    if (await ejecutar(e.target, box.dataset.id, box.dataset.nombre)) cerrarAltaEnLista();
  });
}

// ---------------------------------------------------------------- navegación (barra lateral)
function mostrarVista({ enfocar = false } = {}) {
  const v = state.vista;
  for (const x of VISTAS) $(`#vista-${x}`).hidden = x !== v;
  document.querySelectorAll("#nav a[data-vista]").forEach((a) =>
    a.dataset.vista === v ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  const conFiltros = VISTAS_CON_FILTROS.includes(v);
  $(".filters").hidden = !conFiltros;
  $("#kpis").hidden = !conFiltros;
  $(".layout").classList.toggle("sin-filtros", !conFiltros);
  document.title = `${$(`#nav a[data-vista="${v}"]`).textContent} · Colegios Handihand`;
  // Leaflet y Chart.js miden su contenedor: al aparecer la sección se recalculan
  if (v === "dashboard" && map) {
    map.invalidateSize();
    if (encuadrePendiente) map.fitBounds(encuadrePendiente, { padding: [20, 20], maxZoom: 15 });
    encuadrePendiente = null;
  }
  if (v === "estadisticas") { drawCharts(); Object.values(charts).forEach((c) => c.resize()); }
  if (v === "registro") mapaDe(formularios.r);
  cargarSeccion(v);
  if (enfocar) $(`#vista-${v}`).focus();
}

function irA(vista) {
  cerrarMenu();
  if (state.vista !== vista) {
    state.vista = vista;
    writeUrl({ push: true });
  }
  mostrarVista({ enfocar: true });
}

const menuAbierto = () => $("#menu").getAttribute("aria-expanded") === "true";

function cerrarMenu(devolverFoco = false) {
  if (!menuAbierto()) return;
  $("#nav").classList.remove("abierta");
  $("#menu").setAttribute("aria-expanded", "false");
  if (devolverFoco) $("#menu").focus();
}

function bindNav() {
  $("#menu").addEventListener("click", () => {
    if (menuAbierto()) return cerrarMenu();
    $("#nav").classList.add("abierta");
    $("#menu").setAttribute("aria-expanded", "true");
    $("#nav a[aria-current]")?.focus();
  });
  $("#nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-vista]");
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // abrir en otra pestaña sigue funcionando
    e.preventDefault();
    irA(a.dataset.vista);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuAbierto()) cerrarMenu(true);
  });
}

// ---------------------------------------------------------------- formularios: errores por campo
/** Controles de un campo: el elemento `#pre-campo` o, si es un grupo de casillas, sus casillas. */
const controles = (pre, campo) => {
  const el = $(`#${pre}-${campo}`);
  return !el ? [] : el.tagName === "FIELDSET" ? [...el.querySelectorAll("input")] : [el];
};

function errorEn(pre, campo, mensaje) {
  const p = $(`#${pre}-${campo}-error`);
  if (p) { p.textContent = mensaje || ""; p.hidden = !mensaje; }
  controles(pre, campo).forEach((c) => (mensaje ? c.setAttribute("aria-invalid", "true") : c.removeAttribute("aria-invalid")));
}

/** Cada error junto a su campo; los que no son de ningún campo van al aviso general (`estado`). */
function mostrarErrores(pre, campos, errores, estado, resumen, { enfocar = true } = {}) {
  campos.forEach((c) => errorEn(pre, c, errores[c]));
  const otros = Object.entries(errores).filter(([c]) => !campos.includes(c)).map(([, m]) => m);
  const deCampo = campos.some((c) => errores[c]);
  estado(deCampo ? `${resumen}${otros.length ? `: ${otros.join("; ")}` : " marcados en el formulario."}` : otros.join("; "));
  const primero = campos.find((c) => errores[c]);
  if (primero && enfocar) controles(pre, primero)[0]?.focus();
}

function estadoEn(id, texto, tipo = "error") {
  const p = $(`#${id}`);
  p.textContent = texto;
  p.hidden = !texto;
  p.className = tipo === "error" ? "error-inline" : "info";
}

/** Deshabilita los botones del formulario mientras se envía. */
async function enviando(form, fn) {
  const botones = form.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  form.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } finally {
    botones.forEach((b) => (b.disabled = false));
    form.removeAttribute("aria-busy");
  }
}

const mensajeEnvio = (e, accion) => ({
  0: "No se pudo conectar con el servidor. Revise la conexión y vuelva a intentar.",
  401: `Su sesión venció: inicie sesión de nuevo para ${accion}.`,
  403: `Su usuario no tiene permiso para ${accion}.`,
}[codigoDe(e)] || `No se pudo ${accion} (${e.message}). Vuelva a intentar en unos segundos.`);

// ---------------------------------------------------------------- formulario de colegio (registro HU-04 y corrección HU-08)
const CAMPOS_REGISTRO = ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono", "niveles", "turnos", "lat", "lon"];
let opcionesRegistro = null, catalogosCargados = false, // true también si la carga falló
  puedeRegistrar = CONFIG.staticApi ? null : true; // hay dónde guardar: servidor, o base compartida en claude.ai
// Un mismo formulario y mapa para registrar (r) y corregir (c): el de corrección se copia del de registro.
const formularios = {};

function prepararFormularios() {
  const c = $("#form-correccion");
  c.innerHTML = $("#form-registro").innerHTML.replace(/\b(id|for|aria-describedby)="r-/g, '$1="c-');
  $("#c-guardar").textContent = "Guardar cambios";
  Object.assign($("#c-limpiar"), { type: "button", textContent: "Descartar cambios" });
  for (const pre of ["r", "c"]) formularios[pre] = { pre, form: $(`#${pre === "r" ? "form-registro" : "form-correccion"}`), mapa: null, marcador: null, extraNiveles: [] };
}

/** Mismas reglas y mensajes que POST /api/unidades (app/backend/registro.py); static-estado.js la usa en la
 *  página publicada. Devuelve { campo: mensaje } (vacío si todo está bien). */
function validarRegistro(b, op) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { general: "Los datos enviados no son válidos" };
  const e = {};
  const largo = (v) => [...v].length; // como len() de Python: por carácter, no por unidad UTF-16
  const texto = (campo, max, faltante) => {
    const v = b[campo];
    if (v == null || (typeof v === "string" && !v.trim())) { if (faltante) e[campo] = faltante; return; }
    if (typeof v !== "string") e[campo] = "Debe ser un texto";
    else if (largo(v.trim()) > max) e[campo] = `No puede pasar de ${max} caracteres`;
  };
  texto("nombre", 200, "Escriba el nombre del colegio");
  texto("direccion", 255, "Escriba la dirección");
  texto("zona", 200);
  texto("telefono", 50);
  const mayus = (v) => (typeof v === "string" ? v.trim().toUpperCase() : null);
  if (!op.dependencias.includes(mayus(b.dependencia))) e.dependencia = "Elija la dependencia: fiscal, de convenio o privada";
  if (b.subsistema != null && !op.subsistemas.includes(mayus(b.subsistema))) e.subsistema = "Elija un subsistema válido"; // sin dato: REGULAR
  if (!Number.isInteger(b.distrito_municipal) || !op.distritos.includes(b.distrito_municipal))
    e.distrito_municipal = `Elija un distrito del ${op.distritos[0]} al ${op.distritos[op.distritos.length - 1]}`;
  if (!Array.isArray(b.niveles) || !b.niveles.length) e.niveles = "Elija al menos un nivel";
  else if (!b.niveles.every((n) => typeof n === "string" && n.trim() && !n.includes(",") && largo(n.trim()) <= 100))
    e.niveles = "Cada nivel debe ser un texto sin comas de hasta 100 caracteres";
  if (!Array.isArray(b.turnos) || !b.turnos.length) e.turnos = "Elija al menos un turno";
  else if (!b.turnos.every((t) => op.turnos.includes(mayus(t)))) e.turnos = "Turno no válido: elija mañana, tarde o noche";
  for (const c of ["lat", "lon"]) {
    const [min, max] = op.area[c];
    if (typeof b[c] !== "number" || !Number.isFinite(b[c])) e[c] = "Marque la ubicación en el mapa";
    else if (b[c] < min || b[c] > max) e[c] = "La ubicación está fuera del área de la ciudad";
  }
  return e;
}

/** Valores que se guardan (como app/backend/registro.py): textos sin espacios, mayúsculas y listas en CSV. */
function limpiarRegistro(b, op) {
  const turnos = new Set(b.turnos.map((t) => t.trim().toUpperCase()));
  return {
    nombre: b.nombre.trim(), direccion: b.direccion.trim(), zona: b.zona?.trim() || null, telefono: b.telefono?.trim() || null,
    dependencia: b.dependencia.trim().toUpperCase(), subsistema: b.subsistema == null ? "REGULAR" : b.subsistema.trim().toUpperCase(),
    distrito_municipal: b.distrito_municipal, lat: b.lat, lon: b.lon,
    niveles: [...new Set(b.niveles.map((n) => n.trim()))].join(","), turnos: op.turnos.filter((t) => turnos.has(t)).join(","),
  };
}

const csvLista = (v) => (v == null ? [] : Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);

/** Registro completo de un colegio (ficha de la API) con la forma del cuerpo de POST/PATCH. */
function valoresDe(u) {
  const texto = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());
  return {
    nombre: texto(u.nombre) ?? "", dependencia: texto(u.dependencia)?.toUpperCase() ?? "", subsistema: texto(u.subsistema)?.toUpperCase() ?? null,
    distrito_municipal: u.distrito_municipal ?? null, direccion: texto(u.direccion) ?? "", zona: texto(u.zona), telefono: texto(u.telefono),
    niveles: csvLista(u.niveles), turnos: csvLista(u.turnos).map((t) => t.toUpperCase()),
    lat: typeof u.lat === "number" ? u.lat : null, lon: typeof u.lon === "number" ? u.lon : null,
  };
}

const opcionesSelect = (vals, text = label, porDefecto = "") =>
  `<option value="">Elija…</option>` + vals.map((v) =>
    `<option value="${esc(v)}"${v === porDefecto ? " selected" : ""}>${esc(text(v))}</option>`).join("");
const casillas = (pre, name, vals) => vals.map((v) =>
  `<label title="${esc(v)}"><input type="checkbox" name="${name}" value="${esc(v)}" aria-describedby="${pre}-${name}-error">${esc(label(v))}</label>`).join("");

/** Dibuja selects y casillas desde opciones_registro, sin perder lo que ya se había elegido. */
function renderOpcionesForm(F, op) {
  const form = F.form;
  const antes = datosForm(F);
  form.dependencia.innerHTML = opcionesSelect([...op.dependencias].sort(porOrden(ORDEN.dependencia)));
  form.subsistema.innerHTML = opcionesSelect([...op.subsistemas].sort(porOrden(ORDEN.subsistema)), label, F.pre === "r" ? "REGULAR" : "");
  form.distrito_municipal.innerHTML = opcionesSelect(op.distritos.map(String), (d) => `D-${d}`);
  const niveles = [...new Set([...op.niveles, ...F.extraNiveles])].sort(porOrden(ORDEN.nivel)); // los del colegio aunque falten en el catálogo
  $(`#${F.pre}-niveles .chips`).innerHTML = casillas(F.pre, "niveles", niveles);
  $(`#${F.pre}-turnos .chips`).innerHTML = casillas(F.pre, "turnos", [...op.turnos].sort(porOrden(ORDEN.turno)));
  form.dependencia.value = antes.dependencia ?? "";
  if (antes.subsistema) form.subsistema.value = antes.subsistema;
  form.distrito_municipal.value = String(antes.distrito_municipal ?? "");
  form.querySelectorAll("fieldset input[type=checkbox]").forEach((i) => (i.checked = antes[i.name].includes(i.value)));
}
const renderOpcionesRegistro = (op) => Object.values(formularios).forEach((F) => renderOpcionesForm(F, op));

/** Cuerpo de POST /api/unidades a partir del formulario. */
function datosForm(F) {
  const f = F.form;
  const opcional = (v) => v.trim() || null;
  const numero = (v) => (v.trim() === "" ? null : Number(v));
  const marcados = (name) => [...f.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
  return {
    nombre: f.nombre.value.trim(), dependencia: f.dependencia.value, subsistema: f.subsistema.value,
    distrito_municipal: f.distrito_municipal.value ? Number(f.distrito_municipal.value) : null,
    direccion: f.direccion.value.trim(), zona: opcional(f.zona.value), telefono: opcional(f.telefono.value),
    niveles: marcados("niveles"), turnos: marcados("turnos"), lat: numero(f.lat.value), lon: numero(f.lon.value),
  };
}

/** Pone en el formulario un registro con la forma de valoresDe(). */
function llenarForm(F, v) {
  const f = F.form;
  const elegir = (sel, val) => { sel.value = val ?? ""; if (sel.value !== String(val ?? "")) sel.value = ""; };
  f.nombre.value = v.nombre;
  elegir(f.dependencia, v.dependencia);
  elegir(f.subsistema, v.subsistema);
  elegir(f.distrito_municipal, v.distrito_municipal == null ? "" : String(v.distrito_municipal));
  f.direccion.value = v.direccion;
  f.zona.value = v.zona ?? "";
  f.telefono.value = v.telefono ?? "";
  // los datos de origen pueden traer MANANA (sin Ñ): se marca Mañana
  const turnos = v.turnos.map((t) => (t === "MANANA" ? "MAÑANA" : t));
  f.querySelectorAll("input[name=niveles]").forEach((i) => (i.checked = v.niveles.includes(i.value)));
  f.querySelectorAll("input[name=turnos]").forEach((i) => (i.checked = turnos.includes(i.value)));
  f.lat.value = v.lat ?? "";
  f.lon.value = v.lon ?? "";
}

const errorDeCampo = (F, campo, mensaje) => errorEn(F.pre, campo, mensaje);
const mostrarErroresForm = (F, errores, estado) => mostrarErrores(F.pre, CAMPOS_REGISTRO, errores, estado, "Revise los datos del colegio");
const estadoRegistro = (texto, tipo) => estadoEn("registro-estado", texto, tipo);

/** Formulario visible sólo si hay opciones y dónde guardar (servidor, o base compartida en claude.ai). */
function actualizarRegistro() {
  const form = $("#form-registro");
  if (puedeRegistrar === false) {
    form.hidden = true;
    return estadoRegistro("El registro de colegios sólo funciona en la versión con servidor o en la página publicada en claude.ai. Esta copia es de solo consulta.", "info");
  }
  if (!opcionesRegistro || puedeRegistrar == null) {
    form.hidden = true;
    return catalogosCargados && !opcionesRegistro
      ? estadoRegistro("No se pudieron cargar las opciones del registro. Recargue la página en unos segundos.")
      : estadoRegistro("Cargando el formulario…", "info");
  }
  if (form.hidden) estadoRegistro("");
  form.hidden = false;
  if (state.vista === "registro") mapaDe(formularios.r);
}

/** Mapa pequeño para elegir la ubicación; se crea la primera vez que el formulario está visible. */
function mapaDe(F) {
  if (typeof L === "undefined" || !F.form.offsetParent) return; // oculto: Leaflet mediría 0 × 0
  if (F.mapa) return F.mapa.invalidateSize();
  const area = opcionesRegistro?.area;
  const bounds = area ? [[area.lat[0], area.lon[0]], [area.lat[1], area.lon[1]]] : CONFIG.areaBounds;
  const div = $(`#${F.pre}-mapa`);
  F.mapa = L.map(div).fitBounds(bounds);
  capaBase(F.mapa, proveedores(), () => div.classList.add("sin-mapa-base"));
  L.rectangle(bounds, { color: cssVar("--accent"), weight: 1, fill: false, interactive: false, dashArray: "4 4" }).addTo(F.mapa);
  F.mapa.on("click", (e) => ubicar(F, e.latlng, true));
  new ResizeObserver(() => F.mapa.invalidateSize()).observe(div);
}

/** Mueve el marcador; si la ubicación viene del mapa (clic o arrastre), también los campos. */
function ubicar(F, ll, desdeMapa, centrar = false) {
  const f = F.form;
  if (desdeMapa) {
    f.lat.value = ll.lat.toFixed(6);
    f.lon.value = ll.lng.toFixed(6);
    errorDeCampo(F, "lat"); errorDeCampo(F, "lon");
    f.dispatchEvent(new Event("input")); // la corrección cuenta los cambios pendientes
  }
  if (!F.mapa) return;
  if (!F.marcador) {
    F.marcador = L.marker(ll, { draggable: true, title: "Ubicación del colegio", alt: "Ubicación del colegio",
      icon: L.divIcon({ className: "marcador-registro", iconSize: [18, 18] }) }).addTo(F.mapa);
    F.marcador.on("dragend", () => ubicar(F, F.marcador.getLatLng(), true));
  } else F.marcador.setLatLng(ll);
  if (centrar) F.mapa.setView(ll, Math.max(F.mapa.getZoom(), 15));
  else if (!desdeMapa && !F.mapa.getBounds().contains(ll)) F.mapa.panTo(ll);
}

function quitarMarcador(F) {
  F.marcador?.remove();
  F.marcador = null;
}

/** Escribir latitud y longitud mueve el marcador; corregir un campo quita su error. */
function bindFormColegio(F) {
  F.form.addEventListener("input", (e) => {
    const campo = e.target.name;
    if (CAMPOS_REGISTRO.includes(campo)) errorDeCampo(F, campo);
    if (campo === "lat" || campo === "lon") {
      const [lat, lon] = [F.form.lat.value, F.form.lon.value].map((v) => (v.trim() === "" ? NaN : Number(v)));
      if (Number.isFinite(lat) && Number.isFinite(lon) && typeof L !== "undefined") ubicar(F, L.latLng(lat, lon), false);
    }
  });
}

/** Tras guardar un colegio: catálogos, indicadores, mapa y listado al día. */
async function recargarTodo() {
  await loadCatalogos().catch(showError);
  syncInputs();
  refresh();
}

async function guardarRegistro(ev) {
  ev.preventDefault();
  const F = formularios.r, form = F.form;
  const body = datosForm(F);
  $("#registro-ok").hidden = true;
  const errores = validarRegistro(body, opcionesRegistro);
  mostrarErroresForm(F, errores, estadoRegistro);
  if (Object.keys(errores).length) return;
  let r;
  try {
    r = await enviando(form, () => post("unidades", body));
  } catch (e) {
    if (e.status === 422 && e.errores && Object.keys(e.errores).length) mostrarErroresForm(F, e.errores, estadoRegistro);
    else estadoRegistro(e.status === 422 ? `Revise los datos del colegio (${e.message}).` : mensajeEnvio(e, "registrar colegios"));
    return;
  }
  form.reset(); // antes del aviso: el evento reset lo oculta
  const ok = $("#registro-ok");
  ok.innerHTML = `«${esc(r.unidad?.nombre ?? body.nombre)}» quedó registrado y ya aparece en indicadores, mapa y listado.
    <button type="button" class="enlace" data-ver="${esc(r.id)}">Ver el colegio</button>`;
  ok.hidden = false;
  ok.querySelector("button").focus();
  await recargarTodo();
}

function bindRegistro() {
  const F = formularios.r;
  F.form.addEventListener("submit", guardarRegistro);
  F.form.addEventListener("reset", () => { quitarMarcador(F); mostrarErroresForm(F, {}, estadoRegistro); $("#registro-ok").hidden = true; });
  bindFormColegio(F);
  $("#registro-ok").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ver]");
    if (b) showDetail(b.dataset.ver);
  });
}

// ---------------------------------------------------------------- buscador de colegios (combobox ARIA)
/** Coincidencias mientras se escribe (espera 250 ms; una petición viva por buscador) desde /unidades?q=.
 *  Flechas para recorrer, Enter para elegir, Escape para cerrar; también con el ratón. */
function buscadorColegios(input, alElegir) {
  const lista = $(`#${input.getAttribute("aria-controls")}`);
  const estado = $(`#${input.id}-estado`);
  const canal = `buscar-${input.id}`;
  let timer, opciones = [], activa = -1;
  const abierta = () => !lista.hidden;
  const cerrar = () => {
    lista.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activa = -1;
  };
  const marcar = (i) => {
    activa = i;
    [...lista.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === i)));
    input.setAttribute("aria-activedescendant", `${lista.id}-${i}`);
    lista.children[i]?.scrollIntoView({ block: "nearest" });
  };
  const elegir = (i) => {
    const u = opciones[i];
    if (!u) return;
    input.value = u.nombre ?? "";
    estado.textContent = "";
    cerrar();
    alElegir(u);
  };
  async function buscar() {
    const q = input.value.trim();
    if (q.length < 2) {
      inflight[canal]?.abort();
      opciones = [];
      cerrar();
      estado.textContent = q ? "Escriba al menos 2 letras." : "";
      return;
    }
    estado.textContent = "Buscando…";
    let d;
    try {
      d = await api(canal, "unidades", new URLSearchParams({ q, page_size: 8, orden: "nombre" }));
    } catch (e) {
      if (e?.name === "AbortError") return;
      cerrar();
      estado.textContent = "No se pudo buscar. Vuelva a intentar en unos segundos.";
      return;
    }
    if (input.value.trim() !== q) return; // ya se escribió otra cosa
    opciones = d.results;
    lista.innerHTML = opciones.map((u, i) => `<li id="${lista.id}-${i}" role="option" aria-selected="false" data-i="${i}">
      <span>${esc(u.nombre)}</span><span class="muted">${u.distrito_municipal != null ? `D-${esc(u.distrito_municipal)} · ` : ""}${esc(u.direccion)}</span></li>`).join("");
    estado.textContent = !d.count ? "Ningún colegio coincide."
      : `${fmt(d.count)} ${d.count === 1 ? "coincidencia" : "coincidencias"}${d.count > opciones.length ? ` (se muestran ${opciones.length})` : ""}. Use las flechas para elegir.`;
    activa = -1;
    lista.hidden = !opciones.length;
    input.setAttribute("aria-expanded", String(opciones.length > 0));
    input.removeAttribute("aria-activedescendant");
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(buscar, 250); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!opciones.length) return;
      e.preventDefault();
      if (!abierta()) { lista.hidden = false; input.setAttribute("aria-expanded", "true"); }
      const n = opciones.length;
      marcar(e.key === "ArrowDown" ? (activa + 1) % n : (activa - 1 + n) % n);
    } else if (e.key === "Enter" && abierta()) {
      e.preventDefault(); // no envía el formulario
      if (activa >= 0) elegir(activa);
    } else if (e.key === "Escape" && abierta()) {
      e.preventDefault();
      e.stopPropagation();
      cerrar();
    }
  });
  input.addEventListener("blur", cerrar);
  lista.addEventListener("mousedown", (e) => e.preventDefault()); // el foco se queda en el campo
  lista.addEventListener("click", (e) => {
    const li = e.target.closest("[role=option]");
    if (li) elegir(Number(li.dataset.i));
  });
  return { limpiar() { clearTimeout(timer); inflight[canal]?.abort(); input.value = ""; opciones = []; estado.textContent = ""; cerrar(); } };
}

// ---------------------------------------------------------------- secciones que guardan (Correcciones, Agenda y Personal)
const SECCIONES_GUARDAN = { correcciones: "Las correcciones", agenda: "La agenda", personal: "El registro de personal" };

/** Sin dónde guardar (archivo suelto) estas secciones lo dicen; con servidor o en claude.ai se cargan. */
function actualizarSecciones({ cargar = true } = {}) {
  for (const [s, nombre] of Object.entries(SECCIONES_GUARDAN)) {
    const aviso = $(`#${s}-aviso`);
    aviso.textContent = puedeRegistrar === false
      ? `${nombre} sólo funcionan en la versión con servidor o en la página publicada en claude.ai. Esta copia es de solo consulta.`
      : puedeRegistrar == null ? "Cargando…" : "";
    aviso.hidden = puedeRegistrar === true;
    $(`#${s}-cuerpo`).hidden = puedeRegistrar !== true;
  }
  $("#ag-nueva").hidden = $("#p-nuevo").hidden = puedeRegistrar !== true;
  if (cargar) cargarSeccion(state.vista);
}

function cargarSeccion(v) {
  if (puedeRegistrar !== true) return;
  if (v === "correcciones") {
    if (state.ue && String(correccion?.id ?? "") !== state.ue) abrirColegio(state.ue);
    else if (!state.ue && correccion) cerrarCorreccion();
    else if (correccion) mapaDe(formularios.c);
  }
  if (v === "agenda") cargarAgenda();
  if (v === "personal") cargarPersonal();
}

// ---------------------------------------------------------------- correcciones (HU-08)
let correccion = null; // { id, ficha, base }: colegio abierto y sus valores al abrirlo
const NOMBRE_CAMPO = { nombre: "Nombre", dependencia: "Dependencia", subsistema: "Subsistema", distrito_municipal: "Distrito",
  direccion: "Dirección", zona: "Zona", telefono: "Teléfono", niveles: "Niveles", turnos: "Turnos", lat: "Latitud", lon: "Longitud" };
const ACCION_BITACORA = { modificacion: "Corrección", baja: "Baja", alta: "Alta", registro: "Registro" };
const estadoCorreccion = (texto, tipo) => estadoEn("correccion-estado", texto, tipo);

/** Datos del formulario de corrección. Un subsistema sin elegir vale null (regular) sólo si el colegio no tenía. */
function datosCorreccion() {
  const d = datosForm(formularios.c);
  if (d.subsistema === "") d.subsistema = correccion?.base.subsistema ? "" : null;
  return d;
}

/** Campos que cambiaron respecto de lo que el colegio tenía (las listas, sin importar el orden). */
function cambiosDe(base, datos) {
  const igual = (a, b) => (Array.isArray(a) ? [...a].sort().join(",") === [...b].sort().join(",") : (a ?? null) === (b ?? null));
  return Object.fromEntries(CAMPOS_REGISTRO.filter((c) => !igual(base[c], datos[c])).map((c) => [c, datos[c]]));
}

async function abrirColegio(id) {
  const card = $("#correccion");
  if (state.ue !== String(id)) { state.ue = String(id); writeUrl(); }
  card.hidden = false;
  $("#form-correccion").hidden = true;
  $("#correccion-ok").hidden = true;
  $("#correccion-meta").hidden = true;
  $("#correccion-titulo").textContent = "Registro del colegio";
  estadoCorreccion("Cargando el registro del colegio…", "info");
  let u;
  try {
    u = await api("correccion", `unidades/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e?.name === "AbortError") return;
    correccion = null;
    $("#bitacora").hidden = true;
    return estadoCorreccion(codigoDe(e) === 404 ? "No se encontró ese colegio. Búsquelo de nuevo."
      : `No se pudo abrir el registro del colegio (${e.message}). Vuelva a intentar en unos segundos.`);
  }
  mostrarCorreccion(u);
  cargarBitacora(u.id);
}

/** Pone la ficha en el formulario de corrección (también tras guardar, con la ficha nueva). */
function mostrarCorreccion(u) {
  const F = formularios.c;
  correccion = { id: u.id, ficha: u, base: valoresDe(u) };
  $("#correccion-titulo").textContent = `Corregir «${u.nombre ?? ""}»`;
  const meta = [u.codigo_rue ? `RUE ${u.codigo_rue}` : "", u.registrado ? "Registrado en este sistema" : "",
    u.modificado ? `Última corrección por ${u.modificado.usuario} el ${fmtFechaHora(u.modificado.fecha)}` : ""].filter(Boolean);
  $("#correccion-meta").textContent = meta.join(" · ");
  $("#correccion-meta").hidden = !meta.length;
  if (!opcionesRegistro) return estadoCorreccion(catalogosCargados
    ? "No se pudieron cargar las opciones del formulario. Recargue la página en unos segundos." : "Cargando el formulario…", catalogosCargados ? "error" : "info");
  F.extraNiveles = correccion.base.niveles;
  renderOpcionesForm(F, opcionesRegistro);
  llenarForm(F, correccion.base);
  // el PATCH valida el registro completo: los datos de origen que no cumplen las reglas se marcan desde el inicio
  const pendientes = validarRegistro(datosCorreccion(), opcionesRegistro);
  mostrarErrores("c", CAMPOS_REGISTRO, pendientes, estadoCorreccion, "Complete los datos marcados para poder guardar", { enfocar: false });
  if (Object.keys(pendientes).length) estadoCorreccion("Complete los datos marcados para poder guardar: este colegio tiene datos que no cumplen las reglas del registro.", "info");
  if (u.baja) estadoCorreccion(`Este colegio está dado de baja desde el ${fmtFecha(u.baja.fecha)}. Reactive el colegio antes de corregirlo.`, "info");
  F.form.hidden = false;
  mapaDe(F);
  quitarMarcador(F);
  const { lat, lon } = correccion.base;
  if (F.mapa && lat != null && lon != null) ubicar(F, L.latLng(lat, lon), false, true);
}

function cerrarCorreccion() {
  correccion = null;
  $("#correccion").hidden = $("#bitacora").hidden = true;
}

function mensajeCorreccion(e) {
  if (codigoDe(e) === 409) return "Reactive el colegio antes de corregirlo.";
  if (codigoDe(e) === 404) return "El colegio ya no existe en la base de datos.";
  return mensajeEnvio(e, "corregir colegios");
}

async function guardarCorreccion(ev) {
  ev.preventDefault();
  if (!correccion) return;
  const F = formularios.c, datos = datosCorreccion(), id = correccion.id;
  $("#correccion-ok").hidden = true;
  const errores = validarRegistro(datos, opcionesRegistro);
  mostrarErroresForm(F, errores, estadoCorreccion);
  if (Object.keys(errores).length) return;
  const cambios = cambiosDe(correccion.base, datos);
  if (!Object.keys(cambios).length) return estadoCorreccion("No hay cambios para guardar.", "info");
  let r;
  try {
    r = await enviando(F.form, () => enviar("PATCH", `unidades/${encodeURIComponent(id)}`, cambios));
  } catch (e) {
    if (e.status === 422 && e.errores && Object.keys(e.errores).length) mostrarErroresForm(F, e.errores, estadoCorreccion);
    else estadoCorreccion(mensajeCorreccion(e));
    return;
  }
  if (r.unidad) mostrarCorreccion(r.unidad);
  const n = r.cambios?.length ?? Object.keys(cambios).length;
  const ok = $("#correccion-ok");
  ok.textContent = `Se ${n === 1 ? "guardó 1 cambio" : `guardaron ${n} cambios`} en «${r.unidad?.nombre ?? datos.nombre}». Ya se ven en indicadores, mapa y listado.`;
  ok.hidden = false;
  cargarBitacora(id);
  await recargarTodo();
}

const valorBitacora = (campo, v) => {
  if (v == null || v === "") return "—";
  if (campo === "niveles" || campo === "turnos") return labels(Array.isArray(v) ? v.join(",") : v);
  if (campo === "dependencia" || campo === "subsistema") return label(String(v));
  if (campo === "distrito_municipal") return `D-${v}`;
  return String(v);
};

async function cargarBitacora(id) {
  const estado = $("#bitacora-estado"), lista = $("#bitacora-lista");
  $("#bitacora").hidden = false;
  estado.textContent = "Cargando la bitácora…";
  estado.className = "muted";
  let h;
  try {
    h = await api("bitacora", `unidades/${encodeURIComponent(id)}/historial`);
  } catch (e) {
    if (e?.name === "AbortError") return;
    lista.innerHTML = "";
    estado.className = "error-inline";
    estado.textContent = codigoDe(e) === 403 ? "Su usuario no tiene permiso para ver la bitácora."
      : `No se pudo cargar la bitácora (${e.message}). Vuelva a intentar en unos segundos.`;
    return;
  }
  if (String(correccion?.id) !== String(id)) return;
  estado.textContent = h.length ? "" : "Este colegio todavía no tiene cambios registrados.";
  lista.innerHTML = h.map((x) => `<li>
    <p><strong>${esc(ACCION_BITACORA[x.accion] ?? x.accion)}</strong> · ${esc(x.usuario)} · <time datetime="${esc(x.fecha)}">${esc(fmtFechaHora(x.fecha))}</time></p>
    ${x.motivo ? `<p class="muted">Motivo: ${esc(x.motivo)}</p>` : ""}
    ${Array.isArray(x.cambios) && x.cambios.length ? `<div class="table-wrap"><table class="cambios">
      <thead><tr><th scope="col">Campo</th><th scope="col">Antes</th><th scope="col">Después</th></tr></thead>
      <tbody>${x.cambios.map((c) => `<tr><th scope="row">${esc(NOMBRE_CAMPO[c.campo] ?? c.campo)}</th>
        <td>${esc(valorBitacora(c.campo, c.antes))}</td><td>${esc(valorBitacora(c.campo, c.despues))}</td></tr>`).join("")}</tbody>
    </table></div>` : ""}</li>`).join("");
}

function bindCorrecciones() {
  const F = formularios.c;
  buscadorColegios($("#c-buscar"), (u) => abrirColegio(u.id));
  F.form.addEventListener("submit", guardarCorreccion);
  bindFormColegio(F);
  F.form.addEventListener("input", () => { $("#correccion-ok").hidden = true; });
  $("#c-limpiar").addEventListener("click", () => {
    if (!correccion) return;
    llenarForm(F, correccion.base);
    mostrarErroresForm(F, {}, estadoCorreccion);
    const { lat, lon } = correccion.base;
    if (lat != null && lon != null && typeof L !== "undefined") ubicar(F, L.latLng(lat, lon), false, true);
  });
}

// ---------------------------------------------------------------- personal (HU-10)
const CAMPOS_PERSONA = ["nombre", "cargo", "telefono", "correo"];
let personas = [], personaEditando = null, personaOrigen = null;
const estadoPersona = (texto, tipo) => estadoEn("p-form-estado", texto, tipo);

/** Mismas reglas y mensajes que /api/personal; `parcial` para PATCH (sólo los campos enviados). */
function validarPersona(b, parcial = false) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { general: "Datos no válidos" };
  const e = {};
  const largo = (v) => [...v].length;
  for (const [campo, max, faltante] of [["nombre", 150, "Escriba el nombre"], ["cargo", 100, "Escriba el cargo"], ["telefono", 50], ["correo", 150]]) {
    if (parcial && !(campo in b)) continue;
    const v = b[campo];
    if (v == null || (typeof v === "string" && !v.trim())) { if (faltante) e[campo] = faltante; continue; }
    if (typeof v !== "string") e[campo] = "Debe ser un texto";
    else if (largo(v.trim()) > max) e[campo] = `No puede pasar de ${max} caracteres`;
    else if (campo === "correo" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) e[campo] = "Correo no válido";
  }
  if (parcial && "activo" in b && typeof b.activo !== "boolean") e.activo = "Valor no válido";
  return e;
}

async function cargarPersonal() {
  const estado = $("#personal-estado");
  document.querySelectorAll("#personal-cuerpo [data-ver]").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.ver === "todos") === state.pTodos)));
  estado.textContent = "Cargando el personal…";
  estado.className = "muted";
  try {
    personas = await api("personal", "personal", state.pTodos ? new URLSearchParams({ incluir_inactivos: 1 }) : undefined);
  } catch (e) {
    if (e?.name === "AbortError") return;
    $("#tabla-personal").hidden = true;
    estado.className = "error-inline";
    estado.textContent = `No se pudo cargar el personal (${e.message}). Vuelva a intentar en unos segundos.`;
    return;
  }
  estado.textContent = personas.length ? `${personas.length} ${personas.length === 1 ? "persona" : "personas"}`
    : state.pTodos ? "Todavía no hay personal registrado. Use «Agregar persona»." : "No hay personal activo. Use «Agregar persona» o vea todos.";
  $("#tabla-personal").hidden = !personas.length;
  $("#tabla-personal tbody").innerHTML = personas.map((p) => `
    <tr data-id="${esc(p.id)}"${p.activo ? "" : ` class="inactivo"`}>
      <td>${esc(p.nombre)}</td><td>${esc(p.cargo)}</td><td>${esc(p.telefono)}</td><td>${esc(p.correo)}</td>
      <td><span class="estado-persona">${p.activo ? "Activo" : "Inactivo"}</span></td>
      <td class="acciones-fila"><button type="button" data-editar aria-label="Editar a ${esc(p.nombre)}">Editar</button>
        <button type="button" data-activo="${p.activo ? "0" : "1"}" aria-label="${p.activo ? "Inactivar" : "Activar"} a ${esc(p.nombre)}">${p.activo ? "Inactivar" : "Activar"}</button></td>
    </tr>`).join("");
}

function abrirFormPersona(p = null, origen = null) {
  const form = $("#form-personal"), card = $("#p-form-card");
  personaEditando = p;
  personaOrigen = origen;
  card.hidden = false;
  $("#p-form-titulo").textContent = p ? `Editar a ${p.nombre}` : "Agregar persona";
  form.reset();
  for (const c of CAMPOS_PERSONA) form[c].value = p?.[c] ?? "";
  mostrarErrores("p", CAMPOS_PERSONA, {}, estadoPersona, "");
  card.scrollIntoView({ block: "nearest" });
  form.nombre.focus();
}

function cerrarFormPersona() {
  $("#p-form-card").hidden = true;
  personaEditando = null;
  (personaOrigen?.isConnected ? personaOrigen : $("#p-nuevo")).focus();
}

const datosPersona = () => {
  const f = $("#form-personal");
  return { nombre: f.nombre.value.trim(), cargo: f.cargo.value.trim(), telefono: f.telefono.value.trim() || null, correo: f.correo.value.trim() || null };
};

async function guardarPersona(ev) {
  ev.preventDefault();
  const form = $("#form-personal"), datos = datosPersona(), p = personaEditando;
  const cuerpo = p ? Object.fromEntries(CAMPOS_PERSONA.filter((c) => (p[c] ?? null) !== datos[c]).map((c) => [c, datos[c]])) : datos;
  const errores = validarPersona(cuerpo, !!p);
  mostrarErrores("p", CAMPOS_PERSONA, errores, estadoPersona, "Revise los datos del personal");
  if (Object.keys(errores).length) return;
  if (p && !Object.keys(cuerpo).length) return estadoPersona("No hay cambios para guardar.", "info");
  let r;
  try {
    r = await enviando(form, () => (p ? enviar("PATCH", `personal/${encodeURIComponent(p.id)}`, cuerpo) : post("personal", cuerpo)));
  } catch (e) {
    if (e.status === 422 && e.errores && Object.keys(e.errores).length)
      mostrarErrores("p", CAMPOS_PERSONA, e.errores, estadoPersona, "Revise los datos del personal");
    else estadoPersona(codigoDe(e) === 404 ? "Esa persona ya no existe. Recargue la lista." : mensajeEnvio(e, "guardar el personal"));
    return;
  }
  avisar(p ? `Se guardaron los datos de ${r.persona?.nombre ?? datos.nombre}.` : `${r.persona?.nombre ?? datos.nombre} quedó en la lista del personal.`);
  cerrarFormPersona();
  await cargarPersonal();
}

async function cambiarActivo(btn) {
  const p = personas.find((x) => String(x.id) === btn.closest("tr").dataset.id);
  if (!p) return;
  const activo = btn.dataset.activo === "1";
  btn.disabled = true;
  const estado = $("#personal-estado");
  try {
    await enviar("PATCH", `personal/${encodeURIComponent(p.id)}`, { activo });
  } catch (e) {
    btn.disabled = false;
    estado.className = "error-inline";
    estado.textContent = codigoDe(e) === 404 ? "Esa persona ya no existe. Recargue la lista." : mensajeEnvio(e, "cambiar el personal");
    return;
  }
  avisar(activo ? `${p.nombre} vuelve a estar activo y se puede elegir en las actividades.`
    : `${p.nombre} quedó inactivo: ya no aparece para nuevas actividades.`);
  await cargarPersonal();
  // el foco sigue en la fila (si se ve), si no en el filtro
  const fila = $(`#tabla-personal tr[data-id="${CSS.escape(String(p.id))}"] [data-activo]`);
  (fila || $("#personal-cuerpo [aria-pressed=true]")).focus();
}

function bindPersonal() {
  $("#p-nuevo").addEventListener("click", (e) => abrirFormPersona(null, e.currentTarget));
  $("#p-cancelar").addEventListener("click", cerrarFormPersona);
  $("#form-personal").addEventListener("submit", guardarPersona);
  $("#form-personal").addEventListener("input", (e) => CAMPOS_PERSONA.includes(e.target.name) && errorEn("p", e.target.name));
  $("#personal-cuerpo").addEventListener("click", (e) => {
    const ver = e.target.closest("[data-ver]");
    if (ver) { state.pTodos = ver.dataset.ver === "todos"; writeUrl(); cargarPersonal(); return; }
    const editar = e.target.closest("[data-editar]");
    if (editar) return abrirFormPersona(personas.find((x) => String(x.id) === editar.closest("tr").dataset.id), editar);
    const activo = e.target.closest("[data-activo]");
    if (activo) cambiarActivo(activo);
  });
}

// ---------------------------------------------------------------- agenda (HU-09)
const actividades = new Map(); // id → actividad (de la agenda y de las fichas), para el detalle
let agendaLista = [], actividadEditando = null, actividadOrigen = null, colegioActividad = null, buscadorActividad, buscadorFiltro;
const CAMPOS_ACTIVIDAD = ["ue_id", "tipo", "actividad", "fecha", "hora", "lugar", "encargados", "personal", "asistentes_proyectados", "observaciones"];
const estadoActividad = (texto, tipo) => estadoEn("ag-form-estado", texto, tipo);
const DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

/** Mismas reglas y mensajes que /api/actividades. `parcial` para PATCH; `colegioValido(id)` y
 *  `personaValida(lista, id)` los decide quien valida (el navegador no sabe qué colegios están de baja). */
function validarActividad(b, { parcial = false, colegioValido = () => true, personaValida = () => true } = {}) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { general: "Datos no válidos" };
  const e = {};
  const tiene = (c) => !parcial || c in b;
  const largo = (v) => [...v].length;
  const entero = (v) => typeof v === "number" && Number.isInteger(v);
  if (tiene("ue_id")) {
    if (!entero(b.ue_id)) e.ue_id = "Elija el colegio";
    else if (!colegioValido(b.ue_id)) e.ue_id = "El colegio no existe o está dado de baja";
  }
  if (tiene("tipo") && !TIPOS_ACTIVIDAD.includes(tipoActividad(b.tipo)))
    e.tipo = "Elija el tipo: taller, visita, reunión u otra";
  for (const [c, faltante] of [["actividad", "Describa la actividad"], ["lugar", "Escriba el lugar"]]) {
    if (!tiene(c)) continue;
    if (b[c] != null && typeof b[c] !== "string") e[c] = "Debe ser un texto";
    else if (typeof b[c] !== "string" || !b[c].trim()) e[c] = faltante;
    else if (largo(b[c].trim()) > 200) e[c] = "No puede pasar de 200 caracteres";
  }
  if (tiene("fecha") && !fechaValida(b.fecha)) e.fecha = "Elija una fecha válida";
  if (tiene("hora") && !(typeof b.hora === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora.trim()))) e.hora = "Elija una hora válida";
  for (const [c, obligatorio] of [["encargados", true], ["personal", false]]) {
    if (!tiene(c) || (!obligatorio && b[c] == null)) continue;
    if (!Array.isArray(b[c]) || (obligatorio && !b[c].length)) e[c] = obligatorio ? "Elija al menos un encargado" : "Hay personas que no existen o están inactivas";
    else if (!b[c].every((id) => entero(id) && personaValida(c, id))) e[c] = "Hay personas que no existen o están inactivas";
  }
  const n = b.asistentes_proyectados;
  if (n != null && !(entero(n) && n >= 0 && n <= 1_000_000)) e.asistentes_proyectados = "Debe ser un número entero de 0 o más";
  if (b.observaciones != null) {
    if (typeof b.observaciones !== "string") e.observaciones = "Debe ser un texto";
    else if (largo(b.observaciones.trim()) > 2000) e.observaciones = "No puede pasar de 2000 caracteres";
  }
  if ("estado" in b && (parcial || b.estado != null) && !(typeof b.estado === "string" && ESTADOS_ACTIVIDAD.includes(b.estado.trim().toUpperCase())))
    e.estado = "Estado no válido";
  return e;
}

/** Tipo normalizado como la API ("reunión" vale como REUNION). */
const tipoActividad = (t) => (typeof t === "string" ? t.trim().toUpperCase().replace("REUNIÓN", "REUNION") : null);

/** Mes que muestra la agenda: [año, mes 1-12]. */
const mesAgenda = () => (state.agMes || mesDeHoy()).split("-").map(Number);
const etiquetaEstado = (e) => `<span class="estado-act estado-${esc(String(e).toLowerCase())}">${esc(label(e))}</span>`;
const nombresPersonas = (lista) => (lista || []).map((p) => `${p.nombre ?? `#${p.id}`}${p.activo === false ? " (inactivo)" : ""}`).join(", ");

function recordarActividades(lista) {
  lista.forEach((a) => actividades.set(String(a.id), a));
}

async function cargarAgenda() {
  const [y, m] = mesAgenda();
  const primero = new Date(y, m - 1, 1), ultimo = new Date(y, m, 0);
  // la cuadrícula empieza en lunes y termina en domingo: se piden también esos días de los meses vecinos
  const inicio = new Date(y, m - 1, 1 - ((primero.getDay() + 6) % 7));
  const fin = new Date(y, m - 1, ultimo.getDate() + (6 - ((ultimo.getDay() + 6) % 7)));
  $("#ag-mes").textContent = tipoOracion(primero.toLocaleDateString("es-BO", { month: "long", year: "numeric" }));
  document.querySelectorAll("#agenda-cuerpo [data-modo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.modo === state.agModo)));
  $("#ag-estado").value = state.agEstado;
  $("#ag-colegio-quitar").hidden = !state.agColegio;
  if (state.agColegio && !$("#ag-colegio").value) nombreDeFiltro(state.agColegio);
  if (!state.agColegio && document.activeElement !== $("#ag-colegio")) $("#ag-colegio").value = "";
  const p = new URLSearchParams({ desde: isoDia(inicio), hasta: isoDia(fin) });
  if (state.agColegio) p.set("ue_id", state.agColegio);
  if (state.agEstado) p.set("estado", state.agEstado);
  const carga = $("#ag-carga");
  carga.textContent = "Cargando actividades…";
  carga.className = "muted";
  $("#agenda-cuerpo").setAttribute("aria-busy", "true");
  try {
    agendaLista = await api("agenda", "actividades", p);
  } catch (e) {
    if (e?.name === "AbortError") return;
    carga.className = "error-inline";
    carga.textContent = `No se pudieron cargar las actividades (${e.message}). Vuelva a intentar en unos segundos.`;
    $("#agenda-cuerpo").removeAttribute("aria-busy");
    return;
  }
  $("#agenda-cuerpo").removeAttribute("aria-busy");
  recordarActividades(agendaLista);
  const delMes = agendaLista.filter((a) => a.fecha >= isoDia(primero) && a.fecha <= isoDia(ultimo));
  const filtros = state.agColegio || state.agEstado;
  carga.textContent = delMes.length ? `${delMes.length} ${delMes.length === 1 ? "actividad" : "actividades"} en el mes${filtros ? " con estos filtros" : ""}.`
    : `No hay actividades en este mes${filtros ? " con estos filtros" : ""}.`;
  renderCalendario(inicio, fin, m - 1);
  renderListaAgenda(delMes);
  $("#ag-calendario").hidden = state.agModo !== "mes";
  $("#ag-lista").hidden = state.agModo !== "lista";
}

const botonActividad = (a, clase = "") => `<button type="button" class="ev estado-${esc(String(a.estado).toLowerCase())} ${clase}" data-act="${esc(a.id)}"
  aria-label="${esc(`${a.hora} ${a.actividad} · ${a.colegio?.nombre ?? ""} · ${label(a.estado)}`)}"><span class="hora">${esc(a.hora)}</span> ${esc(a.actividad)}</button>`;

function renderCalendario(inicio, fin, mes) {
  const hoy = isoDia(new Date());
  const porDia = Map.groupBy ? Map.groupBy(agendaLista, (a) => a.fecha) : agendaLista.reduce((m, a) => m.set(a.fecha, [...(m.get(a.fecha) || []), a]), new Map());
  const semanas = [];
  for (let d = new Date(inicio); d <= fin; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) {
    const celdas = [];
    for (let i = 0; i < 7; i++) {
      const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i), iso = isoDia(dia);
      const evs = porDia.get(iso) || [];
      const clases = [dia.getMonth() !== mes ? "otro-mes" : "", iso === hoy ? "hoy" : ""].filter(Boolean).join(" ");
      celdas.push(`<td data-fecha="${iso}"${clases ? ` class="${clases}"` : ""}${iso === hoy ? ` aria-current="date"` : ""}>
        <button type="button" class="dia" data-nueva="${iso}" aria-label="${esc(fechaLarga(iso))}: nueva actividad">${dia.getDate()}</button>
        ${evs.map((a) => botonActividad(a)).join("")}</td>`);
    }
    semanas.push(`<tr>${celdas.join("")}</tr>`);
  }
  $("#ag-calendario").innerHTML = `<table class="mes"><thead><tr>${DIAS.map((n) => `<th scope="col" abbr="${n}">${n.slice(0, 3)}</th>`).join("")}</tr></thead>
    <tbody>${semanas.join("")}</tbody></table>`;
}

function renderListaAgenda(lista) {
  const fechas = [...new Set(lista.map((a) => a.fecha))];
  $("#ag-lista").innerHTML = fechas.length ? fechas.map((f) => `<section class="dia-lista" data-fecha="${esc(f)}">
      <h3>${esc(fechaLarga(f))}</h3>
      <ul>${lista.filter((a) => a.fecha === f).map((a) => `<li>
        <button type="button" class="enlace" data-act="${esc(a.id)}">${esc(a.hora)} · ${esc(label(a.tipo))} · ${esc(a.actividad)}</button>
        ${etiquetaEstado(a.estado)}
        <p class="muted">${esc(a.colegio?.nombre)} · ${esc(a.lugar)}${a.encargados?.length ? ` · Encargados: ${esc(nombresPersonas(a.encargados))}` : ""}</p>
      </li>`).join("")}</ul></section>`).join("")
    : `<p class="vacio">No hay actividades en este mes.</p>`;
}

/** Nombre del colegio del filtro cuando llega sólo su id (URL compartida). */
async function nombreDeFiltro(id) {
  try {
    const u = await api("ag-colegio-nombre", `unidades/${encodeURIComponent(id)}`);
    if (state.agColegio === String(id)) $("#ag-colegio").value = u.nombre ?? "";
  } catch { /* el filtro sigue aplicado aunque no se sepa el nombre */ }
}

function moverMes(delta) {
  if (delta === 0) state.agMes = "";
  else {
    const [y, m] = mesAgenda();
    const d = new Date(y, m - 1 + delta, 1);
    state.agMes = `${d.getFullYear()}-${dos(d.getMonth() + 1)}`;
  }
  writeUrl();
  cargarAgenda();
}

function verActividad(id) {
  const a = actividades.get(String(id));
  if (!a) return;
  const filas = [
    ["Colegio", esc(a.colegio?.nombre ?? `#${a.ue_id}`)], ["Tipo", esc(label(a.tipo))],
    ["Fecha", esc(fechaLarga(a.fecha))], ["Hora", esc(a.hora)], ["Lugar", esc(a.lugar)],
    ["Encargados", personasHtml(a.encargados)], ["Personal que acudirá", personasHtml(a.personal)],
    ["Asistentes proyectados", a.asistentes_proyectados == null ? "—" : esc(fmt(a.asistentes_proyectados))],
    ["Observaciones", a.observaciones ? `<span class="pre">${esc(a.observaciones)}</span>` : "—"],
    ["Estado", etiquetaEstado(a.estado)],
  ];
  const autor = [a.creado_por ? `Creada por ${a.creado_por}${a.creado ? ` el ${fmtFechaHora(a.creado)}` : ""}` : "",
    a.actualizado_por && a.actualizado !== a.creado ? `actualizada por ${a.actualizado_por} el ${fmtFechaHora(a.actualizado)}` : ""].filter(Boolean).join("; ");
  $("#actividad-body").innerHTML = `<h2 id="actividad-titulo">${esc(a.actividad)}</h2>
    <dl>${filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${autor ? `<p class="muted">${esc(autor)}.</p>` : ""}
    <form id="act-estado-form" class="cambio-estado" data-id="${esc(a.id)}" novalidate>
      <label for="act-estado">Cambiar el estado</label>
      <div class="con-boton"><select id="act-estado" aria-describedby="act-estado-error">${ESTADOS_ACTIVIDAD.map((e) =>
        `<option value="${e}"${e === a.estado ? " selected" : ""}>${label(e)}</option>`).join("")}</select>
      <button type="submit" class="primario">Guardar estado</button></div>
      <p id="act-estado-error" class="error-inline" role="alert" hidden></p>
    </form>
    <div class="acciones"><button type="button" data-editar-act="${esc(a.id)}">Editar actividad</button></div>`;
  const dlg = $("#actividad");
  if (!dlg.open) dlg.showModal();
}

const personasHtml = (lista) => (lista?.length ? `<ul class="personas">${lista.map((p) => `<li>${esc(p.nombre ?? `#${p.id}`)}${p.cargo ? ` <span class="muted">· ${esc(p.cargo)}</span>` : ""}${p.activo === false ? ` <span class="marca-inactivo">(inactivo)</span>` : ""}</li>`).join("")}</ul>` : "—");

/** Tras crear o cambiar una actividad: agenda y, si está abierta, la ficha del colegio. */
function actividadGuardada(a) {
  actividades.set(String(a.id), a);
  if (state.vista === "agenda") cargarAgenda();
  if ($("#detalle").open && String(detalleActual?.id) === String(a.ue_id)) actividadesDeFicha(a.ue_id);
}

async function cambiarEstadoActividad(form) {
  const id = form.dataset.id, a = actividades.get(id), estado = form.querySelector("select").value;
  const error = $("#act-estado-error");
  error.hidden = true;
  if (a?.estado === estado) { error.textContent = "No hay cambios para guardar."; error.hidden = false; return; }
  let r;
  try {
    r = await enviando(form, () => enviar("PATCH", `actividades/${encodeURIComponent(id)}`, { estado }));
  } catch (e) {
    error.textContent = e.status === 422 ? (Object.values(e.errores || {})[0] ?? e.message)
      : codigoDe(e) === 404 ? "La actividad ya no existe." : mensajeEnvio(e, "cambiar el estado");
    error.hidden = false;
    return;
  }
  actividadGuardada(r.actividad);
  verActividad(r.actividad.id);
  avisar(`«${r.actividad.actividad}» quedó como ${label(r.actividad.estado).toLowerCase()}.`);
  $("#act-estado").focus();
}

const chipPersona = (name, p, marcado) => `<label><input type="checkbox" name="${name}" value="${esc(p.id)}" aria-describedby="a-${name}-error"${marcado ? " checked" : ""}>${esc(p.nombre)}${p.cargo ? ` <span class="muted">· ${esc(p.cargo)}</span>` : ""}${p.activo === false ? ` <span class="marca-inactivo">(inactivo)</span>` : ""}</label>`;

/** Encargados y personal se eligen SOLO del personal activo; los ya asignados que se inactivaron se muestran marcados. */
function renderPersonasActividad(activos, a) {
  for (const name of ["encargados", "personal"]) {
    const asignados = a?.[name] ?? [];
    const ids = new Set(asignados.map((p) => p.id));
    const lista = [...activos, ...asignados.filter((p) => p.activo === false && !activos.some((x) => x.id === p.id))];
    $(`#a-${name} .chips`).innerHTML = lista.map((p) => chipPersona(name, p, ids.has(p.id))).join("");
  }
}

async function abrirFormActividad(a = null, fecha = null, origen = null) {
  const card = $("#ag-form-card"), form = $("#form-actividad");
  actividadEditando = a;
  actividadOrigen = origen;
  for (const d of ["#actividad", "#detalle"]) if ($(d).open) $(d).close(); // el formulario está en la Agenda, detrás de los diálogos
  if (state.vista !== "agenda") irA("agenda");
  card.hidden = false;
  form.reset();
  $("#ag-form-titulo").textContent = a ? `Editar «${a.actividad}»` : "Nueva actividad";
  mostrarErrores("a", CAMPOS_ACTIVIDAD, {}, estadoActividad, "");
  buscadorActividad.limpiar();
  colegioActividad = a ? { id: a.ue_id, nombre: a.colegio?.nombre ?? "" } : null;
  $("#a-ue_id").value = colegioActividad?.nombre ?? "";
  if (a) {
    for (const c of ["tipo", "actividad", "fecha", "hora", "lugar"]) form[c].value = a[c] ?? "";
    form.asistentes_proyectados.value = a.asistentes_proyectados ?? "";
    form.observaciones.value = a.observaciones ?? "";
  } else {
    const [y, m] = mesAgenda(), hoy = isoDia(new Date());
    form.fecha.value = fecha || (hoy.startsWith(`${y}-${dos(m)}`) ? hoy : `${y}-${dos(m)}-01`);
  }
  $("#ag-form-titulo").focus();
  card.scrollIntoView({ block: "start" });
  const aviso = $("#a-personal-aviso");
  aviso.className = "info";
  aviso.textContent = "Cargando el personal activo…";
  aviso.hidden = false;
  $("#a-encargados .chips").innerHTML = $("#a-personal .chips").innerHTML = "";
  let activos;
  try {
    activos = await api("ag-personal", "personal");
  } catch (e) {
    if (e?.name === "AbortError") return;
    aviso.className = "error-inline";
    aviso.textContent = `No se pudo cargar el personal (${e.message}). Cierre y vuelva a abrir el formulario.`;
    return;
  }
  renderPersonasActividad(activos, a);
  aviso.hidden = activos.length > 0;
  aviso.innerHTML = `Todavía no hay personal activo para elegir encargados. Regístrelo en <a href="${esc(urlDe("personal"))}" data-ir="personal">Personal</a>.`;
}

function cerrarFormActividad() {
  $("#ag-form-card").hidden = true;
  inflight["ag-personal"]?.abort();
  actividadEditando = null;
  (actividadOrigen?.isConnected ? actividadOrigen : $("#ag-nueva")).focus();
}

function datosActividad() {
  const f = $("#form-actividad");
  const ids = (name) => [...f.querySelectorAll(`input[name=${name}]:checked`)].map((i) => Number(i.value));
  const n = f.asistentes_proyectados.value.trim();
  return {
    ue_id: colegioActividad?.id ?? null, tipo: f.tipo.value, actividad: f.actividad.value.trim(), fecha: f.fecha.value, hora: f.hora.value,
    lugar: f.lugar.value.trim(), encargados: ids("encargados"), personal: ids("personal"),
    asistentes_proyectados: n === "" ? (f.asistentes_proyectados.validity.badInput ? NaN : null) : Number(n),
    observaciones: f.observaciones.value.trim() || null,
  };
}

async function guardarActividad(ev) {
  ev.preventDefault();
  const form = $("#form-actividad"), a = actividadEditando, datos = datosActividad();
  // al editar, los que ya estaban asignados (aunque estén inactivos) pueden quedarse
  const activos = new Set([...form.querySelectorAll("fieldset input")].filter((i) => !i.closest("label").querySelector(".marca-inactivo")).map((i) => Number(i.value)));
  const previos = new Set([...(a?.encargados ?? []), ...(a?.personal ?? [])].map((p) => p.id)); // como encargado o como personal
  const errores = validarActividad(datos, { personaValida: (_, id) => activos.has(id) || previos.has(id) });
  mostrarErrores("a", CAMPOS_ACTIVIDAD, errores, estadoActividad, "Revise los datos de la actividad");
  if (Object.keys(errores).length) return;
  let cuerpo = datos;
  if (a) {
    const antes = { ue_id: a.ue_id, tipo: a.tipo, actividad: a.actividad, fecha: a.fecha, hora: a.hora, lugar: a.lugar,
      encargados: a.encargados.map((p) => p.id), personal: a.personal.map((p) => p.id),
      asistentes_proyectados: a.asistentes_proyectados ?? null, observaciones: a.observaciones ?? null };
    const igual = (x, y) => (Array.isArray(x) ? [...x].sort().join() === [...y].sort().join() : x === y);
    cuerpo = Object.fromEntries(Object.entries(datos).filter(([c, v]) => !igual(antes[c], v)));
    if (!Object.keys(cuerpo).length) return estadoActividad("No hay cambios para guardar.", "info");
  }
  let r;
  try {
    r = await enviando(form, () => (a ? enviar("PATCH", `actividades/${encodeURIComponent(a.id)}`, cuerpo) : post("actividades", cuerpo)));
  } catch (e) {
    if (e.status === 422 && e.errores && Object.keys(e.errores).length)
      mostrarErrores("a", CAMPOS_ACTIVIDAD, e.errores, estadoActividad, "Revise los datos de la actividad");
    else estadoActividad(codigoDe(e) === 404 ? "La actividad ya no existe." : mensajeEnvio(e, "guardar la actividad"));
    return;
  }
  const act = r.actividad;
  $("#ag-form-card").hidden = true;
  actividadEditando = null;
  avisar(`«${act.actividad}» quedó en la agenda el ${fechaLarga(act.fecha).toLowerCase()} a las ${act.hora}.`);
  // la agenda pasa al mes de la actividad para que se vea
  if (act.fecha.slice(0, 7) !== `${mesAgenda()[0]}-${dos(mesAgenda()[1])}`) { state.agMes = act.fecha.slice(0, 7); writeUrl(); }
  actividades.set(String(act.id), act);
  await cargarAgenda();
  if ($("#detalle").open && String(detalleActual?.id) === String(act.ue_id)) actividadesDeFicha(act.ue_id);
  ($(`${state.agModo === "mes" ? "#ag-calendario" : "#ag-lista"} [data-act="${CSS.escape(String(act.id))}"]`) || $("#ag-nueva")).focus();
}

/** Actividades del colegio en su ficha (GET /actividades?ue_id=). */
async function actividadesDeFicha(id) {
  const box = $("#detalle-actividades");
  if (!box) return;
  const estado = box.querySelector("p");
  estado.textContent = "Cargando actividades…";
  estado.className = "muted";
  let lista;
  try {
    lista = await api("ficha-actividades", "actividades", new URLSearchParams({ ue_id: id }));
  } catch (e) {
    if (e?.name === "AbortError") return;
    estado.className = "error-inline";
    estado.textContent = "No se pudieron cargar las actividades del colegio.";
    return;
  }
  if (String(detalleActual?.id) !== String(id)) return;
  recordarActividades(lista);
  estado.textContent = lista.length ? "" : "Este colegio no tiene actividades en la agenda.";
  box.querySelector("ul").innerHTML = lista.map((a) => `<li><button type="button" class="enlace" data-act="${esc(a.id)}">${esc(fmtFecha(a.fecha))} ${esc(a.hora)} · ${esc(label(a.tipo))} · ${esc(a.actividad)}</button> ${etiquetaEstado(a.estado)}</li>`).join("");
}

function bindAgenda() {
  $("#ag-estado").innerHTML = `<option value="">Todos</option>` + ESTADOS_ACTIVIDAD.map((e) => `<option value="${e}">${label(e)}</option>`).join("");
  $("#a-tipo").innerHTML = opcionesSelect(TIPOS_ACTIVIDAD);
  $("#ag-anterior").addEventListener("click", () => moverMes(-1));
  $("#ag-siguiente").addEventListener("click", () => moverMes(1));
  $("#ag-hoy").addEventListener("click", () => moverMes(0));
  $("#ag-estado").addEventListener("change", (e) => { state.agEstado = e.target.value; writeUrl(); cargarAgenda(); });
  buscadorFiltro = buscadorColegios($("#ag-colegio"), (u) => { state.agColegio = String(u.id); writeUrl(); cargarAgenda(); });
  const quitarFiltro = () => { buscadorFiltro.limpiar(); state.agColegio = ""; writeUrl(); cargarAgenda(); };
  $("#ag-colegio-quitar").addEventListener("click", () => { quitarFiltro(); $("#ag-colegio").focus(); });
  $("#ag-colegio").addEventListener("input", (e) => { if (!e.target.value.trim() && state.agColegio) quitarFiltro(); });
  buscadorActividad = buscadorColegios($("#a-ue_id"), (u) => { colegioActividad = { id: u.id, nombre: u.nombre }; errorEn("a", "ue_id"); });
  $("#a-ue_id").addEventListener("input", () => { colegioActividad = null; });
  $("#ag-nueva").addEventListener("click", (e) => abrirFormActividad(null, null, e.currentTarget));
  $("#a-cancelar").addEventListener("click", cerrarFormActividad);
  const form = $("#form-actividad");
  form.addEventListener("submit", guardarActividad);
  form.addEventListener("input", (e) => CAMPOS_ACTIVIDAD.includes(e.target.name) && errorEn("a", e.target.name));
  form.addEventListener("change", (e) => e.target.type === "checkbox" && errorEn("a", e.target.name));
  $("#vista-agenda").addEventListener("click", (e) => {
    const modo = e.target.closest("[data-modo]");
    if (modo) { state.agModo = modo.dataset.modo; writeUrl(); cargarAgenda(); return; }
    const act = e.target.closest("[data-act]");
    if (act) { actividadOrigen = act; return verActividad(act.dataset.act); }
    const nueva = e.target.closest("[data-nueva]");
    if (nueva) return abrirFormActividad(null, nueva.dataset.nueva, nueva);
    const ir = e.target.closest("[data-ir]");
    if (ir && !e.ctrlKey && !e.metaKey) { e.preventDefault(); irA(ir.dataset.ir); }
  });
  const dlg = $("#actividad");
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return dlg.close();
    const editar = e.target.closest("[data-editar-act]");
    if (editar) abrirFormActividad(actividades.get(editar.dataset.editarAct), null, actividadOrigen);
  });
  dlg.addEventListener("submit", (e) => {
    if (e.target.id !== "act-estado-form") return;
    e.preventDefault();
    cambiarEstadoActividad(e.target);
  });
  dlg.addEventListener("close", () => { if (actividadOrigen?.isConnected && $("#ag-form-card").hidden) actividadOrigen.focus(); });
}

// ---------------------------------------------------------------- sesión (no aplica al modo estático)
const irAlLogin = () => location.replace("login.html");
let esEncargado = false;

async function initSesion() {
  if (CONFIG.staticApi) {
    // sin servidor no hay login; si la página tiene dónde guardar (claude.ai), todos actúan como encargados
    puedeRegistrar = !!CONFIG.staticEstado && (await CONFIG.staticEstado.disponible());
    actualizarRegistro();
    actualizarSecciones();
    if (!puedeRegistrar) return;
    esEncargado = true;
    $("#bajas").hidden = false;
    loadBajas();
    // la primera carga pudo hacerse antes de conocer bajas y registros: se vuelve a dibujar sin perder página ni filtros
    if (CONFIG.staticApi("bajas").length || CONFIG.staticApi.cantidadRegistros() || CONFIG.staticApi.cantidadCorrecciones()) {
      await loadCatalogos().catch(showError);
      syncInputs();
      await Promise.all([loadStats(), loadMap(), loadTable()]).catch(showError);
    }
    // cambios de otros visitantes: se recargan indicadores, mapa, listado y la sección de bajas
    window.addEventListener("colegios:bajas", () => { refresh(); loadBajas(); });
    window.addEventListener("colegios:registros", recargarTodo);
    window.addEventListener("colegios:correcciones", recargarTodo);
    window.addEventListener("colegios:personal", () => state.vista === "personal" && $("#p-form-card").hidden && cargarPersonal());
    window.addEventListener("colegios:actividades", () => state.vista === "agenda" && cargarAgenda());
    return;
  }
  setBusy(+1); // la sección de bajas depende del rol: la página no está lista hasta saberlo
  const s = await fetch(`${CONFIG.apiBase}/auth/sesion`).then((r) => r.json()).catch(() => null);
  setBusy(-1);
  esEncargado = s?.rol === "encargado";
  if (esEncargado) {
    $("#bajas").hidden = false;
    loadBajas();
  }
  if (!s?.usuario) return; // login desactivado (o sesión vencida: la primera llamada a la API redirige)
  $("#sesion-nombre").textContent = s.nombre || s.usuario;
  $(".sesion").hidden = false;
  $("#salir").addEventListener("click", async () => {
    await fetch(`${CONFIG.apiBase}/auth/logout`, { method: "POST" }).catch(() => {});
    irAlLogin();
  });
}

// ---------------------------------------------------------------- orquestación
/** Filtros cambiaron: todo se recarga desde la página 1. */
function refresh() {
  state.page = 1;
  writeUrl();
  clearError();
  return Promise.all([loadStats(), loadMap(), loadTable()]).catch(showError);
}

/** Sólo cambió la página u orden: no hace falta recargar KPIs ni mapa. */
function refreshTable() {
  writeUrl();
  loadTable().catch(showError);
}

function bindEvents() {
  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value; refresh(); }, 300);
  });
  $(".filters").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return; // el buscador ya se maneja con "input"
    state[e.target.name] = [...document.querySelectorAll(`#f-${e.target.name} input:checked`)].map((i) => i.value);
    refresh();
  });
  $("#limpiar").addEventListener("click", () => {
    clearTimeout(timer);
    state.q = "";
    for (const f of FILTROS) state[f] = [];
    syncInputs();
    refresh();
  });
  $("#prev").addEventListener("click", () => { state.page--; refreshTable(); });
  $("#next").addEventListener("click", () => { state.page++; refreshTable(); });
  document.querySelectorAll("th[data-orden] button").forEach((btn) => btn.addEventListener("click", () => {
    const o = btn.closest("th").dataset.orden;
    state.orden = state.orden === o ? `-${o}` : o;
    state.page = 1;
    refreshTable();
  }));
  const tbody = $("#tabla tbody");
  tbody.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) showDetail(tr.dataset.id); });
  tbody.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showDetail(tr.dataset.id); }
  });
  const dlg = $("#detalle");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // clic en el fondo
  window.addEventListener("popstate", () => {
    const antes = urlDe(VISTA_DEFAULT);
    readUrl();
    mostrarVista(); // también recarga la sección (mes de la agenda, colegio abierto…)
    if (urlDe(VISTA_DEFAULT) !== antes) { syncInputs(); refresh(); } // sólo cambió la sección: no se recarga nada
  });
  $("#detalle-body").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) { actividadOrigen = act; verActividad(act.dataset.act); }
  });
  bindBajas();
  bindNav();
  bindRegistro();
  bindCorrecciones();
  bindPersonal();
  bindAgenda();
}

async function init() {
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  readUrl();
  prepararFormularios();
  bindEvents();
  renderFiltrosActivos();
  actualizarNav();
  actualizarSecciones({ cargar: false });
  mostrarVista();
  actualizarRegistro();
  // En pantallas chicas los filtros empiezan plegados, para ver primero los indicadores
  if (matchMedia("(max-width: 900px)").matches) $("#panel-filtros").open = false;
  initSesion();
  try {
    await loadCatalogos();
  } catch (e) {
    showError(e);
    catalogosCargados = true;
    actualizarRegistro();
    if (correccion) mostrarCorreccion(correccion.ficha);
  }
  syncInputs();
  // Primera carga sin refresh(): respeta la página y el orden que traiga la URL compartida.
  await Promise.all([loadStats(), loadMap(), loadTable()]).catch(showError);
}

init();
