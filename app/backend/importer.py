"""Importa datos cosechados (recon/out/**) o CSV/JSON/GeoJSON a la base.

Uso:
    python -m app.backend.importer recon/out/harvest/data/*.json --fuente cuidados
    python -m app.backend.importer app/data/demo_unidades.csv --fuente DEMO
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

from sqlmodel import Session, select

from .db import engine, init_db
from .models import UnidadEducativa
from .normalize import dedupe_key, normalize_record


def _records_from_json(data) -> Iterator[dict]:
    """Recorre JSON arbitrario buscando listas de objetos con pinta de UE."""
    if isinstance(data, dict):
        if data.get("type") == "FeatureCollection":
            yield from data.get("features", [])
            return
        if data.get("type") == "Feature":
            yield data
            return
        # DRF: {"count":..,"results":[..]} ; otros: {"data":[..]}
        for key in ("results", "data", "items", "unidades", "features", "rows"):
            if isinstance(data.get(key), list):
                yield from _records_from_json(data[key])
                return
        for value in data.values():
            if isinstance(value, (list, dict)):
                yield from _records_from_json(value)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and (item.get("type") == "Feature" or any(
                k.lower() in ("nombre", "name", "unidad_educativa") for k in item
            )):
                yield item
            elif isinstance(item, (list, dict)):
                yield from _records_from_json(item)


def read_file(path: Path) -> Iterator[dict]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as fh:
            yield from csv.DictReader(fh)
    elif suffix in (".json", ".geojson"):
        yield from _records_from_json(json.loads(path.read_text(encoding="utf-8")))
    elif suffix == ".pdf":
        from .pdf_report import parse_pdf

        yield from parse_pdf(path)


def upsert(records: Iterable[dict], fuente: str | None) -> dict[str, int]:
    init_db()
    stats = {"nuevos": 0, "actualizados": 0, "descartados": 0}
    with Session(engine) as session:
        for raw in records:
            rec = normalize_record(raw, fuente)
            if rec is None:
                stats["descartados"] += 1
                continue
            clave = dedupe_key(rec)
            row = session.exec(select(UnidadEducativa).where(UnidadEducativa.clave == clave)).first()
            if row is None:
                session.add(UnidadEducativa(clave=clave, **rec))
                session.flush()
                stats["nuevos"] += 1
            else:
                # completa sin pisar datos existentes con vacíos
                for key, value in rec.items():
                    if value not in (None, ""):
                        setattr(row, key, value)
                row.actualizado = datetime.now(timezone.utc)
                stats["actualizados"] += 1
        session.commit()
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--fuente", default=None)
    args = parser.parse_args()
    total = {"nuevos": 0, "actualizados": 0, "descartados": 0}
    for path in args.paths:
        stats = upsert(read_file(path), args.fuente or path.name)
        print(f"{path}: {stats}")
        for k, v in stats.items():
            total[k] += v
    print("TOTAL", total)


if __name__ == "__main__":
    main()
