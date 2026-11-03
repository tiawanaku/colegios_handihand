# Desarrolladores DEV1_HANDIHAND y DEV2_HANDIHAND

Dos agentes desarrolladores que dependen de **SCRUM_HANDIHAND**: solo trabajan las tareas que SCRUM les asigna, dentro de los sprints que SCRUM armó a partir de actas firmadas por el cliente.

| Agente | Especialidad | Tipos de tarea | Agente en el repo |
|---|---|---|---|
| **DEV1_HANDIHAND** | Backend y datos: FastAPI, vista SQL, login, exportaciones, Docker, pytest | `backend`, `datos`, `devops`, pruebas de API | `.claude/agents/dev1-handihand.md` |
| **DEV2_HANDIHAND** | Frontend: app.js, HTML/CSS, Leaflet, Chart.js, accesibilidad, Playwright | `frontend`, `diseño`, pruebas en navegador | `.claude/agents/dev2-handihand.md` |

## Flujo completo

```
Cliente ⇄ COLEGIOS_HANDIHAND (PO) → acta firmada
  → SCRUM_HANDIHAND: backlog, sprints, y cada tarea asignada a DEV1 o DEV2
     → DESARROLLO (página): tablero por desarrollador, plan técnico, estados
        → "Exportar sprint" → sprints/sprint-NN.json
           → Claude Code: /sprint sprints/sprint-NN.json
                dev1-handihand y dev2-handihand implementan, prueban y hacen un commit por historia
           ← bloque avance-handihand → "Importar avance" en la página
```

## En la página (pestaña DESARROLLO, solo para la dueña)

- **Asignación:** SCRUM_HANDIHAND asigna cada tarea al generar el plan, equilibrando horas (unas 30 h por persona y semana de sprint). Si falta la asignación, se decide por tipo. Para reasignar, se le pide en el chat de SCRUM: "asigna la tarea 2 de HU-01 a DEV2".
- **Tablero:** una columna por desarrollador, con horas asignadas frente a su capacidad y el estado de cada tarea (Pendiente, En curso, En revisión, Hecha).
- **Plan técnico:** el desarrollador asignado escribe enfoque, archivos, pasos, pruebas y dependencias, con la historia, sus criterios y el mapa del repositorio. La tarea pasa a "En curso".
- **Exportar sprint:** genera el JSON `sprint-handihand/1` (historias, criterios, tareas con `id` HU-xx#n, `asignado` y `plan`, más la DoD). Se puede copiar o descargar.
- **Importar avance:** pega el bloque `avance-handihand` que devuelve `/sprint`. Actualiza estado, commit y nota de cada tarea e ignora los `id` desconocidos.

## En el repositorio (Claude Code)

```bash
# 1. guardar el JSON exportado
sprints/sprint-01.json
# 2. en Claude Code, dentro del repo
/sprint sprints/sprint-01.json
```

`/sprint` (`.claude/commands/sprint.md`) actúa como SCRUM:
1. Recorre las historias por prioridad. Primero invoca a `dev1-handihand` con sus tareas y luego a `dev2-handihand`, pasándole lo que cambió DEV1 en la API.
2. Corre `pytest` y `npm run test:e2e`. Si algo falla, lo devuelve al responsable, como máximo dos veces.
3. Hace un commit por historia que pasa las pruebas. No hace push salvo que se le pida.
4. Entrega el bloque `avance-handihand` para importarlo en la página.

Los desarrolladores no cambian el alcance del acta, no escriben en las tablas `core_*` de la BD de cuidados y respetan las decisiones de `docs/04-frontend.md` (por ejemplo, `esc()` para todo dato y el estado en la URL).

## Limitaciones

- La página y el repositorio no se conectan solos: el puente es exportar e importar JSON. Las bases de datos de los artifacts de claude.ai no son accesibles desde scripts del repositorio.
- Los agentes `.claude/agents/*` y el comando `/sprint` se cargan al **iniciar** una sesión de Claude Code en el repo; en una sesión ya abierta antes de crearlos no aparecen.
- `tests/agentes/flujo.test.mjs` prueba la parte de la página con un Claude simulado (43 comprobaciones). La ejecución real de `/sprint` con los subagentes no tiene prueba automática.
