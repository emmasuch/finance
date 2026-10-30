# Mi presupuesto · app instalable

App web instalable (PWA) que lee y escribe en mi hoja de Google "Planner financiero"
a través del script de Apps Script "Mi presupuesto".

- `index.html` – la app (pantallas y lógica).
- `manifest.webmanifest` – nombre, icono y modo pantalla completa.
- `sw.js` – guarda la app en el móvil para que abra al instante.
- `icon-*.png`, `apple-touch-icon.png` – iconos.

La clave de conexión **no** está en este repositorio: se pega dentro de la app la primera vez
y se guarda solo en el móvil.

Al cambiar cualquier archivo, sube el número de `VERSION` en `sw.js` para que el móvil
descargue la versión nueva.
