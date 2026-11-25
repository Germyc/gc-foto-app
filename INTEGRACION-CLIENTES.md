# Guía de Integración en Sitios de Clientes (Vercel + GitHub)

Esta guía explica cómo instalar **GermyCode Foto App** dentro del repositorio de cualquier cliente (por ejemplo `germycode.com.ar/fotoapp.html` o `casaauxiliadora.com.ar/fotoapp.html`) para que el cliente autogestione su galería desde el celular **100% gratis**.

---

## Paso 1: Copiar los archivos al proyecto del cliente

Desde `gc-foto-app/`, copiar al repositorio del cliente:

1. `index.html` → renombrarlo a **`fotoapp.html`** (o el nombre oculto que prefieras, ej. `cargar-fotos.html`).
2. `api/photos.js` → copiar en **`api/photos.js`**.
3. `assets/germycode-logo.webp` → copiar en **`assets/germycode-logo.webp`** (si el proyecto ya lo tiene en esa ruta, no hace falta duplicarlo).
4. Crear la carpeta inicial **`galeria/`** con un archivo vacío **`galeria/galeria.json`** conteniendo `[]`.

> **Nota sobre `server.py`**: NO es necesario copiarlo a producción; solo sirve si querés probar en local en tu PC.

---

## Paso 2: Configurar `vercel.json` del cliente

Si el proyecto del cliente **no tiene** `vercel.json`, copiar el de este repo tal cual.

Si **ya tiene** `vercel.json` (por ejemplo `germycode/vercel.json`), agregar estos bloques dentro de `"rewrites"` y `"headers"`:

```json
{
  "rewrites": [
    { "source": "/api/health", "destination": "/api/photos?action=health" },
    { "source": "/api/publish", "destination": "/api/photos?action=publish" },
    { "source": "/api/photos/:id", "destination": "/api/photos?id=:id" }
  ],
  "headers": [
    {
      "source": "/galeria/galeria.json",
      "headers": [
        { "key": "Cache-Control", "value": "no-store, must-revalidate" }
      ]
    }
  ]
}
```

> **Importante**: En `fotoapp.html`, si querés que el botón **"Ver web"** del header lleve a la página principal del cliente (en vez de `galeria-demo.html`), cambiá `href="galeria-demo.html"` por `href="./"` o `href="./#galeria"`.

---

## Paso 3: Crear un Token de GitHub limitado SOLO a ese cliente

Por seguridad, creá un **Fine-grained Personal Access Token** por cliente:

1. Entrar a GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: `vercel-fotoapp-<nombre-cliente>`
3. **Expiration**: elegir la duración deseada (ej. 1 año; recordá renovarlo antes del vencimiento).
4. **Repository access**: seleccionar **Only select repositories** → elegir únicamente el repositorio de ese cliente.
5. **Permissions → Repository permissions → Contents**: seleccionar **Read and write**.
6. Generar y copiar el token (`github_pat_...`).

---

## Paso 4: Cargar las variables de entorno en Vercel

En el proyecto del cliente dentro de Vercel → **Settings → Environment Variables**, agregar para **Production** (y Preview si querés):

| Variable | Ejemplo | Obligatoria |
| :--- | :--- | :---: |
| `GITHUB_TOKEN` | `github_pat_11AAA...` | Sí |
| `GITHUB_OWNER` | `Germyc` (o cuenta del cliente) | Sí |
| `GITHUB_REPO` | `germycode` (o repo del cliente) | Sí |
| `GITHUB_BRANCH` | `main` | No (default `main`) |
| `VERCEL_DEPLOY_HOOK_URL` | `https://api.vercel.com/v1/integrations/deploy/...` | No (opcional) |

> **Tip sobre `VERCEL_DEPLOY_HOOK_URL`**: Si no la configurás, al tocar **Publicar** se crea un commit vacío sin `[skip ci]` en GitHub que dispara el deploy automáticamente. Si preferís no agregar commits vacíos al historial, creá un Deploy Hook en Vercel (*Settings → Git → Deploy Hooks*) y pegá la URL en `VERCEL_DEPLOY_HOOK_URL`.

Hacer `git push` del proyecto para que Vercel despliegue `fotoapp.html` y `api/photos.js`.

---

## Paso 5: Conectar la galería pública del cliente a `galeria/galeria.json`

En la página web del cliente (`index.html`), agregá un contenedor `<div id="galeria-grid"></div>` y este script liviano (cero dependencias):

```html
<script>
(async function cargarGaleria() {
  const contenedor = document.getElementById('galeria-grid');
  if (!contenedor) return;

  try {
    const res = await fetch('./galeria/galeria.json', { cache: 'no-store' });
    if (!res.ok) return;
    const fotos = await res.json();
    if (!Array.isArray(fotos) || fotos.length === 0) return;

    const esc = (t) => {
      const d = document.createElement('div');
      d.textContent = t || '';
      return d.innerHTML;
    };

    contenedor.innerHTML = fotos.map((f) => `
      <article class="galeria-card">
        <img src="./${esc(f.image)}" alt="${esc(f.title || 'Foto de galería')}" loading="lazy">
        ${(f.title || f.description) ? `
          <div class="galeria-card-body">
            ${f.title ? `<h3>${esc(f.title)}</h3>` : ''}
            ${f.description ? `<p>${esc(f.description)}</p>` : ''}
          </div>
        ` : ''}
      </article>
    `).join('');
  } catch (err) {
    console.error('Error cargando galería:', err);
  }
})();
</script>
```

---

## Flujo diario para el cliente

1. Abrir `https://tudominio.com.ar/fotoapp.html` desde el celular (puede agregarlo a la pantalla de inicio del teléfono como acceso directo).
2. Tocar **Nueva foto** → sacar una foto (o activar **Secuencia** para sacar varias seguidas).
3. Recortar, ajustar brillo/contraste y completar título/descripción cuando quiera.
4. Al terminar toda la tanda, tocar **Publicar** arriba → en ~20 segundos la web oficial muestra todas las fotos nuevas.

---

## Checklist rápido de resolución de problemas

- **El punto de estado en el header aparece en rojo**: faltan las variables `GITHUB_TOKEN`, `GITHUB_OWNER` o `GITHUB_REPO` en Vercel, o el `vercel.json` no tiene el rewrite de `/api/health`.
- **Error 403 / 404 al guardar**: verificar que el token de GitHub tenga permiso **Contents: Read and write** sobre ese repositorio y que `GITHUB_BRANCH` coincida con la rama real (`main`).
- **Las fotos se ven en Foto App pero todavía no en la web pública**: falta tocar el botón **Publicar** arriba (o esperar ~20 segundos a que termine el deploy de Vercel).
- **Recordatorio al trabajar en PC**: antes de editar código del cliente en tu PC, hacé `git pull` para traer las fotos nuevas que haya subido el cliente desde su celular.
