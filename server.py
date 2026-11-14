"""
Ruta 1 — servidor del juego (solo Python, sin dependencias).

    python server.py            → http://localhost:8123/  (y desde la red local)

Sirve el juego y la API de jugadores:
    POST /api/players                  crea un jugador (devuelve id + token secreto)
    GET  /api/me                       datos y partida guardada   (X-Player-Token)
    PUT  /api/me/save                  guarda la partida {rev, save} → 409 si cambió
    GET  /api/me/mail                  envíos sin abrir del buzón
    POST /api/me/mail/<id>/claim       abre un envío {cards?} y suma las cartas

El juego es el único dueño de los datos (data/game.db, catalog.json, world.json,
assets/). El backoffice (backoffice/server.py, puerto 8124) los administra por la
API de admin /admin/v1 (juego/admin.py), que escucha en un listener aparte:
    ADMIN_HOST:ADMIN_PORT   por defecto 127.0.0.1:8125  (Bearer token)
Tokens de admin:  python server.py admin-token new [etiqueta] [--write] | list | revoke <id>

Configuración (variables de entorno):
    GAME_HOST / GAME_PORT   listener público (0.0.0.0:8123); el puerto también va como 1er argumento
    ADMIN_HOST / ADMIN_PORT listener de admin (127.0.0.1:8125)
    GAME_DB                 base SQLite (por defecto data/game.db)
    GAME_DATA_DIR           carpeta de catalog.json / world.json (por defecto data/)
    GAME_ASSETS_DIR         carpeta de imágenes subidas (por defecto assets/)
    TCG_ADMIN_TOKEN_FILE    archivo donde `admin-token new --write` deja el token
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from juego.admin import cli as admin_cli, make_handler as make_admin_handler  # noqa: E402
from juego.content import Content  # noqa: E402
from juego.store import Conflict, Store  # noqa: E402

DATA = Path(os.environ.get("GAME_DATA_DIR") or ROOT / "data")
ASSETS = Path(os.environ.get("GAME_ASSETS_DIR") or ROOT / "assets")
HOST = os.environ.get("GAME_HOST", "0.0.0.0")  # 0.0.0.0: se puede jugar desde el celular en la misma red
_arg_port = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
PORT = int(_arg_port or os.environ.get("GAME_PORT") or os.environ.get("PORT") or "8123")
ADMIN_HOST = os.environ.get("ADMIN_HOST", "127.0.0.1")
ADMIN_PORT = int(os.environ.get("ADMIN_PORT") or "8125")
STORE = Store(Path(os.environ.get("GAME_DB") or DATA / "game.db"))
CONTENT = Content(DATA, ASSETS)

# Solo se publica lo que el juego necesita (nunca la base de datos).
PUBLIC = re.compile(
    r"^/(index\.html|src/[\w.-]+\.ts|assets/[\w.-]+(/[\w.-]+)*\.(png|jpe?g|webp|gif)|data/(catalog|world)\.json)$",
    re.I,
)


def safe_public_path(raw: str):
    """Ruta pública ya decodificada y validada, o None. Rechaza ':', '\\\\', NUL, '..' y '//'
    (en Windows pathlib descarta la base si el segundo operando es absoluto)."""
    from urllib.parse import unquote
    try:
        p = unquote(raw.split("?", 1)[0].split("#", 1)[0], errors="strict")
    except UnicodeDecodeError:
        return None
    if p == "/":
        p = "/index.html"
    if any(c in p for c in (":", "\\", "\0")) or ".." in p or "//" in p or not p.startswith("/"):
        return None
    return p if PUBLIC.match(p) else None


def booster_def(bid: str):
    return CONTENT.booster_def(bid)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path):
        return self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        if self.path.split("?", 1)[0].startswith("/api/") or safe_public_path(self.path) is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        return super().do_HEAD()

    def log_message(self, fmt, *args):
        if "/api/" in (str(args[0]) if args else ""):
            return  # la API se consulta seguido: no ensuciar la consola
        sys.stderr.write("[juego] " + (fmt % args) + "\n")

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        if n > 2_000_000:
            raise ValueError("Pedido demasiado grande.")
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def me(self):
        return STORE.player_by_token(self.headers.get("X-Player-Token", ""))

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/me":
            p = self.me()
            if not p:
                return self.send_json({"error": "Jugador desconocido."}, HTTPStatus.UNAUTHORIZED)
            p["mail"] = STORE.mail_for(p["id"])
            return self.send_json(p)
        if path == "/api/me/mail":
            p = self.me()
            if not p:
                return self.send_json({"error": "Jugador desconocido."}, HTTPStatus.UNAUTHORIZED)
            return self.send_json({"mail": STORE.mail_for(p["id"]), "name": p["name"]})
        path = safe_public_path(self.path)
        if path is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        self.path = path
        m = re.match(r"^/data/(catalog|world)\.json$", path)
        if m:  # salen de la caché del contenido (el juego es su dueño)
            raw = getattr(CONTENT, m.group(1)).raw()
            if raw is None:
                return self.send_error(HTTPStatus.NOT_FOUND)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        return super().do_GET()

    def translate_path(self, path):
        # /assets/* sale de GAME_ASSETS_DIR (puede estar fuera de la raíz del repo)
        p = safe_public_path(path)
        if p is None:
            return str(ROOT / "no-existe-404.invalid")  # nunca se sirve; send_head responde 404
        if p.startswith("/assets/"):
            base = ASSETS.resolve()
            f = (base / p[len("/assets/"):]).resolve()
            if f != base and base not in f.parents:
                return str(ROOT / "no-existe-404.invalid")
            return str(f)
        return super().translate_path(p)

    # ------------------------------------------------------------------ POST / PUT
    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)

        if path == "/api/players":
            player, token = STORE.create_player(body.get("save"))
            player["token"] = token
            player["mail"] = []
            return self.send_json(player, HTTPStatus.CREATED)

        m = re.match(r"^/api/me/mail/(\d+)/claim$", path)
        if m:
            p = self.me()
            if not p:
                return self.send_json({"error": "Jugador desconocido."}, HTTPStatus.UNAUTHORIZED)
            mid = int(m.group(1))
            item = next((x for x in STORE.mail_for(p["id"]) if x["id"] == mid), None)
            if not item:
                return self.send_json({"error": "Ese envío ya se abrió o no existe."}, HTTPStatus.CONFLICT)
            if item["kind"] == "cards":
                cards = [c for c in item["payload"].get("cards", []) if isinstance(c, str)]
            else:
                # el sobre lo arma el juego; acá se controla que las cartas sean de ese sobre
                b = booster_def(item["payload"].get("booster", ""))
                cards = body.get("cards")
                if not b or not isinstance(cards, list):
                    return self.send_json({"error": "Sobre desconocido."}, HTTPStatus.BAD_REQUEST)
                size = sum(int(s.get("count") or 0) for s in b.get("slots", [])) or 11
                pool = set(b.get("cards", []))
                if len(cards) > size or any(c not in pool for c in cards):
                    return self.send_json({"error": "Las cartas no corresponden a ese sobre."}, HTTPStatus.BAD_REQUEST)
            try:
                mail, player = STORE.claim_mail(p["id"], mid, cards)
            except KeyError:
                return self.send_json({"error": "Ese envío ya se abrió."}, HTTPStatus.CONFLICT)
            return self.send_json({"mail": mail, "player": player})
        return self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        if self.path.split("?", 1)[0] != "/api/me/save":
            return self.send_error(HTTPStatus.NOT_FOUND)
        p = self.me()
        if not p:
            return self.send_json({"error": "Jugador desconocido."}, HTTPStatus.UNAUTHORIZED)
        try:
            body = self.read_json()
            player = STORE.save_game(p["id"], int(body.get("rev", -1)), body.get("save"))
        except Conflict as c:
            return self.send_json({"error": "conflict", "player": c.player}, HTTPStatus.CONFLICT)
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        return self.send_json({"rev": player["rev"]})


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "admin-token":
        sys.exit(admin_cli(sys.argv[2:], STORE))
    if ADMIN_HOST not in ("127.0.0.1", "localhost", "::1"):
        if os.environ.get("ADMIN_ALLOW_NONLOOPBACK") != "1":
            sys.exit(f"Me niego a escuchar la API de admin en {ADMIN_HOST!r} (no es loopback). "
                     "Si de verdad lo querés, definí ADMIN_ALLOW_NONLOOPBACK=1.")
        print(f"ADVERTENCIA: la API de admin escucha en {ADMIN_HOST}, no en loopback. El token es obligatorio, "
              "pero no la expongas a Internet.", file=sys.stderr)
    admin = ThreadingHTTPServer((ADMIN_HOST, ADMIN_PORT), make_admin_handler(STORE, CONTENT))
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    print(f"API de admin en http://{ADMIN_HOST}:{ADMIN_PORT}/admin/v1  (Bearer token)")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Juego en http://localhost:{PORT}/  (Ctrl+C para cerrar)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
