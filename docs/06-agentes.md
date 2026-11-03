# Agentes COLEGIOS_HANDIHAND (PO) y SCRUM_HANDIHAND

Página publicada: https://claude.ai/artifact/6sdwXjEQyhYAA4wmhhkmAn · fuente: `agentes/colegios_handihand.html`

| Vista | Para quién | Qué hace |
|---|---|---|
| `#po`: **COLEGIOS_HANDIHAND** | Cliente | Conversa como Product Owner; registra historias de usuario (Como / quiero / para, criterios de aceptación, prioridad MoSCoW); arma el acta y recoge la firma |
| `#scrum`: **SCRUM_HANDIHAND** | Solo el dueño de la página (oculta para colaboradores) | Recibe solo historias de actas firmadas; estima en puntos Fibonacci, desglosa tareas, arma sprints según velocidad, DoD y riesgos; acepta ajustes por chat; marca tareas hechas |

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
| `backlog/*`, `sprints/*`, `scrum/plan` | plan del equipo | **solo el dueño** lee y escribe (`read/write: owner`) |

**Integridad:** al firmar se guarda la huella SHA-256 del acta. Si alguien cambia el acta después, el historial muestra "modificada después de la firma".

## Cómo compartir con el cliente

1. Abrir la página, menú **Share** → invitar al cliente **por correo** con rol **Editor**. Los visitantes externos con link público o rol Visualizador pueden leer, pero no conversar ni firmar.
2. Enviarle el enlace con la vista del PO: `https://claude.ai/artifact/6sdwXjEQyhYAA4wmhhkmAn#po`
3. El cliente necesita una cuenta de claude.ai. Cada mensaje al agente usa **su** cuota de Claude, y la primera vez se le pide permiso.

El colaborador solo ve a COLEGIOS_HANDIHAND: la pestaña SCRUM no aparece, `#scrum` lo devuelve a `#po` y las reglas de datos le impiden leer o escribir backlog y sprints, aunque tenga rol Editor.

## Si el cliente no puede usar la página (plan B)

**Causa habitual:** la página está compartida con "cualquiera con el link". Con un link público, claude.ai deja a los invitados de fuera de tu organización **solo en lectura**, aunque los hayas invitado como Editor. Para que el cliente converse y firme en la página: Share → desactivar el link público y dejar solo la invitación por correo como Editor, con el mismo correo con que el cliente entra a Claude.

**Si aun así no puede:** el cliente usa al PO en **su propio Claude**.
1. Le envías el texto de `agentes/INSTRUCCIONES_PO_CLAUDE.md` (también está en la página: "Use al PO en su propio Claude" → Copiar instrucciones).
2. Lo pega en un chat nuevo y conversa. Al final responde **ACEPTO**, su nombre y su CI, y recibe un bloque `acta-handihand`.
3. Te envía ese bloque y lo pegas en `#scrum` → "Importar acta aceptada en el Claude del cliente". El acta queda con su huella SHA-256 y la aceptación escrita (sin firma dibujada), y las historias pasan a SCRUM.

## Pruebas

`npm run test:agentes` recorre el flujo completo con `window.claude` simulado (31 comprobaciones, incluidos el plan B y la vista del colaborador): registro de historias, escape de HTML, acta, bloqueo del chat, firma, traspaso, descarga, planificación, tareas, ajuste por herramienta, detección de alteraciones y nueva ronda.
