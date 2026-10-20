const COLORS = { FISCAL: "--fiscal", CONVENIO: "--convenio", PRIVADA: "--privada", COMUNITARIA: "--comunitaria" };
const color = (dep) => getComputedStyle(document.documentElement).getPropertyValue(COLORS[dep] || "--sindato").trim();
const LABEL = { FISCAL: "Fiscal (pública)", CONVENIO: "De convenio", PRIVADA: "Privada", COMUNITARIA: "Comunitaria",
  INICIAL: "Inicial", PRIMARIA: "Primaria", SECUNDARIA: "Secundaria", ALTERNATIVA: "Alternativa / adultos",
  ESPECIAL: "Especial", TECNICA: "Técnica", MANANA: "Mañana", TARDE: "Tarde", NOCHE: "Noche" };
const label = (k) => LABEL[k] || k;
const fmt = (n) => (n ?? 0).toLocaleString("es-BO");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { page: 1, pageSize: 25, orden: "nombre" };
const charts = {};
let map, layer;

function params(extra = {}) {
  const p = new URLSearchParams();
  const q = document.getElementById("q").value.trim();
  if (q) p.set("q", q);
  for (const key of ["dependencia", "nivel", "turno"])
    document.querySelectorAll(`#f-${key} input:checked`).forEach((i) => p.append(key, i.value));
  [...document.getElementById("f-distrito").selectedOptions].forEach((o) => p.append("distrito", o.value));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

const api = (path, p) => fetch(`/api/${path}?${p}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

function chips(id, values, name) {
  document.getElementById(id).innerHTML = values
    .map((v) => `<label><input type="checkbox" name="${name}" value="${esc(v)}">${esc(label(v))}</label>`).join("");
}

async function loadCatalogos() {
  const c = await api("catalogos", "");
  chips("f-dependencia", c.dependencias, "dependencia");
  chips("f-nivel", c.niveles, "nivel");
  chips("f-turno", c.turnos, "turno");
  document.getElementById("f-distrito").innerHTML = c.distritos.map((d) => `<option value="${d}">Distrito ${d}</option>`).join("");
  document.getElementById("fuente").textContent = c.fuentes.length ? `Fuente: ${c.fuentes.join(", ")}` : "";
  document.getElementById("legend").innerHTML = c.dependencias
    .map((d) => `<span><i style="background:${color(d)}"></i>${label(d)}</span>`).join("");
}

function chart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

async function loadStats() {
  const s = await api("estadisticas", params());
  const dep = s.por_dependencia;
  document.getElementById("kpis").innerHTML = [
    ["Unidades educativas", s.total_unidades, "--accent"],
    ["Fiscales", dep.FISCAL, "--fiscal"],
    ["De convenio", dep.CONVENIO, "--convenio"],
    ["Privadas", dep.PRIVADA, "--privada"],
    ["Estudiantes", s.estudiantes.total, "--comunitaria"],
    ["Estudiante / docente", s.ratio_estudiante_docente ?? "—", "--sindato"],
  ].map(([t, v, c]) => `<div class="kpi" style="--c:var(${c})"><b>${typeof v === "number" ? fmt(v) : (v ?? 0)}</b><span>${t}</span></div>`).join("");

  const deps = Object.keys(dep);
  chart("ch-dep", { type: "doughnut", data: { labels: deps.map(label), datasets: [{ data: deps.map((d) => dep[d]), backgroundColor: deps.map(color) }] },
    options: { aspectRatio: 1.8, plugins: { legend: { position: "bottom" } } } });

  const distritos = Object.keys(s.por_distrito);
  chart("ch-distrito", { type: "bar",
    data: { labels: distritos.map((d) => (isNaN(d) ? d : `D-${d}`)),
      datasets: deps.map((d) => ({ label: label(d), backgroundColor: color(d), data: distritos.map((k) => s.por_distrito[k][d] || 0) })) },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: "bottom" } } } });

  const niveles = Object.keys(s.por_nivel);
  chart("ch-nivel", { type: "bar", data: { labels: niveles.map(label), datasets: [{ label: "Unidades", data: niveles.map((n) => s.por_nivel[n]), backgroundColor: color() }] },
    options: { aspectRatio: 1.8, indexAxis: "y", plugins: { legend: { display: false } } } });
}

async function loadMap() {
  if (!map) {
    map = L.map("map").setView([-16.505, -68.19], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  }
  const gj = await api("geojson", params());
  layer?.remove();
  layer = L.geoJSON(gj, {
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, weight: 1, color: "#fff", fillOpacity: 0.9, fillColor: color(f.properties.dependencia) }),
    onEachFeature: (f, l) => l.on("click", () => showDetail(f.properties.id)).bindTooltip(f.properties.nombre),
  }).addTo(map);
  if (gj.features.length) map.fitBounds(layer.getBounds(), { padding: [20, 20], maxZoom: 15 });
}

async function loadTable() {
  const d = await api("unidades", params({ page: state.page, page_size: state.pageSize, orden: state.orden }));
  document.getElementById("count").textContent = `(${fmt(d.count)})`;
  document.querySelector("#tabla tbody").innerHTML = d.results.map((r) => `
    <tr data-id="${r.id}">
      <td>${esc(r.nombre)}</td><td>${r.distrito_municipal ?? ""}</td>
      <td><span class="badge" style="background:${color(r.dependencia)}">${esc(label(r.dependencia || "S/D"))}</span></td>
      <td>${esc(r.direccion)}</td><td>${esc((r.niveles || "").split(",").map(label).join(", "))}</td>
      <td>${esc((r.turnos || "").split(",").map(label).join(", "))}</td><td>${r.estudiantes_total != null ? fmt(r.estudiantes_total) : ""}</td>
    </tr>`).join("");
  const pages = Math.max(1, Math.ceil(d.count / state.pageSize));
  document.getElementById("pageinfo").textContent = `Página ${state.page} de ${pages}`;
  document.getElementById("prev").disabled = state.page <= 1;
  document.getElementById("next").disabled = state.page >= pages;
}

async function showDetail(id) {
  const r = await fetch(`/api/unidades/${id}`).then((x) => x.json());
  const rows = [["RUE", r.codigo_rue], ["Dependencia", label(r.dependencia || "")], ["Convenio con", r.tipo_convenio],
    ["Subsistema", r.subsistema], ["Niveles", (r.niveles || "").split(",").map(label).join(", ")],
    ["Turnos", (r.turnos || "").split(",").map(label).join(", ")], ["Distrito", r.distrito_municipal], ["Zona", r.zona],
    ["Dirección", r.direccion], ["Teléfono", r.telefono], ["Director/a", r.director],
    ["Estudiantes", r.estudiantes_total != null ? `${fmt(r.estudiantes_total)} (M ${fmt(r.estudiantes_mujeres)} / H ${fmt(r.estudiantes_hombres)})` : null],
    ["Docentes", r.docentes], ["Fuente", r.fuente]].filter(([, v]) => v != null && v !== "");
  document.getElementById("detalle-body").innerHTML = `<h2>${esc(r.nombre)}</h2><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  document.getElementById("detalle").showModal();
}

function refresh() {
  state.page = 1;
  loadStats(); loadMap(); loadTable();
}

let t;
document.getElementById("q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(refresh, 300); });
document.querySelector(".filters").addEventListener("change", refresh);
document.getElementById("limpiar").onclick = () => {
  document.querySelectorAll(".filters input[type=checkbox]").forEach((i) => (i.checked = false));
  document.querySelectorAll("#f-distrito option").forEach((o) => (o.selected = false));
  document.getElementById("q").value = ""; refresh();
};
document.getElementById("prev").onclick = () => { state.page--; loadTable(); };
document.getElementById("next").onclick = () => { state.page++; loadTable(); };
document.querySelectorAll("th[data-orden]").forEach((th) => th.onclick = () => {
  const o = th.dataset.orden; state.orden = state.orden === o ? `-${o}` : o; state.page = 1; loadTable();
});
document.querySelector("#tabla tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr"); if (tr) showDetail(tr.dataset.id); });
document.querySelectorAll("[data-export]").forEach((a) => a.onclick = (e) => { e.preventDefault(); location.href = `/api/export.${a.dataset.export}?${params()}`; });

loadCatalogos().then(refresh);
