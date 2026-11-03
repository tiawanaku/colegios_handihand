import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture()
def client(tmp_path_factory):
    # la BD se fija antes del primer import de app.backend.db
    os.environ.setdefault("COLEGIOS_DB", f"sqlite:///{tmp_path_factory.getbasetemp() / 'test.db'}")
    os.environ.setdefault("COLEGIOS_AUTH_DB", f"sqlite:///{tmp_path_factory.getbasetemp() / 'usuarios.db'}")
    from fastapi.testclient import TestClient
    from sqlmodel import SQLModel

    from app.backend import auth, importer
    from app.backend.db import engine
    from app.backend.main import app

    SQLModel.metadata.drop_all(engine)
    importer.upsert(importer.read_file(ROOT / "app/data/demo_unidades.csv"), "DEMO")
    auth.AuthModel.metadata.drop_all(auth.auth_engine)
    auth.init_auth_db()
    auth._fallos.clear()
    nuevo_usuario("analista", "clave-segura-1", nombre="Ana Lista")
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"usuario": "analista", "clave": "clave-segura-1"}).status_code == 200
        c.importer = importer
        yield c


def nuevo_usuario(usuario, clave, **kw):
    from sqlmodel import Session

    from app.backend import auth

    with Session(auth.auth_engine) as s:
        u = auth.Usuario(usuario=usuario, clave_hash=auth.hash_clave(clave), **kw)
        s.add(u)
        s.commit()
        s.refresh(u)
        return u


def test_normalize_aliases():
    from app.backend.normalize import normalize_record

    rec = normalize_record({"Nombre": " u.e.  san  andrés ", "Dist.": "D-8", "Dependencia": "Fiscal de Convenio",
                            "Dirección": "Av. X", "Nivel": "Primaria Comunitaria Vocacional / Secundaria",
                            "Latitud": "-16,51", "Longitud": "-68.17"})
    assert rec["nombre"] == "U.E. SAN ANDRÉS"
    assert rec["distrito_municipal"] == 8
    assert rec["dependencia"] == "CONVENIO"
    assert rec["niveles"] == "PRIMARIA,SECUNDARIA"
    assert rec["subsistema"] == "REGULAR"
    assert (rec["lat"], rec["lon"]) == (-16.51, -68.17)


@pytest.mark.parametrize("raw,expected", [("PÚBLICA", "FISCAL"), ("Privada", "PRIVADA"), ("particular", "PRIVADA"),
                                          ("CONVENIO", "CONVENIO"), ("Comunitaria", "COMUNITARIA")])
def test_dependencias(raw, expected):
    from app.backend.normalize import norm_dependencia

    assert norm_dependencia(raw) == expected


def test_swapped_coordinates_fixed():
    from app.backend.normalize import normalize_record

    rec = normalize_record({"nombre": "x", "lat": -68.2, "lon": -16.5})
    assert (rec["lat"], rec["lon"]) == (-16.5, -68.2)


def test_list_filters_and_pagination(client):
    r = client.get("/api/unidades", params={"dependencia": "PRIVADA", "page_size": 5}).json()
    assert r["count"] > 0 and len(r["results"]) <= 5
    assert {x["dependencia"] for x in r["results"]} == {"PRIVADA"}
    r = client.get("/api/unidades", params=[("distrito", 3), ("distrito", 4)]).json()
    assert {x["distrito_municipal"] for x in r["results"]} <= {3, 4}
    assert client.get("/api/unidades", params={"orden": "drop table"}).status_code == 422


def test_stats_consistent(client):
    s = client.get("/api/estadisticas").json()
    assert s["total_unidades"] == 180
    assert sum(s["por_dependencia"].values()) == 180
    assert sum(sum(v.values()) for v in s["por_distrito"].values()) == 180
    conv = client.get("/api/estadisticas", params={"dependencia": "CONVENIO"}).json()
    assert conv["total_unidades"] == s["por_dependencia"]["CONVENIO"]


