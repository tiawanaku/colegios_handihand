import os
from pathlib import Path

from sqlmodel import SQLModel, create_engine

DB_URL = os.environ.get(
    "COLEGIOS_DB",
    f"sqlite:///{Path(__file__).resolve().parents[1] / 'data' / 'colegios.db'}",
)
engine = create_engine(DB_URL, connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {})


def init_db() -> None:
    from . import models  # noqa: F401  (registra tablas)

    SQLModel.metadata.create_all(engine)
