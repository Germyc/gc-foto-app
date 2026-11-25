# GermyCode · Foto App (`gc-foto-app`)

Aplicación web móvil **zero-dependencies** para que los clientes de **GermyCode / TownShop** puedan capturar fotos desde el celular, recortarlas, ajustarlas y cargar título y descripción, manteniendo actualizada la galería de su sitio web **sin costo mensual, sin base de datos y sin Google Drive/Sheets**.

---

## Arquitectura

La aplicación usa el **mismo formato de almacenamiento** tanto en local como en producción (Vercel):

```text
proyecto-cliente/
├── fotoapp.html          (o index.html en este repo)
├── galeria-demo.html     (ejemplo de galería pública)
├── assets/               (logo bitmap GermyCode y favicons)
├── api/
│   └── photos.js         (función serverless de Vercel → GitHub API)
├── vercel.json           (rewrites de /api/* y cache-control)
├── server.py             (solo para pruebas/uso en PC local)
└── galeria/
    ├── galeria.json      (índice de fotos con título, descripción y ruta)
    └── fotos/            (imágenes JPEG optimizadas, máx. 1280px, ~80-150 KB)
```

### Dos modos de operación transparentes

| Modo | Backend | Dónde guarda | Publicación |
| :--- | :--- | :--- | :--- |
| **Local (PC / pruebas)** | `server.py` (Python stdlib) | Disco local (`./galeria/`) | Inmediata |
| **Nube (Vercel + GitHub)** | `api/photos.js` (Node 18+ nativo) | Repo GitHub del cliente (`galeria/`) | En lote con botón **Publicar** |

---

## Cómo funciona el modo "Editar todo → Publicar al salir" (Vercel)

Para no consumir la cuota diaria de deploys gratuitos de Vercel (100/día en plan Hobby):

1. **Durante la carga y edición** (sacar fotos, modo secuencia, recortar, ajustar brillo/contraste/saturación, editar textos o borrar):
   - Cada operación genera **1 commit atómico** en GitHub con `[skip ci]` en el mensaje.
   - Los cambios quedan **guardados al instante en GitHub** (no se pierden aunque se cierre el navegador), pero **Vercel NO dispara deploy**.
   - Dentro de Foto App las imágenes recién subidas se ven al instante mediante el proxy seguro `/api/photos?file=...` (funciona tanto en repos públicos como privados).
2. **Al terminar la tanda**:
   - Arriba aparece el banner amarillo **"Hay cambios guardados sin publicar en la web"** con el botón **Publicar**.
   - Al tocar **Publicar**, `POST /api/publish` dispara **1 solo deploy en Vercel** (vía Deploy Hook o commit vacío sin `[skip ci]`).
   - En ~15–25 segundos todas las fotos y ediciones quedan publicadas en la CDN global de Vercel.

---

## Funcionalidades de la app móvil

- **Cámara integrada (`getUserMedia`) fullscreen (`100dvh`)**: evita que Android recargue la pestaña al volver de la cámara externa.
- **Modo secuencia**: guarda cada foto directo al disparar sin salir del visor, dejando las fotos marcadas como *"Sin título"* para editarlas después con tranquilidad.
- **Control de Flash (`⚡ ON / OFF`)** y cambio de cámara trasera/frontal.
- **Acceso a galería del dispositivo** desde la misma pantalla de cámara (y fallback automático en PC sin webcam).
- **Editor fullscreen (`100dvh`, sin scroll)**:
  - **Recortar**: `Libre`, `1:1`, `4:3`, `16:9`, `4:5`, `9:16`, **Rotar 90°**, **Espejo** y **Resetear**.
  - **Ajustes**: **Brillo**, **Contraste** y **Saturación** en tiempo real.
  - **Datos**: **Título** y **Descripción** (ambos opcionales).
- **Filtro en Galería**: `Todas` / `Pendientes` (muestra rápido las fotos sin título) + buscador + re-edición completa de fotos ya guardadas.

---

## Uso en local (PC / pruebas con celular)

1. Iniciar el servidor local (no requiere instalar paquetes):
   ```bash
   python3 server.py 8080
   ```
2. Abrir en la PC:
   - App de carga: `http://localhost:8080/`
   - Vista galería pública demo: `http://localhost:8080/galeria-demo.html`
3. Para probar desde el celular con HTTPS (requerido por la cámara `getUserMedia`), abrir un túnel temporal:
   ```bash
   ssh -R 80:localhost:8080 serveo.net
   ```

---

## Endpoints de la API (`server.py` y `api/photos.js`)

| Método | Ruta | Descripción |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Estado del servidor, modo (`local` o `vercel-github`) y si hay cambios sin publicar |
| `GET` | `/api/photos` | Lista de fotos desde `galeria/galeria.json` |
| `GET` | `/api/photos?file=<nombre>` | (Solo Vercel) Devuelve la imagen desde GitHub antes del redeploy |
| `POST` | `/api/photos` | Sube una nueva foto (`{ title, description, image }`) |
| `PATCH` | `/api/photos/:id` | Actualiza título, descripción y opcionalmente reemplaza la imagen |
| `DELETE` | `/api/photos/:id` | Elimina la foto y su entrada en `galeria/galeria.json` |
| `POST` | `/api/publish` | (Solo Vercel) Dispara 1 deploy con todos los cambios pendientes |

---

## Integración en páginas de clientes

Ver la guía paso a paso completa en [INTEGRACION-CLIENTES.md](./INTEGRACION-CLIENTES.md).
