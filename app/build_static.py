"""Genera el dashboard como página estática única (sin servidor), con los datos embebidos.

    COLEGIOS_DB=postgresql+psycopg://usuario@host/cuidados python -m app.build_static dist/colegios.html
    python -m app.build_static dist/colegios.html --fragment   # sin <html>/<head>/<body> (p. ej. claude.ai)

Lee la tabla/vista `unidad_educativa` de COLEGIOS_DB, la incrusta como JSON y usa static-api.js para
responder la misma API en el navegador. Leaflet y Chart.js se cargan de jsDelivr; su CSS va incrustado.
Sin mapa base (los tiles de OpenStreetMap son una carga externa más): se dibujan rótulos de distrito.
Pasa --tiles para incluir el mapa base de OpenStreetMap cuando el sitio de destino lo permita.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from sqlmodel import Session, select

from .backend.db import engine
from .backend.main import EXPORT_FIELDS
from .backend.models import UnidadEducativa

FRONT = Path(__file__).resolve().parent / "frontend"
LEAFLET_JS = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"
CHART_JS = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"


def filas() -> list[dict]:
    with Session(engine) as s:
        rows = s.exec(select(UnidadEducativa).order_by(UnidadEducativa.id)).all()
    campos = [f for f in EXPORT_FIELDS if f != "fuente"] + ["fuente"]
    return [{k: v for k, v in r.model_dump().items() if k in campos and v is not None} for r in rows]


def script_json(data) -> str:
    # dentro de <script>, "</" cerraría la etiqueta
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def build(fragment: bool, tiles: bool) -> str:
    html = (FRONT / "index.html").read_text(encoding="utf-8")
    body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    body = re.sub(r"\s*<script src=[^>]*></script>", "", body)  # los scripts se insertan abajo
    body = re.sub(r"\s*<nav class=\"exports\">.*?</nav>", "", body, flags=re.S)  # exportar necesita el backend
    leaflet_css = (FRONT / "vendor/leaflet/leaflet.css").read_text(encoding="utf-8")
    leaflet_css = re.sub(r"url\(images/[^)]*\)", "none", leaflet_css)  # iconos que no se usan
    config = {"tiles": None} if not tiles else {}
    partes = [
        "<title>Colegios El Alto</title>",
        f"<style>\n{leaflet_css}\n{(FRONT / 'styles.css').read_text(encoding='utf-8')}\n</style>",
        body.strip(),
        f'<script src="{LEAFLET_JS}"></script>',
        f'<script src="{CHART_JS}"></script>',
        f"<script>\n{(FRONT / 'static-api.js').read_text(encoding='utf-8')}\n"
        f"const FILAS = {script_json(filas())};\n"
        f"window.COLEGIOS_CONFIG = Object.assign({json.dumps(config)}, {{ staticApi: createStaticApi(FILAS) }});\n</script>",
        f"<script>\n{(FRONT / 'app.js').read_text(encoding='utf-8')}\n</script>",
    ]
    contenido = "\n".join(partes)
    if fragment:
        return contenido + "\n"
    head, resto = contenido.split("\n", 1)
    return ('<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f"{head}\n</head>\n<body>\n{resto}\n</body>\n</html>\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("salida", type=Path)
    ap.add_argument("--fragment", action="store_true", help="sin <html>/<head>/<body>")
    ap.add_argument("--tiles", action="store_true", help="incluir mapa base de OpenStreetMap")
    args = ap.parse_args()
    args.salida.parent.mkdir(parents=True, exist_ok=True)
    args.salida.write_text(build(args.fragment, args.tiles), encoding="utf-8")
    print(f"{args.salida} ({args.salida.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
