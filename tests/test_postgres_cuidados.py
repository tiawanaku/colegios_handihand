"""Integración con la BD real de cuidados (PostgreSQL + db/vista_unidad_educativa.sql).

    COLEGIOS_PG_TEST_URL=postgresql+psycopg://usuario@host/cuidados pytest tests/test_postgres_cuidados.py

Compara lo que devuelve la API (a través de la vista) con consultas directas a las tablas de Django,
por eso el usuario de la prueba necesita SELECT sobre core_* (la API en producción sólo sobre la vista).
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, text

URL = os.environ.get("COLEGIOS_PG_TEST_URL")
pytestmark = pytest.mark.skipif(not URL, reason="definir COLEGIOS_PG_TEST_URL para probar contra PostgreSQL")
ROOT = Path(__file__).resolve().parents[1]

EAV = """
select count(distinct i.id) from core_institucion i
join core_tipoinstitucion t on t.id = i.id_tipo_institucion_id and t.nombre = 'EDUCACION'
join core_institucionpropiedad p on p.id_institucion_id = i.id
join core_catalogogeneral c on c.id = p.id_catalogo_id and c.deleted is null
where i.deleted is null and c.propiedad = :prop and c.valor = :valor
"""


@pytest.fixture(scope="module")
def api():
    port = 8700 + os.getpid() % 200
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.backend.main:app", "--port", str(port)],
                            cwd=ROOT, env={**os.environ, "COLEGIOS_DB": URL, "COLEGIOS_AUTH": "0"},  # compara datos, no el login
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}/api", timeout=30)
    for _ in range(50):
        try:
            client.get("/catalogos").raise_for_status()
            break
        except httpx.HTTPError:
            time.sleep(0.2)
    yield client
    proc.terminate()


@pytest.fixture(scope="module")
def db():
    with create_engine(URL).connect() as conn:
        yield conn


def count(api, **params):
    return api.get("/unidades", params={**params, "page_size": 1}).json()["count"]


def test_total_igual_a_instituciones_educativas_vivas(api, db):
    esperado = db.execute(text("""select count(*) from core_institucion i join core_tipoinstitucion t
        on t.id = i.id_tipo_institucion_id where t.nombre = 'EDUCACION' and i.deleted is null""")).scalar()
    assert api.get("/estadisticas").json()["total_unidades"] == esperado == count(api)


@pytest.mark.parametrize("prop,valor,param", [
    ("DEPENDENCIA", "FISCAL", "dependencia"), ("DEPENDENCIA", "CONVENIO", "dependencia"),
    ("DEPENDENCIA", "PRIVADA", "dependencia"), ("NIVEL EDUCATIVO", "ESPECIAL", "nivel"),
    ("NIVEL EDUCATIVO", "PRIMARIA COMUNITARIA VOCACIONAL", "nivel"), ("NIVEL EDUCATIVO", "TÉCNICO MEDIO", "nivel"),
    ("TURNO", "MAÑANA", "turno"), ("TURNO", "NOCHE", "turno"),
])
def test_filtros_coinciden_con_el_catalogo(api, db, prop, valor, param):
    assert count(api, **{param: valor}) == db.execute(text(EAV), {"prop": prop, "valor": valor}).scalar()


def test_subsistema_sale_de_tipo(api, db):
    esperado = db.execute(text(EAV), {"prop": "TIPO", "valor": "EDUCACIÓN ALTERNATIVA"}).scalar()
    assert count(api, subsistema="ALTERNATIVA") == esperado


def test_catalogos_y_exportes(api):
    c = api.get("/catalogos").json()
    assert set(c["dependencias"]) == {"FISCAL", "CONVENIO", "PRIVADA"}
    assert c["campos"]["matricula"] is False
    assert api.get("/export.xlsx", params={"dependencia": "CONVENIO"}).content[:2] == b"PK"
    assert api.get("/export.pdf").content[:4] == b"%PDF"
