"""Sprint 3: personal (HU-10), correcciones con bitácora (HU-08) y agenda de actividades (HU-09)."""
import sqlite3

import pytest
from test_app import client, colegio, como, una_unidad, visible  # noqa: F401  (client es un fixture)


def sql(consulta, base="sistema", **params):
    """Filas de una consulta directa a la BD del sistema o a la de datos (vale para SQLite y PostgreSQL)."""
    from sqlalchemy import text

    from app.backend import auth, db

    with (auth.auth_engine if base == "sistema" else db.engine).connect() as con:
        return [tuple(f) for f in con.execute(text(consulta), params)]


def sin_sesion(client):
    client.post("/api/auth/logout")


# ---------------------------------------------------------------- HU-10: personal
def persona(client, **datos):
    r = client.post("/api/personal", json={"nombre": "Ana Pérez", "cargo": "Coordinadora", **datos})
    assert r.status_code == 201, r.text
    return r.json()["persona"]


def test_personal_alta_lista_y_normalizacion(client):
    assert client.get("/api/personal").json() == []
    r = client.post("/api/personal", json={"nombre": "  beto Ríos ", "cargo": " Técnico ", "telefono": "  ",
                                           "correo": "", "activo": False, "extra": 1})
    assert r.status_code == 201
    p = r.json()
    assert p["ok"] is True and set(p["persona"]) == {"id", "nombre", "cargo", "telefono", "correo", "activo",
                                                     "creado", "actualizado"}
    assert (p["persona"]["nombre"], p["persona"]["cargo"]) == ("beto Ríos", "Técnico")
    assert (p["persona"]["telefono"], p["persona"]["correo"], p["persona"]["activo"]) == (None, None, True)
    assert p["persona"]["creado"].endswith("+00:00")
    persona(client, nombre="Carla", correo="carla@org.bo", telefono="777-1")
    persona(client, nombre="ana")
    assert [x["nombre"] for x in client.get("/api/personal").json()] == ["ana", "beto Ríos", "Carla"]
    assert client.get("/api/personal").json()[2]["correo"] == "carla@org.bo"


def test_personal_edicion_inactivar_y_sin_cambios(client):
    p = persona(client)
    url = f"/api/personal/{p['id']}"
    r = client.patch(url, json={"cargo": " Directora ", "correo": "ana@org.bo"})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert (r.json()["persona"]["cargo"], r.json()["persona"]["correo"]) == ("Directora", "ana@org.bo")
    assert r.json()["persona"]["actualizado"] >= p["actualizado"]
    como(client, "editora", "encargado")
    assert client.patch(url, json={"activo": False}).json()["persona"]["activo"] is False
    assert sql("SELECT usuario FROM personal") == [("editora",)]   # quién hizo el último cambio
    assert client.get("/api/personal").json() == []
    todos = client.get("/api/personal", params={"incluir_inactivos": 1}).json()
    assert [(x["id"], x["activo"], x["cargo"]) for x in todos] == [(p["id"], False, "Directora")]
    for body in ({"activo": False}, {"cargo": "Directora"}, {}, {"desconocido": 1}):
        r = client.patch(url, json=body)
        assert r.status_code == 422 and r.json() == {"detail": "Revise los datos del personal",
                                                     "errores": {"general": "No hay cambios para guardar"}}
    assert client.patch(url, json={"activo": True}).json()["persona"]["activo"] is True
    assert client.patch(url, json={"telefono": ""}).status_code == 422          # ya era null: sin cambios
    assert client.patch("/api/personal/999", json={"cargo": "x"}).status_code == 404
    assert client.patch("/api/personal/99999999999", json={"cargo": "x"}).status_code == 404


@pytest.mark.parametrize("body,errores", [
    ({"cargo": "x"}, {"nombre": "Escriba el nombre"}),
    ({"nombre": "   ", "cargo": "x"}, {"nombre": "Escriba el nombre"}),
    ({"nombre": "x"}, {"cargo": "Escriba el cargo"}),
    ({}, {"nombre": "Escriba el nombre", "cargo": "Escriba el cargo"}),
    ({"nombre": 5, "cargo": ["x"]}, {"nombre": "Debe ser un texto", "cargo": "Debe ser un texto"}),
    ({"nombre": "x" * 151, "cargo": "x" * 101, "telefono": "1" * 51, "correo": "a" * 145 + "@org.bo"},
     {"nombre": "No puede pasar de 150 caracteres", "cargo": "No puede pasar de 100 caracteres",
      "telefono": "No puede pasar de 50 caracteres", "correo": "No puede pasar de 150 caracteres"}),
    ({"nombre": "x", "cargo": "y", "correo": "ana@org"}, {"correo": "Correo no válido"}),
    ({"nombre": "x", "cargo": "y", "correo": "ana org@x.bo"}, {"correo": "Correo no válido"}),
    ({"nombre": "x", "cargo": "y", "telefono": 7}, {"telefono": "Debe ser un texto"}),
])
def test_personal_alta_mensajes(client, body, errores):
    r = client.post("/api/personal", json=body)
    assert r.status_code == 422 and r.json() == {"detail": "Revise los datos del personal", "errores": errores}
    assert client.get("/api/personal", params={"incluir_inactivos": 1}).json() == []


