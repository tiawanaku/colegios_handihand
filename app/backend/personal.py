"""Personal de la organización (HU-10): lista propia para elegir encargados y personal de las actividades.

Vive en la BD del sistema (COLEGIOS_AUTH_DB). No se borra: se marca inactivo y deja de poder asignarse.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlmodel import Field, Session, select

from .auth import AuthModel, auth_engine
from .estado import iso
from .registro import _texto

ahora = lambda: datetime.now(timezone.utc)

CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_ID = 2**31 - 1  # INTEGER de PostgreSQL: un id mayor no existe


class Persona(AuthModel, table=True):
    __tablename__ = "personal"

    id: int | None = Field(default=None, primary_key=True)
    nombre: str
    cargo: str
    telefono: str | None = None
    correo: str | None = None
    activo: bool = True
    creado: datetime = Field(default_factory=ahora)
    actualizado: datetime = Field(default_factory=ahora)
    usuario: str = Field(description="quién hizo el último cambio")


class ErrorValidacion(Exception):
    def __init__(self, errores: dict[str, str]):
        super().__init__("Revise los datos del personal")
        self.errores = errores


class NoExiste(Exception):
    pass


def validar(datos, parcial: bool) -> dict:
    """Valores limpios de los campos enviados (todos en un alta); ErrorValidacion con un mensaje por campo."""
    if not isinstance(datos, dict):
        raise ErrorValidacion({"general": "Datos no válidos"})
    e: dict[str, str] = {}
    limpio = {}
    for campo, maximo, obligatorio, faltante in (("nombre", 150, True, "Escriba el nombre"),
                                                 ("cargo", 100, True, "Escriba el cargo"),
                                                 ("telefono", 50, False, ""), ("correo", 150, False, "")):
        if not parcial or campo in datos:
            limpio[campo] = _texto(datos, campo, maximo, obligatorio, e, faltante)
    if limpio.get("correo") is not None and "correo" not in e and not CORREO.match(limpio["correo"]):
        e["correo"] = "Correo no válido"
    if parcial and "activo" in datos:
        if not isinstance(datos["activo"], bool):
            e["activo"] = "Valor no válido"
        limpio["activo"] = datos["activo"]
    if e:
        raise ErrorValidacion(e)
    return limpio


def a_dict(p: Persona) -> dict:
    return {"id": p.id, "nombre": p.nombre, "cargo": p.cargo, "telefono": p.telefono, "correo": p.correo,
            "activo": p.activo, "creado": iso(p.creado), "actualizado": iso(p.actualizado)}


def listar(incluir_inactivos: bool) -> list[Persona]:
    with Session(auth_engine) as s:
        stmt = select(Persona) if incluir_inactivos else select(Persona).where(Persona.activo == True)  # noqa: E712
        filas = s.exec(stmt).all()
    return sorted(filas, key=lambda p: (p.nombre.casefold(), p.id))


def por_ids(ids) -> dict[int, Persona]:
    ids = [i for i in ids if 0 < i <= MAX_ID]
    if not ids:
        return {}
    with Session(auth_engine) as s:
        return {p.id: p for p in s.exec(select(Persona).where(Persona.id.in_(ids))).all()}


def crear(datos, usuario: str) -> Persona:
    p = Persona(**validar(datos, parcial=False), usuario=usuario)
    with Session(auth_engine) as s:
        s.add(p)
        s.commit()
        s.refresh(p)
    return p


def modificar(pid: int, datos, usuario: str) -> Persona:
    with Session(auth_engine) as s:
        p = s.get(Persona, pid) if 0 < pid <= MAX_ID else None
        if p is None:
            raise NoExiste()
        limpio = validar(datos, parcial=True)
        cambios = {k: v for k, v in limpio.items() if getattr(p, k) != v}
        if not cambios:
            raise ErrorValidacion({"general": "No hay cambios para guardar"})
        for k, v in cambios.items():
            setattr(p, k, v)
        p.actualizado, p.usuario = ahora(), usuario
        s.add(p)
        s.commit()
        s.refresh(p)
    return p
