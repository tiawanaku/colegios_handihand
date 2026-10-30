"""Exportación del "Reporte de Unidades Educativas" en PDF."""
from __future__ import annotations

import io
from typing import Iterable


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