def test_geojson_and_bbox(client):
    gj = client.get("/api/geojson").json()
    assert gj["type"] == "FeatureCollection" and len(gj["features"]) == 180
    small = client.get("/api/geojson", params={"bbox": "-68.2,-16.52,-68.18,-16.49"}).json()
    assert 0 < len(small["features"]) < 180


def filas_pdf(path):
    """Filas de la tabla del PDF exportado (la cabecera, que se repite en cada página, se descarta)."""
    import pdfplumber

    filas = []
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                header = [(c or "").strip().lower() for c in table[0]]
                filas += [dict(zip(header, row)) for row in table[1:] if row[0]]
    return filas


def test_exports_and_pdf_roundtrip(client, tmp_path):
    assert client.get("/api/export.csv").text.count("\n") == 181
    assert client.get("/api/export.xlsx").content[:2] == b"PK"
    pdf = client.get("/api/export.pdf", params={"dependencia": "CONVENIO"})
    assert pdf.content[:4] == b"%PDF"
    path = tmp_path / "reporte.pdf"
    path.write_bytes(pdf.content)
    rows = filas_pdf(path)
    expected = client.get("/api/estadisticas", params={"dependencia": "CONVENIO"}).json()["total_unidades"]
    assert len(rows) == expected
    assert {r["dependencia"] for r in rows} == {"CONVENIO"}


def test_import_drf_and_geojson_shapes(client, tmp_path):
    drf = tmp_path / "drf.json"
    drf.write_text(json.dumps({"count": 2, "next": None, "results": [
        {"codigo_rue": "40730001", "unidad_educativa": "U.E. PRUEBA A", "distrito": 5, "dependencia": "Privada"},
        {"codigo_rue": "40730002", "unidad_educativa": "U.E. PRUEBA B", "distrito": 6, "dependencia": "Fiscal"}]}))
    geo = tmp_path / "geo.geojson"
    geo.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-68.18, -16.5]},
         "properties": {"rue": "40730001", "nombre": "U.E. PRUEBA A", "turno": "Mañana"}}]}))
    imp = client.importer
    assert imp.upsert(imp.read_file(drf), "t")["nuevos"] == 2
    assert imp.upsert(imp.read_file(geo), "t")["actualizados"] == 1  # mismo RUE: completa coordenadas
    r = client.get("/api/unidades", params={"q": "40730001"}).json()["results"][0]
    assert (r["lat"], r["turnos"], r["dependencia"]) == (-16.5, "MANANA", "PRIVADA")


def test_filtro_por_item_exacto(client, tmp_path):
    # Valores reales del catálogo de cuidados: 'ESPECIAL' no debe casar con 'EDUCACIÓN ESPECIAL ...'
    data = tmp_path / "eav.json"
    data.write_text(json.dumps([
        {"nombre": "UE ESP", "dist": 1, "dependencia": "FISCAL"},
        {"nombre": "UE ADUL", "dist": 1, "dependencia": "FISCAL"},
    ]))
    client.importer.upsert(client.importer.read_file(data), "t")
    from sqlmodel import Session, select

    from app.backend.db import engine
    from app.backend.models import UnidadEducativa

    with Session(engine) as s:  # como llegan de la vista SQL, sin normalizar
        for nombre, niveles, turnos in [("UE ESP", "ESPECIAL", "MAÑANA"),
                                        ("UE ADUL", "EDUCACIÓN PRIMARIA PARA ADULTOS,TÉCNICO MEDIO", "NOCHE")]:
            row = s.exec(select(UnidadEducativa).where(UnidadEducativa.nombre == nombre)).one()
            row.niveles, row.turnos = niveles, turnos
        s.commit()
    names = lambda **p: {r["nombre"] for r in client.get("/api/unidades", params={**p, "page_size": 500}).json()["results"]}
    assert "UE ESP" in names(nivel="ESPECIAL") and "UE ADUL" not in names(nivel="ESPECIAL")
    assert "UE ADUL" in names(nivel="TÉCNICO MEDIO")
    assert names(nivel="PRIMARIA") & {"UE ADUL"} == set()   # 'PRIMARIA' ≠ 'EDUCACIÓN PRIMARIA PARA ADULTOS'
    assert names(turno="MAÑANA") & {"UE ESP", "UE ADUL"} == {"UE ESP"}
    assert names(nivel="100%_") == set()                     # comodines de LIKE escapados


