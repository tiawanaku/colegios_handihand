# Contrato del sprint 3 (SCRUM_HANDIHAND)

DEV1 (backend) y DEV2 (frontend) programan en paralelo contra este documento. Si algo cambia, se avisa en el reporte final.

## Decisiones de alcance (el acta N.º 3 las dejó abiertas)
- **Quién puede editar:** todo usuario con sesión. Las correcciones usan la misma dependencia de rol que bajas y altas (`exigir_encargado`; con `COLEGIOS_TODOS_ENCARGADOS` por defecto, todos lo son). Personal y agenda solo exigen sesión.
- **Aplicación:** los cambios se aplican de inmediato, sin aprobación.
- **Fechas y horas:** locales de La Paz, guardadas como texto `YYYY-MM-DD` y `HH:MM`.
- **Base:** todo se guarda en tablas propias de la BD del sistema (`COLEGIOS_AUTH_DB`), nunca en `core_*` ni en la vista. Las tablas se crean al iniciar (`init_auth_db`) sin destruir nada.
- **Errores:** todos los 422 tienen la forma `{"detail": "<resumen>", "errores": {"<campo>": "<mensaje>"}}`. Si el body no es un objeto JSON, el error va en la clave `general`, con "Datos no válidos".

## HU-10 · Personal de la organización
No tiene relación con los colegios: es una lista propia.
- **Tabla `personal`:** id (autoincremental), nombre, cargo, telefono, correo, activo (bool, true por defecto), creado, actualizado, usuario (quién hizo el último cambio).
- **`GET /api/personal?incluir_inactivos=1`:** devuelve `[{id, nombre, cargo, telefono, correo, activo, creado, actualizado}]` ordenado por nombre, sin distinguir mayúsculas. Sin el parámetro, solo los activos.
- **`POST /api/personal`** con body `{nombre, cargo, telefono?, correo?}`: responde 201 `{"ok": true, "persona": {...}}`.
- **`PATCH /api/personal/{id}`:** acepta cualquier subconjunto de `{nombre, cargo, telefono, correo, activo}` y responde 200 `{"ok": true, "persona"}`. Responde 404 si el id no existe y 422 con `general` "No hay cambios para guardar" si nada cambia.
- **422:** `detail` = "Revise los datos del personal". Mensajes:
  - nombre: "Escriba el nombre"
  - cargo: "Escriba el cargo"
  - correo: "Correo no válido" (validación simple: algo@algo.algo)
  - si un campo no es texto: "Debe ser un texto"
  - si un texto es demasiado largo: "No puede pasar de N caracteres" (nombre 150, cargo 100, telefono 50, correo 150)
  - activo no booleano: "Valor no válido"
- **Normalización:** trim en todos los textos; telefono y correo vacíos se guardan como null.

## HU-08 · Correcciones
- **Colegios de la vista:** la corrección se guarda en la tabla propia `unidad_correccion` (ue_id PK y los valores corregidos de los campos editables, null si no se corrigen). Se aplica encima de la vista en **todo**: listado, filtros, búsqueda `q`, orden, mapa, estadísticas, catálogos (incluido `opciones_registro`), ficha, bajas, exportaciones y `build_static.filas()`.
- **Colegios registrados (id ≥ 1.000.000):** se actualiza su fila directamente.
- **Campos editables:** son los mismos del registro: nombre, dependencia, subsistema, distrito_municipal, direccion, zona, telefono, niveles (lista), turnos (lista), lat, lon.
- **`PATCH /api/unidades/{id}`:** body con cualquier subconjunto de esos campos (los desconocidos se ignoran).
  - Se valida el **registro resultante completo** con las mismas reglas, mensajes y normalización de `POST /api/unidades` (`app/backend/registro.py`).
  - Si se cumplen, responde 200 `{"ok": true, "id", "unidad": <ficha>, "cambios": [{"campo", "antes", "despues"}]}`.
  - 422 con `detail` "Revise los datos del colegio".
  - Sin cambios reales: 422 con `general` "No hay cambios para guardar".
  - Id inexistente: 404.
  - Colegio dado de baja: 409 "Reactive el colegio antes de corregirlo".
  - Exige sesión (401) y pasa por `exigir_encargado`.
