"""Genera datos FICTICIOS (fuente=DEMO) para probar el sistema sin acceso al sitio original.

Ningún registro corresponde a una unidad educativa real; los datos reales se obtienen con recon/.
"""
import csv
import random
from pathlib import Path

random.seed(2026)
OUT = Path(__file__).with_name("demo_unidades.csv")
DEPS = ["FISCAL"] * 70 + ["CONVENIO"] * 12 + ["PRIVADA"] * 18
CONVENIOS = ["Fe y Alegría", "Iglesia Católica", "Iglesia Evangélica", "ONG"]
NIVELES = ["Inicial en Familia Comunitaria", "Primaria Comunitaria Vocacional", "Secundaria Comunitaria Productiva"]
TURNOS = ["Mañana", "Tarde", "Noche"]
# centro aproximado de El Alto y desplazamientos por distrito (aprox.)
CENTRO = (-16.505, -68.19)

rows = []
for i in range(1, 181):
    dist = random.randint(1, 14)
    dep = random.choice(DEPS)
    if random.random() < 0.08:
        niveles = ["Educación Primaria para Adultos", "Educación Secundaria para Adultos"]
    else:
        niveles = random.sample(NIVELES, random.randint(1, 3))
    turnos = random.sample(TURNOS[:2] if dep == "PRIVADA" else TURNOS, random.randint(1, 2))
    est = random.randint(80, 1600) if dep != "PRIVADA" else random.randint(60, 700)
    muj = int(est * random.uniform(0.45, 0.55))
    rows.append({
        "rue": f"9{i:07d}",
        "nombre": f"U.E. DEMO {i:03d}",
        "dist": dist,
        "dependencia": dep,
        "tipo_convenio": random.choice(CONVENIOS) if dep == "CONVENIO" else "",
        "nivel": " / ".join(niveles),
        "turno": " y ".join(turnos),
        "direccion": f"Zona Demo {dist}-{random.randint(1, 30)}, Calle {random.randint(1, 99)}",
        "lat": round(CENTRO[0] + random.uniform(-0.06, 0.06), 6),
        "lon": round(CENTRO[1] + random.uniform(-0.06, 0.06), 6),
        "mujeres": muj,
        "hombres": est - muj,
        "docentes": max(4, est // random.randint(18, 32)),
    })

with OUT.open("w", newline="", encoding="utf-8") as fh:
    writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)
print(f"{len(rows)} registros DEMO -> {OUT}")