def test_personal_patch_mensajes_y_cuerpo(client):
    url = f"/api/personal/{persona(client)['id']}"
    casos = [({"nombre": ""}, {"nombre": "Escriba el nombre"}), ({"cargo": None}, {"cargo": "Escriba el cargo"}),
             ({"activo": "no"}, {"activo": "Valor no válido"}), ({"activo": 0}, {"activo": "Valor no válido"}),
             ({"correo": "x"}, {"correo": "Correo no válido"}), ({"nombre": "x" * 151}, {"nombre": "No puede pasar de 150 caracteres"})]
    for body, errores in casos:
        r = client.patch(url, json=body)
        assert r.status_code == 422 and r.json() == {"detail": "Revise los datos del personal", "errores": errores}
    for cuerpo in ("{mal", "[1]", "null", '"x"'):
        for r in (client.patch(url, content=cuerpo, headers={"content-type": "application/json"}),
                  client.post("/api/personal", content=cuerpo, headers={"content-type": "application/json"})):
            assert r.status_code == 422 and r.json()["errores"] == {"general": "Datos no válidos"}
    assert client.get("/api/personal").json()[0]["nombre"] == "Ana Pérez"


def test_personal_exige_sesion(client):
    pid = persona(client)["id"]
    sin_sesion(client)
    for r in (client.get("/api/personal"), client.get("/api/personal", params={"incluir_inactivos": 1}),
              client.post("/api/personal", json={"nombre": "x", "cargo": "y"}),
              client.patch(f"/api/personal/{pid}", json={"cargo": "y"})):
        assert r.status_code == 401 and r.json() == {"detail": "Sesión requerida"}
    como(client, "otra", "encargado")   # cualquier rol con sesión
    assert [p["cargo"] for p in client.get("/api/personal").json()] == ["Coordinadora"]


# ---------------------------------------------------------------- HU-08: correcciones
def completo(ue, **cambios):
    """Cuerpo con todos los datos editables, como lo manda el formulario."""
    datos = {"nombre": ue["nombre"], "dependencia": ue["dependencia"], "subsistema": ue["subsistema"],
             "distrito_municipal": ue["distrito_municipal"], "direccion": ue["direccion"], "zona": ue["zona"],
             "telefono": ue["telefono"], "niveles": ue["niveles"].split(","), "turnos": ue["turnos"].split(","),
             "lat": ue["lat"], "lon": ue["lon"]}
    return {**datos, **cambios}


