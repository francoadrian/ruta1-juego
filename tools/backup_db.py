"""
Copia de seguridad de data/game.db (jugadores, colecciones y buzón).

    python tools/backup_db.py                 → copia en %USERPROFILE%\\tcglocal-backups
    python tools/backup_db.py --keep 30       → conserva las 30 más nuevas (por defecto 20)
    python tools/backup_db.py --dest D:\\bk    → otra carpeta (o variable TCG_BACKUP_DIR)
    python tools/backup_db.py --db otra.db    → otra base (para pruebas)

Usa la API de backup de SQLite: la copia es consistente aunque el juego o el
backoffice estén corriendo y escribiendo (modo WAL). No modifica la base original.
Después de copiar verifica la copia (PRAGMA integrity_check) y borra las más viejas.
Sale con código 1 si falla, para que el Programador de tareas lo marque.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "data" / "game.db"
DEFAULT_DEST = Path(os.environ.get("TCG_BACKUP_DIR") or Path.home() / "tcglocal-backups")
PREFIX = "game-"


def backup(db: Path, dest: Path, keep: int) -> Path:
    if not db.exists():
        raise FileNotFoundError(f"No existe {db}")
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / f"{PREFIX}{time.strftime('%Y%m%d-%H%M%S')}.db"
    tmp = target.with_suffix(".tmp")

    src = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        out = sqlite3.connect(tmp)
        try:
            src.backup(out)
            ok = out.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            out.close()
    finally:
        src.close()
    if ok != "ok":
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"La copia no pasó integrity_check: {ok}")
    os.replace(tmp, target)

    olds = sorted(dest.glob(f"{PREFIX}*.db"), reverse=True)[keep:]
    for old in olds:
        old.unlink()
    return target


def main() -> int:
    ap = argparse.ArgumentParser(description="Backup de data/game.db")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    ap.add_argument("--keep", type=int, default=20)
    a = ap.parse_args()
    try:
        target = backup(a.db, a.dest, max(1, a.keep))
    except Exception as e:  # noqa: BLE001 — cualquier falla tiene que salir con código 1
        print(f"[backup] ERROR: {e}", file=sys.stderr)
        return 1
    print(f"[backup] OK → {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
