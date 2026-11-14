"""
Almacén de jugadores y buzón — SQLite (solo biblioteca estándar).

Es de uso exclusivo del servidor del juego (server.py): el backoffice no abre la
base, habla con el juego por la API de administración (/admin/v1, juego/admin.py).
SQLite en modo WAL admite varios lectores a la vez y serializa las escrituras,
así que muchos jugadores pueden jugar en paralelo mientras el backoffice manda
envíos por la API sin pisarse.

Concurrencia:
  * Cada partida guardada tiene un número de revisión (rev). Un guardado con una
    rev vieja se rechaza (409) y el cliente recibe la versión actual: nunca se
    pierde lo que llegó por el buzón aunque el jugador tenga dos pestañas.
  * Reclamar un envío marca el envío y suma las cartas a la colección en la
    MISMA transacción: un envío no se puede cobrar dos veces.

Para escalar a otro motor (PostgreSQL, etc.) alcanza con reimplementar esta
clase con la misma interfaz.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import string
import time
from contextlib import contextmanager
from pathlib import Path

ID_ALPHABET = string.ascii_uppercase.replace("O", "").replace("I", "") + "23456789"

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created     REAL NOT NULL,
  last_seen   REAL NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1,
  save        TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS mail (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('cards', 'booster')),
  payload     TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  sender      TEXT NOT NULL DEFAULT '',
  created     REAL NOT NULL,
  claimed     REAL,
  result      TEXT
);
CREATE INDEX IF NOT EXISTS mail_by_player ON mail(player_id, claimed);
CREATE TABLE IF NOT EXISTS admin_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  created     REAL NOT NULL,
  last_used   REAL,
  revoked     REAL
);
"""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clean_save(save) -> dict:
    """Normaliza lo que manda el cliente (y descarta basura)."""
    if not isinstance(save, dict):
        save = {}
    col = save.get("collection")
    collection = {}
    if isinstance(col, dict):
        for k, v in col.items():
            if isinstance(k, str) and isinstance(v, int) and 0 < v < 100000:
                collection[k[:64]] = v
    out = {"collection": collection}
    if isinstance(save.get("decks"), dict):
        out["decks"] = save["decks"]
    if isinstance(save.get("defeated"), dict):
        out["defeated"] = {k[:64]: int(v) for k, v in save["defeated"].items() if isinstance(v, int)}
    return out


