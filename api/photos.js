/**
 * GC Foto App — Vercel Serverless API (Zero Dependencies, Node 18+)
 *
 * Guarda fotos optimizadas en `galeria/fotos/` y actualiza `galeria/galeria.json`
 * directamente en el repositorio de GitHub del cliente mediante commits atómicos
 * con `[skip ci]` para NO disparar deploys en Vercel hasta que el usuario toque
 * "Publicar en la web" (`POST /api/publish`).
 *
 * Variables de entorno requeridas en Vercel:
 *   - GITHUB_TOKEN   : Fine-grained PAT con permiso "Contents: Read and write" en ese repo
 *   - GITHUB_OWNER   : Usuario u organización de GitHub (ej. "Germyc")
 *   - GITHUB_REPO    : Nombre del repositorio (ej. "germycode")
 *   - GITHUB_BRANCH  : (Opcional) Rama principal, por defecto "main"
 *   - VERCEL_DEPLOY_HOOK_URL : (Opcional) Deploy Hook de Vercel; si no está, hace un commit vacío sin [skip ci]
 */

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB
const GALERIA_JSON_PATH = "galeria/galeria.json";
const FOTOS_PREFIX = "galeria/fotos/";
const SKIP_TAG = "[skip ci]";

function getConfig() {
  const token = process.env.GITHUB_TOKEN || "";
  const owner = process.env.GITHUB_OWNER || "";
  const repo = process.env.GITHUB_REPO || "";
  const branch = process.env.GITHUB_BRANCH || "main";
  const deployHook = process.env.VERCEL_DEPLOY_HOOK_URL || "";
  return { token, owner, repo, branch, deployHook };
}