def test_sin_matricula_devuelve_null(client):
    from sqlmodel import Session, SQLModel

    from app.backend.db import engine

    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    client.importer.upsert([{"nombre": "UE SOLA", "dependencia": "PRIVADA"}], "t")
    s = client.get("/api/estadisticas").json()
    assert s["estudiantes"]["total"] is None and s["ratio_estudiante_docente"] is None
    assert client.get("/api/catalogos").json()["campos"] == {"matricula": False}


def test_hash_de_clave():
    from app.backend.auth import hash_clave, verificar_clave

    h = hash_clave("secreta123")
    assert h.startswith("scrypt$") and "secreta123" not in h
    assert verificar_clave("secreta123", h) and not verificar_clave("secreta124", h)
    assert hash_clave("secreta123") != h                       # sal distinta cada vez
    assert not verificar_clave("x", "basura") and not verificar_clave("x", "md5$1$2$3$4$5")


def test_sin_sesion_api_401_y_dashboard_redirige(client):
    client.post("/api/auth/logout")
    assert client.get("/api/unidades").status_code == 401
    assert client.get("/api/export.csv").status_code == 401
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login.html"
    assert client.get("/login.html").status_code == 200        # el login y sus recursos son públicos
    assert client.get("/styles.css").status_code == 200
    assert client.get("/api/auth/sesion").json() == {"requerida": True, "usuario": None, "nombre": None, "rol": None}


def test_login_y_logout(client):
    s = client.get("/api/auth/sesion").json()
    assert (s["usuario"], s["nombre"]) == ("analista", "Ana Lista")
    assert client.get("/", follow_redirects=False).status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/catalogos").status_code == 401
    r = client.post("/api/auth/login", json={"usuario": "  ANALISTA ", "clave": "clave-segura-1"})
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert client.get("/api/catalogos").status_code == 200


def test_credenciales_invalidas_y_bloqueo(client):
    from app.backend import auth

    client.post("/api/auth/logout")
    for datos in [{"usuario": "analista", "clave": "mala"}, {"usuario": "nadie", "clave": "x"}]:
        r = client.post("/api/auth/login", json=datos)
        assert r.status_code == 401 and r.json()["detail"] == "Usuario o contraseña incorrectos"
    for _ in range(auth.MAX_FALLOS - 2):
        client.post("/api/auth/login", json={"usuario": "analista", "clave": "mala"})
    # bloqueado aunque ahora la clave sea correcta
    assert client.post("/api/auth/login", json={"usuario": "analista", "clave": "clave-segura-1"}).status_code == 429
    auth._fallos.clear()


def test_token_alterado_vencido_o_usuario_inactivo(client):
    from sqlmodel import Session

    from app.backend import auth

    u = nuevo_usuario("temporal", "clave-temporal")
    token = auth.crear_token(u)
    assert auth.leer_token(token).usuario == "temporal"
    uid, exp, firma = token.split(".")
    assert auth.leer_token(f"{int(uid) + 1}.{exp}.{firma}") is None   # otro id con la misma firma
    assert auth.leer_token(f"{uid}.{int(exp) + 999}.{firma}") is None        # extender la expiración
    assert auth.leer_token(auth.crear_token(u, ahora=0)) is None              # vencido
    assert auth.leer_token("basura") is None and auth.leer_token(None) is None
    with Session(auth.auth_engine) as s:
        s.get(auth.Usuario, u.id).activo = False
        s.commit()
    assert auth.leer_token(token) is None
    assert auth.autenticar("temporal", "clave-temporal") is None