class Conflict(Exception):
    def __init__(self, player):
        super().__init__("La partida cambió en otro lado.")
        self.player = player


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def db(self, write: bool = False):
        con = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                con.execute("BEGIN IMMEDIATE")  # toma el lock de escritura ya
            yield con
            if write:
                con.execute("COMMIT")
        except BaseException:
            if write:
                con.execute("ROLLBACK")
            raise
        finally:
            con.close()

    # ------------------------------------------------------------ jugadores
    @staticmethod
    def _player(row, full=True) -> dict:
        p = {
            "id": row["id"],
            "name": row["name"],
            "created": row["created"],
            "lastSeen": row["last_seen"],
            "rev": row["rev"],
        }
        if full:
            p["save"] = json.loads(row["save"] or "{}")
        return p

    def create_player(self, save=None, name: str | None = None) -> tuple[dict, str]:
        token = secrets.token_urlsafe(24)
        now = time.time()
        with self.db(write=True) as c:
            n = c.execute("SELECT COUNT(*) FROM players").fetchone()[0]
            while True:
                pid = "J-" + "".join(secrets.choice(ID_ALPHABET) for _ in range(6))
                if not c.execute("SELECT 1 FROM players WHERE id=?", (pid,)).fetchone():
                    break
            c.execute(
                "INSERT INTO players (id, token_hash, name, created, last_seen, save) VALUES (?,?,?,?,?,?)",
                (pid, _hash(token), (name or f"Jugador {n + 1}")[:24], now, now, json.dumps(clean_save(save))),
            )
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
        return self._player(row), token

    def player_by_token(self, token: str, touch: bool = True) -> dict | None:
        if not token:
            return None
        with self.db(write=touch) as c:
            row = c.execute("SELECT * FROM players WHERE token_hash=?", (_hash(token),)).fetchone()
            if row and touch:
                c.execute("UPDATE players SET last_seen=? WHERE id=?", (time.time(), row["id"]))
        return self._player(row) if row else None

    def get_player(self, pid: str) -> dict | None:
        with self.db() as c:
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
        return self._player(row) if row else None

    def list_players(self) -> list[dict]:
        with self.db() as c:
            rows = c.execute(
                """SELECT p.*, (SELECT COUNT(*) FROM mail m WHERE m.player_id=p.id AND m.claimed IS NULL) AS pending
                   FROM players p ORDER BY p.last_seen DESC"""
            ).fetchall()
        out = []
        for r in rows:
            p = self._player(r)
            col = p["save"].get("collection", {})
            p["cards"] = sum(col.values())
            p["distinct"] = len(col)
            p["pending"] = r["pending"]
            del p["save"]
            out.append(p)
        return out

    def rename_player(self, pid: str, name: str) -> dict | None:
        name = (name or "").strip()[:24]
        if not name:
            raise ValueError("El nombre no puede estar vacío.")
        with self.db(write=True) as c:
            if c.execute("UPDATE players SET name=? WHERE id=?", (name, pid)).rowcount == 0:
                return None
        return self.get_player(pid)

    def delete_player(self, pid: str) -> bool:
        with self.db(write=True) as c:
            return c.execute("DELETE FROM players WHERE id=?", (pid,)).rowcount > 0

    def save_game(self, pid: str, rev: int, save) -> dict:
        """Guarda si rev coincide con la actual; si no, lanza Conflict con la versión vigente."""
        with self.db(write=True) as c:
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
            if not row:
                raise KeyError(pid)
            if row["rev"] != rev:
                raise Conflict(self._player(row))
            c.execute(
                "UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?",
                (json.dumps(clean_save(save)), time.time(), pid),
            )
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
        return self._player(row)

    # ------------------------------------------------------------ buzón
    @staticmethod
    def _mail(row) -> dict:
        return {
            "id": row["id"],
            "player": row["player_id"],
            "kind": row["kind"],
            "payload": json.loads(row["payload"]),
            "message": row["message"],
            "sender": row["sender"],
            "created": row["created"],
            "claimed": row["claimed"],
            "result": json.loads(row["result"]) if row["result"] else None,
        }

    def send_mail(self, player_ids: list[str] | None, kind: str, payload: dict, message: str = "", sender: str = "") -> int:
        """Manda un envío a cada jugador indicado (None = a todos). Devuelve cuántos se crearon."""
        if kind not in ("cards", "booster"):
            raise ValueError("Tipo de envío desconocido.")
        now = time.time()
        with self.db(write=True) as c:
            if player_ids is None:
                player_ids = [r[0] for r in c.execute("SELECT id FROM players")]
            n = 0
            for pid in player_ids:
                if not c.execute("SELECT 1 FROM players WHERE id=?", (pid,)).fetchone():
                    continue
                c.execute(
                    "INSERT INTO mail (player_id, kind, payload, message, sender, created) VALUES (?,?,?,?,?,?)",
                    (pid, kind, json.dumps(payload), message[:200], sender[:40], now),
                )
                n += 1
        return n

    def mail_for(self, pid: str, include_claimed: bool = False, limit: int = 200) -> list[dict]:
        q = "SELECT * FROM mail WHERE player_id=?" + ("" if include_claimed else " AND claimed IS NULL")
        with self.db() as c:
            rows = c.execute(q + " ORDER BY id DESC LIMIT ?", (pid, limit)).fetchall()
        return [self._mail(r) for r in rows]

    def mail_exists(self, mid: int) -> bool:
        with self.db() as c:
            return c.execute("SELECT 1 FROM mail WHERE id=?", (mid,)).fetchone() is not None

    def cancel_mail(self, mid: int) -> bool:
        with self.db(write=True) as c:
            return c.execute("DELETE FROM mail WHERE id=? AND claimed IS NULL", (mid,)).rowcount > 0

    def claim_mail(self, pid: str, mid: int, cards: list[str]) -> tuple[dict, dict]:
        """Marca el envío como recibido y suma `cards` a la colección, todo junto.

        Devuelve (envío, jugador). Lanza KeyError si no existe o ya se reclamó.
        """
        with self.db(write=True) as c:
            m = c.execute("SELECT * FROM mail WHERE id=? AND player_id=? AND claimed IS NULL", (mid, pid)).fetchone()
            if not m:
                raise KeyError(mid)
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
            save = json.loads(row["save"] or "{}")
            col = save.setdefault("collection", {})
            for cid in cards:
                col[cid] = col.get(cid, 0) + 1
            now = time.time()
            c.execute("UPDATE mail SET claimed=?, result=? WHERE id=?", (now, json.dumps(cards), mid))
            c.execute("UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?", (json.dumps(save), now, pid))
            m = c.execute("SELECT * FROM mail WHERE id=?", (mid,)).fetchone()
            row = c.execute("SELECT * FROM players WHERE id=?", (pid,)).fetchone()
        return self._mail(m), self._player(row)

    # ------------------------------------------------------------ tokens de admin
    def create_admin_token(self, label: str = "") -> tuple[int, str]:
        """Crea un token de admin. Devuelve (id, token); el token en claro no se guarda."""
        token = secrets.token_urlsafe(32)
        with self.db(write=True) as c:
            cur = c.execute(
                "INSERT INTO admin_tokens (token_hash, label, created) VALUES (?,?,?)",
                (_hash(token), (label or "")[:40], time.time()),
            )
            tid = cur.lastrowid
        return tid, token

    def check_admin_token(self, token: str) -> bool:
        """True si el token existe y no fue revocado (y anota el último uso)."""
        if not token:
            return False
        h = _hash(token)
        with self.db(write=True) as c:
            row = c.execute("SELECT id, token_hash FROM admin_tokens WHERE token_hash=? AND revoked IS NULL", (h,)).fetchone()
            if not row or not hmac.compare_digest(row["token_hash"], h):
                return False
            c.execute("UPDATE admin_tokens SET last_used=? WHERE id=?", (time.time(), row["id"]))
        return True

    def list_admin_tokens(self) -> list[dict]:
        with self.db() as c:
            rows = c.execute("SELECT id, label, created, last_used, revoked FROM admin_tokens ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def revoke_admin_token(self, tid: int) -> bool:
        with self.db(write=True) as c:
            return c.execute("UPDATE admin_tokens SET revoked=? WHERE id=? AND revoked IS NULL", (time.time(), tid)).rowcount > 0
