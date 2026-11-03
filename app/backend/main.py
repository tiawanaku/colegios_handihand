"""API + dashboard de Unidades Educativas (fiscales, de convenio y privadas).

    uvicorn app.backend.main:app --reload
"""
from __future__ import annotations

import csv
import io
import json
from collections import Counter, defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import literal
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, StrictBool
from sqlmodel import Session, col, func, or_, select

from . import auth, estado, registro
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
    resp = JSONResponse({"usuario": u.usuario, "nombre": u.nombre, "rol": auth.rol_de(u)})
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
    """Usuario de la sesión actual (null si no hay). `requerida` es false si el login está desactivado,
    y entonces el rol es `encargado` (modo desarrollo)."""
    if not auth.AUTH_ENABLED:
        return {"requerida": False, "usuario": None, "nombre": None, "rol": "encargado"}
    u = auth.leer_token(request.cookies.get(auth.COOKIE))
    return {"requerida": True, "usuario": u and u.usuario, "nombre": u and u.nombre, "rol": u and auth.rol_de(u)}


def exigir_encargado(request: Request) -> str:
    """Usuario que firma el cambio. El middleware ya garantizó la sesión; aquí se exige el rol."""
    if not auth.AUTH_ENABLED:
        return "dev"
    u = getattr(request.state, "usuario", None)
    if u is None:
        raise HTTPException(401, "Sesión requerida")
    if auth.rol_de(u) != "encargado":
        raise HTTPException(403, "Se requiere el rol de encargado")
    return u.usuario