function setNoCache(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

function sendJson(res, status, payload) {
  setNoCache(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sanitizeSlug(text) {
  const clean = (text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.slice(0, 45) || "foto";
}

function decodeDataUrl(dataUrl) {
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) {
    throw new Error("Formato de imagen no válido (se espera JPEG, PNG o WebP en base64).");
  }
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  const buf = Buffer.from(base64, "base64");
  if (!buf.length) throw new Error("La imagen recibida está vacía.");
  return { ext, base64, sizeBytes: buf.length };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("La imagen supera el tamaño máximo permitido (15 MB).");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function ghFetch(cfg, endpoint, options = {}) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gc-foto-app",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && data.message) || `GitHub API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getBranchHead(cfg) {
  const ref = await ghFetch(cfg, `/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  const commitSha = ref.object.sha;
  const commit = await ghFetch(cfg, `/git/commits/${commitSha}`);
  return {
    commitSha,
    treeSha: commit.tree.sha,
    message: commit.message || "",
  };
}

async function readGalleryJson(cfg) {
  try {
    const file = await ghFetch(
      cfg,
      `/contents/${GALERIA_JSON_PATH}?ref=${encodeURIComponent(cfg.branch)}`
    );
    const content = Buffer.from(file.content || "", "base64").toString("utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Crea un commit atómico en GitHub con múltiples cambios de archivos
 * (agregar/actualizar blobs y/o borrar archivos) en una sola operación.
 */
async function commitChanges(cfg, { upserts = [], deletes = [], message }) {
  const head = await getBranchHead(cfg);
  const treeItems = [];

  for (const file of upserts) {
    const blob = await ghFetch(cfg, "/git/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: file.content,
        encoding: file.encoding || "utf-8",
      }),
    });
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  for (const path of deletes) {
    treeItems.push({
      path,
      mode: "100644",
      type: "blob",
      sha: null,
    });
  }

  let newTreeSha = head.treeSha;
  if (treeItems.length > 0) {
    const newTree = await ghFetch(cfg, "/git/trees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: head.treeSha,
        tree: treeItems,
      }),
    });
    newTreeSha = newTree.sha;
  }

  const newCommit = await ghFetch(cfg, "/git/commits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      tree: newTreeSha,
      parents: [head.commitSha],
    }),
  });

  await ghFetch(cfg, `/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });

  return newCommit.sha;
}

function attachPreviewUrl(item) {
  if (!item || !item.filename) return item;
  return {
    ...item,
    previewUrl: `/api/photos?file=${encodeURIComponent(item.filename)}`,
  };
}

module.exports = async function handler(req, res) {
  const cfg = getConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    return sendJson(res, 500, {
      error: "Faltan variables de entorno en Vercel: GITHUB_TOKEN, GITHUB_OWNER y GITHUB_REPO.",
    });
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const action = url.searchParams.get("action") || "";
  const fileParam = url.searchParams.get("file") || "";
  const idFromQuery = url.searchParams.get("id") || "";
  const idFromPath = pathname.startsWith("/api/photos/")
    ? decodeURIComponent(pathname.slice("/api/photos/".length).replace(/\/+$/, ""))
    : "";
  const photoId = idFromPath || idFromQuery;

  try {
    // 1. Health & estado de publicación
    if (req.method === "GET" && (pathname === "/api/health" || action === "health")) {
      const head = await getBranchHead(cfg);
      const hasUnpublished = head.message.includes(SKIP_TAG);
      return sendJson(res, 200, {
        ok: true,
        mode: "vercel-github",
        folder: `${cfg.owner}/${cfg.repo}/galeria/`,
        supportsPublish: true,
        hasUnpublished,
      });
    }

    // 2. Proxy de imagen recién subida (funciona en repos públicos y privados antes del redeploy)
    if (req.method === "GET" && fileParam) {
      const safeName = fileParam.replace(/[^a-zA-Z0-9._-]/g, "");
      if (!safeName) return sendJson(res, 400, { error: "Nombre de archivo inválido." });
      const ghUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${FOTOS_PREFIX}${encodeURIComponent(safeName)}?ref=${encodeURIComponent(cfg.branch)}`;
      const imgRes = await fetch(ghUrl, {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "gc-foto-app",
        },
      });
      if (!imgRes.ok) return sendJson(res, 404, { error: "Imagen no encontrada." });
      const ext = safeName.split(".").pop().toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.statusCode = 200;
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.end(buf);
    }

    // 3. Publicar todos los cambios pendientes (1 solo deploy en Vercel)
    if (req.method === "POST" && (pathname === "/api/publish" || action === "publish")) {
      if (cfg.deployHook) {
        const hookRes = await fetch(cfg.deployHook, { method: "POST" });
        if (!hookRes.ok) throw new Error(`Deploy Hook respondió ${hookRes.status}`);
      } else {
        await commitChanges(cfg, {
          message: `galeria: publicar cambios en la web`,
        });
      }
      return sendJson(res, 200, { ok: true, published: true });
    }

    // 4. Listar fotos desde GitHub (siempre fresco, incluso antes del redeploy)
    if (req.method === "GET") {
      const photos = await readGalleryJson(cfg);
      return sendJson(res, 200, photos.map(attachPreviewUrl));
    }

    // 5. Subir nueva foto (commit atómico con [skip ci])
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const imageData = String(body.image || "").trim();
      if (!imageData) return sendJson(res, 400, { error: "Falta la imagen." });

      const { ext, base64, sizeBytes } = decodeDataUrl(imageData);
      const id = String(Date.now());
      const filename = `${sanitizeSlug(title)}_${id}.${ext}`;
      const imagePath = `${FOTOS_PREFIX}${filename}`;

      const item = {
        id,
        title,
        description,
        image: imagePath,
        filename,
        sizeBytes,
        date: new Date().toISOString(),
      };

      const photos = await readGalleryJson(cfg);
      photos.unshift(item);

      await commitChanges(cfg, {
        upserts: [
          { path: imagePath, content: base64, encoding: "base64" },
          { path: GALERIA_JSON_PATH, content: JSON.stringify(photos, null, 2) + "\n", encoding: "utf-8" },
        ],
        message: `galeria: agregar ${filename} ${SKIP_TAG}`,
      });

      return sendJson(res, 201, attachPreviewUrl(item));
    }

    // 6. Editar foto/texto existente (commit atómico con [skip ci])
    if (req.method === "PATCH") {
      if (!photoId) return sendJson(res, 400, { error: "Falta el ID de la foto." });
      const body = await readJsonBody(req);
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const imageData = String(body.image || "").trim();

      const photos = await readGalleryJson(cfg);
      const target = photos.find((p) => String(p.id) === String(photoId));
      if (!target) return sendJson(res, 404, { error: "Foto no encontrada." });

      target.title = title;
      target.description = description;

      const upserts = [];
      const deletes = [];

      if (imageData) {
        const { ext, base64, sizeBytes } = decodeDataUrl(imageData);
        const oldFilename = target.filename;
        const newFilename = `${sanitizeSlug(title)}_${Date.now()}.${ext}`;
        const newPath = `${FOTOS_PREFIX}${newFilename}`;
        upserts.push({ path: newPath, content: base64, encoding: "base64" });
        if (oldFilename && oldFilename !== newFilename) {
          deletes.push(`${FOTOS_PREFIX}${oldFilename}`);
        }
        target.filename = newFilename;
        target.image = newPath;
        target.sizeBytes = sizeBytes;
      }

      upserts.push({
        path: GALERIA_JSON_PATH,
        content: JSON.stringify(photos, null, 2) + "\n",
        encoding: "utf-8",
      });

      await commitChanges(cfg, {
        upserts,
        deletes,
        message: `galeria: editar ${target.filename || photoId} ${SKIP_TAG}`,
      });

      return sendJson(res, 200, attachPreviewUrl(target));
    }

    // 7. Eliminar foto (commit atómico con [skip ci])
    if (req.method === "DELETE") {
      if (!photoId) return sendJson(res, 400, { error: "Falta el ID de la foto." });
      const photos = await readGalleryJson(cfg);
      const idx = photos.findIndex((p) => String(p.id) === String(photoId));
      if (idx === -1) return sendJson(res, 404, { error: "Foto no encontrada." });

      const [removed] = photos.splice(idx, 1);
      const deletes = removed.filename ? [`${FOTOS_PREFIX}${removed.filename}`] : [];

      await commitChanges(cfg, {
        upserts: [
          {
            path: GALERIA_JSON_PATH,
            content: JSON.stringify(photos, null, 2) + "\n",
            encoding: "utf-8",
          },
        ],
        deletes,
        message: `galeria: eliminar ${removed.filename || photoId} ${SKIP_TAG}`,
      });

      return sendJson(res, 200, { ok: true, id: photoId });
    }

    return sendJson(res, 405, { error: "Método no permitido." });
  } catch (err) {
    console.error("GC Foto App API error:", err);
    return sendJson(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 500, {
      error: err.message || "Error interno del servidor.",
    });
  }
}
