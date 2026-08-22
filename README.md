# Fútbol Libre para Stremio

Servidor de addon compatible con Stremio. Expone los canales y la agenda del addon original de Kodi como catálogos y resuelve sus streams.

## Ejecutar localmente

```bash
npm install
npm start
```

Luego se instala en Stremio con:

```text
http://localhost:7000/manifest.json
```

## Desplegar en Vercel

1. Sube esta carpeta a un repositorio de GitHub.
2. Entra a Vercel y selecciona **Add New > Project**.
3. Importa el repositorio de GitHub y deja la configuración por defecto.
4. Pulsa **Deploy**. Vercel usará `vercel.json` y `api/index.js` automáticamente.
5. Copia la URL pública asignada por Vercel y agrégale `/manifest.json` en Stremio.

Ejemplo:

```text
https://tu-proyecto.vercel.app/manifest.json
```

En **Settings > Environment Variables** puedes personalizar `BASE_URL`, `AGENDA_URL` e `ICON_URL`. No necesitas configurar `PORT`: Vercel administra ese puerto.

Para probarlo localmente, `npm start` sigue funcionando en `http://localhost:7000/manifest.json`.

Usa esta integración únicamente con fuentes y emisiones que tengas autorización para redistribuir.