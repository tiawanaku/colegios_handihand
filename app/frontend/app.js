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

const COLORS = { FISCAL: "--fiscal", CONVENIO: "--convenio", PRIVADA: "--privada", COMUNITARIA: "--comunitaria" };
const LABEL = {
  FISCAL: "Fiscal (pública)", CONVENIO: "De convenio", PRIVADA: "Privada", COMUNITARIA: "Comunitaria",
  INICIAL: "Inicial", PRIMARIA: "Primaria", SECUNDARIA: "Secundaria", ALTERNATIVA: "Alternativa",
  ESPECIAL: "Especial", TECNICA: "Técnica", MANANA: "Mañana", TARDE: "Tarde", NOCHE: "Noche", "SIN DATO": "Sin dato",
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

// ---------------------------------------------------------------- estado (único, sincronizado con la URL)
const state = { q: "", page: 1, orden: ORDEN_DEFAULT, ...Object.fromEntries(FILTROS.map((f) => [f, []])) };

function readUrl() {
  const u = new URLSearchParams(location.search);
  state.q = u.get("q") || "";
  for (const f of FILTROS) state[f] = u.getAll(f);
  state.page = Math.max(1, parseInt(u.get("page"), 10) || 1);
  state.orden = u.get("orden") || ORDEN_DEFAULT;
}

/** Parámetros de filtro (sin paginación): los comparten estadísticas, mapa, tabla y exportación. */
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

function writeUrl() {
  renderFiltrosActivos();
  const p = filterParams();
  if (state.page > 1) p.set("page", state.page);
  if (state.orden !== ORDEN_DEFAULT) p.set("orden", state.orden);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
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
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
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
  return c;
}

// ---------------------------------------------------------------- KPIs y gráficos
const charts = {};

function chart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart($(`#${id}`), config);
}

async function loadStats() {
  const s = await api("stats", "estadisticas", filterParams());
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
let map, layer, ultimoGeojson, sinMapaBase = false;

/** Lista de mapas base de la configuración (acepta también una URL suelta, como en versiones anteriores). */
function proveedores() {
  const t = CONFIG.tiles;
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((p) => (typeof p === "string" ? { url: p, attribution: CONFIG.tilesAttribution } : p));
}

/** Prueba los mapas base en orden. Un proveedor se descarta si sus primeros tiles fallan sin que cargue ninguno. */
function addBaseLayer(lista) {
  if (!lista.length) {
    sinMapaBase = true;
    $("#map").classList.add("sin-mapa-base");
    if (ultimoGeojson) drawDistritos(ultimoGeojson);
    return;
  }
  const [p, ...resto] = lista;
  // referrerPolicy: OpenStreetMap rechaza (403) los tiles pedidos sin Referer, p. ej. tras un
  // proxy con "Referrer-Policy: no-referrer"; así se envía al menos el origen del sitio.
  const tl = L.tileLayer(p.url, { maxZoom: 19, attribution: p.attribution, referrerPolicy: "strict-origin-when-cross-origin" });
  let cargados = 0, fallos = 0;
  tl.on("tileload", () => cargados++);
  tl.on("tileerror", () => {
    if (++fallos < 4 || cargados > 0 || !map.hasLayer(tl)) return;
    tl.remove();
    console.warn(`Mapa base no disponible: ${p.url}`);
    addBaseLayer(resto);
  });
  tl.addTo(map);
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
  if (bounds) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 15 });
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
    $("#detalle-body").innerHTML = `<h2 id="detalle-titulo">${esc(r.nombre)}</h2>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    const dlg = $("#detalle");
    if (!dlg.open) dlg.showModal();
  } catch (e) {
    showError(e);
  }
}

// ---------------------------------------------------------------- sesión (no aplica al modo estático)
const irAlLogin = () => location.replace("login.html");

async function initSesion() {
  if (CONFIG.staticApi) return;
  const s = await fetch(`${CONFIG.apiBase}/auth/sesion`).then((r) => r.json()).catch(() => null);
  if (!s?.usuario) return; // login desactivado (o sesión vencida: la primera llamada a la API redirige)
  $("#sesion-nombre").textContent = s.nombre || s.usuario;
  $(".sesion").hidden = false;
  $("#salir").addEventListener("click", async () => {
    await fetch(`${CONFIG.apiBase}/auth/logout`, { method: "POST" }).catch(() => {});
    irAlLogin();
  });
}

// ---------------------------------------------------------------- orquestación
function updateExports() {
  const nav = $(".exports"); // exportar necesita el backend; la versión estática no trae estos enlaces
  if (!nav) return;
  nav.hidden = Boolean(CONFIG.staticApi);
  const p = filterParams().toString();
  document.querySelectorAll("[data-export]").forEach((a) => (a.href = `${CONFIG.apiBase}/export.${a.dataset.export}${p ? `?${p}` : ""}`));
}

/** Filtros cambiaron: todo se recarga desde la página 1. */
function refresh() {
  state.page = 1;
  writeUrl();
  updateExports();
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
  window.addEventListener("popstate", () => { readUrl(); syncInputs(); refresh(); });
}

async function init() {
  Chart.defaults.color = cssVar("--muted");
  Chart.defaults.borderColor = cssVar("--line");
  readUrl();
  renderFiltrosActivos();
  // En pantallas chicas los filtros empiezan plegados, para ver primero los indicadores
  if (matchMedia("(max-width: 900px)").matches) $("#panel-filtros").open = false;
  bindEvents();
  initSesion();
  try {
    await loadCatalogos();
  } catch (e) {
    showError(e);
  }
  syncInputs();
  // Primera carga sin refresh(): respeta la página y el orden que traiga la URL compartida.
  updateExports();
  await Promise.all([loadStats(), loadMap(), loadTable()]).catch(showError);
}

init();
