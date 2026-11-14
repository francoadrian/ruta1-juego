// Almacén de jugadores y buzón — SQLite con node:sqlite (port 1:1 de juego/store.py).
//
// MISMO esquema y MISMO formato de hashes (sha256 hex del token) que el servidor Python:
// una DB creada por uno se abre con el otro. La "migración" es idempotente igual que en
// Python: CREATE TABLE/INDEX IF NOT EXISTS al abrir.
//
// Concurrencia:
//   * Cada partida guardada tiene `rev`: un guardado con una rev vieja se rechaza (409/Conflict).
//   * Reclamar un envío marca el envío y suma las cartas en la MISMA transacción.
// El proceso usa una sola conexión síncrona (las operaciones no se intercalan); BEGIN IMMEDIATE y
// busy_timeout cubren a otro proceso que abra la misma base (p. ej. tools/backup_db.py o el servidor Python).

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ValueError, cut, isObj, setOwn } from "./util.ts";

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ" + "23456789";

const SCHEMA = `
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
`;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const now = (): number => Date.now() / 1000;

/** Normaliza lo que manda el cliente (y descarta basura). Los booleanos NO cuentan como cantidad. */
export function cleanSave(save: unknown): Record<string, any> {
  const s = isObj(save) ? save : {};
  const collection: Record<string, number> = {};
  if (isObj(s.collection)) {
    for (const [k, v] of Object.entries(s.collection)) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100000) setOwn(collection, cut(k, 64), v);
    }
  }
  const out: Record<string, any> = { collection };
  if (isObj(s.decks)) out.decks = s.decks;
  if (isObj(s.defeated)) {
    const d: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.defeated)) {
      if (typeof v === "number" && Number.isSafeInteger(v)) setOwn(d, cut(k, 64), v);
    }
    out.defeated = d;
  }
  return out;
}

export class Conflict extends Error {
  player: Record<string, any>;
  constructor(player: Record<string, any>) {
    super("La partida cambió en otro lado.");
    this.player = player;
  }
}

type Row = Record<string, any>;

export class Store {
  path: string;
  db: DatabaseSync;