def test_correccion_se_ve_en_todo_el_sistema(client):
    from app import build_static

    ue = una_unidad(client)
    stats0 = client.get("/api/estadisticas").json()
    nuevo_dep = "PRIVADA" if ue["dependencia"] != "PRIVADA" else "CONVENIO"
    nuevo_dist = 14 if ue["distrito_municipal"] != 14 else 13
    r = client.patch(f"/api/unidades/{ue['id']}", json=completo(
        ue, nombre="  ZZZ U.E. CORREGIDA ", dependencia=nuevo_dep.lower(), distrito_municipal=nuevo_dist,
        niveles=["TÉCNICO MEDIO"], turnos=["noche"], lat=-16.45, lon=-68.10, telefono="2-2445566", zona="Sopocachi"))
    assert r.status_code == 200, r.text
    cuerpo = r.json()
    assert cuerpo["ok"] is True and cuerpo["id"] == ue["id"]
    cambios = {c["campo"]: (c["antes"], c["despues"]) for c in cuerpo["cambios"]}
    assert cambios["nombre"] == (ue["nombre"], "ZZZ U.E. CORREGIDA")
    assert cambios["dependencia"] == (ue["dependencia"], nuevo_dep)
    assert cambios["distrito_municipal"] == (ue["distrito_municipal"], nuevo_dist)
    assert cambios["niveles"] == (ue["niveles"], "TÉCNICO MEDIO") and cambios["turnos"] == (ue["turnos"], "NOCHE")
    assert cambios["lat"] == (ue["lat"], -16.45) and cambios["telefono"] == (None, "2-2445566")
    assert "subsistema" not in cambios and "direccion" not in cambios   # sin cambio real no se anota

    ficha = client.get(f"/api/unidades/{ue['id']}").json()
    assert ficha == cuerpo["unidad"] and "registrado" not in ficha
    assert (ficha["nombre"], ficha["dependencia"], ficha["distrito_municipal"], ficha["zona"]) == (
        "ZZZ U.E. CORREGIDA", nuevo_dep, nuevo_dist, "Sopocachi")
    assert ficha["modificado"]["usuario"] == "analista" and ficha["modificado"]["fecha"].endswith("+00:00")
    assert "modificado" not in client.get(f"/api/unidades/{ue['id'] + 1}").json()

    # listado: búsqueda, filtros, orden y paginación sobre los valores corregidos
    ids = lambda **p: [x["id"] for x in client.get("/api/unidades", params={"page_size": 500, **p}).json()["results"]]
    assert ids(q="corregida") == [ue["id"]] and ue["id"] not in ids(q=ue["nombre"])
    assert ue["id"] in ids(dependencia=nuevo_dep, distrito=nuevo_dist, nivel="TÉCNICO MEDIO", turno="NOCHE")
    for p in ({"dependencia": ue["dependencia"]}, {"distrito": ue["distrito_municipal"]}, {"turno": "MAÑANA"},
              {"bbox": "-68.2,-16.52,-68.18,-16.49"}):
        assert ue["id"] not in ids(**p), p
    assert ids()[-1] == ue["id"] and ids(orden="-nombre")[0] == ue["id"]
    paginas = [client.get("/api/unidades", params={"page": n, "page_size": 50}).json() for n in (1, 2, 3, 4)]
    assert {pg["count"] for pg in paginas} == {180} and len({x["id"] for pg in paginas for x in pg["results"]}) == 180
    assert paginas[3]["results"][-1]["nombre"] == "ZZZ U.E. CORREGIDA"

    # mapa, estadísticas y catálogos
    feat = [f for f in client.get("/api/geojson").json()["features"] if f["properties"]["id"] == ue["id"]]
    assert feat[0]["geometry"]["coordinates"] == [-68.10, -16.45] and feat[0]["properties"]["nombre"] == "ZZZ U.E. CORREGIDA"
    assert [f["properties"]["id"] for f in client.get("/api/geojson", params={"q": "corregida"}).json()["features"]] == [ue["id"]]
    s = client.get("/api/estadisticas").json()
    assert s["total_unidades"] == 180
    assert s["por_dependencia"][nuevo_dep] == stats0["por_dependencia"].get(nuevo_dep, 0) + 1
    assert s["por_nivel"]["TÉCNICO MEDIO"] == 1
    assert s["por_turno"]["NOCHE"] == stats0["por_turno"].get("NOCHE", 0) + ("NOCHE" not in ue["turnos"].split(","))
    assert client.get("/api/estadisticas", params={"nivel": "TÉCNICO MEDIO"}).json()["total_unidades"] == 1
    c = client.get("/api/catalogos").json()
    assert "TÉCNICO MEDIO" in c["niveles"] and "TÉCNICO MEDIO" in c["opciones_registro"]["niveles"]

    # exportaciones y página estática
    texto = client.get("/api/export.csv").text
    assert "ZZZ U.E. CORREGIDA" in texto and f"{ue['nombre']}," not in texto and texto.count("\n") == 181
    assert client.get("/api/export.csv", params={"q": "corregida"}).text.count("\n") == 2
    assert client.get("/api/export.xlsx").status_code == 200 and client.get("/api/export.pdf").status_code == 200
    fila = [f for f in build_static.filas() if f["id"] == ue["id"]][0]
    assert (fila["nombre"], fila["dependencia"], fila["niveles"], fila["lat"]) == (
        "ZZZ U.E. CORREGIDA", nuevo_dep, "TÉCNICO MEDIO", -16.45)
    assert len(build_static.filas()) == 180

    # bajas: la lista muestra lo corregido; corregir un colegio dado de baja es 409
    assert client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "x", "confirmar": True}).status_code == 200
    assert client.get("/api/bajas").json()[0]["nombre"] == "ZZZ U.E. CORREGIDA"
    assert visible(client, {**ue, "nombre": "ZZZ U.E. CORREGIDA"}) == (179, False)
    assert ue["id"] not in {f["id"] for f in build_static.filas()}
    r = client.patch(f"/api/unidades/{ue['id']}", json={"nombre": "OTRO"})
    assert r.status_code == 409 and r.json() == {"detail": "Reactive el colegio antes de corregirlo"}
    assert client.post(f"/api/unidades/{ue['id']}/alta", json={"confirmar": True}).status_code == 200
    assert visible(client, {**ue, "nombre": "ZZZ U.E. CORREGIDA"}) == (180, True)


def test_correccion_parcial_bitacora_e_historial(client):
    ue = una_unidad(client)
    url = f"/api/unidades/{ue['id']}"
    r = client.patch(url, json={"telefono": " 2-111 ", "zona": "Centro", "desconocido": "x"})
    assert r.status_code == 200 and r.json()["cambios"] == [{"campo": "zona", "antes": None, "despues": "Centro"},
                                                            {"campo": "telefono", "antes": None, "despues": "2-111"}]
    como(client, "editora", "encargado")
    r = client.patch(url, json={"telefono": "", "distrito_municipal": ue["distrito_municipal"] % 14 + 1})
    assert r.json()["cambios"] == [{"campo": "distrito_municipal", "antes": ue["distrito_municipal"],
                                    "despues": ue["distrito_municipal"] % 14 + 1},
                                   {"campo": "telefono", "antes": "2-111", "despues": None}]
    ficha = client.get(url).json()
    assert ficha["telefono"] is None and ficha["zona"] == "Centro"          # vaciar un campo también se corrige
    assert ficha["modificado"]["usuario"] == "editora"
    assert ficha["nombre"] == ue["nombre"] and ficha["niveles"] == ue["niveles"]   # lo no enviado queda igual

    client.post(f"{url}/baja", json={"motivo": "m", "confirmar": True})
    client.post(f"{url}/alta", json={"confirmar": True})
    hist = client.get(f"{url}/historial").json()
    assert [(h["accion"], h["usuario"]) for h in hist] == [("alta", "editora"), ("baja", "editora"),
                                                           ("modificacion", "editora"), ("modificacion", "analista")]
    assert hist[2]["cambios"] == r.json()["cambios"] and hist[2]["fecha"] == ficha["modificado"]["fecha"]
    assert hist[3]["cambios"][0] == {"campo": "zona", "antes": None, "despues": "Centro"}

    filas = sql("SELECT campo, antes, despues, usuario FROM unidad_cambio WHERE ue_id = :id ORDER BY id", id=ue["id"])
    assert filas == [("zona", None, "Centro", "analista"), ("telefono", None, "2-111", "analista"),
                     ("distrito_municipal", str(ue["distrito_municipal"]), str(ue["distrito_municipal"] % 14 + 1), "editora"),
                     ("telefono", "2-111", None, "editora")]
    assert len(set(sql("SELECT fecha FROM unidad_cambio"))) == 2   # una fecha por guardado
    assert sql("SELECT zona, distrito_municipal FROM unidad_educativa WHERE id = :id", "datos",   # la vista no se toca
               id=ue["id"]) == [(None, ue["distrito_municipal"])]


