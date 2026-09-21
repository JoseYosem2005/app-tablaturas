# Tab Finder

App para buscar y descargar tablaturas Guitar Pro desde GProTab.net.

Reescrita en HTML/CSS/JS (originalmente era Python + Kivy) para poder
empaquetarla como app Android nativa con **Capacitor**.

## Estructura

```
www/              → codigo web (esto es lo que Capacitor empaqueta)
  index.html
  css/style.css
  js/app.js       → logica de busqueda/descarga, portada del script Python
capacitor.config.json
package.json
.github/workflows/build-android.yml   → compila el APK automaticamente
```

## Por que CapacitorHttp y no `fetch()`

GProTab.net no manda cabeceras CORS, asi que un `fetch()` normal desde el
WebView seria bloqueado por el navegador. El codigo usa el plugin
**CapacitorHttp**, que hace la peticion a nivel nativo (fuera del WebView),
evitando el problema — funciona igual que `requests` en la version Python.
Esto **solo funciona dentro del shell nativo de la app**, no abriendo
`index.html` suelto en un navegador de escritorio.

## Compilar localmente

```bash
npm install
npx cap add android
npx cap sync android
npx cap open android      # abre Android Studio
```

## Compilar via GitHub Actions

Cada push a `main` dispara el workflow `build-android.yml`, que instala
dependencias, agrega la plataforma Android, y compila un APK debug.
El APK queda disponible como artifact descargable en la pestaña
**Actions** del repo (`tab-finder-debug-apk`).

También se puede disparar manualmente desde Actions → Build Android APK →
**Run workflow**.

## Pendiente / a revisar

- El guardado de archivos usa el plugin `@capacitor/filesystem` en
  `Directory.Documents/tablaturas/`. En Android 10+ esto puede requerir
  ajustar permisos de almacenamiento segun la version del SO.
- El parseo de metadata (rating, descargas, tamaño) depende de regex
  contra el HTML de gprotab.net — si el sitio cambia su marcado, hay que
  actualizar `enrichDetails()` en `www/js/app.js`.
- El APK que genera el workflow es **debug**, sin firmar para producción.
  Para publicarlo hay que configurar firma (`keystore`) aparte.
