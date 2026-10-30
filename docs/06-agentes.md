# Agentes COLEGIOS_HANDIHAND (PO) y SCRUM_HANDIHAND

Página publicada: https://claude.ai/artifact/6sdwXjEQyhYAA4wmhhkmAn · fuente: `agentes/colegios_handihand.html`

| Vista | Para quién | Qué hace |
|---|---|---|
| `#po`: **COLEGIOS_HANDIHAND** | Cliente | Conversa como Product Owner; registra historias de usuario (Como / quiero / para, criterios de aceptación, prioridad MoSCoW); arma el acta y recoge la firma |
| `#scrum`: **SCRUM_HANDIHAND** | Equipo (editores) | Recibe solo historias de actas firmadas; estima en puntos Fibonacci, desglosa tareas, arma sprints según velocidad, DoD y riesgos; acepta ajustes por chat; marca tareas hechas |

## Flujo

```
Cliente ⇄ PO (ronda N: conversación + historias)
   └─ "no tengo más cambios" → acta N (hash SHA-256 del contenido)
        ├─ "Pedir cambios" → vuelve a conversación
        └─ Firma (nombre, CI, cargo, trazo, aceptación) → ronda "entregada"
              └─ SCRUM_HANDIHAND: "Generar backlog y sprints" → ronda "planificada"
```

## Datos (base compartida de la página)

| Colección | Contenido | Escriben |
|---|---|---|
| `rondas/rNNN` | estado (abierta, en_firma, entregada o planificada) y mensajes | participantes (Colaborador o Editor) |
| `historias/HU-xx` | historias y su estado | participantes |
| `actas/rNNN` | contenido del acta y `hash` | participantes |
| `firmas/<id de cuenta>` | firma por acta: nombre, CI, trazo, hash y fecha | **solo el propio firmante** (regla `self`: ni el dueño puede alterarla) |
| `backlog/*`, `sprints/*`, `scrum/plan` | plan del equipo | solo editores y dueño |

**Integridad:** al firmar se guarda la huella SHA-256 del acta. Si alguien cambia el acta después, el historial muestra "modificada después de la firma".

## Cómo compartir con el cliente

1. Abrir la página, menú **Share** → invitar al cliente **por correo** con rol **Editor**. Los visitantes externos con link público o rol Visualizador pueden leer, pero no conversar ni firmar.
2. Enviarle el enlace con la vista del PO: `https://claude.ai/artifact/6sdwXjEQyhYAA4wmhhkmAn#po`
3. El cliente necesita una cuenta de claude.ai. Cada mensaje al agente usa **su** cuota de Claude, y la primera vez se le pide permiso.

Limitación: como Editor, el cliente también puede abrir la vista `#scrum`. Para separarlo del todo haría falta una lista de miembros del equipo o dos páginas distintas.

## Pruebas

`npm run test:agentes` recorre el flujo completo con `window.claude` simulado (22 comprobaciones): registro de historias, escape de HTML, acta, bloqueo del chat, firma, traspaso, descarga, planificación, tareas, ajuste por herramienta, detección de alteraciones y nueva ronda.