def test_correccion_listas_guardadas_como_csv(client):
    ue = una_unidad(client)
    r = client.patch(f"/api/unidades/{ue['id']}", json={"turnos": ["tarde", "MAÑANA"]})
    if set(ue["turnos"].split(",")) == {"MAÑANA", "TARDE"}:
        assert r.status_code == 422                                   # mismo conjunto: no es un cambio
    else:
        assert r.json()["cambios"] == [{"campo": "turnos", "antes": ue["turnos"], "despues": "MAÑANA,TARDE"}]
        assert sql("SELECT antes, despues FROM unidad_cambio") == [(ue["turnos"], "MAÑANA,TARDE")]
    # reordenar los mismos valores no es un cambio
    actual = client.get(f"/api/unidades/{ue['id']}").json()
    r = client.patch(f"/api/unidades/{ue['id']}", json={"niveles": list(reversed(actual["niveles"].split(",")))})
    assert r.status_code == 422 and r.json()["errores"] == {"general": "No hay cambios para guardar"}


def test_correccion_de_un_registrado(client):
    reg = client.post("/api/unidades", json=colegio()).json()["unidad"]
    url = f"/api/unidades/{reg['id']}"
    r = client.patch(url, json={"nombre": "U.E. ESPERANZA CORREGIDA", "niveles": ["SECUNDARIA"]})
    assert r.status_code == 200
    assert r.json()["cambios"] == [{"campo": "nombre", "antes": "U.E. NUEVA ESPERANZA", "despues": "U.E. ESPERANZA CORREGIDA"},
                                   {"campo": "niveles", "antes": "INICIAL,PRIMARIA", "despues": "SECUNDARIA"}]
    ficha = client.get(url).json()
    assert ficha["registrado"] is True and ficha["nombre"] == "U.E. ESPERANZA CORREGIDA" and ficha["modificado"]
    assert [x["id"] for x in client.get("/api/unidades", params={"q": "esperanza corregida"}).json()["results"]] == [reg["id"]]
    assert client.get("/api/unidades", params={"nivel": "INICIAL", "q": "esperanza"}).json()["count"] == 0
    assert [h["accion"] for h in client.get(f"{url}/historial").json()] == ["modificacion", "registro"]
    from app.backend import correcciones
    assert correcciones.ids() == set()                     # el registrado se corrige en su propia fila


def test_correccion_sin_cambios_404_401_403(client, monkeypatch):
    ue = una_unidad(client)
    url = f"/api/unidades/{ue['id']}"
    for body in ({}, {"desconocido": 1}, {"nombre": f"  {ue['nombre']} "}, completo(ue), {"zona": ""}):
        r = client.patch(url, json=body)
        assert r.status_code == 422 and r.json() == {"detail": "Revise los datos del colegio",
                                                     "errores": {"general": "No hay cambios para guardar"}}
    for cuerpo in ("{mal", "[1]", "null"):
        r = client.patch(url, content=cuerpo, headers={"content-type": "application/json"})
        assert r.status_code == 422 and r.json()["errores"] == {"general": "Datos no válidos"}
    assert client.patch("/api/unidades/999999", json={"nombre": "x"}).status_code == 404
    assert client.patch("/api/unidades/1000000", json={"nombre": "x"}).status_code == 404
    monkeypatch.setenv("COLEGIOS_TODOS_ENCARGADOS", "0")
    r = client.patch(url, json={"nombre": "x"})
    assert r.status_code == 403 and r.json()["detail"] == "Se requiere el rol de encargado"
    monkeypatch.delenv("COLEGIOS_TODOS_ENCARGADOS")
    sin_sesion(client)
    assert client.patch(url, json={"nombre": "x"}).status_code == 401
    assert client.get(f"{url}/historial").status_code == 401
    como(client, "encargada", "encargado")
    ficha = client.get(url).json()
    assert ficha["nombre"] == ue["nombre"] and "modificado" not in ficha
    assert client.get(f"{url}/historial").json() == []


