"""Login del dashboard: usuarios propios, contraseñas con scrypt y sesión en cookie firmada (HMAC).

Los usuarios viven en una BD aparte (COLEGIOS_AUTH_DB, por defecto SQLite en app/data/usuarios.db):
la BD de datos puede ser la vista de sólo lectura sobre cuidados y no debe recibir tablas nuevas.

    python -m app.backend.auth crear admin --nombre "Administrador"   # pide la contraseña
    python -m app.backend.auth crear ana --rol encargado               # puede dar de baja/alta colegios
    python -m app.backend.auth rol ana encargado|consulta
    python -m app.backend.auth clave admin                             # cambia la contraseña
    python -m app.backend.auth desactivar admin
    python -m app.backend.auth listar

Variables de entorno:
    COLEGIOS_AUTH=0        desactiva el login (desarrollo)
    COLEGIOS_SECRET        clave para firmar las sesiones; sin ella se genera una al arrancar
                           (las sesiones se pierden al reiniciar y no se comparten entre workers)
    COLEGIOS_AUTH_DB       URL SQLAlchemy de la BD de usuarios
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import logging
import os
import secrets
import shutil
import sys
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Engine, inspect, text
from sqlalchemy.orm import registry
from sqlmodel import Field, Session, SQLModel, create_engine, select

log = logging.getLogger(__name__)

AUTH_ENABLED = os.environ.get("COLEGIOS_AUTH", "1") != "0"
AUTH_DB_URL = os.environ.get(
    "COLEGIOS_AUTH_DB",
    f"sqlite:///{Path(__file__).resolve().parents[1] / 'data' / 'usuarios.db'}",
)
COOKIE = "colegios_sesion"
DURACION = 8 * 3600          # segundos de validez de una sesión
MAX_FALLOS, VENTANA = 5, 15 * 60  # intentos fallidos por IP antes de bloquear, y ventana en segundos

_secret_env = os.environ.get("COLEGIOS_SECRET")
SECRET = _secret_env.encode() if _secret_env else secrets.token_bytes(32)
if AUTH_ENABLED and not _secret_env:
    log.warning("COLEGIOS_SECRET no está definida: las sesiones se invalidan al reiniciar el servidor")


class AuthModel(SQLModel, registry=registry()):
    """Metadata propia: create_all de la BD de datos no crea estas tablas, y viceversa."""


class Usuario(AuthModel, table=True):
    __tablename__ = "usuario"

    id: int | None = Field(default=None, primary_key=True)
    usuario: str = Field(index=True, unique=True)
    nombre: str | None = None
    clave_hash: str
    activo: bool = True
    rol: str = Field(default="consulta", description="consulta | encargado")
    creado: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


auth_engine = create_engine(
    AUTH_DB_URL, connect_args={"check_same_thread": False} if AUTH_DB_URL.startswith("sqlite") else {}
)


ROLES = ("consulta", "encargado")


def todos_encargados() -> bool:
    """Interruptor temporal: mientras COLEGIOS_TODOS_ENCARGADOS no sea "0", todo usuario con sesión actúa
    como encargado (decisión del cliente para esta etapa). Con "0" rige el rol guardado de cada usuario."""
    return os.environ.get("COLEGIOS_TODOS_ENCARGADOS", "1") != "0"


def rol_de(u: "Usuario") -> str:
    return "encargado" if todos_encargados() else u.rol


def respaldar(engine: Engine) -> Path | None:
    """Copia el archivo SQLite a <archivo>.bak-<fecha> antes de alterar una tabla existente.
    En PostgreSQL el respaldo (pg_dump) es responsabilidad del despliegue."""
    db = engine.url.database
    if engine.url.get_backend_name() != "sqlite" or not db or db == ":memory:" or not Path(db).exists():
        return None
    destino = Path(f"{db}.bak-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}")
    shutil.copy2(db, destino)
    log.warning("Respaldo de la BD del sistema antes de migrar: %s", destino)
    return destino


def init_auth_db(engine: Engine | None = None) -> None:
    """Crea las tablas que falten y agrega columnas nuevas a las existentes (con respaldo previo)."""
    from . import estado  # noqa: F401  (registra unidad_estado y su historial en AuthModel)

    engine = engine or auth_engine
    AuthModel.metadata.create_all(engine)
    columnas = {c["name"] for c in inspect(engine).get_columns("usuario")}
    if "rol" not in columnas:
        respaldar(engine)
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE usuario ADD COLUMN rol VARCHAR NOT NULL DEFAULT 'consulta'"))


# ---------------------------------------------------------------- contraseñas
_N, _R, _P = 2**14, 8, 1
_b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
_unb64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_clave(clave: str) -> str:
    sal = secrets.token_bytes(16)
    h = hashlib.scrypt(clave.encode(), salt=sal, n=_N, r=_R, p=_P)
    return f"scrypt${_N}${_R}${_P}${_b64(sal)}${_b64(h)}"


def verificar_clave(clave: str, guardado: str) -> bool:
    try:
        alg, n, r, p, sal, h = guardado.split("$")
        assert alg == "scrypt"
        calc = hashlib.scrypt(clave.encode(), salt=_unb64(sal), n=int(n), r=int(r), p=int(p))
    except (ValueError, AssertionError):
        return False
    return hmac.compare_digest(calc, _unb64(h))


_HASH_SEÑUELO = hash_clave(secrets.token_hex(8))  # usuario inexistente: mismo costo, sin delatar quién existe


def autenticar(usuario: str, clave: str) -> Usuario | None:
    with Session(auth_engine) as s:
        u = s.exec(select(Usuario).where(Usuario.usuario == usuario.strip().lower())).first()
    if u is None:
        verificar_clave(clave, _HASH_SEÑUELO)
        return None
    return u if verificar_clave(clave, u.clave_hash) and u.activo else None


# ---------------------------------------------------------------- sesión (token firmado, sin estado en el servidor)
def _firma(payload: str) -> str:
    return _b64(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest())


def crear_token(u: Usuario, ahora: float | None = None) -> str:
    payload = f"{u.id}.{int((time.time() if ahora is None else ahora) + DURACION)}"
    return f"{payload}.{_firma(payload)}"


def leer_token(token: str | None) -> Usuario | None:
    """Usuario de un token válido, vigente y de una cuenta activa; None en cualquier otro caso."""
    if not token or token.count(".") != 2:
        return None
    uid, exp, firma = token.split(".")
    if not hmac.compare_digest(firma, _firma(f"{uid}.{exp}")):
        return None
    if not (uid.isdigit() and exp.isdigit()) or int(exp) < time.time():
        return None
    with Session(auth_engine) as s:
        u = s.get(Usuario, int(uid))
    return u if u and u.activo else None


# ---------------------------------------------------------------- freno a la fuerza bruta (por IP, en memoria)
_fallos: dict[str, deque[float]] = defaultdict(deque)


def bloqueado(ip: str) -> bool:
    q, limite = _fallos[ip], time.time() - VENTANA
    while q and q[0] < limite:
        q.popleft()
    return len(q) >= MAX_FALLOS


def registrar_fallo(ip: str) -> None:
    _fallos[ip].append(time.time())


def limpiar_fallos(ip: str) -> None:
    _fallos.pop(ip, None)


# ---------------------------------------------------------------- CLI de administración
def _pedir_clave() -> str:
    clave = getpass.getpass("Contraseña: ")
    if len(clave) < 8:
        sys.exit("La contraseña debe tener al menos 8 caracteres")
    if clave != getpass.getpass("Repite la contraseña: "):
        sys.exit("Las contraseñas no coinciden")
    return clave


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Administra los usuarios del dashboard")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crear")
    c.add_argument("usuario")
    c.add_argument("--nombre")
    c.add_argument("--rol", choices=ROLES, default="consulta")
    r = sub.add_parser("rol")
    r.add_argument("usuario")
    r.add_argument("nuevo_rol", choices=ROLES)
    sub.add_parser("clave").add_argument("usuario")
    sub.add_parser("desactivar").add_argument("usuario")
    sub.add_parser("activar").add_argument("usuario")
    sub.add_parser("listar")
    args = ap.parse_args(argv)
    init_auth_db()
    with Session(auth_engine) as s:
        if args.cmd == "listar":
            for u in s.exec(select(Usuario).order_by(Usuario.usuario)):
                print(f"{u.usuario:20} {'activo' if u.activo else 'INACTIVO':9} {u.rol:10} {u.nombre or ''}")
            return
        nombre = args.usuario.strip().lower()
        u = s.exec(select(Usuario).where(Usuario.usuario == nombre)).first()
        if args.cmd == "crear":
            if u:
                sys.exit(f"El usuario {nombre} ya existe")
            u = Usuario(usuario=nombre, nombre=args.nombre, rol=args.rol, clave_hash=hash_clave(_pedir_clave()))
        elif u is None:
            sys.exit(f"No existe el usuario {nombre}")
        elif args.cmd == "clave":
            u.clave_hash = hash_clave(_pedir_clave())
        elif args.cmd == "rol":
            u.rol = args.nuevo_rol
        else:
            u.activo = args.cmd == "activar"
        s.add(u)
        s.commit()
        print(f"{nombre}: {args.cmd} ✓")


if __name__ == "__main__":
    main()