def test_cli_crear_usuario(client, monkeypatch, capsys):
    from app.backend import auth

    monkeypatch.setattr(auth.getpass, "getpass", lambda _prompt: "otra-clave-1")
    auth.main(["crear", "Nuevo", "--nombre", "Nuevo Usuario"])
    assert auth.autenticar("nuevo", "otra-clave-1").nombre == "Nuevo Usuario"
    with pytest.raises(SystemExit):
        auth.main(["crear", "nuevo"])
    auth.main(["desactivar", "nuevo"])
    assert auth.autenticar("nuevo", "otra-clave-1") is None
    auth.main(["listar"])
    out = capsys.readouterr().out
    assert "INACTIVO" in out and "consulta" in out
    auth.main(["crear", "jefa", "--rol", "encargado"])
    assert auth.autenticar("jefa", "otra-clave-1").rol == "encargado"
    auth.main(["rol", "nuevo", "encargado"])
    auth.main(["activar", "nuevo"])
    assert auth.autenticar("nuevo", "otra-clave-1").rol == "encargado"
    with pytest.raises(SystemExit):
        auth.main(["rol", "nuevo", "admin"])


def test_fuente_no_se_expone(client):
    # La fuente sólo se guarda para trazabilidad interna: no aparece en API, catálogos ni exportaciones
    r = client.get("/api/unidades", params={"page_size": 1}).json()["results"][0]
    assert "fuente" not in r and "fuente" not in client.get(f"/api/unidades/{r['id']}").json()
    assert "fuentes" not in client.get("/api/catalogos").json()
    assert "fuente" not in client.get("/api/export.csv").text.splitlines()[0]


# ---------------------------------------------------------------- HU-01: exportación sólo por backend
def test_exportes_siguen_en_backend_y_exigen_sesion(client):
    for fmt in ("csv", "xlsx", "pdf"):
        assert client.get(f"/api/export.{fmt}").status_code == 200
    client.post("/api/auth/logout")
    for fmt in ("csv", "xlsx", "pdf"):
        r = client.get(f"/api/export.{fmt}")
        assert r.status_code == 401 and r.json() == {"detail": "Sesión requerida"}


# ---------------------------------------------------------------- HU-02: baja y alta de colegios
def como(client, usuario, rol):
    nuevo_usuario(usuario, "clave-segura-2", rol=rol)
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"usuario": usuario, "clave": "clave-segura-2"}).json()["rol"] == rol


def una_unidad(client):
    return client.get("/api/unidades", params={"page_size": 1, "con_coordenadas": True}).json()["results"][0]


def visible(client, ue):
    stats = client.get("/api/estadisticas").json()
    ids_mapa = {f["properties"]["id"] for f in client.get("/api/geojson").json()["features"]}
    ids_lista = {r["id"] for r in client.get("/api/unidades", params={"page_size": 500}).json()["results"]}
    ids_q = {r["id"] for r in client.get("/api/unidades", params={"q": ue["nombre"]}).json()["results"]}
    assert (ue["id"] in ids_mapa) == (ue["id"] in ids_lista) == (ue["id"] in ids_q)
    return stats["total_unidades"], ue["id"] in ids_lista


