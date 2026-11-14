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
CREATE TABLE IF NOT EXISTS invites (
  code_hash   TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  uses_left   INTEGER NOT NULL,
  expires     REAL,
  created     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('pvp', 'npc')),
  p0          TEXT NOT NULL,
  p1          TEXT NOT NULL,
  seed        TEXT NOT NULL,
  catalog_rev TEXT,
  decks       TEXT NOT NULL,
  intents     TEXT NOT NULL DEFAULT '[]',
  started     REAL NOT NULL,
  ended       REAL,
  winner      INTEGER,
  reason      TEXT,
  reward      TEXT
);
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

/** Código de invitación en forma canónica (mayúsculas, sin guiones ni espacios). */
export function normalizeInvite(code: unknown): string {
  return typeof code === "string" ? code.toUpperCase().replace(/[\s-]/g, "") : "";
}
const INVITE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
export const inviteHash = (code: unknown): string => hashToken(normalizeInvite(code));

/** La invitación no existe, venció, se agotó o fue revocada. */
export class InviteError extends Error {}
/** Se llegó a MAX_PLAYERS. */
export class PlayersFull extends Error {}

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

  /**
   * Alta con invitación (ADR 0002 3.3). Ignora todo lo que mande el cliente salvo el nombre: la colección arranca
   * vacía de `pulled` (la colección inicial la suma ownedCounts del núcleo). Todo en una transacción: si el
   * servidor está lleno la invitación NO se consume.
   */
  createPlayer(name: string | undefined, inviteCode: unknown, maxPlayers: number): [Record<string, any>, string] {
    const token = randomBytes(24).toString("base64url");
    const t = now();
    const clean = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return this.tx(() => {
      const inv = INVITE_RE.test(normalizeInvite(inviteCode))
        ? this.get("SELECT * FROM invites WHERE code_hash=?", inviteHash(inviteCode))
        : undefined;
      if (!inv || inv.uses_left <= 0 || (inv.expires !== null && inv.expires <= t)) throw new InviteError("Código de invitación inválido o usado.");
      const n = Number(this.get("SELECT COUNT(*) AS n FROM players")!.n);
      if (n >= maxPlayers) throw new PlayersFull("El servidor está lleno.");
      this.run("UPDATE invites SET uses_left=uses_left-1 WHERE code_hash=?", inv.code_hash);
      let pid: string;
      for (;;) {
        pid = "J-";
        for (let i = 0; i < 6; i++) pid += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
        if (!this.get("SELECT 1 FROM players WHERE id=?", pid)) break;
      }
      this.run(
        "INSERT INTO players (id, token_hash, name, created, last_seen, save) VALUES (?,?,?,?,?,?)",
        pid, hashToken(token), cut(clean || `Jugador ${n + 1}`, 24), t, t, JSON.stringify({ collection: {} }),
      );
      const row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      return [this.player(row), token] as [Record<string, any>, string];
    });
  }

  // ------------------------------------------------------------ invitaciones (solo CLI)
  /** Crea una invitación. Devuelve el código en claro (XXXX-XXXX); en la base queda solo su hash. */
  createInvite(label: string, uses: number, days: number): string {
    let a = "";
    for (let i = 0; i < 8; i++) a += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    const t = now();
    this.tx(() => this.run(
      "INSERT INTO invites (code_hash, label, uses_left, expires, created) VALUES (?,?,?,?,?)",
      inviteHash(a), cut(label, 40), uses, t + days * 86400, t,
    ));
    return `${a.slice(0, 4)}-${a.slice(4)}`;
  }

  listInvites(): Row[] {
    return this.all("SELECT substr(code_hash,1,8) AS id, label, uses_left, expires, created FROM invites ORDER BY created").map((r) => ({ ...r }));
  }

  /** Revoca por código completo o por el id (8 hex) que muestra `invite list`. */
  revokeInvite(codeOrId: string): boolean {
    return this.tx(() => {
      let n = this.run("DELETE FROM invites WHERE code_hash=?", inviteHash(codeOrId)).changes;
      if (n === 0 && /^[0-9a-f]{8}$/.test(codeOrId)) n = this.run("DELETE FROM invites WHERE substr(code_hash,1,8)=?", codeOrId).changes;
      return n > 0;
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

  /**
   * Guarda los mazos si `rev` coincide. `build` recibe el save vigente (para validar contra la colección real, dentro de la
   * misma transacción) y devuelve los mazos ya normalizados; si lanza ValueError no se guarda nada.
   */
  saveDecks(pid: string, rev: number, build: (save: Record<string, any>) => unknown): Record<string, any> {
    return this.tx(() => {
      let row = this.get("SELECT * FROM players WHERE id=?", pid);
      if (!row) throw new Error(`jugador inexistente: ${pid}`);
      if (row.rev !== rev) throw new Conflict(this.player(row));
      const save = JSON.parse(row.save || "{}");
      save.decks = build(save);
      this.run("UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?", JSON.stringify(save), now(), pid);
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

  // ------------------------------------------------------------ partidas (ADR 0002, 3.4)
  /** Registra una partida que arranca. Lanza si el id ya existe (el que llama prueba con otro). */
  matchStart(m: { id: string; kind: "pvp" | "npc"; p0: string; p1: string; seed: string; catalogRev: string | null; decks: unknown }): void {
    this.tx(() => this.run(
      "INSERT INTO matches (id, kind, p0, p1, seed, catalog_rev, decks, started) VALUES (?,?,?,?,?,?,?,?)",
      m.id, m.kind, m.p0, m.p1, m.seed, m.catalogRev, JSON.stringify(m.decks), now(),
    ));
  }

  /** Guarda el log de intenciones (para depurar o reproducir). */
  matchIntents(id: string, intents: unknown): void {
    this.tx(() => this.run("UPDATE matches SET intents=? WHERE id=? AND ended IS NULL", JSON.stringify(intents), id));
  }

  /** Cierra una partida. winner: 0/1 (asiento), 2 empate, null anulada. */
  matchEnd(id: string, winner: number | null, reason: string, reward: unknown, intents: unknown): void {
    this.tx(() => this.run(
      "UPDATE matches SET ended=?, winner=?, reason=?, reward=?, intents=? WHERE id=?",
      now(), winner, reason, reward === null ? null : JSON.stringify(reward), JSON.stringify(intents), id,
    ));
  }

  /** Al arrancar: las partidas que quedaron abiertas (reinicio del servidor) se anulan sin resultado. Devuelve cuántas. */
  voidOpenMatches(): number {
    return this.tx(() => this.run("UPDATE matches SET ended=?, reason='void' WHERE ended IS NULL", now()).changes);
  }

  /** Estadística de PvP de un jugador (el PvP no da cartas). */
  pvpStats(pid: string): { played: number; won: number; lost: number; drawn: number } {
    const rows = this.all("SELECT p0, winner FROM matches WHERE kind='pvp' AND reason<>'void' AND ended IS NOT NULL AND (p0=? OR p1=?)", pid, pid);
    let won = 0, lost = 0, drawn = 0;
    for (const r of rows) {
      if (r.winner === 2) drawn++;
      else if (r.winner === null) continue;
      else if ((r.winner === 0) === (r.p0 === pid)) won++;
      else lost++;
    }
    return { played: won + lost + drawn, won, lost, drawn };
  }

  /**
   * Victoria contra un NPC (la decide el servidor): suma 1 a `defeated[npcId]` y, si `makeCards(before)` devuelve cartas,
   * las suma a la colección, todo en UNA transacción con rev+1. `before` = veces ganadas antes de esta.
   */
  npcWin(pid: string, npcId: string, makeCards: (before: number) => string[] | null): { defeated: number; cards: string[] | null; player: Record<string, any> } {
    return this.tx(() => {
      let row = this.get("SELECT * FROM players WHERE id=?", pid);
      if (!row) throw new Error(`jugador inexistente: ${pid}`);
      const save = JSON.parse(row.save || "{}");
      if (!isObj(save.defeated)) save.defeated = {};
      const before = Object.hasOwn(save.defeated, npcId) && Number.isSafeInteger(save.defeated[npcId]) ? save.defeated[npcId] as number : 0;
      setOwn(save.defeated, npcId, before + 1);
      const cards = makeCards(before);
      if (cards && cards.length) {
        if (!isObj(save.collection)) save.collection = {};
        const col = save.collection as Record<string, number>;
        for (const cid of cards) setOwn(col, cid, (Object.hasOwn(col, cid) ? col[cid] : 0) + 1);
      }
      this.run("UPDATE players SET save=?, rev=rev+1, last_seen=? WHERE id=?", JSON.stringify(save), now(), pid);
      row = this.get("SELECT * FROM players WHERE id=?", pid)!;
      return { defeated: before + 1, cards: cards && cards.length ? cards : null, player: this.player(row) };
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
