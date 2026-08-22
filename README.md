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

## Desplegar en Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render selecciona **New > Blueprint** y conecta el repositorio.
3. Render detectará `render.yaml`, instalará las dependencias y arrancará el servidor.
4. Copia la URL pública asignada por Render y agrégale `/manifest.json` en Stremio.

Ejemplo:

```text
https://tu-servicio.onrender.com/manifest.json
```

En un hosting, usar el mismo `manifest.json` reemplazando `localhost` por el dominio público. El servidor escucha en `PORT` y permite personalizar `BASE_URL`, `AGENDA_URL` e `ICON_URL` mediante variables de entorno.

Usa esta integración únicamente con fuentes y emisiones que tengas autorización para redistribuir.