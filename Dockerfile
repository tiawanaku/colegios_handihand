# Dashboard + API. La BD se pasa por COLEGIOS_DB (p. ej. la vista de db/vista_unidad_educativa.sql):
#   docker build -t colegios .
#   docker run -p 8000:8000 -e COLEGIOS_DB="postgresql+psycopg://dashboard:clave@host/cuidados" colegios
FROM python:3.13-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
USER nobody
CMD ["uvicorn", "app.backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
