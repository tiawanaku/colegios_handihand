"""Agenda de actividades en los colegios (HU-09).

Vive en la BD del sistema (COLEGIOS_AUTH_DB). Fecha y hora son locales de La Paz, como texto `YYYY-MM-DD` y `HH:MM`
(así ordenan bien como texto en SQLite y PostgreSQL). Encargados y personal son listas de ids de `personal` en CSV.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Callable

from sqlmodel import Field, Session, select

from . import personal
from .auth import AuthModel, auth_engine
from .estado import iso
from .registro import _texto

ahora = lambda: datetime.now(timezone.utc)

TIPOS = ["TALLER", "VISITA", "REUNION", "OTRA"]
ESTADOS = ["PENDIENTE", "REALIZADA", "POSTERGADA", "CANCELADA"]
CAMPOS = ["ue_id", "tipo", "actividad", "fecha", "hora", "lugar", "encargados", "personal",
          "asistentes_proyectados", "observaciones", "estado"]
MAX_ASISTENTES = 1_000_000
MAX_DIAS = 400
FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
INACTIVAS = "Hay personas que no existen o están inactivas"


class Actividad(AuthModel, table=True):
    __tablename__ = "actividad"

    id: int | None = Field(default=None, primary_key=True)
    ue_id: int = Field(index=True)
    tipo: str
    actividad: str
    fecha: str = Field(index=True, description="YYYY-MM-DD, hora local de La Paz")
    hora: str = Field(description="HH:MM")
    lugar: str
    encargados: str = Field(description="CSV de ids de personal")
    personal: str = Field(default="", description="CSV de ids de personal")
    asistentes_proyectados: int | None = None
    observaciones: str | None = None
    estado: str = "PENDIENTE"
    creado: datetime = Field(default_factory=ahora)
    creado_por: str
    actualizado: datetime = Field(default_factory=ahora)
    actualizado_por: str


class ErrorValidacion(Exception):
    def __init__(self, errores: dict[str, str]):
        super().__init__("Revise los datos de la actividad")
        self.errores = errores


class NoExiste(Exception):
    pass


def es_fecha(v) -> bool:
    if not isinstance(v, str) or not FECHA.match(v):
        return False
    try:
        date.fromisoformat(v)
    except ValueError:
        return False
    return True


def _ids(v: str) -> list[int]:
    return [int(x) for x in v.split(",") if x]


def _csv(ids: list[int]) -> str:
    return ",".join(map(str, ids))


def _opcion(v, opciones: list[str]) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip().upper()
    v = {"REUNIÓN": "REUNION"}.get(v, v)
    return v if v in opciones else None


def _personas(v, previas: set[int], e: dict, campo: str, obligatorio: bool) -> list[int]:
    """Lista de ids sin repetir. Una persona nueva en la actividad debe existir y estar activa; si ya estaba
    asignada, puede quedarse aunque ahora esté inactiva."""
    if v is None and not obligatorio:
        return []
    if not isinstance(v, list) or (obligatorio and not v):
        e[campo] = "Elija al menos un encargado" if obligatorio else INACTIVAS
        return []
    if not all(isinstance(i, int) and not isinstance(i, bool) for i in v):
        e[campo] = INACTIVAS
        return []
    ids = list(dict.fromkeys(v))
    encontradas = personal.por_ids(ids)
    if any(i not in encontradas or (not encontradas[i].activo and i not in previas) for i in ids):
        e[campo] = INACTIVAS
    return ids


def validar(datos: dict, previa: Actividad | None, colegio_valido: Callable[[int], bool]) -> dict:
    """Valida la actividad resultante completa. En una modificación, `datos` ya trae los valores actuales
    debajo de los enviados y `previa` permite conservar colegio y personas que ya estaban."""
    e: dict[str, str] = {}
    limpio: dict = {}

    ue = datos.get("ue_id")
    if isinstance(ue, bool) or not isinstance(ue, int):
        e["ue_id"] = "Elija el colegio"
    elif not (previa is not None and ue == previa.ue_id) and not colegio_valido(ue):
        e["ue_id"] = "El colegio no existe o está dado de baja"
    limpio["ue_id"] = ue

    limpio["tipo"] = _opcion(datos.get("tipo"), TIPOS)
    if limpio["tipo"] is None:
        e["tipo"] = "Elija el tipo: taller, visita, reunión u otra"
    limpio["actividad"] = _texto(datos, "actividad", 200, True, e, "Describa la actividad")
    if not es_fecha(datos.get("fecha")):
        e["fecha"] = "Elija una fecha válida"
    limpio["fecha"] = datos.get("fecha")
    hora = datos.get("hora")
    if not isinstance(hora, str) or not HORA.match(hora):
        e["hora"] = "Elija una hora válida"
    limpio["hora"] = hora
    limpio["lugar"] = _texto(datos, "lugar", 200, True, e, "Escriba el lugar")

    previas = set(_ids(previa.encargados) + _ids(previa.personal)) if previa else set()
    limpio["encargados"] = _personas(datos.get("encargados"), previas, e, "encargados", True)
    limpio["personal"] = _personas(datos.get("personal"), previas, e, "personal", False)

    n = datos.get("asistentes_proyectados")
    if n is not None and (isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= MAX_ASISTENTES):
        e["asistentes_proyectados"] = "Debe ser un número entero de 0 o más"
    limpio["asistentes_proyectados"] = n
    limpio["observaciones"] = _texto(datos, "observaciones", 2000, False, e, "")

    est = datos.get("estado")
    limpio["estado"] = "PENDIENTE" if est is None and previa is None else _opcion(est, ESTADOS)
    if limpio["estado"] is None:
        e["estado"] = "Estado no válido"

    if e:
        raise ErrorValidacion(e)
    return limpio


def _como_datos(a: Actividad) -> dict:
    return {k: (_ids(getattr(a, k)) if k in ("encargados", "personal") else getattr(a, k)) for k in CAMPOS}


def crear(datos, usuario: str, colegio_valido: Callable[[int], bool]) -> Actividad:
    if not isinstance(datos, dict):
        raise ErrorValidacion({"general": "Datos no válidos"})
    limpio = validar(datos, None, colegio_valido)
    a = Actividad(**{**limpio, "encargados": _csv(limpio["encargados"]), "personal": _csv(limpio["personal"])},
                  creado_por=usuario, actualizado_por=usuario)
    with Session(auth_engine) as s:
        s.add(a)
        s.commit()
        s.refresh(a)
    return a


def modificar(aid: int, datos, usuario: str, colegio_valido: Callable[[int], bool]) -> Actividad:
    with Session(auth_engine) as s:
        a = s.get(Actividad, aid) if 0 < aid <= personal.MAX_ID else None
        if a is None:
            raise NoExiste()
        if not isinstance(datos, dict):
            raise ErrorValidacion({"general": "Datos no válidos"})
        actual = _como_datos(a)
        limpio = validar({**actual, **{k: datos[k] for k in CAMPOS if k in datos}}, a, colegio_valido)
        cambios = {k: v for k, v in limpio.items() if actual[k] != v}
        if not cambios:
            raise ErrorValidacion({"general": "No hay cambios para guardar"})
        for k, v in cambios.items():
            setattr(a, k, _csv(v) if k in ("encargados", "personal") else v)
        a.actualizado, a.actualizado_por = ahora(), usuario
        s.add(a)
        s.commit()
        s.refresh(a)
    return a


def obtener(aid: int) -> Actividad | None:
    if not 0 < aid <= personal.MAX_ID:
        return None
    with Session(auth_engine) as s:
        return s.get(Actividad, aid)


def filtros(desde, hasta, ue_id, estado) -> dict:
    """Parámetros de GET /api/actividades ya validados (todos opcionales)."""
    e: dict[str, str] = {}
    for campo, v in (("desde", desde), ("hasta", hasta)):
        if v is not None and not es_fecha(v):
            e[campo] = "Elija una fecha válida"
    if desde and hasta and not e:
        dias = (date.fromisoformat(hasta) - date.fromisoformat(desde)).days
        if dias < 0:
            e["hasta"] = "Debe ser igual o posterior a la fecha inicial"
        elif dias > MAX_DIAS:
            e["hasta"] = f"El rango no puede pasar de {MAX_DIAS} días"
    ue = None
    if ue_id is not None:
        try:
            ue = int(ue_id)
        except ValueError:
            e["ue_id"] = "Elija el colegio"
    est = None
    if estado is not None and (est := _opcion(estado, ESTADOS)) is None:
        e["estado"] = "Estado no válido"
    if e:
        raise ErrorValidacion(e)
    return {"desde": desde, "hasta": hasta, "ue_id": ue, "estado": est}


def listar(desde: str | None, hasta: str | None, ue_id: int | None, estado: str | None) -> list[Actividad]:
    A = Actividad
    stmt = select(A)
    if desde:
        stmt = stmt.where(A.fecha >= desde)
    if hasta:
        stmt = stmt.where(A.fecha <= hasta)
    if ue_id is not None:
        if not -personal.MAX_ID <= ue_id <= personal.MAX_ID:
            return []
        stmt = stmt.where(A.ue_id == ue_id)
    if estado:
        stmt = stmt.where(A.estado == estado)
    with Session(auth_engine) as s:
        return list(s.exec(stmt.order_by(A.fecha, A.hora, A.id)).all())


def a_dicts(acts: list[Actividad], colegios: dict[int, str | None]) -> list[dict]:
    """`colegios`: nombre de cada ue_id (vista con correcciones o registrado)."""
    personas = personal.por_ids({i for a in acts for i in _ids(a.encargados) + _ids(a.personal)})
    ficha = lambda i: ({"id": i, "nombre": p.nombre, "cargo": p.cargo, "activo": p.activo}
                       if (p := personas.get(i)) else {"id": i, "nombre": None, "cargo": None, "activo": False})
    return [{"id": a.id, "ue_id": a.ue_id, "colegio": {"id": a.ue_id, "nombre": colegios.get(a.ue_id)},
             "tipo": a.tipo, "actividad": a.actividad, "fecha": a.fecha, "hora": a.hora, "lugar": a.lugar,
             "encargados": [ficha(i) for i in _ids(a.encargados)], "personal": [ficha(i) for i in _ids(a.personal)],
             "asistentes_proyectados": a.asistentes_proyectados, "observaciones": a.observaciones,
             "estado": a.estado, "creado": iso(a.creado), "creado_por": a.creado_por,
             "actualizado": iso(a.actualizado), "actualizado_por": a.actualizado_por}
            for a in acts]