EncargadoDep = Annotated[str, Depends(exigir_encargado)]


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def solo_activas(stmt):
    """Excluye las unidades dadas de baja (tabla propia en la BD del sistema, no en la vista)."""
    bajas = estado.ids_de_baja()
    return stmt.where(col(UnidadEducativa.id).not_in(bajas)) if bajas else stmt


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
        stmt = solo_activas(stmt)
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
        if caja := self._caja():
            x1, y1, x2, y2 = caja
            stmt = stmt.where(U.lon >= x1, U.lon <= x2, U.lat >= y1, U.lat <= y2)
        if self.con_coordenadas is True:
            stmt = stmt.where(col(U.lat).is_not(None), col(U.lon).is_not(None))
        elif self.con_coordenadas is False:
            stmt = stmt.where(or_(col(U.lat).is_(None), col(U.lon).is_(None)))
        return stmt

    def _caja(self) -> tuple[float, ...] | None:
        if not self.bbox:
            return None
        try:
            x1, y1, x2, y2 = map(float, self.bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox debe ser minLon,minLat,maxLon,maxLat")
        return x1, y1, x2, y2

    def registrados(self) -> list[UnidadEducativa]:
        """Colegios registrados (tabla propia) activos que pasan los mismos filtros que apply() en SQL."""
        bajas, caja = estado.ids_de_baja(), self._caja()
        return [u for u in map(registro.a_unidad, registro.todas()) if u.id not in bajas and self._cumple(u, caja)]

    def _cumple(self, u: UnidadEducativa, caja) -> bool:
        items = lambda v: set((v or "").split(","))
        if self.dependencia and u.dependencia not in {d.upper() for d in self.dependencia}:
            return False
        if self.distrito and u.distrito_municipal not in self.distrito:
            return False
        for valores, campo in ((self.nivel, u.niveles), (self.turno, u.turnos), (self.subsistema, u.subsistema)):
            if valores and not items(campo) & {v.upper() for v in valores}:
                return False
        if self.q:
            texto = self.q.strip().lower()
            if not any(texto in (x or "").lower() for x in (u.nombre, u.direccion, u.zona, u.codigo_rue)):
                return False
        con_coord = u.lat is not None and u.lon is not None
        if caja and not (con_coord and caja[0] <= u.lon <= caja[2] and caja[1] <= u.lat <= caja[3]):
            return False
        return self.con_coordenadas is None or self.con_coordenadas == con_coord

    def todas(self, session: Session, stmt=None) -> list[UnidadEducativa]:
        """Vista filtrada más registrados filtrados."""
        return list(session.exec(self.apply(stmt if stmt is not None else select(UnidadEducativa))).all()) + self.registrados()


def _ordenar(rows: list, campo: str, desc: bool) -> list:
    # como el ORDER BY de SQL: nulos al final y desempate por id (sort de Python es estable, también con reverse)
    rows = sorted(rows, key=lambda r: r.id)
    con = sorted((r for r in rows if getattr(r, campo) is not None), key=lambda r: getattr(r, campo), reverse=desc)
    return con + [r for r in rows if getattr(r, campo) is None]


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
    if extra := filtros.registrados():
        # con colegios registrados se combina y pagina en Python (son pocos cientos de filas)
        todas = _ordenar(list(session.exec(filtros.apply(select(UnidadEducativa))).all()) + extra, campo, desc)
        total, rows = len(todas), todas[(page - 1) * page_size:page * page_size]
    else:
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


def _buscar(session: Session, ue_id: int) -> tuple[UnidadEducativa | None, registro.UnidadRegistrada | None]:
    if (reg := registro.obtener(ue_id)) is not None:
        return registro.a_unidad(reg), reg
    return session.get(UnidadEducativa, ue_id), None


def _ficha(row: UnidadEducativa, reg: registro.UnidadRegistrada | None) -> dict:
    datos = row.model_dump(exclude=OCULTOS)
    if reg is not None:
        datos["registrado"] = True
        datos["registro"] = {"usuario": reg.usuario, "fecha": estado.iso(reg.creado)}
    if (e := estado.de_baja(row.id)) is not None:
        datos["baja"] = {"fecha": estado.iso(e.fecha_baja), "motivo": e.motivo, "usuario": e.usuario}
    return datos


@app.get("/api/unidades/{ue_id}", tags=["unidades"])
def detalle(ue_id: int, session: SessionDep):
    row, reg = _buscar(session, ue_id)
    if row is None:
        raise HTTPException(404, "Unidad educativa no encontrada")
    return _ficha(row, reg)


MAX_CUERPO = 64 * 1024


@app.post("/api/unidades", tags=["registro"], status_code=201)
async def registrar_unidad(request: Request):
    """Registra un colegio nuevo (cualquier usuario con sesión). Los errores de validación llegan como
    422 `{detail, errores: {campo: mensaje}}`, también si el JSON está mal formado."""
    if auth.AUTH_ENABLED:
        u = getattr(request.state, "usuario", None)
        if u is None:
            raise HTTPException(401, "Sesión requerida")
        usuario = u.usuario
    else:
        usuario = "dev"
    cuerpo = await request.body()
    try:
        datos = json.loads(cuerpo) if len(cuerpo) <= MAX_CUERPO else None
    except (ValueError, RecursionError):
        datos = None
    try:
        reg = await run_in_threadpool(registro.registrar, datos, usuario)
    except registro.ErrorValidacion as e:
        return JSONResponse({"detail": "Revise los datos del colegio", "errores": e.errores}, status_code=422)
    unidad = _ficha(registro.a_unidad(reg), reg)
    return JSONResponse(jsonable_encoder({"ok": True, "id": reg.id, "unidad": unidad}), status_code=201)


class Baja(BaseModel):
    motivo: str | None = None
    confirmar: StrictBool | None = None


class Alta(BaseModel):
    confirmar: StrictBool | None = None


def _confirmada(confirmar: bool | None) -> None:
    # la confirmación del diálogo también se exige en el servidor
    if confirmar is not True:
        raise HTTPException(422, "Debe confirmar la operación (confirmar: true)")


def _existente(session: Session, ue_id: int) -> None:
    if _buscar(session, ue_id)[0] is None:
        raise HTTPException(404, "Unidad educativa no encontrada")


@app.post("/api/unidades/{ue_id}/baja", tags=["estado"])
def dar_baja(ue_id: int, datos: Baja, session: SessionDep, usuario: EncargadoDep):
    _confirmada(datos.confirmar)
    motivo = (datos.motivo or "").strip()
    if not motivo or len(motivo) > 300:
        raise HTTPException(422, "El motivo es obligatorio (máximo 300 caracteres)")
    _existente(session, ue_id)
    try:
        estado.dar_baja(ue_id, motivo, usuario)
    except estado.Conflicto as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "id": ue_id, "estado": "baja"}