def test_baja_oculta_y_alta_restituye(client):
    como(client, "encargada", "encargado")
    ue = una_unidad(client)
    assert visible(client, ue) == (180, True)
    r = client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "  Cerró en 2026 ", "confirmar": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "id": ue["id"], "estado": "baja"}
    assert visible(client, ue) == (179, False)
    assert sum(client.get("/api/estadisticas").json()["por_dependencia"].values()) == 179
    assert client.get("/api/export.csv").text.count("\n") == 180
    ficha = client.get(f"/api/unidades/{ue['id']}").json()   # la ficha sigue disponible, marcada
    assert ficha["baja"]["motivo"] == "Cerró en 2026" and ficha["baja"]["usuario"] == "encargada"
    assert ficha["baja"]["fecha"].endswith("+00:00")
    bajas = client.get("/api/bajas").json()
    assert bajas == [{"id": ue["id"], "nombre": ue["nombre"], "distrito_municipal": ue["distrito_municipal"],
                      "dependencia": ue["dependencia"], "fecha_baja": ficha["baja"]["fecha"],
                      "motivo": "Cerró en 2026", "usuario": "encargada"}]

    r = client.post(f"/api/unidades/{ue['id']}/alta", json={"confirmar": True})
    assert r.status_code == 200 and r.json() == {"ok": True, "id": ue["id"], "estado": "activa"}
    assert visible(client, ue) == (180, True)
    assert "baja" not in client.get(f"/api/unidades/{ue['id']}").json()
    assert client.get("/api/bajas").json() == []
    hist = client.get(f"/api/unidades/{ue['id']}/historial").json()
    assert [(h["accion"], h["usuario"]) for h in hist] == [("alta", "encargada"), ("baja", "encargada")]
    assert hist[1]["motivo"] == "Cerró en 2026" and all(h["fecha"] for h in hist)


def test_baja_excluye_de_catalogos(client):
    como(client, "encargada", "encargado")
    client.importer.upsert([{"nombre": "UE UNICA", "dist": 99, "dependencia": "COMUNITARIA"}], "t")
    ue = client.get("/api/unidades", params={"q": "UE UNICA"}).json()["results"][0]
    assert 99 in client.get("/api/catalogos").json()["distritos"]
    client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "x", "confirmar": True})
    c = client.get("/api/catalogos").json()
    assert 99 not in c["distritos"] and "COMUNITARIA" not in c["dependencias"]


@pytest.mark.parametrize("body", [{"motivo": "x"}, {"motivo": "x", "confirmar": False},
                                  {"motivo": "x", "confirmar": "true"}, {"motivo": "x", "confirmar": 1},
                                  {"motivo": "  ", "confirmar": True}, {"confirmar": True},
                                  {"motivo": "x" * 301, "confirmar": True}])
def test_baja_exige_confirmacion_y_motivo(client, body):
    como(client, "encargada", "encargado")
    ue = una_unidad(client)
    assert client.post(f"/api/unidades/{ue['id']}/baja", json=body).status_code == 422
    assert visible(client, ue) == (180, True)
    assert client.get(f"/api/unidades/{ue['id']}/historial").json() == []


def test_alta_exige_confirmacion_404_y_409(client):
    como(client, "encargada", "encargado")
    ue = una_unidad(client)
    url = f"/api/unidades/{ue['id']}"
    assert client.post(f"{url}/alta", json={"confirmar": True}).status_code == 409       # no estaba de baja
    assert client.post(f"{url}/baja", json={"motivo": "x", "confirmar": True}).status_code == 200
    assert client.post(f"{url}/baja", json={"motivo": "x", "confirmar": True}).status_code == 409
    for body in ({}, {"confirmar": False}):
        assert client.post(f"{url}/alta", json=body).status_code == 422
    assert visible(client, ue)[1] is False
    assert client.post("/api/unidades/999999/baja", json={"motivo": "x", "confirmar": True}).status_code == 404
    assert client.post("/api/unidades/999999/alta", json={"confirmar": True}).status_code == 404
    assert client.get("/api/unidades/999999/historial").status_code == 404


def test_por_ahora_todos_son_encargados(client):
    # decisión del cliente: mientras COLEGIOS_TODOS_ENCARGADOS no sea "0", todo usuario con sesión es encargado
    ue = una_unidad(client)
    assert client.get("/api/auth/sesion").json()["rol"] == "encargado"   # el usuario del fixture tiene rol consulta
    assert client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "cerró", "confirmar": True}).status_code == 200
    assert client.post(f"/api/unidades/{ue['id']}/alta", json={"confirmar": True}).status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/bajas").status_code == 401                    # la sesión sigue siendo obligatoria


