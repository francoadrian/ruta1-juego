"""
Contenido del juego: catálogo (cartas, sobres) y mundo (mapas, NPCs) + assets.

El servidor del juego es el único dueño de estos archivos. Acá viven la lectura,
la validación, el `rev` (16 hex del sha256 del archivo guardado), el backup
(`*.backup.json`) y la escritura atómica (tmp + replace).

Hay una caché en memoria por archivo, invalidada por (mtime, tamaño): el juego
no relee ni reparsea el JSON en cada pedido.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import threading
from pathlib import Path

UPLOAD_DIRS = {"card": "cards", "back": "backs", "pack": "packs"}
MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_UPLOAD = 15 * 1024 * 1024
# Tope de espacio total de assets (configurable por GAME_MAX_ASSETS_MB); al superarlo, 413.
MAX_ASSETS_TOTAL = int(os.environ.get("GAME_MAX_ASSETS_MB") or "500") * 1024 * 1024


class AssetQuota(Exception):
    pass


def sniff_image(raw: bytes) -> str | None:
    """MIME real según los magic bytes (png/jpeg/webp/gif), o None."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


class ContentConflict(Exception):
    def __init__(self, rev):
        super().__init__("conflict")
        self.rev = rev


class ContentCorrupt(Exception):
    pass


def slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", s).strip("-")
    return s[:48] or "img"


def rev_of(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def validate_catalog(catalog) -> None:
    if not isinstance(catalog, dict) or not isinstance(catalog.get("cards"), list):
        raise ValueError("El catálogo debe tener una lista 'cards'.")
    if any(not isinstance(c, dict) for c in catalog["cards"]):
        raise ValueError("Cada carta debe ser un objeto.")
    ids = [c.get("id") for c in catalog["cards"]]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Cada carta necesita un id único.")
    boosters = catalog.get("boosters", [])
    if not isinstance(boosters, list) or any(not isinstance(b, dict) for b in boosters):
        raise ValueError("Los sobres deben ser una lista de objetos.")


def validate_world(world) -> None:
    if not isinstance(world, dict) or not isinstance(world.get("maps"), list) or not world["maps"]:
        raise ValueError("El mundo necesita al menos un mapa.")
    if any(not isinstance(m, dict) for m in world["maps"]):
        raise ValueError("Cada mapa debe ser un objeto.")
    ids = [m.get("id") for m in world["maps"]]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Cada mapa necesita un id único.")
    for mp in world["maps"]:
        rows = mp.get("tiles")
        if not isinstance(rows, list) or not rows or any(not isinstance(r, str) or len(r) != len(rows[0]) for r in rows):
            raise ValueError(f"Las filas del mapa {mp.get('id')} deben tener todas el mismo largo.")
    npcs = world.get("npcs", [])
    if not isinstance(npcs, list) or any(not isinstance(n, dict) for n in npcs):
        raise ValueError("Los NPCs deben ser una lista de objetos.")
    npc_ids = [n.get("id") for n in npcs]
    if any(not isinstance(i, str) or not i for i in npc_ids) or len(set(npc_ids)) != len(npc_ids):
        raise ValueError("Cada NPC necesita un id único.")


class _Doc:
    """Un JSON del juego (catálogo o mundo) con caché, rev y escritura atómica."""

    def __init__(self, path: Path, backup: Path, validate, label: str):
        self.path, self.backup, self.validate, self.label = path, backup, validate, label
        self.lock = threading.Lock()
        self._sig = None
        self._raw: bytes | None = None
        self._obj = None

    def _load(self):
        """Devuelve (raw, obj) o (None, None) si no existe. Caché por mtime+tamaño."""
        try:
            st = self.path.stat()
        except OSError:
            self._sig = self._raw = self._obj = None
            return None, None
        sig = (st.st_mtime_ns, st.st_size)
        if sig != self._sig:
            raw = self.path.read_bytes()
            try:
                obj = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise ContentCorrupt(f"{self.path.name} está dañado: {e}")
            self._sig, self._raw, self._obj = sig, raw, obj
        return self._raw, self._obj

    def raw(self) -> bytes | None:
        with self.lock:
            try:
                return self._load()[0]
            except ContentCorrupt:
                return None

    def get(self):
        """(rev, obj) o (None, None) si no existe."""
        with self.lock:
            raw, obj = self._load()
            return (rev_of(raw), obj) if raw is not None else (None, None)

    def object_or_none(self):
        try:
            return self.get()[1]
        except ContentCorrupt:
            return None

    def put(self, rev, obj) -> str:
        """Valida y guarda si `rev` coincide con el actual (None si no existe). Devuelve el rev nuevo."""
        self.validate(obj)
        with self.lock:
            corrupt = False
            try:
                raw, _ = self._load()
            except ContentCorrupt:
                raw, corrupt = self.path.read_bytes(), True  # dañado: se permite pisarlo (queda en el backup)
            current = rev_of(raw) if raw is not None else None
            if rev != current and not corrupt:
                raise ContentConflict(current)
            data = json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if raw is not None:
                self.backup.write_bytes(raw)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, self.path)
            self._sig = None  # fuerza el recargo con el stat real
            return rev_of(data)