CASOS_INVALIDOS = [
    ({"lat": -16.30}, "lat"), ({"lon": -68.40}, "lon"), ({"lat": None}, "lat"), ({"lon": "x"}, "lon"),
    ({"lat": True}, "lat"), ({"niveles": []}, "niveles"), ({"niveles": "PRIMARIA"}, "niveles"),
    ({"niveles": ["A,B"]}, "niveles"), ({"turnos": []}, "turnos"), ({"turnos": ["MADRUGADA"]}, "turnos"),
    ({"dependencia": "COMUNITARIA"}, "dependencia"), ({"dependencia": None}, "dependencia"),
    ({"subsistema": "OTRO"}, "subsistema"), ({"distrito_municipal": 15}, "distrito_municipal"),
    ({"distrito_municipal": "8"}, "distrito_municipal"), ({"nombre": ""}, "nombre"), ({"nombre": "x" * 201}, "nombre"),
    ({"nombre": 5}, "nombre"), ({"direccion": "  "}, "direccion"), ({"direccion": "x" * 256}, "direccion"),
    ({"telefono": "1" * 51}, "telefono"), ({"zona": "x" * 201}, "zona"),
]


@pytest.mark.parametrize("cambios,campo", CASOS_INVALIDOS)
def test_correccion_valida_con_los_mensajes_del_registro(client, cambios, campo):
    esperado = client.post("/api/unidades", json=colegio(**cambios)).json()
    for ue in (una_unidad(client), client.post("/api/unidades", json=colegio()).json()["unidad"]):
        r = client.patch(f"/api/unidades/{ue['id']}", json=cambios)
        assert r.status_code == 422 and r.json() == esperado and list(esperado["errores"]) == [campo]
        assert "modificado" not in client.get(f"/api/unidades/{ue['id']}").json()


def test_correccion_valida_el_registro_resultante_completo(client):
    # un colegio de la vista con datos que no cumplen las reglas del registro: hay que corregirlos para guardar
    client.importer.upsert([{"nombre": "UE INCOMPLETA", "dist": 99, "dependencia": "COMUNITARIA"}], "t")
    ue = client.get("/api/unidades", params={"q": "UE INCOMPLETA"}).json()["results"][0]
    url = f"/api/unidades/{ue['id']}"
    r = client.patch(url, json={"telefono": "2-123"})
    assert r.status_code == 422 and set(r.json()["errores"]) == {
        "dependencia", "distrito_municipal", "direccion", "niveles", "turnos", "lat", "lon"}
    assert r.json()["errores"]["lat"] == "Marque la ubicación en el mapa"
    r = client.patch(url, json=colegio(nombre=..., telefono="2-123"))
    assert r.status_code == 200 and r.json()["unidad"]["nombre"] == "UE INCOMPLETA"
    assert 99 not in client.get("/api/catalogos").json()["distritos"]
    assert "COMUNITARIA" not in client.get("/api/catalogos").json()["dependencias"]


def test_tablas_nuevas_se_crean_sin_destruir(tmp_path):
    from sqlalchemy import create_engine, inspect

    from app.backend import auth

    db = tmp_path / "sprint2.db"
    with sqlite3.connect(db) as con:
        con.execute("CREATE TABLE unidad_estado (ue_id INTEGER PRIMARY KEY, activo BOOLEAN NOT NULL, "
                    "fecha_baja DATETIME, motivo VARCHAR, usuario VARCHAR)")
        con.execute("INSERT INTO unidad_estado VALUES (5, 0, '2026-01-01', 'cerró', 'ana')")
    engine = create_engine(f"sqlite:///{db}")
    auth.init_auth_db(engine)
    auth.init_auth_db(engine)
    tablas = set(inspect(engine).get_table_names())
    assert {"personal", "unidad_correccion", "unidad_cambio", "actividad"} <= tablas
    assert {c["name"] for c in inspect(engine).get_columns("unidad_cambio")} == {
        "id", "ue_id", "campo", "antes", "despues", "usuario", "fecha"}
    assert {c["name"] for c in inspect(engine).get_columns("personal")} == {
        "id", "nombre", "cargo", "telefono", "correo", "activo", "creado", "actualizado", "usuario"}
    assert {c["name"] for c in inspect(engine).get_columns("actividad")} == {
        "id", "ue_id", "tipo", "actividad", "fecha", "hora", "lugar", "encargados", "personal",
        "asistentes_proyectados", "observaciones", "estado", "creado", "creado_por", "actualizado", "actualizado_por"}
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT ue_id, motivo FROM unidad_estado").fetchall() == [(5, "cerró")]
    assert not list(tmp_path.glob("*.bak-*"))     # sólo se crean tablas: no hace falta respaldo


# ---------------------------------------------------------------- HU-09: agenda
def actividad(ue_id, encargados, /, **cambios):
    datos = {"ue_id": ue_id, "tipo": "taller", "actividad": " Taller de lectura ", "fecha": "2026-12-05",
             "hora": "09:30", "lugar": " Aula 3 ", "encargados": encargados, "personal": [],
             "asistentes_proyectados": 30, "observaciones": "  "}
    datos.update(cambios)
    return {k: v for k, v in datos.items() if v is not ...}


