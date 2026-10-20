from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


class UnidadEducativa(SQLModel, table=True):
    __tablename__ = "unidad_educativa"

    id: int | None = Field(default=None, primary_key=True)
    clave: str = Field(index=True, unique=True, description="RUE o nombre+distrito normalizado")
    codigo_rue: str | None = Field(default=None, index=True)
    nombre: str = Field(index=True)
    dependencia: str | None = Field(default=None, index=True, description="FISCAL | CONVENIO | PRIVADA | COMUNITARIA")
    tipo_convenio: str | None = None
    subsistema: str | None = Field(default=None, index=True)
    niveles: str | None = Field(default=None, description="CSV: INICIAL,PRIMARIA,SECUNDARIA,...")
    turnos: str | None = None
    distrito_municipal: int | None = Field(default=None, index=True)
    distrito_educativo: str | None = None
    zona: str | None = None
    direccion: str | None = None
    telefono: str | None = None
    director: str | None = None
    area: str | None = None
    lat: float | None = None
    lon: float | None = None
    estudiantes_total: int | None = None
    estudiantes_mujeres: int | None = None
    estudiantes_hombres: int | None = None
    docentes: int | None = None
    fuente: str | None = None
    actualizado: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
