// Arranque común de las pruebas e2e del sprint 3: BD demo propia, backend real (con login) y Chromium.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const PY = process.env.PYTHON || "python3";
const TILES = /openstreetmap\.org|cartocdn\.com/;

/** Levanta el backend con un usuario y devuelve { BASE, api, open, settle, cerrar, cookie }. */
export async function arrancar(nombre, { usuario = "e2e-s3", clave = "clave-sprint-3", puerto = 9800 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `colegios-${nombre}-`));
  const PORT = puerto + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, COLEGIOS_DB: `sqlite:///${path.join(tmp, "d.db")}`,
    COLEGIOS_AUTH_DB: `sqlite:///${path.join(tmp, "sistema.db")}`, COLEGIOS_AUTH: "1", COLEGIOS_SECRET: "e2e" };
  execFileSync(PY, ["-c", `
import sys
from app.backend import auth
from sqlmodel import Session
auth.init_auth_db()
with Session(auth.auth_engine) as s:
    s.add(auth.Usuario(usuario=sys.argv[1], nombre="Usuaria Sprint 3", clave_hash=auth.hash_clave(sys.argv[2])))
    s.commit()`, usuario, clave], { cwd: ROOT, env });
  execFileSync(PY, ["-m", "app.backend.importer", "app/data/demo_unidades.csv", "--fuente", "DEMO"], { cwd: ROOT, env });
  const server = spawn(PY, ["-m", "uvicorn", "app.backend.main:app", "--port", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/auth/sesion`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario, clave }),
  });
  if (r.status !== 200) throw new Error(`login: HTTP ${r.status}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /** fetch a la API con la sesión: api("personal"), api("personal", { method: "POST", body: {...} }). */
  const api = async (p, { method = "GET", body, sesion = true } = {}) => {
    const res = await fetch(`${BASE}/api/${p}`, { method, headers: { ...(sesion ? { cookie } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const settle = (page) => page.waitForFunction(() => document.querySelector(".content").getAttribute("aria-busy") === "false");

  /** Página con sesión (o sin ella, `sesion: false`); `page.errors` junta errores de JS y de consola. */
  async function open(query = "", ctxOpts = {}, { sesion = true } = {}) {
    const ctx = await browser.newContext({ timezoneId: "America/La_Paz", ...ctxOpts });
    if (sesion) {
      const [name, value] = cookie.split(/=(.*)/);
      await ctx.addCookies([{ name, value, url: BASE }]);
    }
    const page = await ctx.newPage();
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
    await page.route(TILES, (rt) => rt.abort());
    await page.goto(`${BASE}/${query}`);
    if (sesion) await settle(page);
    return page;
  }

  async function cerrar() {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { BASE, api, open, settle, cerrar, cookie, usuario };
}

export const sinScrollHorizontal = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
export const kpiTotal = async (page) => Number((await page.locator(".kpi b").first().innerText()).replace(/\D/g, ""));
