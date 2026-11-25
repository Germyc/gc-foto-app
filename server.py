#!/usr/bin/env python3
"""
Servidor local zero-dependencies para gc-foto-app.
Sirve la app móvil y guarda las fotos + metadata directamente en ./galeria/.
"""

import base64
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
GALERIA_DIR = BASE_DIR / "galeria"
FOTOS_DIR = GALERIA_DIR / "fotos"
JSON_PATH = GALERIA_DIR / "galeria.json"
MAX_BODY_BYTES = 15 * 1024 * 1024  # 15 MB


def ensure_storage():
    FOTOS_DIR.mkdir(parents=True, exist_ok=True)
    if not JSON_PATH.exists():
        JSON_PATH.write_text("[]\n", encoding="utf-8")


def read_photos():
    ensure_storage()
    try:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def write_photos(photos):
    ensure_storage()
    tmp_path = JSON_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(
        json.dumps(photos, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(JSON_PATH)


def sanitize_slug(text):
    normalized = unicodedata.normalize("NFKD", text or "")
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return (slug[:45] or "foto")


def decode_data_url(data_url):
    match = re.match(r"^data:image/(jpeg|jpg|png|webp);base64,(.+)$", data_url, re.DOTALL)
    if not match:
        raise ValueError("Formato de imagen no válido (se espera JPEG, PNG o WebP en base64).")
    ext = match.group(1).lower()
    if ext == "jpeg":
        ext = "jpg"
    raw = base64.b64decode(match.group(2))
    if not raw:
        raise ValueError("La imagen recibida está vacía.")
    return ext, raw


class FotoAppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self):
        path = urlparse(self.path).path
        if path.startswith("/api/") or path == "/galeria/galeria.json":
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise ValueError("Cuerpo de petición vacío.")
        if length > MAX_BODY_BYTES:
            raise ValueError("La imagen supera el tamaño máximo permitido (15 MB).")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json(200, {
                "ok": True,
                "mode": "local",
                "folder": "galeria/",
            })
            return
        if path == "/api/photos":
            self.send_json(200, read_photos())
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/photos":
            self.send_json(404, {"error": "Ruta no encontrada"})
            return

        try:
            body = self.read_json_body()
            title = str(body.get("title", "")).strip()
            description = str(body.get("description", "")).strip()
            image_data = str(body.get("image", "")).strip()

            if not image_data:
                self.send_json(400, {"error": "Falta la imagen."})
                return

            ext, raw_bytes = decode_data_url(image_data)
            photo_id = str(int(time.time() * 1000))
            filename = f"{sanitize_slug(title)}_{photo_id}.{ext}"

            ensure_storage()
            file_path = FOTOS_DIR / filename
            file_path.write_bytes(raw_bytes)

            item = {
                "id": photo_id,
                "title": title,
                "description": description,
                "image": f"galeria/fotos/{filename}",
                "filename": filename,
                "sizeBytes": len(raw_bytes),
                "date": datetime.now(timezone.utc).isoformat(),
            }

            photos = read_photos()
            photos.insert(0, item)
            write_photos(photos)

            self.send_json(201, item)
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except Exception as err:
            self.send_json(500, {"error": f"Error al guardar la foto: {err}"})

    def do_PATCH(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/photos/"):
            self.send_json(404, {"error": "Ruta no encontrada"})
            return

        photo_id = path.split("/api/photos/", 1)[1].strip("/")
        try:
            body = self.read_json_body()
            title = str(body.get("title", "")).strip()
            description = str(body.get("description", "")).strip()
            image_data = str(body.get("image", "")).strip()

            photos = read_photos()
            updated = None
            for item in photos:
                if str(item.get("id")) == photo_id:
                    item["title"] = title
                    item["description"] = description
                    if image_data:
                        ext, raw_bytes = decode_data_url(image_data)
                        old_filename = item.get("filename")
                        new_filename = f"{sanitize_slug(title)}_{int(time.time() * 1000)}.{ext}"
                        ensure_storage()
                        (FOTOS_DIR / new_filename).write_bytes(raw_bytes)
                        if old_filename and old_filename != new_filename:
                            old_path = FOTOS_DIR / Path(old_filename).name
                            if old_path.exists():
                                try:
                                    old_path.unlink()
                                except Exception:
                                    pass
                        item["filename"] = new_filename
                        item["image"] = f"galeria/fotos/{new_filename}"
                        item["sizeBytes"] = len(raw_bytes)
                    updated = item
                    break

            if not updated:
                self.send_json(404, {"error": "Foto no encontrada."})
                return

            write_photos(photos)
            self.send_json(200, updated)
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except Exception as err:
            self.send_json(500, {"error": f"Error al actualizar: {err}"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/photos/"):
            self.send_json(404, {"error": "Ruta no encontrada"})
            return

        photo_id = path.split("/api/photos/", 1)[1].strip("/")
        photos = read_photos()
        target = None
        remaining = []
        for item in photos:
            if str(item.get("id")) == photo_id and target is None:
                target = item
            else:
                remaining.append(item)

        if not target:
            self.send_json(404, {"error": "Foto no encontrada."})
            return

        filename = target.get("filename")
        if filename:
            file_path = (FOTOS_DIR / Path(filename).name)
            if file_path.exists():
                try:
                    file_path.unlink()
                except Exception:
                    pass

        write_photos(remaining)
        self.send_json(200, {"ok": True, "id": photo_id})


def main():
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else "8080"))
    ensure_storage()
    server = ThreadingHTTPServer(("0.0.0.0", port), FotoAppHandler)
    print(f"GC Foto App escuchando en http://0.0.0.0:{port}/ (guardando en {GALERIA_DIR})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
