-- Vista `unidad_educativa` sobre la BD de cuidados (Django: core_institucion + catálogo EAV).
-- Con esta vista, el backend de este repo funciona contra la BD real sin copiar datos:
--     psql -d cuidados -f db/vista_unidad_educativa.sql
--     COLEGIOS_DB=postgresql+psycopg://usuario@host/cuidados uvicorn app.backend.main:app
--
-- Mapeo (ver docs/05-bd-cuidados.md):
--   core_institucion (tipo EDUCACION, deleted IS NULL)  -> una fila por unidad educativa
--   core_institucionpropiedad -> core_catalogogeneral(propiedad, valor):
--     DEPENDENCIA      -> dependencia   (FISCAL | CONVENIO | PRIVADA; 1 por UE)
--     TIPO             -> subsistema    (EDUCACIÓN REGULAR | ... ; 1 por UE. Se usa TIPO y no
--                                        SUBSISTEMA porque éste marca ESPECIAL también a los CEA)
--     NIVEL EDUCATIVO  -> niveles       (varios, separados por coma)
--     TURNO            -> turnos        (varios, separados por coma)
-- Los valores de catálogo no contienen comas; el backend filtra por ítem exacto de la lista.

CREATE OR REPLACE VIEW public.unidad_educativa AS
WITH props AS (
    SELECT p.id_institucion_id AS id,
           string_agg(c.valor, ',' ORDER BY c.valor) FILTER (WHERE c.propiedad = 'DEPENDENCIA')     AS dependencia,
           string_agg(c.valor, ',' ORDER BY c.valor) FILTER (WHERE c.propiedad = 'TIPO')            AS tipo,
           string_agg(c.valor, ',' ORDER BY c.id)    FILTER (WHERE c.propiedad = 'NIVEL EDUCATIVO') AS niveles,
           string_agg(c.valor, ',' ORDER BY c.id)    FILTER (WHERE c.propiedad = 'TURNO')           AS turnos
    FROM core_institucionpropiedad p
    JOIN core_catalogogeneral c ON c.id = p.id_catalogo_id AND c.deleted IS NULL
    GROUP BY p.id_institucion_id
),
ultima_edicion AS (
    SELECT id, max(history_date) AS fecha FROM core_historicalinstitucion GROUP BY id
)
SELECT i.id,
       'cuidados:' || i.id                                   AS clave,
       NULL::varchar                                          AS codigo_rue,      -- la BD no tiene RUE
       i.nombre_institucion                                   AS nombre,
       pr.dependencia,
       NULL::varchar                                          AS tipo_convenio,
       regexp_replace(pr.tipo, '^EDUCACIÓN ', '')             AS subsistema,      -- REGULAR | ALTERNATIVA | ESPECIAL | PERMANENTE
       pr.niveles,
       pr.turnos,
       i.distrito                                             AS distrito_municipal,
       NULL::varchar                                          AS distrito_educativo,
       i.zona,
       i.direccion,
       NULLIF(concat_ws(' / ',
           NULLIF(array_to_string(ARRAY(SELECT jsonb_array_elements_text(i.telefono)), ', '), ''),
           NULLIF(array_to_string(ARRAY(SELECT jsonb_array_elements_text(i.celular)), ', '), '')), '') AS telefono,
       i.responsable                                          AS director,
       NULL::varchar                                          AS area,
       i.latitud                                              AS lat,
       i.longitud                                             AS lon,
       NULL::integer AS estudiantes_total, NULL::integer AS estudiantes_mujeres,
       NULL::integer AS estudiantes_hombres, NULL::integer AS docentes,         -- la BD no tiene matrícula
       NULL::varchar                                         AS fuente,
       COALESCE(ue.fecha, now())                              AS actualizado
FROM core_institucion i
JOIN core_tipoinstitucion t ON t.id = i.id_tipo_institucion_id AND t.nombre = 'EDUCACION'
LEFT JOIN props pr ON pr.id = i.id
LEFT JOIN ultima_edicion ue ON ue.id = i.id
WHERE i.deleted IS NULL;

COMMENT ON VIEW public.unidad_educativa IS 'Unidades educativas para el dashboard (colegios_handihand). Sólo lectura.';