@pytest.fixture()
def agenda(client):
    ue = una_unidad(client)
    ana, beto, carla = (persona(client, nombre=n)["id"] for n in ("Ana", "Beto", "Carla"))
    return client, ue, ana, beto, carla


def test_actividad_crear_con_encargados_y_personal(agenda):
    client, ue, ana, beto, carla = agenda
    r = client.post("/api/actividades", json=actividad(ue["id"], [ana, ana], personal=[beto, carla, beto],
                                                        tipo=" Reunión ", observaciones=" Traer material "))
    assert r.status_code == 201, r.text
    a = r.json()["actividad"]
    assert r.json()["ok"] is True and isinstance(a["id"], int)
    assert {k: a[k] for k in ("ue_id", "tipo", "actividad", "fecha", "hora", "lugar", "asistentes_proyectados",
                              "observaciones", "estado", "creado_por", "actualizado_por")} == {
        "ue_id": ue["id"], "tipo": "REUNION", "actividad": "Taller de lectura", "fecha": "2026-12-05", "hora": "09:30",
        "lugar": "Aula 3", "asistentes_proyectados": 30, "observaciones": "Traer material", "estado": "PENDIENTE",
        "creado_por": "analista", "actualizado_por": "analista"}
    assert a["colegio"] == {"id": ue["id"], "nombre": ue["nombre"]}
    assert a["encargados"] == [{"id": ana, "nombre": "Ana", "cargo": "Coordinadora", "activo": True}]
    assert [p["nombre"] for p in a["personal"]] == ["Beto", "Carla"]
    assert a["creado"].endswith("+00:00") and a["actualizado"].endswith("+00:00")
    assert client.get("/api/actividades").json() == [a]
    b = client.post("/api/actividades", json=actividad(ue["id"], [beto], observaciones=None, asistentes_proyectados=None,
                                                       personal=..., estado="realizada")).json()["actividad"]
    assert (b["observaciones"], b["asistentes_proyectados"], b["personal"], b["estado"]) == (None, None, [], "REALIZADA")


def test_actividad_lista_por_rango_colegio_y_estado(agenda):
    client, ue, ana, *_ = agenda
    otro = client.get("/api/unidades", params={"page": 2, "page_size": 1}).json()["results"][0]
    crear = lambda ue_id, fecha, hora, **kw: client.post("/api/actividades", json=actividad(
        ue_id, [ana], fecha=fecha, hora=hora, **kw)).json()["actividad"]["id"]
    a3 = crear(ue["id"], "2026-12-20", "08:00")
    a1 = crear(ue["id"], "2026-12-01", "15:00")
    a2 = crear(otro["id"], "2026-12-01", "07:45", estado="CANCELADA")
    a4 = crear(otro["id"], "2027-01-10", "10:00")
    lista = lambda **p: [x["id"] for x in client.get("/api/actividades", params=p).json()]
    assert lista() == [a2, a1, a3, a4]
    assert lista(desde="2026-12-01", hasta="2026-12-31") == [a2, a1, a3]
    assert lista(desde="2026-12-02", hasta="2026-12-20") == [a3]
    assert lista(desde="2026-12-21") == [a4] and lista(hasta="2026-12-01") == [a2, a1]
    assert lista(ue_id=ue["id"]) == [a1, a3] and lista(ue_id=otro["id"]) == [a2, a4]
    assert lista(estado="cancelada") == [a2] and lista(estado="PENDIENTE", ue_id=otro["id"]) == [a4]
    assert lista(ue_id=999999) == [] and lista(ue_id=99999999999) == []
    assert lista(desde="2026-01-01", hasta="2027-02-05") == [a2, a1, a3, a4]   # 400 días justos


@pytest.mark.parametrize("params,errores", [
    ({"desde": "2026-13-01", "hasta": "2026-12-31"}, {"desde": "Elija una fecha válida"}),
    ({"desde": "2026-12-01", "hasta": "31/12/2026"}, {"hasta": "Elija una fecha válida"}),
    ({"desde": "2026-02-30"}, {"desde": "Elija una fecha válida"}),
    ({"desde": "2026-12-31", "hasta": "2026-12-01"}, {"hasta": "Debe ser igual o posterior a la fecha inicial"}),
    ({"desde": "2026-01-01", "hasta": "2027-02-06"}, {"hasta": "El rango no puede pasar de 400 días"}),
    ({"estado": "HECHA"}, {"estado": "Estado no válido"}),
    ({"ue_id": "abc"}, {"ue_id": "Elija el colegio"}),
])
def test_actividad_lista_parametros_invalidos(client, params, errores):
    r = client.get("/api/actividades", params=params)
    assert r.status_code == 422 and r.json() == {"detail": "Revise los datos de la actividad", "errores": errores}