- **Bitácora:** tabla `unidad_cambio` con id, ue_id, campo, antes, despues, usuario y fecha UTC, una fila por campo cambiado. Las listas se guardan como CSV.
  - `GET /api/unidades/{id}/historial` agrega entradas `{"accion": "modificacion", "usuario", "fecha", "cambios": [{campo, antes, despues}]}`, una por guardado, más recientes primero, mezcladas con las de baja, alta y registro.
- **Ficha:** cuando un colegio tuvo correcciones, agrega `"modificado": {"usuario", "fecha"}` con la última.

## HU-09 · Agenda de actividades
- **Tabla `actividad`:** id, ue_id, tipo, actividad, fecha, hora, lugar, encargados (lista de ids de personal), personal (lista de ids), asistentes_proyectados, observaciones, estado, creado, creado_por, actualizado, actualizado_por.
- **Tipos:** `TALLER`, `VISITA`, `REUNION`, `OTRA`. **Estados:** `PENDIENTE` (por defecto), `REALIZADA`, `POSTERGADA`, `CANCELADA`.
- **`GET /api/actividades?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&ue_id=&estado=`:** todos los parámetros son opcionales.
  - Si van `desde` y `hasta`, deben ser válidos, con desde ≤ hasta y un rango de 400 días como máximo; si no, 422 con las claves `desde` o `hasta`.
  - Devuelve la lista ordenada por fecha y hora. Cada elemento trae `{id, ue_id, colegio: {id, nombre}, tipo, actividad, fecha, hora, lugar, encargados: [{id, nombre, cargo, activo}], personal: [...], asistentes_proyectados, observaciones, estado, creado, creado_por, actualizado, actualizado_por}`.
- **`POST /api/actividades`:** responde 201 `{"ok": true, "actividad"}`.
- **`PATCH /api/actividades/{id}`:** acepta un subconjunto de campos (incluido `estado`) y responde 200 `{"ok": true, "actividad"}`. Responde 404 si no existe y 422 con `general` "No hay cambios para guardar".
- **422:** `detail` = "Revise los datos de la actividad". Mensajes:
  - ue_id: "Elija el colegio" (falta o no es entero) / "El colegio no existe o está dado de baja"
  - tipo: "Elija el tipo: taller, visita, reunión u otra"
  - actividad: "Describa la actividad"; si pasa de 200: "No puede pasar de 200 caracteres"
  - fecha: "Elija una fecha válida"
  - hora: "Elija una hora válida" (HH:MM, 00:00 a 23:59)
  - lugar: "Escriba el lugar"; si pasa de 200: "No puede pasar de 200 caracteres"
  - encargados: "Elija al menos un encargado" / "Hay personas que no existen o están inactivas"
  - personal: "Hay personas que no existen o están inactivas"
  - asistentes_proyectados: "Debe ser un número entero de 0 o más" (null permitido)
  - observaciones: si pasa de 2000: "No puede pasar de 2000 caracteres"
  - estado: "Estado no válido"
- **Personal inactivo:** no se puede asignar en una actividad nueva ni agregar en un PATCH. Si ya estaba asignado, puede quedarse.
- **Normalización:** tipo y estado se aceptan en minúsculas y se guardan en mayúsculas; trim en los textos; listas de ids sin repetir; observaciones vacías se guardan como null.
- La ficha del colegio puede pedir sus actividades con `GET /api/actividades?ue_id=<id>`.

## Página publicada (DEV2: static-api.js y static-estado.js)
La página debe hacer lo mismo con la base compartida del artifact y las mismas reglas y mensajes, con las colecciones `personal/<id>`, `correcciones/<id>` y `actividades/<id>`, más una entrada en `historial` por cada cambio. Los ids de personal y actividades se basan en `Date.now()`, como los registros.

## Navegación (DEV2)
La barra lateral queda con Dashboard, Registro, **Correcciones** (reemplaza a "Modificación"; el valor de `vista` puede ser `correcciones`), Agenda, **Personal** (nueva) y Estadísticas.
