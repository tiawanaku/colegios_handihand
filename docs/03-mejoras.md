# Sistema mejorado frente al original

| Aspecto | Original (observado) | Sistema mejorado |
|---|---|---|
| Datos | Un PDF estático con 5 columnas | API JSON paginada y filtrable, más GeoJSON, CSV, Excel y PDF con los mismos filtros |
| Filtros | Categoría en el mapa | Dependencia, nivel, turno, distrito (varios a la vez), texto libre (nombre, dirección, RUE) y bbox del mapa |
| Indicadores | — | KPIs por dependencia, distrito × dependencia, oferta por nivel, matrícula M/H, ratio estudiante/docente y unidades sin coordenadas |
| Identidad | Por nombre | Código RUE (SIE) con deduplicación entre fuentes |
| Integración | — | Lectura directa de la BD de cuidados (vista SQL); importador de CSV, JSON y GeoJSON |
| Documentación API | — | OpenAPI automático en `/docs` |
| Rendimiento offline | Depende de CDNs | Leaflet y Chart.js servidos localmente (sirve en intranet municipal) |
| Móvil | — | Diseño adaptable |

## Hoja de ruta sugerida

1. **Cruce con el SIE**: un job nocturno que compare la BD de cuidados con el directorio SIE y registre las diferencias (altas, bajas, cambios de dependencia).
2. **Cumplimiento de convenios (RM 0021/2024)**: guardar la vigencia de la autorización y del certificado RUE, con alertas de vencimiento.
3. **Capas de cobertura**: densidad de oferta por nivel y por distrito frente a la población en edad escolar (INE), para detectar zonas desatendidas.
4. **Accesibilidad a la escuela**: isócronas a pie desde cada barrio (OSRM/Valhalla).
5. **Roles**: edición por las direcciones distritales, con auditoría (historial de cambios por registro).
6. **Migrar a PostgreSQL + PostGIS** para hacer consultas espaciales en el servidor (`COLEGIOS_DB=postgresql://…`; SQLModel ya lo soporta).
