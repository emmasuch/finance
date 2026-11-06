# Mi presupuesto

App web instalable (PWA) para llevar cuentas, presupuesto, ahorro y gastos compartidos.
Los datos se guardan en Supabase (UE); cada cuenta solo ve lo suyo.

- `index.html` – la app (pantallas).
- `logica.js` – cálculos (ciclo, saldos, presupuesto, gastos compartidos).
- `datos.js` – lectura y escritura en Supabase.
- `config.js` – dirección del proyecto de Supabase y su clave pública (no es secreta).
- `sw.js` – guarda la app en el móvil para que abra al instante. Al cambiar cualquier archivo, sube `VERSION`.
- `privacidad.html`, `aviso-legal.html` – textos legales.
- `v1/` – versión antigua conectada a la hoja de Google (copia de seguridad).
- `v2/` – dirección anterior de la app nueva: redirige aquí.
