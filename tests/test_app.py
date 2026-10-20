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
    from fastapi.testclient import TestClient
    from sqlmodel import SQLModel

    from app.backend import importer
    from app.backend.db import engine
    from app.backend.main import app

    SQLModel.metadata.drop_all(engine)
    importer.upsert(importer.read_file(ROOT / "app/data/demo_unidades.csv"), "DEMO")
    with TestClient(app) as c:
        c.importer = importer
        yield c


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


def test_exports_and_pdf_roundtrip(client, tmp_path):
    assert client.get("/api/export.csv").text.count("\n") == 181
    assert client.get("/api/export.xlsx").content[:2] == b"PK"
    pdf = client.get("/api/export.pdf", params={"dependencia": "CONVENIO"})
    assert pdf.content[:4] == b"%PDF"
    path = tmp_path / "reporte.pdf"
    path.write_bytes(pdf.content)
    from app.backend.pdf_report import parse_pdf

    rows = list(parse_pdf(path))
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
