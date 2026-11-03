---
description: Ejecuta un sprint de SCRUM_HANDIHAND con los agentes DEV1_HANDIHAND y DEV2_HANDIHAND
argument-hint: sprints/sprint-NN.json
---

Actúas en nombre de **SCRUM_HANDIHAND** y coordinas a los dos desarrolladores del proyecto: `dev1-handihand` (backend y datos) y `dev2-handihand` (frontend).

Archivo del sprint: `$ARGUMENTS`. Si no se indicó ninguno, usa el `sprints/sprint-*.json` más reciente.

## Pasos
1. Lee el JSON (`formato: "sprint-handihand/1"`). Si falta o tiene otro formato, detente y dilo.
2. Recorre las historias en el orden del archivo, que es el orden de prioridad. Por cada historia:
   - Ignora las tareas con `estado` `hecha` o `revision`.
   - Primero las tareas de **DEV1**: invoca al subagente `dev1-handihand`. Pásale la historia completa (rol, acción, beneficio, criterios), solo sus tareas con `id`, `titulo`, `tipo` y `plan`, y la definición de terminado (`dod`).
   - Después las tareas de **DEV2**, con `dev2-handihand`. Agrega a la instrucción lo que reportó DEV1 sobre la API, si cambió algo.
   - Si una historia no tiene dependencias entre backend y frontend, puedes invocar a los dos a la vez.
3. Al terminar cada historia, corre `python3 -m pytest -q tests` y `npm run test:e2e`.
   - Si algo falla, devuelve el fallo al desarrollador responsable, como máximo dos veces.
   - Si sigue fallando, marca esas tareas como `en_curso` con una nota del bloqueo y no hagas commit de esa historia.
4. Si la historia pasó las pruebas, haz **un commit por historia**: `HU-xx: <título> (sprint N)`, con lo que hizo cada desarrollador en el cuerpo. No hagas `git push` salvo que el usuario lo pida.
5. Al final, entrega el bloque de avance para importarlo en la vista DESARROLLO de la página. Lleva una entrada por tarea trabajada, con el hash corto del commit cuando lo haya:

```avance-handihand
{"sprint": N, "tareas": [{"id": "HU-01#1", "estado": "revision", "commit": "abc1234", "nota": "..."}]}
```

Estados válidos: `pendiente`, `en_curso`, `revision`, `hecha`. Usa `hecha` solo si el usuario revisó y aprobó; si no, deja `revision`.

## Reglas
- No amplíes el alcance: solo lo que dicen las historias y sus criterios de aceptación.
- No escribas en las tablas `core_*` de la BD de cuidados.
- Resume al usuario: historias completadas, tareas bloqueadas con su motivo y pruebas ejecutadas.
