"""API + dashboard de Unidades Educativas (fiscales, de convenio y privadas).

    uvicorn app.backend.main:app --reload
"""
from __future__ import annotations

import csv
import io
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import literal
from pydantic import BaseModel
from sqlmodel import Session, col, func, or_, select

from . import auth
from .db import engine, init_db
from .models import UnidadEducativa
from .pdf_report import build_pdf

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
EXPORT_FIELDS = [
    "id", "codigo_rue", "nombre", "dependencia", "tipo_convenio", "subsistema", "niveles", "turnos",
    "distrito_municipal", "distrito_educativo", "zona", "direccion", "telefono", "director", "area",
    "lat", "lon", "estudiantes_total", "estudiantes_mujeres", "estudiantes_hombres", "docentes",
]
OCULTOS = {"fuente"}  # de uso interno (trazabilidad del importador): no sale por la API ni en exportaciones

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    auth.init_auth_db()
    yield


app = FastAPI(title="Colegios Handihand", version="1.0.0", description=__doc__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

# Sin sesión: la API responde 401 y el dashboard redirige al login. Los recursos estáticos (js, css,
# vendor/) son públicos: los datos sólo salen por /api.
PUBLICAS = {"/api/auth/login", "/api/auth/sesion"}
PAGINAS = {"/", "/index.html"}


@app.middleware("http")
async def exigir_sesion(request: Request, call_next):
    path = request.url.path
    if auth.AUTH_ENABLED and path not in PUBLICAS and (path.startswith("/api/") or path in PAGINAS):
        request.state.usuario = auth.leer_token(request.cookies.get(auth.COOKIE))
        if request.state.usuario is None:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sesión requerida"}, status_code=401)
            return RedirectResponse("/login.html", status_code=303)
    return await call_next(request)


class Credenciales(BaseModel):
    usuario: str
    clave: str


@app.post("/api/auth/login", tags=["sesión"])
def login(datos: Credenciales, request: Request):
    ip = request.client.host if request.client else "?"
    if auth.bloqueado(ip):
        raise HTTPException(429, "Demasiados intentos fallidos. Espera unos minutos.")
    u = auth.autenticar(datos.usuario, datos.clave)
    if u is None:
        auth.registrar_fallo(ip)
        raise HTTPException(401, "Usuario o contraseña incorrectos")
    auth.limpiar_fallos(ip)
    resp = JSONResponse({"usuario": u.usuario, "nombre": u.nombre})
    resp.set_cookie(auth.COOKIE, auth.crear_token(u), max_age=auth.DURACION, httponly=True,
                    samesite="lax", secure=request.url.scheme == "https", path="/")
    return resp


@app.post("/api/auth/logout", tags=["sesión"])
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/auth/sesion", tags=["sesión"])
def sesion(request: Request):
    """Usuario de la sesión actual (null si no hay). `requerida` es false si el login está desactivado."""
    u = auth.leer_token(request.cookies.get(auth.COOKIE)) if auth.AUTH_ENABLED else None
    return {"requerida": auth.AUTH_ENABLED, "usuario": u and u.usuario, "nombre": u and u.nombre}


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def _en_lista(column, valores: list[str]):
    """Ítem exacto dentro de una lista separada por comas ('A,B,C'): 'PRIMARIA' no debe casar con
    'EDUCACIÓN PRIMARIA PARA ADULTOS'. Funciona igual en SQLite y PostgreSQL."""
    envuelta = literal(",").concat(column).concat(",")
    escapar = lambda v: v.upper().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return or_(*[envuelta.like(f"%,{escapar(v)},%", escape="\\") for v in valores])


class Filtros:
    def __init__(
        self,
        dependencia: Annotated[list[str] | None, Query(description="FISCAL, CONVENIO, PRIVADA, COMUNITARIA")] = None,
        distrito: Annotated[list[int] | None, Query()] = None,
        nivel: Annotated[list[str] | None, Query(description="INICIAL, PRIMARIA, SECUNDARIA, ALTERNATIVA, ESPECIAL")] = None,
        turno: Annotated[list[str] | None, Query()] = None,
        subsistema: Annotated[list[str] | None, Query(description="REGULAR, ALTERNATIVA, ESPECIAL, PERMANENTE")] = None,
        q: Annotated[str | None, Query(description="Busca en nombre, dirección, zona y RUE")] = None,
        bbox: Annotated[str | None, Query(description="minLon,minLat,maxLon,maxLat")] = None,
        con_coordenadas: bool | None = None,
    ):
        self.dependencia, self.distrito, self.nivel, self.turno = dependencia, distrito, nivel, turno
        self.subsistema, self.q, self.bbox, self.con_coordenadas = subsistema, q, bbox, con_coordenadas

    def apply(self, stmt):
        U = UnidadEducativa
        if self.dependencia:
            stmt = stmt.where(col(U.dependencia).in_([d.upper() for d in self.dependencia]))
        if self.distrito:
            stmt = stmt.where(col(U.distrito_municipal).in_(self.distrito))
        if self.nivel:
            stmt = stmt.where(_en_lista(col(U.niveles), self.nivel))
        if self.turno:
            stmt = stmt.where(_en_lista(col(U.turnos), self.turno))
        if self.subsistema:
            stmt = stmt.where(_en_lista(col(U.subsistema), self.subsistema))
        if self.q:
            like = f"%{self.q.strip()}%"
            stmt = stmt.where(or_(col(U.nombre).ilike(like), col(U.direccion).ilike(like),
                                  col(U.zona).ilike(like), col(U.codigo_rue).ilike(like)))
        if self.bbox:
            try:
                x1, y1, x2, y2 = map(float, self.bbox.split(","))
            except ValueError:
                raise HTTPException(422, "bbox debe ser minLon,minLat,maxLon,maxLat")
            stmt = stmt.where(U.lon >= x1, U.lon <= x2, U.lat >= y1, U.lat <= y2)
        if self.con_coordenadas is True:
            stmt = stmt.where(col(U.lat).is_not(None), col(U.lon).is_not(None))
        elif self.con_coordenadas is False:
            stmt = stmt.where(or_(col(U.lat).is_(None), col(U.lon).is_(None)))
        return stmt


FiltrosDep = Annotated[Filtros, Depends()]
ORDENABLES = {"nombre", "distrito_municipal", "dependencia", "estudiantes_total", "codigo_rue"}


@app.get("/api/unidades", tags=["unidades"])
def listar(
    session: SessionDep, filtros: FiltrosDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=500)] = 50,
    orden: str = "nombre",
):
    desc = orden.startswith("-")
    campo = orden.lstrip("-")
    if campo not in ORDENABLES:
        raise HTTPException(422, f"orden debe ser uno de {sorted(ORDENABLES)}")
    base = filtros.apply(select(UnidadEducativa))
    total = session.exec(select(func.count()).select_from(base.subquery())).one()
    sort_col = getattr(UnidadEducativa, campo)
    rows = session.exec(
        # NULLS LAST explícito: PostgreSQL y SQLite difieren por defecto en DESC
        base.order_by((sort_col.desc() if desc else sort_col.asc()).nulls_last(), UnidadEducativa.id)
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return {"count": total, "page": page, "page_size": page_size,
            "results": [r.model_dump(exclude=OCULTOS) for r in rows]}


@app.get("/api/unidades/{ue_id}", tags=["unidades"])
def detalle(ue_id: int, session: SessionDep):
    row = session.get(UnidadEducativa, ue_id)
    if row is None:
        raise HTTPException(404, "Unidad educativa no encontrada")
    return row.model_dump(exclude=OCULTOS)


@app.get("/api/geojson", tags=["mapa"])
def geojson(session: SessionDep, filtros: FiltrosDep):
    stmt = filtros.apply(select(UnidadEducativa)).where(
        col(UnidadEducativa.lat).is_not(None), col(UnidadEducativa.lon).is_not(None))
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r.lon, r.lat]},
            "properties": {"id": r.id, "nombre": r.nombre, "dependencia": r.dependencia,
                           "distrito": r.distrito_municipal, "niveles": r.niveles},
        }
        for r in session.exec(stmt).all()
    ]
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/estadisticas", tags=["indicadores"])
def estadisticas(session: SessionDep, filtros: FiltrosDep):
    rows = session.exec(filtros.apply(select(UnidadEducativa))).all()
    por_dep = Counter(r.dependencia or "SIN DATO" for r in rows)
    por_nivel: Counter = Counter()
    por_turno: Counter = Counter()
    por_sub: Counter = Counter()
    distrito_dep: dict = defaultdict(Counter)
    est_dep: Counter = Counter()
    mujeres = hombres = docentes = 0
    for r in rows:
        for n in (r.niveles or "SIN DATO").split(","):
            por_nivel[n] += 1
        for t in (r.turnos or "SIN DATO").split(","):
            por_turno[t] += 1
        for x in (r.subsistema or "SIN DATO").split(","):
            por_sub[x] += 1
        distrito_dep[r.distrito_municipal if r.distrito_municipal is not None else "SIN DATO"][r.dependencia or "SIN DATO"] += 1
        est_dep[r.dependencia or "SIN DATO"] += r.estudiantes_total or 0
        mujeres += r.estudiantes_mujeres or 0
        hombres += r.estudiantes_hombres or 0
        docentes += r.docentes or 0
    # Sin matrícula en los datos: null (el frontend oculta el KPI) en vez de un 0 engañoso
    hay_matricula = any(r.estudiantes_total is not None for r in rows)
    total_est = sum(est_dep.values()) if hay_matricula else None
    return {
        "total_unidades": len(rows),
        "por_dependencia": dict(por_dep),
        "por_nivel": dict(por_nivel),
        "por_turno": dict(por_turno),
        "por_subsistema": dict(por_sub),
        "por_distrito": {str(k): dict(v) for k, v in sorted(distrito_dep.items(), key=lambda kv: (isinstance(kv[0], str), kv[0]))},
        "estudiantes": {"total": total_est, "mujeres": mujeres if hay_matricula else None,
                        "hombres": hombres if hay_matricula else None, "por_dependencia": dict(est_dep) if hay_matricula else {}},
        "docentes": docentes or None,
        "ratio_estudiante_docente": round(total_est / docentes, 1) if docentes and total_est else None,
        "sin_coordenadas": sum(1 for r in rows if r.lat is None or r.lon is None),
    }


