// Formulario de ingreso: POST /api/auth/login deja una cookie de sesión HttpOnly y vuelve al dashboard.
const API = (window.COLEGIOS_CONFIG || {}).apiBase || "/api";
const form = document.getElementById("login");
const error = document.getElementById("login-error");

// Si ya hay sesión (o el login está desactivado), directo al dashboard
fetch(`${API}/auth/sesion`).then((r) => r.json()).then((s) => {
  if (!s.requerida || s.usuario) location.replace(".");
}).catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.hidden = true;
  const usuario = form.usuario.value.trim();
  const clave = form.clave.value;
  if (!usuario || !clave) return mostrar("Escribe tu usuario y contraseña.");
  const boton = form.querySelector("button");
  boton.disabled = true;
  try {
    const r = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ usuario, clave }),
    });
    if (r.ok) return location.replace(".");
    const { detail } = await r.json().catch(() => ({}));
    mostrar(typeof detail === "string" ? detail : `No se pudo ingresar (HTTP ${r.status}).`);
    form.clave.value = "";
    form.clave.focus();
  } catch {
    mostrar("No se pudo conectar con el servidor.");
  } finally {
    boton.disabled = false;
  }
});

function mostrar(msg) {
  error.textContent = msg;
  error.hidden = false;
}