def test_actividad_patch_estado_y_datos(agenda):
    client, ue, ana, beto, carla = agenda
    a = client.post("/api/actividades", json=actividad(ue["id"], [ana])).json()["actividad"]
    url = f"/api/actividades/{a['id']}"
    como(client, "editora", "encargado")
    r = client.patch(url, json={"estado": "realizada"})
    assert r.status_code == 200 and r.json()["ok"] is True
    b = r.json()["actividad"]
    assert (b["estado"], b["creado_por"], b["actualizado_por"]) == ("REALIZADA", "analista", "editora")
    assert b["actualizado"] >= a["actualizado"] and b["creado"] == a["creado"]
    assert client.get("/api/actividades", params={"estado": "REALIZADA"}).json() == [b]
    r = client.patch(url, json={"personal": [carla, beto], "asistentes_proyectados": 45, "observaciones": "Asistieron 40",
                                "hora": "10:00", "fecha": "2026-12-06", "lugar": "Patio", "tipo": "OTRA"})
    b = r.json()["actividad"]
    assert [p["id"] for p in b["personal"]] == [carla, beto]
    assert (b["asistentes_proyectados"], b["observaciones"], b["hora"], b["fecha"], b["lugar"], b["tipo"]) == (
        45, "Asistieron 40", "10:00", "2026-12-06", "Patio", "OTRA")
    assert client.patch(url, json={"observaciones": ""}).json()["actividad"]["observaciones"] is None
    for body in ({}, {"estado": "realizada"}, {"desconocido": 1}, {"encargados": [ana]}):
        r = client.patch(url, json=body)
        assert r.status_code == 422 and r.json() == {"detail": "Revise los datos de la actividad",
                                                     "errores": {"general": "No hay cambios para guardar"}}
    for cuerpo in ("{mal", "[1]", "null"):
        r = client.patch(url, content=cuerpo, headers={"content-type": "application/json"})
        assert r.status_code == 422 and r.json()["errores"] == {"general": "Datos no válidos"}
    assert client.patch("/api/actividades/999", json={"estado": "REALIZADA"}).status_code == 404
    assert client.patch("/api/actividades/99999999999", json={"estado": "REALIZADA"}).status_code == 404


def test_actividad_personal_inactivo(agenda):
    client, ue, ana, beto, carla = agenda
    a = client.post("/api/actividades", json=actividad(ue["id"], [ana], personal=[beto])).json()["actividad"]
    for pid in (ana, beto, carla):
        client.patch(f"/api/personal/{pid}", json={"activo": False})
    # nueva actividad: no se pueden asignar inactivos
    for body, campo in ((actividad(ue["id"], [ana]), "encargados"), (actividad(ue["id"], [999]), "encargados"),
                        (actividad(ue["id"], [persona(client, nombre="Dora")["id"]], personal=[carla]), "personal")):
        r = client.post("/api/actividades", json=body)
        assert r.status_code == 422 and r.json()["errores"] == {campo: "Hay personas que no existen o están inactivas"}
    # la existente conserva a los que ya estaban, y se ven como inactivos
    url = f"/api/actividades/{a['id']}"
    r = client.patch(url, json={"estado": "POSTERGADA"})
    assert r.status_code == 200
    assert r.json()["actividad"]["encargados"] == [{"id": ana, "nombre": "Ana", "cargo": "Coordinadora", "activo": False}]
    assert client.patch(url, json={"encargados": [beto, ana]}).status_code == 200   # ya estaba en la actividad
    r = client.patch(url, json={"personal": [beto, carla]})                          # carla es nueva: no
    assert r.status_code == 422 and r.json()["errores"] == {"personal": "Hay personas que no existen o están inactivas"}
    assert client.get("/api/actividades").json()[0]["personal"][0]["id"] == beto


def test_actividad_colegio_de_baja_o_inexistente(agenda):
    client, ue, ana, *_ = agenda
    a = client.post("/api/actividades", json=actividad(ue["id"], [ana])).json()["actividad"]
    client.post(f"/api/unidades/{ue['id']}/baja", json={"motivo": "x", "confirmar": True})
    for ue_id in (ue["id"], 999999, 1_000_000, 0, -5, 99999999999):
        r = client.post("/api/actividades", json=actividad(ue_id, [ana]))
        assert r.status_code == 422 and r.json()["errores"] == {"ue_id": "El colegio no existe o está dado de baja"}
    # la actividad existente sigue editable aunque su colegio esté de baja, pero no se mueve a otro de baja
    assert client.patch(f"/api/actividades/{a['id']}", json={"estado": "CANCELADA"}).status_code == 200
    reg = client.post("/api/unidades", json=colegio()).json()["unidad"]
    r = client.patch(f"/api/actividades/{a['id']}", json={"ue_id": reg["id"]})
    assert r.status_code == 200 and r.json()["actividad"]["colegio"] == {"id": reg["id"], "nombre": "U.E. NUEVA ESPERANZA"}
    assert client.patch(f"/api/actividades/{a['id']}", json={"ue_id": ue["id"]}).json()["errores"] == {
        "ue_id": "El colegio no existe o está dado de baja"}
    # el nombre del colegio sale corregido
    client.patch(f"/api/unidades/{reg['id']}", json={"nombre": "U.E. RENOMBRADA"})
    assert client.get("/api/actividades", params={"ue_id": reg["id"]}).json()[0]["colegio"]["nombre"] == "U.E. RENOMBRADA"


