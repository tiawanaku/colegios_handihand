// window.claude falso: db en memoria con onSnapshot, sample que usa las herramientas, user y downloads
(() => {
  const store = new Map(); const subs = new Set();
  const parent = (p) => p.split("/").slice(0, -1).join("/");
  const snapDoc = (p) => ({ id: p.split("/").pop(), exists: store.has(p), data: () => store.has(p) ? structuredClone(store.get(p)) : undefined, metadata: {} });
  const notify = () => setTimeout(() => subs.forEach((f) => f()), 0);
  const docRef = (p) => ({ id: p.split("/").pop(), path: p,
    get: async () => snapDoc(p),
    set: async (d) => { store.set(p, structuredClone(d)); notify(); },
    update: async (d) => { if (!store.has(p)) throw { code: "invalid_argument" }; store.set(p, { ...store.get(p), ...structuredClone(d) }); notify(); },
    delete: async () => { store.delete(p); notify(); },
    onSnapshot: (next) => { const f = () => next(snapDoc(p)); subs.add(f); f(); return () => subs.delete(f); } });
  const colRef = (c) => ({ path: c, doc: (id) => docRef(`${c}/${id || Math.random().toString(36).slice(2)}`),
    onSnapshot: (next) => { const f = () => { const docs = [...store.keys()].filter((k) => parent(k) === c).sort().map(snapDoc); next({ docs, size: docs.length, empty: !docs.length }); }; subs.add(f); f(); return () => subs.delete(f); } });
  const db = { doc: docRef, collection: colRef };
  window.__store = store; window.__llamadas = [];
  const sample = async (turnos, opts) => {
    const ultimo = turnos[turnos.length - 1].content.toLowerCase();
    const tool = (n) => opts.tools.find((t) => t.name === n);
    window.__llamadas.push(ultimo);
    let txt;
    if (ultimo.includes("mueve")) { await tool("mover_historia").execute({ codigo: "HU-01", sprint: 2 }, {}); txt = "Listo, HU-01 pasó al sprint 2."; }
    else if (ultimo.includes("no tengo más")) { await tool("preparar_acta").execute({ resumen: "Se acordó mostrar la matrícula por colegio." }, {}); txt = "Preparé el acta. Revísela y fírmela al final."; }
    else { const r = await tool("registrar_historia").execute({ titulo: "Ver matrícula por colegio", como: "técnico distrital", quiero: "ver cuántos estudiantes tiene cada colegio <b>", para: "planificar recursos", criterios: ["Dado un colegio, cuando abro su ficha, entonces veo su matrícula", "Se indica la fuente del dato"], prioridad: "MUST", notas: "Falta el dato de matrícula (SIE)" }, {}); txt = `Registré ${r.codigo}. ¿Algo más?`; }
    opts.onText?.({ text: txt, delta: txt });
    return { text: txt, truncated: false };
  };
  sample.json = async () => ({ backlog: [{ codigo: "HU-01", titulo: "Ver matrícula por colegio", prioridad: "MUST", puntos: 8, sprint: 1, tareas: [{ titulo: "Importar matrícula del SIE", tipo: "datos", horas: 10 }, { titulo: "Mostrar matrícula en la ficha", tipo: "frontend", horas: 4 }] }],
    sprints: [{ numero: 1, objetivo: "Matrícula visible en el dashboard" }, { numero: 2, objetivo: "Reportes" }], dod: ["Pruebas pasan"], riesgos: ["Acceso al SIE"] });
  const user = { id: async () => "u_cliente", can: async () => true, canEdit: async () => true, isOwner: async () => true, profiles: async (ids) => Object.fromEntries([].concat(ids).map((i) => [i, { id: i, name: "Cliente Prueba" }])) };
  const downloads = { save: async (r) => { window.__descarga = r.filename; return { status: "saved" }; } };
  const caps = { db, sample, user, downloads };
  window.claude = { use: (n) => new Promise((ok) => setTimeout(() => ok(caps[n] ?? null), 50)) };
})();
