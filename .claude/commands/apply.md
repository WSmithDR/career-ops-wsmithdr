# apply

Prepara una aplicación para una vacante: reporte, CV adaptado, carta de presentación y borrador de correo.

## Uso

```
/apply <url-de-la-vacante>
/apply <numero-de-reporte>
```

## Ejemplos

```
/apply https://empresa.com/jobs/123
/apply 042
```

## Qué hace

Ejecuta `pnpm run apply <url|numero>` que genera en `output/applications/NNN/`:
- Reporte de evaluación
- Borrador de carta de presentación
- Borrador de correo (.eml y enlace mailto:)
- Nota para generar el CV adaptado con `pnpm run pdf`

Tú revisas el borrador y envías el correo tú mismo. Nunca se envía nada automáticamente.


Para flujo asistido con confirmación humana explícita (nunca auto-submit): `node scripts/apply-assist.mjs <URL|numero-de-reporte>` o `/apply-assist <...>`.