@pytest.mark.parametrize("cambios,errores", [
    ({"ue_id": ...}, {"ue_id": "Elija el colegio"}), ({"ue_id": "5"}, {"ue_id": "Elija el colegio"}),
    ({"ue_id": True}, {"ue_id": "Elija el colegio"}),
    ({"tipo": "charla"}, {"tipo": "Elija el tipo: taller, visita, reunión u otra"}),
    ({"tipo": ...}, {"tipo": "Elija el tipo: taller, visita, reunión u otra"}),
    ({"actividad": "  "}, {"actividad": "Describa la actividad"}),
    ({"actividad": "x" * 201}, {"actividad": "No puede pasar de 200 caracteres"}),
    ({"fecha": "2026-02-30"}, {"fecha": "Elija una fecha válida"}), ({"fecha": "05/12/2026"}, {"fecha": "Elija una fecha válida"}),
    ({"fecha": ...}, {"fecha": "Elija una fecha válida"}),
    ({"hora": "24:00"}, {"hora": "Elija una hora válida"}), ({"hora": "9:30"}, {"hora": "Elija una hora válida"}),
    ({"hora": "09:60"}, {"hora": "Elija una hora válida"}), ({"hora": ...}, {"hora": "Elija una hora válida"}),
    ({"lugar": ""}, {"lugar": "Escriba el lugar"}), ({"lugar": "x" * 201}, {"lugar": "No puede pasar de 200 caracteres"}),
    ({"encargados": []}, {"encargados": "Elija al menos un encargado"}),
    ({"encargados": ...}, {"encargados": "Elija al menos un encargado"}),
    ({"encargados": [999]}, {"encargados": "Hay personas que no existen o están inactivas"}),
    ({"encargados": ["1"]}, {"encargados": "Hay personas que no existen o están inactivas"}),
    ({"personal": [999]}, {"personal": "Hay personas que no existen o están inactivas"}),
    ({"personal": 3}, {"personal": "Hay personas que no existen o están inactivas"}),
    ({"asistentes_proyectados": -1}, {"asistentes_proyectados": "Debe ser un número entero de 0 o más"}),
    ({"asistentes_proyectados": 2.5}, {"asistentes_proyectados": "Debe ser un número entero de 0 o más"}),
    ({"asistentes_proyectados": "30"}, {"asistentes_proyectados": "Debe ser un número entero de 0 o más"}),
    ({"observaciones": "x" * 2001}, {"observaciones": "No puede pasar de 2000 caracteres"}),
    ({"estado": "HECHA"}, {"estado": "Estado no válido"}), ({"estado": None}, {}),
])
def test_actividad_mensajes(agenda, cambios, errores):
    client, ue, ana, *_ = agenda
    r = client.post("/api/actividades", json=actividad(ue["id"], [ana], **cambios))
    if not errores:
        assert r.status_code == 201
        return
    assert r.status_code == 422 and r.json() == {"detail": "Revise los datos de la actividad", "errores": errores}
    assert client.get("/api/actividades").json() == []
    if all(v is not ... for v in cambios.values()):   # el mismo mensaje en una modificación
        a = client.post("/api/actividades", json=actividad(ue["id"], [ana])).json()["actividad"]
        r = client.patch(f"/api/actividades/{a['id']}", json=cambios)
        assert r.status_code == 422 and r.json()["errores"] == errores


def test_actividad_cuerpo_invalido_y_vacio(client):
    for cuerpo in ("{mal", "[1]", "null", '"x"'):
        r = client.post("/api/actividades", content=cuerpo, headers={"content-type": "application/json"})
        assert r.status_code == 422 and r.json() == {"detail": "Revise los datos de la actividad",
                                                     "errores": {"general": "Datos no válidos"}}
    r = client.post("/api/actividades", json={})
    assert set(r.json()["errores"]) == {"ue_id", "tipo", "actividad", "fecha", "hora", "lugar", "encargados"}


def test_actividad_exige_sesion(agenda):
    client, ue, ana, *_ = agenda
    a = client.post("/api/actividades", json=actividad(ue["id"], [ana])).json()["actividad"]
    sin_sesion(client)
    for r in (client.get("/api/actividades"), client.get("/api/actividades", params={"ue_id": ue["id"]}),
              client.post("/api/actividades", json=actividad(ue["id"], [ana])),
              client.patch(f"/api/actividades/{a['id']}", json={"estado": "REALIZADA"})):
        assert r.status_code == 401 and r.json() == {"detail": "Sesión requerida"}
    como(client, "otra", "encargado")
    assert [x["estado"] for x in client.get("/api/actividades").json()] == ["PENDIENTE"]


def test_sin_login_usuario_dev(client, monkeypatch):
    from app.backend import auth

    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    client.cookies.clear()
    pid = persona(client)["id"]
    ue = una_unidad(client)
    a = client.post("/api/actividades", json=actividad(ue["id"], [pid])).json()["actividad"]
    assert a["creado_por"] == "dev"
    r = client.patch(f"/api/unidades/{ue['id']}", json={"telefono": "2-1"})
    assert r.json()["unidad"]["modificado"]["usuario"] == "dev"
