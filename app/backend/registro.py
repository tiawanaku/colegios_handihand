"""Colegios nuevos registrados desde el dashboard (HU-04).

La vista `unidad_educativa` (BD de cuidados) es de sólo lectura, así que los registros viven en una tabla
propia de la BD del sistema (COLEGIOS_AUTH_DB), con ids desde 1.000.000 para no chocar con los de la vista.
La API los combina con la vista en Python: son pocas filas.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Field, Session, select

from .auth import AuthModel, auth_engine
from .models import UnidadEducativa

ahora = lambda: datetime.now(timezone.utc)

PRIMER_ID = 1_000_000
DEPENDENCIAS = ["FISCAL", "CONVENIO", "PRIVADA"]
SUBSISTEMAS = ["REGULAR", "ALTERNATIVA", "ESPECIAL", "PERMANENTE"]
TURNOS = ["MAÑANA", "TARDE", "NOCHE"]
DISTRITOS = list(range(1, 15))
AREA = {"lat": [-16.65, -16.40], "lon": [-68.35, -68.05]}  # área urbana que encuadra el mapa


class UnidadRegistrada(AuthModel, table=True):
    __tablename__ = "unidad_registrada"

    id: int = Field(primary_key=True, sa_column_kwargs={"autoincrement": False})
    nombre: str
    dependencia: str
    subsistema: str
    niveles: str = Field(description="CSV de valores del catálogo")
    turnos: str = Field(description="CSV: MAÑANA,TARDE,NOCHE")
    distrito_municipal: int
    zona: str | None = None
    direccion: str
    telefono: str | None = None
    lat: float
    lon: float
    usuario: str
    creado: datetime = Field(default_factory=ahora)


class ErrorValidacion(Exception):
    def __init__(self, errores: dict[str, str]):
        super().__init__("Revise los datos del colegio")
        self.errores = errores


def _texto(datos: dict, campo: str, maximo: int, obligatorio: bool, errores: dict, faltante: str) -> str | None:
    v = datos.get(campo)
    if v is None or (isinstance(v, str) and not v.strip()):
        if obligatorio:
            errores[campo] = faltante
        return None
    if not isinstance(v, str):
        errores[campo] = "Debe ser un texto"
        return None
    v = v.strip()
    if len(v) > maximo:
        errores[campo] = f"No puede pasar de {maximo} caracteres"
    return v


def _numero(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return float(v)


def validar(datos) -> dict:
    """Valores limpios para guardar, o ErrorValidacion con un mensaje por campo (claves = campos del body)."""
    if not isinstance(datos, dict):
        raise ErrorValidacion({"general": "Los datos enviados no son válidos"})
    e: dict[str, str] = {}
    limpio = {
        "nombre": _texto(datos, "nombre", 200, True, e, "Escriba el nombre del colegio"),
        "direccion": _texto(datos, "direccion", 255, True, e, "Escriba la dirección"),
        "zona": _texto(datos, "zona", 200, False, e, ""),
        "telefono": _texto(datos, "telefono", 50, False, e, ""),
    }

    dep = datos.get("dependencia")
    limpio["dependencia"] = dep.strip().upper() if isinstance(dep, str) else None
    if limpio["dependencia"] not in DEPENDENCIAS:
        e["dependencia"] = "Elija la dependencia: fiscal, de convenio o privada"

    sub = datos.get("subsistema")
    limpio["subsistema"] = "REGULAR" if sub is None else (sub.strip().upper() if isinstance(sub, str) else None)
    if limpio["subsistema"] not in SUBSISTEMAS:
        e["subsistema"] = "Elija un subsistema válido"

    dist = datos.get("distrito_municipal")
    if isinstance(dist, bool) or not isinstance(dist, int) or dist not in DISTRITOS:
        e["distrito_municipal"] = "Elija un distrito del 1 al 14"
    limpio["distrito_municipal"] = dist

    niveles = datos.get("niveles")
    if not isinstance(niveles, list) or not niveles:
        e["niveles"] = "Elija al menos un nivel"
    elif not all(isinstance(n, str) and n.strip() and "," not in n and len(n.strip()) <= 100 for n in niveles):
        e["niveles"] = "Cada nivel debe ser un texto sin comas de hasta 100 caracteres"
    else:
        limpio["niveles"] = ",".join(dict.fromkeys(n.strip() for n in niveles))

    turnos = datos.get("turnos")
    if not isinstance(turnos, list) or not turnos:
        e["turnos"] = "Elija al menos un turno"
    elif not all(isinstance(t, str) and t.strip().upper() in TURNOS for t in turnos):
        e["turnos"] = "Turno no válido: elija mañana, tarde o noche"
    else:
        elegidos = {t.strip().upper() for t in turnos}
        limpio["turnos"] = ",".join(t for t in TURNOS if t in elegidos)

    for campo in ("lat", "lon"):
        v = _numero(datos.get(campo))
        if v is None:
            e[campo] = "Marque la ubicación en el mapa"
        elif not AREA[campo][0] <= v <= AREA[campo][1]:
            e[campo] = "La ubicación está fuera del área de la ciudad"
        limpio[campo] = v

    if e:
        raise ErrorValidacion(e)
    return limpio


def registrar(datos, usuario: str) -> UnidadRegistrada:
    limpio = validar(datos)
    for _ in range(5):  # dos altas simultáneas pueden calcular el mismo id: se reintenta
        with Session(auth_engine) as s:
            ultimo = s.exec(select(func.max(UnidadRegistrada.id))).one()
            r = UnidadRegistrada(id=max(PRIMER_ID - 1, ultimo or 0) + 1, usuario=usuario, **limpio)
            s.add(r)
            try:
                s.commit()
            except IntegrityError:
                continue
            s.refresh(r)
            return r
    raise RuntimeError("No se pudo asignar un id al colegio registrado")


def a_unidad(r: UnidadRegistrada) -> UnidadEducativa:
    """Mismo modelo que la vista, para que la API los trate igual."""
    return UnidadEducativa(
        id=r.id, clave=f"registro:{r.id}", nombre=r.nombre, dependencia=r.dependencia, subsistema=r.subsistema,
        niveles=r.niveles, turnos=r.turnos, distrito_municipal=r.distrito_municipal, zona=r.zona,
        direccion=r.direccion, telefono=r.telefono, lat=r.lat, lon=r.lon, actualizado=r.creado,
    )


def todas() -> list[UnidadRegistrada]:
    with Session(auth_engine) as s:
        return list(s.exec(select(UnidadRegistrada).order_by(UnidadRegistrada.id)).all())


def obtener(ue_id: int) -> UnidadRegistrada | None:
    if ue_id < PRIMER_ID:
        return None
    with Session(auth_engine) as s:
        return s.get(UnidadRegistrada, ue_id)