@app.post("/api/unidades/{ue_id}/alta", tags=["estado"])
def dar_alta(ue_id: int, datos: Alta, session: SessionDep, usuario: EncargadoDep):
    _confirmada(datos.confirmar)
    _existente(session, ue_id)
    try:
        estado.dar_alta(ue_id, usuario)
    except estado.Conflicto as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "id": ue_id, "estado": "activa"}


@app.get("/api/unidades/{ue_id}/historial", tags=["estado"])
def historial(ue_id: int, session: SessionDep, _usuario: EncargadoDep):
    _existente(session, ue_id)
    return estado.historial(ue_id)


@app.get("/api/bajas", tags=["estado"])
def listar_bajas(session: SessionDep, _usuario: EncargadoDep):
    """Unidades dadas de baja, la más reciente primero. Nombre y demás datos salen de la vista."""
    filas = estado.bajas()
    U = UnidadEducativa
    unidades = {u.id: u for u in session.exec(select(U).where(col(U.id).in_([f.ue_id for f in filas])))} if filas else {}
    if filas and any(f.ue_id >= registro.PRIMER_ID for f in filas):
        unidades.update((r.id, registro.a_unidad(r)) for r in registro.todas())
    return [
        {"id": f.ue_id, "nombre": (u := unidades.get(f.ue_id)) and u.nombre,
         "distrito_municipal": u and u.distrito_municipal, "dependencia": u and u.dependencia,
         "fecha_baja": estado.iso(f.fecha_baja), "motivo": f.motivo, "usuario": f.usuario}
        for f in filas
    ]


@app.get("/api/geojson", tags=["mapa"])
def geojson(session: SessionDep, filtros: FiltrosDep):
    stmt = select(UnidadEducativa).where(col(UnidadEducativa.lat).is_not(None), col(UnidadEducativa.lon).is_not(None))
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r.lon, r.lat]},
            "properties": {"id": r.id, "nombre": r.nombre, "dependencia": r.dependencia,
                           "distrito": r.distrito_municipal, "niveles": r.niveles},
        }
        for r in filtros.todas(session, stmt) if r.lat is not None and r.lon is not None
    ]
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/estadisticas", tags=["indicadores"])
def estadisticas(session: SessionDep, filtros: FiltrosDep):
    rows = filtros.todas(session)
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
    distritos = session.exec(solo_activas(select(U.distrito_municipal).where(col(U.distrito_municipal).is_not(None)).distinct())).all()
    niveles, turnos, subsistemas = set(), set(), set()
    for n, t, sub in session.exec(solo_activas(select(U.niveles, U.turnos, U.subsistema))).all():
        niveles.update(filter(None, (n or "").split(",")))
        turnos.update(filter(None, (t or "").split(",")))
        subsistemas.update(filter(None, (sub or "").split(",")))
    deps = set(session.exec(solo_activas(select(U.dependencia).where(col(U.dependencia).is_not(None)).distinct())).all())
    distritos = set(distritos)
    for r in Filtros().registrados():
        niveles.update(filter(None, r.niveles.split(",")))
        turnos.update(filter(None, r.turnos.split(",")))
        subsistemas.update(filter(None, r.subsistema.split(",")))
        deps.add(r.dependencia)
        distritos.add(r.distrito_municipal)
    con_matricula = session.exec(solo_activas(select(U.id).where(col(U.estudiantes_total).is_not(None))).limit(1)).first() is not None
    return {"dependencias": sorted(deps), "distritos": sorted(distritos), "niveles": sorted(niveles),
            "turnos": sorted(turnos), "subsistemas": sorted(subsistemas),
            "campos": {"matricula": con_matricula},
            "opciones_registro": {"dependencias": registro.DEPENDENCIAS, "subsistemas": registro.SUBSISTEMAS,
                                  "turnos": registro.TURNOS, "niveles": sorted(niveles),
                                  "distritos": registro.DISTRITOS, "area": registro.AREA}}


@app.get("/api/export.{fmt}", tags=["exportar"])
def exportar(fmt: str, session: SessionDep, filtros: FiltrosDep):
    rows = session.exec(filtros.apply(select(UnidadEducativa)).order_by(UnidadEducativa.distrito_municipal, UnidadEducativa.nombre)).all()
    if extra := filtros.registrados():
        rows = sorted([*rows, *extra], key=lambda r: (r.distrito_municipal is None, r.distrito_municipal or 0, r.nombre))
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