def test_endpoints_de_encargado_exigen_sesion_y_rol(client, monkeypatch):
    monkeypatch.setenv("COLEGIOS_TODOS_ENCARGADOS", "0")   # roles por usuario (etapa posterior)
    ue = una_unidad(client)
    url = f"/api/unidades/{ue['id']}"
    llamadas = [("post", f"{url}/baja", {"motivo": "x", "confirmar": True}), ("post", f"{url}/alta", {"confirmar": True}),
                ("get", "/api/bajas", None), ("get", f"{url}/historial", None)]
    assert client.get("/api/auth/sesion").json()["rol"] == "consulta"   # el usuario del fixture
    for metodo, ruta, body in llamadas:
        r = getattr(client, metodo)(ruta, **({"json": body} if body else {}))
        assert r.status_code == 403 and r.json()["detail"] == "Se requiere el rol de encargado"
    assert client.post(f"{url}/baja", json={}).status_code == 403          # el rol se revisa antes que el cuerpo
    client.post("/api/auth/logout")
    for metodo, ruta, body in llamadas:
        assert getattr(client, metodo)(ruta, **({"json": body} if body else {})).status_code == 401
    como(client, "encargada", "encargado")
    assert visible(client, ue) == (180, True)                               # nada cambió


def test_sin_login_rol_encargado_y_usuario_dev(client, monkeypatch):
    from app.backend import auth

    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    client.cookies.clear()
    assert client.get("/api/auth/sesion").json() == {"requerida": False, "usuario": None, "nombre": None,
                                                     "rol": "encargado"}
    ue = una_unidad(client)
    assert client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "prueba", "confirmar": True}).status_code == 200
    assert client.get("/api/bajas").json()[0]["usuario"] == "dev"
    assert client.get(f"/api/unidades/{ue['id']}/historial").json()[0]["usuario"] == "dev"


def test_migracion_agrega_rol_con_respaldo(tmp_path):
    import sqlite3

    from sqlalchemy import create_engine, inspect

    from app.backend import auth

    db = tmp_path / "viejo.db"
    with sqlite3.connect(db) as con:   # esquema anterior a HU-02: sin rol
        con.execute("CREATE TABLE usuario (id INTEGER PRIMARY KEY, usuario VARCHAR UNIQUE, nombre VARCHAR, "
                    "clave_hash VARCHAR NOT NULL, activo BOOLEAN NOT NULL, creado DATETIME NOT NULL)")
        con.execute("INSERT INTO usuario VALUES (1, 'viejo', NULL, 'h', 1, '2026-01-01')")
    engine = create_engine(f"sqlite:///{db}")
    auth.init_auth_db(engine)
    assert [p.name.startswith("viejo.db.bak-") for p in tmp_path.iterdir()].count(True) == 1
    with sqlite3.connect(next(tmp_path.glob("viejo.db.bak-*"))) as con:   # el respaldo es el esquema anterior
        assert "rol" not in {r[1] for r in con.execute("PRAGMA table_info(usuario)")}
    tablas = set(inspect(engine).get_table_names())
    assert {"usuario", "unidad_estado", "unidad_estado_historial"} <= tablas
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT usuario, rol FROM usuario").fetchall() == [("viejo", "consulta")]
    auth.init_auth_db(engine)                          # idempotente: ya migrada, no vuelve a respaldar
    assert len(list(tmp_path.glob("viejo.db.bak-*"))) == 1


def test_pagina_estatica_sin_bajas(client):
    from app import build_static

    como(client, "encargada", "encargado")
    ue = una_unidad(client)
    assert len(build_static.filas()) == 180
    client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "x", "confirmar": True})
    filas = build_static.filas()
    assert len(filas) == 179 and ue["id"] not in {f["id"] for f in filas}
