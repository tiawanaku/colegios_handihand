"""Lectura y escritura del "Reporte de Unidades Educativas" en PDF.

El sitio original publica /educacion/api/reporte/pdf/ con la tabla
Nombre | Dist. | Dependencia | Dirección | Nivel. `parse_pdf` convierte ese PDF
en registros; `build_pdf` genera un reporte con la misma estructura (y más
columnas) desde nuestra base.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Iterable, Iterator

HEADER_ALIASES = {
    "nombre": "nombre",
    "dist": "distrito",
    "distrito": "distrito",
    "dependencia": "dependencia",
    "direccion": "direccion",
    "dirección": "direccion",
    "nivel": "nivel",
    "niveles": "nivel",
    "turno": "turno",
    "rue": "rue",
}


def _header_key(cell: str | None) -> str | None:
    if not cell:
        return None
    key = re.sub(r"[^a-záéíóúñ]", "", cell.strip().lower())
    return HEADER_ALIASES.get(key)


def parse_pdf(path: Path | str) -> Iterator[dict]:
    import pdfplumber

    header: list[str | None] | None = None
    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    keys = [_header_key(c) for c in row]
                    if "nombre" in keys:
                        header = keys  # cabecera (se repite en cada página)
                        continue
                    if header is None or not any(row):
                        continue
                    rec = {k: (v or "").replace("\n", " ").strip() for k, v in zip(header, row) if k}
                    if rec.get("nombre"):
                        yield rec


def build_pdf(rows: Iterable, titulo: str = "Reporte de Unidades Educativas") -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle

    styles = getSampleStyleSheet()
    cell = styles["BodyText"].clone("cell", fontSize=7, leading=8)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(letter), leftMargin=24, rightMargin=24, topMargin=24, bottomMargin=24)
    data = [["Nombre", "Dist.", "Dependencia", "Dirección", "Nivel", "Turno", "RUE"]]
    for r in rows:
        data.append([
            Paragraph(r.nombre or "", cell),
            str(r.distrito_municipal or ""),
            r.dependencia or "",
            Paragraph(r.direccion or "", cell),
            Paragraph((r.niveles or "").replace(",", ", "), cell),
            (r.turnos or "").replace(",", ", "),
            r.codigo_rue or "",
        ])
    table = Table(data, repeatRows=1, colWidths=[200, 32, 70, 200, 120, 70, 50])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f4e79")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f6fa")]),
    ]))
    doc.build([Paragraph(titulo, styles["Title"]), table])
    return buf.getvalue()
