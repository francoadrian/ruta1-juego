"""
API de administración del juego (/admin/v1) y CLI de tokens.

Corre en un listener aparte (por defecto 127.0.0.1:8125) dentro del proceso del
servidor del juego, para que el túnel/hosting público no la exponga. Contrato:
ADR 0001 (repo privado del backoffice).

  * Autenticación: `Authorization: Bearer <token>` (se guarda solo el sha256).
  * Sin CORS y rechaza cualquier pedido con cabecera `Origin`.
  * Errores: {"error": "<texto>"} con status 400/401/404/409/413.

CLI:
    python server.py admin-token new [etiqueta] [--write]   crea un token (se muestra una vez)
    python server.py admin-token list
    python server.py admin-token revoke <id>
`--write` guarda el token en el archivo de TCG_ADMIN_TOKEN_FILE (por defecto
%USERPROFILE%\\.tcglocal\\admin-token), fuera del repo.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from .content import MAX_UPLOAD, AssetQuota, Content, ContentConflict, ContentCorrupt
from .store import Store

API = 1
MAX_JSON = 8 * 1024 * 1024
MAX_ASSET_BODY = MAX_UPLOAD * 4 // 3 + 64 * 1024  # base64 de 15 MB + sobre del JSON
PLAYER_ID = r"[\w-]{1,32}"


class HttpError(Exception):
    def __init__(self, status, msg, extra=None):
        super().__init__(msg)
        self.status, self.msg, self.extra = status, msg, extra or {}


def make_handler(store: Store, content: Content):
    class AdminHandler(BaseHTTPRequestHandler):
        server_version = "RutaAdmin/1"

        def log_message(self, fmt, *args):
            sys.stderr.write("[admin] " + (fmt % args) + "\n")

        # ------------------------------------------------------------ helpers
        def send_json(self, obj, status=HTTPStatus.OK):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def read_json(self, limit=MAX_JSON):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise HttpError(400, "Content-Length inválido.")
            if n > limit:
                raise HttpError(413, "Pedido demasiado grande.")
            if n <= 0:
                raise HttpError(400, "Cuerpo vacío.")
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HttpError(400, "JSON inválido.")
            if not isinstance(body, dict):
                raise HttpError(400, "El cuerpo debe ser un objeto JSON.")
            return body

        def authorize(self):
            port = self.server.server_address[1]
            host = (self.headers.get("Host") or "").lower()
            if host not in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"):
                raise HttpError(403, "Host no permitido.")
            if self.headers.get("Origin") is not None:
                raise HttpError(403, "Origen no permitido.")
            h = self.headers.get("Authorization", "")
            if not h.startswith("Bearer ") or not store.check_admin_token(h[7:].strip()):
                raise HttpError(401, "No autorizado.")

        def dispatch(self, method):
            path = self.path.split("?", 1)[0]
            try:
                self.authorize()
                self.route(method, path)
            except HttpError as e:
                self.send_json({"error": e.msg, **e.extra}, e.status)
            except ContentCorrupt as e:
                self.send_json({"error": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            except Exception as e:  # no filtrar detalles internos
                sys.stderr.write(f"[admin] error interno: {e!r}\n")
                self.send_json({"error": "Error interno."}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def do_GET(self):
            self.dispatch("GET")

        def do_PUT(self):
            self.dispatch("PUT")

        def do_POST(self):
            self.dispatch("POST")

        def do_PATCH(self):
            self.dispatch("PATCH")

        def do_DELETE(self):
            self.dispatch("DELETE")

        # ------------------------------------------------------------ rutas
        def route(self, method, path):
            if path == "/admin/v1/health" and method == "GET":
                return self.send_json({"ok": True, "api": API})
            for name, doc in (("catalog", content.catalog), ("world", content.world)):
                if path == f"/admin/v1/{name}":
                    if method == "GET":
                        rev, obj = doc.get()
                        if rev is None:
                            return self.send_json({"exists": False, "rev": None})
                        return self.send_json({"exists": True, "rev": rev, name: obj})
                    if method == "PUT":
                        return self.put_doc(name, doc)
                    break
            else:
                if path == "/admin/v1/players" and method == "GET":
                    return self.send_json({"players": store.list_players()})
                m = re.match(rf"^/admin/v1/players/({PLAYER_ID})$", path)
                if m:
                    return self.player(method, m.group(1))
                if path == "/admin/v1/mail" and method == "POST":
                    return self.post_mail()
                m = re.match(r"^/admin/v1/mail/(\d{1,12})$", path)
                if m and method == "DELETE":
                    mid = int(m.group(1))
                    if not store.mail_exists(mid):
                        raise HttpError(404, "No existe ese envío.")
                    if not store.cancel_mail(mid):
                        raise HttpError(409, "Ese envío ya se abrió.")
                    return self.send_json({"ok": True})
                if path == "/admin/v1/assets" and method == "POST":
                    return self.post_asset()
                raise HttpError(404, "Ruta desconocida.")
            raise HttpError(405, "Método no permitido.")

        def put_doc(self, name, doc):
            body = self.read_json()
            rev = body.get("rev")
            if rev is not None and not isinstance(rev, str):
                raise HttpError(400, "rev inválido.")
            if name not in body:
                raise HttpError(400, f"Falta '{name}' en el cuerpo.")
            try:
                new_rev = doc.put(rev, body[name])
            except ContentConflict as c:
                raise HttpError(409, "conflict", {"rev": c.rev})
            except ValueError as e:
                raise HttpError(400, str(e))
            self.send_json({"ok": True, "rev": new_rev})

        def player(self, method, pid):
            if method == "GET":
                p = store.get_player(pid)
                if not p:
                    raise HttpError(404, "No existe ese jugador.")
                p["mail"] = store.mail_for(pid, include_claimed=True)
                return self.send_json(p)
            if method == "PATCH":
                body = self.read_json(64 * 1024)
                try:
                    p = store.rename_player(pid, str(body.get("name", "")))
                except ValueError as e:
                    raise HttpError(400, str(e))
                if not p:
                    raise HttpError(404, "No existe ese jugador.")
                p.pop("save", None)
                return self.send_json(p)
            if method == "DELETE":
                if not store.delete_player(pid):
                    raise HttpError(404, "No existe ese jugador.")
                return self.send_json({"ok": True})
            raise HttpError(405, "Método no permitido.")

        def post_mail(self):
            """{to: "all"|[ids], kind: "cards"|"booster", cards?, booster?, count?, message?, sender?}"""
            req = self.read_json(1024 * 1024)
            to = req.get("to")
            if to == "all":
                players = None
            elif isinstance(to, list) and all(isinstance(x, str) for x in to):
                players = to[:1000]
                if not players:
                    raise HttpError(400, "Elegí a quién mandarlo.")
            else:
                raise HttpError(400, "Elegí a quién mandarlo.")
            msg = str(req.get("message", ""))
            sender = str(req.get("sender", "")) or "Backoffice"
            kind = req.get("kind")
            if kind == "cards":
                cards = req.get("cards")
                if not isinstance(cards, list) or not cards or len(cards) > 200 or any(not isinstance(c, str) for c in cards):
                    raise HttpError(400, "Elegí entre 1 y 200 cartas.")
                known = content.card_ids()
                if known is None:
                    raise HttpError(400, "No hay catálogo publicado.")
                bad = sorted({c for c in cards if c not in known})
                if bad:
                    raise HttpError(400, f"Cartas que no están en el catálogo: {', '.join(b[:40] for b in bad[:5])}.")
                sent = store.send_mail(players, "cards", {"cards": cards}, msg, sender)
            elif kind == "booster":
                bid = req.get("booster")
                if not isinstance(bid, str) or not bid:
                    raise HttpError(400, "Elegí un sobre.")
                known = content.booster_ids()
                if known is None:
                    raise HttpError(400, "No hay catálogo publicado.")
                if bid not in known:
                    raise HttpError(400, "Ese sobre no está en el catálogo.")
                try:
                    count = max(1, min(50, int(req.get("count") or 1)))
                except (TypeError, ValueError):
                    raise HttpError(400, "count inválido.")
                sent = 0
                for _ in range(count):  # un envío por sobre: cada uno se abre por separado
                    sent += store.send_mail(players, "booster", {"booster": bid}, msg, sender)
            else:
                raise HttpError(400, "Tipo de envío desconocido.")
            self.send_json({"sent": sent})

        def post_asset(self):
            req = self.read_json(MAX_ASSET_BODY)
            try:
                path = content.save_asset(req.get("kind"), req.get("name"), req.get("dataUrl"))
            except AssetQuota as e:
                raise HttpError(413, str(e))
            except ValueError as e:
                raise HttpError(400, str(e))
            self.send_json({"path": path}, HTTPStatus.CREATED)

    return AdminHandler


# ---------------------------------------------------------------------- CLI
def default_token_file() -> Path:
    env = os.environ.get("TCG_ADMIN_TOKEN_FILE")
    return Path(env) if env else Path.home() / ".tcglocal" / "admin-token"


def cli(args: list[str], store: Store) -> int:
    cmd = args[0] if args else ""
    if cmd == "new":
        rest = [a for a in args[1:] if a != "--write"]
        tid, token = store.create_admin_token(rest[0] if rest else "")
        if "--write" in args:
            f = default_token_file()
            f.parent.mkdir(parents=True, exist_ok=True)
            # Se crea con 0600 desde el inicio: no hay ventana en la que otro usuario pueda leerlo.
            fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(token + "\n")
            try:
                os.chmod(f, 0o600)
            except OSError:
                pass
            if os.name == "nt":
                try:
                    user = os.environ.get("USERNAME") or ""
                    r = subprocess.run(["icacls", str(f), "/inheritance:r", "/grant:r", f"{user}:F"],
                                       capture_output=True, timeout=15)
                    if not user or r.returncode != 0:
                        raise OSError("icacls falló")
                except (OSError, subprocess.SubprocessError):
                    print(f"AVISO: no pude restringir los permisos de {f}; revisalos a mano.", file=sys.stderr)
            print(f"Token de admin #{tid} guardado en {f} (no se muestra por pantalla).")
        else:
            print(f"Token de admin #{tid} (se muestra una sola vez; el juego guarda solo el hash):\n{token}")
        return 0
    if cmd == "list":
        for t in store.list_admin_tokens():
            fmt = lambda x: time.strftime("%Y-%m-%d %H:%M", time.localtime(x)) if x else "-"
            print(f"#{t['id']}  {t['label'] or '(sin etiqueta)'}  creado {fmt(t['created'])}  "
                  f"último uso {fmt(t['last_used'])}  {'REVOCADO ' + fmt(t['revoked']) if t['revoked'] else 'activo'}")
        return 0
    if cmd == "revoke" and len(args) == 2 and args[1].isdigit():
        ok = store.revoke_admin_token(int(args[1]))
        print("Revocado." if ok else "No existe o ya estaba revocado.")
        return 0 if ok else 1
    print("Uso: python server.py admin-token new [etiqueta] [--write] | list | revoke <id>", file=sys.stderr)
    return 2