@app.get("/api/catalogos", tags=["indicadores"])
def catalogos(session: SessionDep):
    U = UnidadEducativa
    distritos = session.exec(select(U.distrito_municipal).where(col(U.distrito_municipal).is_not(None)).distinct()).all()
    niveles, turnos, subsistemas = set(), set(), set()
    for n, t, sub in session.exec(select(U.niveles, U.turnos, U.subsistema)).all():
        niveles.update(filter(None, (n or "").split(",")))
        turnos.update(filter(None, (t or "").split(",")))
        subsistemas.update(filter(None, (sub or "").split(",")))
    deps = session.exec(select(U.dependencia).where(col(U.dependencia).is_not(None)).distinct()).all()
    con_matricula = session.exec(select(U.id).where(col(U.estudiantes_total).is_not(None)).limit(1)).first() is not None
    return {"dependencias": sorted(deps), "distritos": sorted(distritos), "niveles": sorted(niveles),
            "turnos": sorted(turnos), "subsistemas": sorted(subsistemas),
            "campos": {"matricula": con_matricula}}


@app.get("/api/export.{fmt}", tags=["exportar"])
def exportar(fmt: str, session: SessionDep, filtros: FiltrosDep):
    rows = session.exec(filtros.apply(select(UnidadEducativa)).order_by(UnidadEducativa.distrito_municipal, UnidadEducativa.nombre)).all()
    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=EXPORT_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow(r.model_dump())
        return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": "attachment; filename=unidades_educativas.csv"})
    if fmt == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Unidades educativas"
        ws.append(EXPORT_FIELDS)
        for r in rows:
            d = r.model_dump()
            ws.append([d.get(f) for f in EXPORT_FIELDS])
        ws.auto_filter.ref = ws.dimensions
        ws.freeze_panes = "A2"
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                 headers={"Content-Disposition": "attachment; filename=unidades_educativas.xlsx"})
    if fmt == "pdf":
        return Response(build_pdf(rows), media_type="application/pdf",
                        headers={"Content-Disposition": "attachment; filename=unidades_educativas.pdf"})
    raise HTTPException(404, "Formato no soportado: csv, xlsx, pdf")


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