  constructor(file: string) {
    this.path = path.resolve(file);
    mkdirSync(path.dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 15000 });
    this.db.exec("PRAGMA busy_timeout=15000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ helpers
  private get(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: any[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...p);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  /** Transacción de escritura (BEGIN IMMEDIATE toma el lock ya). */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ya no hay transacción */ }
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------ jugadores
  private player(row: Row, full = true): Record<string, any> {
    const p: Record<string, any> = {
      id: row.id,
      name: row.name,
      created: row.created,
      lastSeen: row.last_seen,
      rev: row.rev,
    };
    if (full) p.save = JSON.parse(row.save || "{}");
    return p;
  }

  createPlayer(save?: unknown, name?: string): [Record<string, any>, string] {
    const token = randomBytes(24).toString("base64url");
    const t = now();
    return this.tx(() => {
      const n = Number(this.get("SELECT COUNT(*) AS n FROM players")!.n);
      let pid: string;
      for (;;) {
        pid = "J-";
        for (let i = 0; i < 6; i++) pid += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
        if (!this.get("SELECT 1 FROM players WHERE id=?", pid)) break;
      }
      this.run(
        "INSERT INTO players (id, token_hash, name, created, last_seen, save) VALUES (?,?,?,?,?,?)",
        pid, hashToken(token), cut(name || `Jugador ${n + 1}`, 24), t, t, JSON.stringify(cleanSave(save)),
      );
      const row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      return [this.player(row), token] as [Record<string, any>, string];
    });
  }

  playerByToken(token: string, touch = true): Record<string, any> | null {
    if (!token) return null;
    const find = (): Row | undefined => this.get("SELECT * FROM players WHERE token_hash=?", hashToken(token));
    if (!touch) {
      const row = find();
      return row ? this.player(row) : null;
    }
    return this.tx(() => {
      const row = find();
      if (row) this.run("UPDATE players SET last_seen=? WHERE id=?", now(), row.id);
      return row ? this.player(row) : null; // como en Python: devuelve el last_seen anterior
    });
  }

  getPlayer(pid: string): Record<string, any> | null {
    const row = this.get("SELECT * FROM players WHERE id=?", pid);
    return row ? this.player(row) : null;
  }

  listPlayers(): Record<string, any>[] {
    const rows = this.all(
      `SELECT p.*, (SELECT COUNT(*) FROM mail m WHERE m.player_id=p.id AND m.claimed IS NULL) AS pending
       FROM players p ORDER BY p.last_seen DESC`,
    );
    return rows.map((r) => {
      const p = this.player(r);
      const col: Record<string, number> = isObj(p.save.collection) ? p.save.collection : {};
      p.cards = Object.values(col).reduce((a, b) => a + b, 0);
      p.distinct = Object.keys(col).length;
      p.pending = Number(r.pending);
      delete p.save;
      return p;
    });
  }

  renamePlayer(pid: string, name: string): Record<string, any> | null {
    name = cut((name || "").trim(), 24);
    if (!name) throw new ValueError("El nombre no puede estar vacío.");
    const changed = this.tx(() => this.run("UPDATE players SET name=? WHERE id=?", name, pid).changes);
    if (changed === 0) return null;
    return this.getPlayer(pid);
  }

  deletePlayer(pid: string): boolean {
    return this.tx(() => this.run("DELETE FROM players WHERE id=?", pid).changes > 0);
  }

  /** Guarda si rev coincide con la actual; si no, lanza Conflict con la versión vigente. */
  saveGame(pid: string, rev: number, save: unknown): Record<string, any> {
    return this.tx(() => {
      let row = this.get("SELECT * FROM players WHERE id=?", pid);
      if (!row) throw new Error(`jugador inexistente: ${pid}`);
      if (row.rev !== rev) throw new Conflict(this.player(row));
      this.run("UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?", JSON.stringify(cleanSave(save)), now(), pid);
      row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      return this.player(row);
    });
  }

  // ------------------------------------------------------------ buzón
  private mail(row: Row): Record<string, any> {
    return {
      id: row.id,
      player: row.player_id,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      message: row.message,
      sender: row.sender,
      created: row.created,
      claimed: row.claimed,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  /** Manda un envío a cada jugador indicado (null = a todos). Devuelve cuántos se crearon. */
  sendMail(playerIds: string[] | null, kind: string, payload: unknown, message = "", sender = ""): number {
    if (kind !== "cards" && kind !== "booster") throw new ValueError("Tipo de envío desconocido.");
    const t = now();
    return this.tx(() => {
      const ids = playerIds ?? this.all("SELECT id FROM players").map((r) => r.id as string);
      let n = 0;
      for (const pid of ids) {
        if (!this.get("SELECT 1 FROM players WHERE id=?", pid)) continue;
        this.run(
          "INSERT INTO mail (player_id, kind, payload, message, sender, created) VALUES (?,?,?,?,?,?)",
          pid, kind, JSON.stringify(payload), cut(message, 200), cut(sender, 40), t,
        );
        n++;
      }
      return n;
    });
  }

  mailFor(pid: string, includeClaimed = false, limit = 200): Record<string, any>[] {
    const q = "SELECT * FROM mail WHERE player_id=?" + (includeClaimed ? "" : " AND claimed IS NULL");
    return this.all(q + " ORDER BY id DESC LIMIT ?", pid, limit).map((r) => this.mail(r));
  }

  mailExists(mid: number): boolean {
    return this.get("SELECT 1 FROM mail WHERE id=?", mid) !== undefined;
  }

  cancelMail(mid: number): boolean {
    return this.tx(() => this.run("DELETE FROM mail WHERE id=? AND claimed IS NULL", mid).changes > 0);
  }

  /** Marca el envío como recibido y suma `cards` a la colección, todo junto. Devuelve [envío, jugador]; lanza KeyError-like si no existe o ya se reclamó. */
  claimMail(pid: string, mid: number, cards: string[]): [Record<string, any>, Record<string, any>] {
    return this.tx(() => {
      const m = this.get("SELECT * FROM mail WHERE id=? AND player_id=? AND claimed IS NULL", mid, pid);
      if (!m) throw new MailGone(mid);
      let row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      const save = JSON.parse(row.save || "{}");
      if (!isObj(save.collection)) save.collection = {};
      const col = save.collection as Record<string, number>;
      for (const cid of cards) {
        const cur = Object.hasOwn(col, cid) ? col[cid] : 0;
        setOwn(col, cid, cur + 1);
      }
      const t = now();
      this.run("UPDATE mail SET claimed=?, result=? WHERE id=?", t, JSON.stringify(cards), mid);
      this.run("UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?", JSON.stringify(save), t, pid);
      const m2 = this.get("SELECT * FROM mail WHERE id=?", mid)!;
      row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      return [this.mail(m2), this.player(row)] as [Record<string, any>, Record<string, any>];
    });
  }

  // ------------------------------------------------------------ tokens de admin
  /** Crea un token de admin. Devuelve [id, token]; el token en claro no se guarda. */
  createAdminToken(label = ""): [number, string] {
    const token = randomBytes(32).toString("base64url");
    const id = this.tx(
      () => this.run("INSERT INTO admin_tokens (token_hash, label, created) VALUES (?,?,?)", hashToken(token), cut(label || "", 40), now()).lastInsertRowid,
    );
    return [id, token];
  }

  /** true si el token existe y no fue revocado (y anota el último uso). */
  checkAdminToken(token: string): boolean {
    if (!token) return false;
    const h = hashToken(token);
    return this.tx(() => {
      const row = this.get("SELECT id, token_hash FROM admin_tokens WHERE token_hash=? AND revoked IS NULL", h);
      if (!row) return false;
      const a = Buffer.from(String(row.token_hash));
      const b = Buffer.from(h);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      this.run("UPDATE admin_tokens SET last_used=? WHERE id=?", now(), row.id);
      return true;
    });
  }

  listAdminTokens(): Row[] {
    return this.all("SELECT id, label, created, last_used, revoked FROM admin_tokens ORDER BY id").map((r) => ({ ...r }));
  }

  revokeAdminToken(tid: number): boolean {
    return this.tx(() => this.run("UPDATE admin_tokens SET revoked=? WHERE id=? AND revoked IS NULL", now(), tid).changes > 0);
  }
}

/** El envío no existe, es de otro jugador o ya se reclamó (KeyError en Python). */
export class MailGone extends Error {
  constructor(mid: number) {
    super(`envío ${mid} no disponible`);
  }
}
