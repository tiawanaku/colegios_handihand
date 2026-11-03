"""Baja lógica y reactivación de unidades educativas.

La vista `unidad_educativa` (BD de cuidados) es de sólo lectura, así que el estado vive en tablas propias
de la BD del sistema (la de usuarios, COLEGIOS_AUTH_DB). La API excluye los ids dados de baja con
`id NOT IN (...)`: son pocas filas y no hace falta cruzar las dos BD.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlmodel import Field, Session, select

from .auth import AuthModel, auth_engine

ahora = lambda: datetime.now(timezone.utc)


class UnidadEstado(AuthModel, table=True):
    __tablename__ = "unidad_estado"

    ue_id: int = Field(primary_key=True, description="id de unidad_educativa")
    activo: bool = True
    fecha_baja: datetime | None = None
    motivo: str | None = None
    usuario: str | None = None


class UnidadEstadoHistorial(AuthModel, table=True):
    __tablename__ = "unidad_estado_historial"

    id: int | None = Field(default=None, primary_key=True)
    ue_id: int = Field(index=True)
    accion: str = Field(description="baja | alta")
    motivo: str | None = None
    usuario: str
    fecha: datetime = Field(default_factory=ahora)


class Conflicto(Exception):
    """La unidad ya está en el estado pedido."""


def iso(d: datetime | None) -> str | None:
    # SQLite devuelve la fecha sin zona: se guardó en UTC
    if d is None:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()


def ids_de_baja() -> set[int]:
    with Session(auth_engine) as s:
        return set(s.exec(select(UnidadEstado.ue_id).where(UnidadEstado.activo == False)).all())  # noqa: E712


def de_baja(ue_id: int) -> UnidadEstado | None:
    with Session(auth_engine) as s:
        e = s.get(UnidadEstado, ue_id)
    return e if e and not e.activo else None


def bajas() -> list[UnidadEstado]:
    with Session(auth_engine) as s:
        return list(s.exec(select(UnidadEstado).where(UnidadEstado.activo == False)  # noqa: E712
                           .order_by(UnidadEstado.fecha_baja.desc(), UnidadEstado.ue_id)).all())


def dar_baja(ue_id: int, motivo: str, usuario: str) -> None:
    fecha = ahora()
    with Session(auth_engine) as s:
        e = s.get(UnidadEstado, ue_id) or UnidadEstado(ue_id=ue_id)
        if not e.activo:
            raise Conflicto("La unidad ya está dada de baja")
        e.activo, e.fecha_baja, e.motivo, e.usuario = False, fecha, motivo, usuario
        s.add(e)
        s.add(UnidadEstadoHistorial(ue_id=ue_id, accion="baja", motivo=motivo, usuario=usuario, fecha=fecha))
        try:
            s.commit()
        except IntegrityError:  # otra petición la dio de baja al mismo tiempo
            raise Conflicto("La unidad ya está dada de baja")


def dar_alta(ue_id: int, usuario: str) -> None:
    with Session(auth_engine) as s:
        e = s.get(UnidadEstado, ue_id)
        if e is None or e.activo:
            raise Conflicto("La unidad no está dada de baja")
        e.activo, e.fecha_baja, e.motivo, e.usuario = True, None, None, None
        s.add(e)
        s.add(UnidadEstadoHistorial(ue_id=ue_id, accion="alta", usuario=usuario))
        s.commit()


def historial(ue_id: int) -> list[dict]:
    with Session(auth_engine) as s:
        filas = s.exec(select(UnidadEstadoHistorial).where(UnidadEstadoHistorial.ue_id == ue_id)
                       .order_by(UnidadEstadoHistorial.fecha.desc(), UnidadEstadoHistorial.id.desc())).all()
    return [{"accion": h.accion, "motivo": h.motivo, "usuario": h.usuario, "fecha": iso(h.fecha)} for h in filas]
