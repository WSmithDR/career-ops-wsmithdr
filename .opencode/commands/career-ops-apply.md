---
name: career-ops-apply
description: Prepara una aplicación para una vacante: reporte, CV adaptado, carta de presentación y borrador de correo.
---

# career-ops-apply

Prepara todo lo necesario para aplicar a una vacante sin tener que recordar comandos:

1. Pega la URL de la vacante (o el número de reporte, ej. `002`).
2. El script genera en `output/applications/NNN/`:
   - Reporte de evaluación (si no existe aún).
   - Borrador de carta de presentación.
   - Borrador de correo (`.eml` y enlace `mailto:`).
   - Nota de que el CV adaptado se genera con `/career-ops pdf`.
3. Tú revisas el borrador y tú envías el correo. El script nunca envía nada ni rellena formularios.

## Uso

Escribe en el chat:

```
/career-ops-apply https://empresa.com/jobs/123
```

o con un número de reporte:

```
/career-ops-apply 002
```

## Qué hace internamente

Ejecuta:

```bash
node automation/prepare-application.mjs <URL|numero-de-reporte>
```

## Ejemplo de salida

```
prepare-application: reporte 042 — Niuro | Forward Deployed Engineer
prepare-application: borrador escrito en output/applications/042
prepare-application: output/applications/042/borrador-042.eml
prepare-application: output/applications/042/mailto-042.txt
```

Luego abre el archivo `.eml` en tu cliente de correo, rellena el destinatario, adjunta el CV y la carta, y envía tú mismo.