class Content:
    def __init__(self, data_dir: Path, assets_dir: Path):
        self.data_dir, self.assets_dir = Path(data_dir), Path(assets_dir)
        self.catalog = _Doc(self.data_dir / "catalog.json", self.data_dir / "catalog.backup.json", validate_catalog, "catálogo")
        self.world = _Doc(self.data_dir / "world.json", self.data_dir / "world.backup.json", validate_world, "mundo")

    # --- consultas para el juego -------------------------------------------------
    def booster_def(self, bid: str):
        cat = self.catalog.object_or_none()
        if not cat:
            return None
        return next((b for b in cat.get("boosters", []) if b.get("id") == bid), None)

    def card_ids(self) -> set[str] | None:
        cat = self.catalog.object_or_none()
        return {c["id"] for c in cat["cards"]} if cat else None

    def booster_ids(self) -> set[str] | None:
        cat = self.catalog.object_or_none()
        return {b.get("id") for b in cat.get("boosters", [])} if cat else None

    # --- assets ------------------------------------------------------------------
    def assets_size(self) -> int:
        total = 0
        for root, _dirs, files in os.walk(self.assets_dir):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total

    def save_asset(self, kind, name, data_url) -> str:
        """Valida y guarda una imagen. Devuelve la ruta pública `assets/<carpeta>/<slug>-<sha1>.<ext>`."""
        folder = UPLOAD_DIRS.get(kind) if isinstance(kind, str) else None
        if not folder:
            raise ValueError("Tipo de imagen desconocido.")
        m = re.match(r"^data:(image/[a-z+.-]+);base64,(.*)$", data_url if isinstance(data_url, str) else "", re.S)
        if not m or m.group(1) not in MIME_EXT:
            raise ValueError("Formato no soportado (usá PNG, JPG, WEBP o GIF).")
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except binascii.Error:
            raise ValueError("Imagen inválida.")
        if len(raw) > MAX_UPLOAD:
            raise ValueError("La imagen supera los 15 MB.")
        if not raw:
            raise ValueError("Imagen vacía.")
        if sniff_image(raw) != m.group(1):
            raise ValueError("El contenido no coincide con el formato declarado.")
        fname = f"{slug(str(name or 'img'))}-{hashlib.sha1(raw).hexdigest()[:10]}.{MIME_EXT[m.group(1)]}"
        target = self.assets_dir / folder / fname
        if not target.exists() and self.assets_size() + len(raw) > MAX_ASSETS_TOTAL:
            raise AssetQuota("Se alcanzó el tope de espacio para imágenes.")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        return f"assets/{folder}/{fname}"
