"""Normalización de registros crudos (CSV / JSON / GeoJSON) al modelo canónico.

Los archivos usan nombres de columna distintos ("Nombre, Dist., Dependencia, Dirección, Nivel";
el SIE del Ministerio usa otros). Aquí se mapean todos los alias conocidos a un único esquema.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

DEPENDENCIAS = ("FISCAL", "CONVENIO", "PRIVADA", "COMUNITARIA")

NIVELES = {
    "INICIAL": ("inicial", "familia comunitaria", "kinder", "pre"),
    "PRIMARIA": ("primaria",),
    "SECUNDARIA": ("secundaria",),
    "ALTERNATIVA": ("adulto", "alternativa", "epja", "cea", "jovenes"),
    "ESPECIAL": ("especial",),
    "TECNICA": ("tecnic", "tecnolog", "instituto"),
}

TURNOS = {"MANANA": ("manana", "mañana"), "TARDE": ("tarde",), "NOCHE": ("noche",)}

# alias de columna -> campo canónico
ALIASES: dict[str, tuple[str, ...]] = {
    "codigo_rue": ("rue", "codigo_rue", "cod_rue", "codigo", "cod_ue", "sie", "codigo_sie"),
    "nombre": ("nombre", "name", "unidad_educativa", "ue", "institucion", "institucion_educativa", "nombre_ue"),
    "dependencia": ("dependencia", "tipo", "tipo_dependencia", "administracion", "sector"),
    "tipo_convenio": ("tipo_convenio", "convenio_con", "entidad_convenio", "iglesia"),
    "niveles": ("nivel", "niveles", "nivel_educativo", "oferta"),
    "turnos": ("turno", "turnos", "horario"),
    "subsistema": ("subsistema",),
    "distrito_municipal": ("dist", "distrito", "distrito_municipal", "nro_distrito", "d"),
    "distrito_educativo": ("distrito_educativo", "direccion_distrital", "dde"),
    "zona": ("zona", "barrio", "urbanizacion"),
    "direccion": ("direccion", "address", "domicilio", "ubicacion"),
    "telefono": ("telefono", "tel", "celular", "phone"),
    "director": ("director", "directora", "responsable"),
    "area": ("area",),
    "lat": ("lat", "latitud", "latitude", "y"),
    "lon": ("lon", "lng", "long", "longitud", "longitude", "x"),
    "estudiantes_total": ("estudiantes", "matricula", "total_estudiantes", "inscritos"),
    "estudiantes_mujeres": ("mujeres", "estudiantes_mujeres", "femenino"),
    "estudiantes_hombres": ("hombres", "estudiantes_hombres", "masculino", "varones"),
    "docentes": ("docentes", "maestros", "profesores"),
}


def slug(value: str) -> str:
    value = unicodedata.normalize("NFKD", str(value)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


_ALIAS_INDEX = {alias: field for field, aliases in ALIASES.items() for alias in aliases}


def norm_dependencia(value: Any) -> str | None:
    if value is None:
        return None
    s = slug(value)
    if not s:
        return None
    if "convenio" in s:
        return "CONVENIO"
    if "privad" in s or "particular" in s:
        return "PRIVADA"
    if "comunitari" in s:
        return "COMUNITARIA"
    if any(k in s for k in ("fiscal", "public", "estatal", "municipal")):
        return "FISCAL"
    return s.upper()


def _match_set(value: Any, table: dict[str, tuple[str, ...]]) -> str | None:
    if value is None:
        return None
    s = slug(value).replace("_", " ")
    found = [key for key, needles in table.items() if any(n in s for n in needles)]
    return ",".join(found) if found else None


def norm_niveles(value: Any) -> str | None:
    if isinstance(value, (list, tuple)):
        value = " ".join(map(str, value))
    return _match_set(value, NIVELES)


def norm_turnos(value: Any) -> str | None:
    if isinstance(value, (list, tuple)):
        value = " ".join(map(str, value))
    return _match_set(value, TURNOS)


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    m = re.search(r"\d+", str(value))
    return int(m.group()) if m else None


def _float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace(",", "."))
    except ValueError:
        return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    return text or None


def flatten_geojson_feature(feature: dict) -> dict:
    props = dict(feature.get("properties") or {})
    geom = feature.get("geometry") or {}
    if geom.get("type") == "Point" and len(geom.get("coordinates", [])) >= 2:
        props.setdefault("lon", geom["coordinates"][0])
        props.setdefault("lat", geom["coordinates"][1])
    return props


def normalize_record(raw: dict, fuente: str | None = None) -> dict | None:
    """Devuelve un dict con los campos canónicos, o None si no hay nombre."""
    if raw.get("type") == "Feature":
        raw = flatten_geojson_feature(raw)
    out: dict[str, Any] = {}
    for key, value in raw.items():
        field = _ALIAS_INDEX.get(slug(key))
        if field and out.get(field) in (None, ""):
            out[field] = value
    nombre = _text(out.get("nombre"))
    if not nombre:
        return None
    rec = {
        "codigo_rue": _text(out.get("codigo_rue")),
        "nombre": nombre.upper(),
        "dependencia": norm_dependencia(out.get("dependencia")),
        "tipo_convenio": _text(out.get("tipo_convenio")),
        "niveles": norm_niveles(out.get("niveles")),
        "turnos": norm_turnos(out.get("turnos")),
        "subsistema": _text(out.get("subsistema")),
        "distrito_municipal": _int(out.get("distrito_municipal")),
        "distrito_educativo": _text(out.get("distrito_educativo")),
        "zona": _text(out.get("zona")),
        "direccion": _text(out.get("direccion")),
        "telefono": _text(out.get("telefono")),
        "director": _text(out.get("director")),
        "area": _text(out.get("area")),
        "lat": _float(out.get("lat")),
        "lon": _float(out.get("lon")),
        "estudiantes_total": _int(out.get("estudiantes_total")),
        "estudiantes_mujeres": _int(out.get("estudiantes_mujeres")),
        "estudiantes_hombres": _int(out.get("estudiantes_hombres")),
        "docentes": _int(out.get("docentes")),
        "fuente": fuente,
    }
    if rec["subsistema"] is None and rec["niveles"]:
        nv = rec["niveles"].split(",")
        rec["subsistema"] = (
            "ALTERNATIVA" if "ALTERNATIVA" in nv else "ESPECIAL" if "ESPECIAL" in nv else "REGULAR"
        )
    if rec["estudiantes_total"] is None and rec["estudiantes_mujeres"] is not None and rec["estudiantes_hombres"] is not None:
        rec["estudiantes_total"] = rec["estudiantes_mujeres"] + rec["estudiantes_hombres"]
    # descarta coordenadas fuera de Bolivia (errores típicos lat/lon invertidos)
    if rec["lat"] is not None and rec["lon"] is not None:
        if -23 < rec["lon"] < -9 and -70 < rec["lat"] < -57:
            rec["lat"], rec["lon"] = rec["lon"], rec["lat"]
        if not (-23 < rec["lat"] < -9 and -70 < rec["lon"] < -57):
            rec["lat"] = rec["lon"] = None
    return rec


def dedupe_key(rec: dict) -> str:
    if rec.get("codigo_rue"):
        return f"rue:{rec['codigo_rue']}"
    return f"n:{slug(rec['nombre'])}|d:{rec.get('distrito_municipal')}"
