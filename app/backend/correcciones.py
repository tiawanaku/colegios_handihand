"""Correcciones de los datos de un colegio (HU-08), con bitácora campo a campo.

La vista `unidad_educativa` es de sólo lectura: lo corregido de un colegio de la vista se guarda en la tabla propia
`unidad_correccion` (un valor por campo editable, null = sin corregir) y se aplica encima de la vista en toda la API.
Los colegios registrados (id >= 1.000.000) se corrigen en su propia fila de `unidad_registrada`.
Cada guardado deja una fila por campo cambiado en `unidad_cambio`, con el mismo usuario y la misma fecha.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Field, Session, select

from . import registro
from .estado import iso
from .auth import AuthModel, auth_engine
from .models import UnidadEducativa

ahora = lambda: datetime.now(timezone.utc)

CAMPOS = ["nombre", "dependencia", "subsistema", "distrito_municipal", "direccion", "zona", "telefono",
          "niveles", "turnos", "lat", "lon"]
LISTAS = {"niveles", "turnos"}
OPCIONALES = {"zona", "telefono"}  # corregidos a vacío se guardan como "" (null significa "sin corregir")


class UnidadCorreccion(AuthModel, table=True):
    __tablename__ = "unidad_correccion"

    ue_id: int = Field(primary_key=True, sa_column_kwargs={"autoincrement": False})
    nombre: str | None = None
    dependencia: str | None = None
    subsistema: str | None = None
    distrito_municipal: int | None = None
    direccion: str | None = None
    zona: str | None = None
    telefono: str | None = None
    niveles: str | None = None
    turnos: str | None = None
    lat: float | None = None
    lon: float | None = None
    usuario: str
    fecha: datetime = Field(default_factory=ahora)


class UnidadCambio(AuthModel, table=True):
    __tablename__ = "unidad_cambio"

    id: int | None = Field(default=None, primary_key=True)
    ue_id: int = Field(index=True)
    campo: str
    antes: str | None = None
    despues: str | None = None
    usuario: str
    fecha: datetime = Field(default_factory=ahora)


def todas() -> dict[int, UnidadCorreccion]:
    with Session(auth_engine) as s:
        return {c.ue_id: c for c in s.exec(select(UnidadCorreccion)).all()}


def ids() -> set[int]:
    with Session(auth_engine) as s:
        return set(s.exec(select(UnidadCorreccion.ue_id)).all())


def obtener(ue_id: int) -> UnidadCorreccion | None:
    with Session(auth_engine) as s:
        return s.get(UnidadCorreccion, ue_id)


def aplicar(u: UnidadEducativa, c: UnidadCorreccion | None) -> UnidadEducativa:
    """Copia de la fila de la vista con lo corregido encima (la fila de la sesión no se toca)."""
    if c is None:
        return u
    cambios = {k: (getattr(c, k) or None if k in OPCIONALES else getattr(c, k))
               for k in CAMPOS if getattr(c, k) is not None}
    return UnidadEducativa(**{**u.model_dump(), **cambios})


def _items(v) -> list[str]:
    return [x for x in (v or "").split(",") if x]


def _igual(campo: str, antes, despues) -> bool:
    if campo in LISTAS:
        return set(_items(antes)) == set(_items(despues))
    return (antes if antes != "" else None) == despues


def _texto(v) -> str | None:
    return None if v is None or v == "" else str(v)


def _valor(campo: str, v: str | None):
    """Valor de la bitácora (texto) con el tipo con que sale en la ficha."""
    if v is None:
        return None
    if campo == "distrito_municipal":
        return int(v)
    if campo in ("lat", "lon"):
        return float(v)
    return v


def corregir(u: UnidadEducativa, reg: registro.UnidadRegistrada | None, datos, usuario: str) -> list[dict]:
    """Valida el registro resultante completo con las reglas de registro.py y guarda los campos que cambian.
    `u` es el colegio tal como se ve ahora (vista + correcciones, o el registrado)."""
    if not isinstance(datos, dict):
        raise registro.ErrorValidacion({"general": "Datos no válidos"})
    actual = {k: getattr(u, k) for k in CAMPOS}
    pedido = {k: datos[k] for k in CAMPOS if k in datos}
    resultante = {**{k: (_items(v) if k in LISTAS else v) for k, v in actual.items()}, **pedido}
    limpio = registro.validar(resultante)
    cambios = [{"campo": k, "antes": actual[k], "despues": limpio[k]}
               for k in CAMPOS if k in pedido and not _igual(k, actual[k], limpio[k])]
    if not cambios:
        raise registro.ErrorValidacion({"general": "No hay cambios para guardar"})
    fecha = ahora()
    with Session(auth_engine) as s:
        if reg is not None:
            fila = s.get(registro.UnidadRegistrada, reg.id)
            for c in cambios:
                setattr(fila, c["campo"], c["despues"])
        else:
            fila = s.get(UnidadCorreccion, u.id) or UnidadCorreccion(ue_id=u.id, usuario=usuario)
            for c in cambios:
                v = c["despues"]
                setattr(fila, c["campo"], "" if v is None and c["campo"] in OPCIONALES else v)
            fila.usuario, fila.fecha = usuario, fecha
        s.add(fila)
        for c in cambios:
            s.add(UnidadCambio(ue_id=u.id, campo=c["campo"], antes=_texto(c["antes"]), despues=_texto(c["despues"]),
                               usuario=usuario, fecha=fecha))
        s.commit()
    return [{"campo": c["campo"], "antes": None if c["antes"] == "" else c["antes"], "despues": c["despues"]}
            for c in cambios]


def ultima(ue_id: int) -> UnidadCambio | None:
    with Session(auth_engine) as s:
        return s.exec(select(UnidadCambio).where(UnidadCambio.ue_id == ue_id)
                      .order_by(UnidadCambio.fecha.desc(), UnidadCambio.id.desc())).first()


def historial(ue_id: int) -> list[dict]:
    """Una entrada por guardado (mismo usuario y fecha), la más reciente primero."""
    with Session(auth_engine) as s:
        filas = s.exec(select(UnidadCambio).where(UnidadCambio.ue_id == ue_id).order_by(UnidadCambio.id)).all()
    grupos: dict[tuple, list[UnidadCambio]] = {}
    for f in filas:
        grupos.setdefault((f.fecha, f.usuario), []).append(f)
    return [{"accion": "modificacion", "usuario": usuario, "fecha": iso(fecha),
             "cambios": [{"campo": f.campo, "antes": _valor(f.campo, f.antes), "despues": _valor(f.campo, f.despues)}
                         for f in fs]}
            for (fecha, usuario), fs in reversed(grupos.items())]
