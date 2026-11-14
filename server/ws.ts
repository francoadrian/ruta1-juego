// WebSocket del juego: lobby, desafíos, cola, partidas PvP y contra NPC (ADR 0002, 3.2). Autoridad total del servidor:
// el cliente solo manda intenciones; cada jugador recibe SOLO su vista (viewFor) y lo que `peek` le permite ver.
//
// Una conexión por jugador (la nueva gana, la vieja se cierra con 4409) y una partida activa por jugador.
// Variables de entorno (todas opcionales):
//   TURN_SECONDS=90        tiempo por decisión; al vencer se aplica defaultIntent (3 seguidos = derrota por timeout)
//   GRACE_SECONDS=90       gracia por desconexión durante una partida (después, derrota por abandono)
//   CHALLENGE_SECONDS=60   vencimiento de un desafío
//   NPC_STEP_MS=800        pausa entre pasos de la IA contra un NPC
//   WS_PING_SECONDS=25     ping de aplicación
//   WS_AUTH_MS=5000        tiempo para mandar `auth` tras abrir la conexión
//   WS_MSGS_PER_SEC=20     mensajes por segundo por conexión (más = cierre 4429)
//   WS_CONN_PER_MIN=60     conexiones nuevas por IP y minuto
//   MATCH_LOG_MAX_ENTRIES=2000   tope de entradas del log de intents por partida (y 256 KB)
//   MATCH_STARTS_PER_MIN=6 / MATCH_STARTS_PER_HOUR=60   partidas que puede empezar un jugador (más = error; si insiste, cierre 4429)

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomInt } from "node:crypto";
import type { Content } from "./content.ts";
import { type Core, type Engine, serverRng } from "./engine.ts";
import { RateLimiter, type Access } from "./security.ts";
import type { Store } from "./store.ts";
import { isObj } from "./util.ts";

const MAX_BYTES = 16 * 1024;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TIMEOUTS = 3;
const MAX_SOCKETS = 200;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_STRIKES = 5; // intentos de pasarse del límite de partidas antes del cierre 4429

export interface WsConfig {
  turnMs: number;
  graceMs: number;
  challengeMs: number;
  npcStepMs: number;
  pingMs: number;
  authMs: number;
  msgsPerSec: number;
  connPerMin: number;
  startsPerMin: number;
  startsPerHour: number;
  /** Entradas del log de intents por partida (para depurar; el resto se descarta). */
  logMax: number;
}

export function wsConfigFromEnv(env: NodeJS.ProcessEnv): WsConfig {
  const int = (name: string, dflt: number): number => {
    const n = Number.parseInt(env[name] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    turnMs: int("TURN_SECONDS", 90) * 1000,
    graceMs: int("GRACE_SECONDS", 90) * 1000,
    challengeMs: int("CHALLENGE_SECONDS", 60) * 1000,
    npcStepMs: int("NPC_STEP_MS", 800),
    pingMs: int("WS_PING_SECONDS", 25) * 1000,
    authMs: int("WS_AUTH_MS", 5000),
    msgsPerSec: int("WS_MSGS_PER_SEC", 20),
    connPerMin: int("WS_CONN_PER_MIN", 60),
    startsPerMin: int("MATCH_STARTS_PER_MIN", 6),
    startsPerHour: int("MATCH_STARTS_PER_HOUR", 60),
    logMax: int("MATCH_LOG_MAX_ENTRIES", 2000),
  };
}

export interface WsDeps {
  store: Store;
  content: Content;
  engine: Engine;
  access: Access;
  clientIp: (req: IncomingMessage) => string;
  config?: WsConfig;
}

// ------------------------------------------------------------------ tipos internos
interface Conn {
  ws: WebSocket;
  ip: string;
  pid: string | null;
  sub: boolean;
  stamps: number[];
  lastRx: number;
  authTimer: NodeJS.Timeout | null;
  replaced: boolean;
  strikes: number;
}

interface Seat {
  pid: string | null; // null = NPC
  name: string;
  deadline: number | null; // ms epoch
  timeouts: number;
  lastN: number;
  online: boolean;
  graceTimer: NodeJS.Timeout | null;
  graceUntil: number;
}

interface Active {
  id: string;
  kind: "pvp" | "npc";
  core: Core;
  m: any;
  seats: [Seat, Seat];
  seed: string;
  log: unknown[];
  logBytes: number;
  logTruncated: boolean;
  flushed: number;
  npc: { id: string; def: any } | null;
  timer: NodeJS.Timeout | null;
  npcTimer: NodeJS.Timeout | null;
  reason: string | null;
  ended: boolean;
}

interface Peer {
  id: string;
  name: string;
  conn: Conn | null;
  match: Active | null;
  queued: { deckId: string | undefined; prizes: number } | null;
}

interface Challenge {
  id: string;
  from: string;
  to: string;
  prizes: number;
  deckId: string | undefined;
  expires: number; // ms epoch
  timer: NodeJS.Timeout;
}

const sec = (ms: number): number => Math.ceil(ms / 1000);
const randId = (prefix: string, n: number): string => {
  let s = prefix;
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
};

// ------------------------------------------------------------------ servidor
export interface WsHandle {
  close(): void;
  /** El admin borró al jugador: se cierra su socket (4401) y se anula su partida. */
  dropPlayer(pid: string): void;
  /** El admin renombró al jugador: se refresca su nombre en el lobby (no se lo desconecta). */
  renamePlayer(pid: string, name: string): void;
  /** Para los tests y la depuración. */
  stats(): { sockets: number; peers: number; matches: number; challenges: number; queue: number };
}

export function attachWs(srv: Server, deps: WsDeps): WsHandle {
  const { store, content, engine, access } = deps;
  const cfg = deps.config ?? wsConfigFromEnv(process.env);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * MAX_BYTES, perMessageDeflate: false });
  const connLimit = new RateLimiter(cfg.connPerMin, 60_000);

  const conns = new Set<Conn>();
  const peers = new Map<string, Peer>();
  const challenges = new Map<string, Challenge>();
  const queue: string[] = []; // ids de jugador, FIFO
  const finished = new Map<string, { match: string; msg: any; sent: boolean }>(); // último match.over por jugador
  let chalSeq = 0;
  let lobbyTimer: NodeJS.Timeout | null = null;
  const actives = new Set<Active>();

  // Logs a stderr, una línea por evento, SIN tokens ni códigos de invitación (solo ids de jugador/partida e IP).
  const stamp = (): string => new Date().toISOString();
  const log = (msg: string): void => {
    process.stderr.write(`${stamp()} [ws] ${msg}\n`);
  };
  const warn = (what: string, e: unknown): void => {
    process.stderr.write(`${stamp()} [ws] ${what}: ${(e as Error)?.stack ?? e}\n`);
  };
  const lastLog = new Map<string, number>();
  /** Como log, pero a lo sumo una vez por segundo por clave (un flood de rechazos no inunda el archivo de logs). */
  const logThrottled = (key: string, msg: string): void => {
    const t = Date.now();
    if (t - (lastLog.get(key) ?? 0) < 1000) return;
    lastLog.set(key, t);
    if (lastLog.size > 500) for (const [k, v] of lastLog) if (t - v > 60_000) lastLog.delete(k);
    log(msg);
  };
  /** Corre `fn` (un timer o un manejador): una excepción se loguea y, si es de una partida, la anula; nunca sube al proceso. */
  function guard(what: string, fn: () => void, am?: Active): void {
    try {
      fn();
    } catch (e) {
      if (am) voidMatch(am, e); else warn(what, e);
    }
  }
  // Partidas empezadas por jugador (ventana de 1 h) para limitar el spam de partidas.
  const starts = new Map<string, number[]>();
  const startsLeft = (pid: string): boolean => {
    const t = Date.now();
    const arr = (starts.get(pid) ?? []).filter((x) => x > t - 3_600_000);
    starts.set(pid, arr);
    return arr.length < cfg.startsPerHour && arr.filter((x) => x > t - 60_000).length < cfg.startsPerMin;
  };
  const recordStart = (pid: string): void => { (starts.get(pid) ?? starts.set(pid, []).get(pid)!).push(Date.now()); };
  /** true (y avisa) si el jugador ya empezó demasiadas partidas; si insiste, se lo desconecta con 4429. */
  function overStartBudget(conn: Conn, me: Peer, ref: string): boolean {
    if (startsLeft(me.id)) return false;
    err(conn, ref, "Empezaste demasiadas partidas seguidas. Esperá un rato.");
    if (++conn.strikes >= MAX_STRIKES) {
      log(`cierre 4429 (demasiadas partidas) jugador=${me.id} ip=${conn.ip}`);
      kill(conn, 4429, "Demasiadas partidas.");
    }
    return true;
  }
  /** Agrega una entrada al log de la partida con tope de cantidad y de bytes. */
  function pushLog(am: Active, entry: unknown): void {
    if (am.logTruncated) return;
    const size = JSON.stringify(entry).length;
    if (am.log.length >= cfg.logMax || am.logBytes + size > MAX_LOG_BYTES) {
      am.logTruncated = true;
      am.log.push({ k: "truncated" });
      return;
    }
    am.logBytes += size;
    am.log.push(entry);
  }

  // --------------------------------------------------------------- envío y cierre
  function send(conn: Conn | null, obj: unknown): void {
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch (e) {
      warn("send", e);
    }
  }
  const sendPid = (pid: string | null, obj: unknown): void => {
    if (pid) send(peers.get(pid)?.conn ?? null, obj);
  };
  function kill(conn: Conn, code: number, reason: string): void {
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      try { conn.ws.close(code, reason); } catch { /* ya cerrándose */ }
    }
    setTimeout(() => { try { conn.ws.terminate(); } catch { /* nada */ } }, 2000).unref();
  }
  const err = (conn: Conn, ref: string, error: string): void => send(conn, { type: "error", ref, error });

  // --------------------------------------------------------------- lobby
  function statusOf(p: Peer): "libre" | "jugando" {
    return p.match ? "jugando" : "libre";
  }
  function lobbyFor(pid: string): unknown {
    const online = [];
    for (const p of peers.values()) if (p.conn && p.id !== pid) online.push({ id: p.id, name: p.name, status: statusOf(p) });
    return { type: "lobby", online };
  }
  function scheduleLobby(): void {
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
      lobbyTimer = null;
      guard("lobby", () => { for (const c of conns) if (c.sub && c.pid) send(c, lobbyFor(c.pid)); });
    }, 100);
    lobbyTimer.unref();
  }

  // --------------------------------------------------------------- mazos
  /** Mazo guardado del jugador + validación completa (deckProblems con su colección real). El cliente solo manda el id. */
  function deckOf(core: Core, pid: string, deckId: string | undefined): { deck: any } | { error: string } {
    const player = store.getPlayer(pid);
    if (!player) return { error: "Jugador desconocido." };
    const save = isObj(player.save) ? player.save : {};
    const list: any[] = isObj(save.decks) && Array.isArray(save.decks.decks) ? save.decks.decks : [];
    const id = deckId ?? (isObj(save.decks) && typeof save.decks.mainId === "string" ? save.decks.mainId : undefined);
    const d = list.find((x) => isObj(x) && x.id === id);
    if (!d) return { error: "No tenés ese mazo." };
    try {
      const deck = { name: String(d.name), cards: (d.cards as any[]).map((e) => ({ id: String(e.id), qty: Number(e.qty) })) };
      const owned = core.ownedCounts(isObj(save.collection) ? save.collection : {});
      const problems = [...core.deckProblems(deck, owned)] as string[];
      if (problems.length) return { error: `Mazo "${deck.name}": ${problems.slice(0, 2).join(" ")}` };
      return { deck };
    } catch {
      return { error: "Ese mazo no es válido." };
    }
  }

  // --------------------------------------------------------------- desafíos
  function chalUpdate(c: Challenge, status: string, error?: string): void {
    const msg: Record<string, unknown> = { type: "challenge.update", id: c.id, status };
    if (error) msg.error = error;
    sendPid(c.from, msg);
    sendPid(c.to, msg);
  }
  function dropChallenge(c: Challenge): void {
    clearTimeout(c.timer);
    challenges.delete(c.id);
  }
  function closeChallenge(c: Challenge, status: string, error?: string): void {
    dropChallenge(c);
    chalUpdate(c, status, error);
  }
  /** Cancela los desafíos pendientes de un jugador (desconexión, empezó una partida). */
  function cancelChallengesOf(pid: string, why: string, except?: Challenge): void {
    for (const c of [...challenges.values()]) if (c !== except && (c.from === pid || c.to === pid)) closeChallenge(c, "cancelled", why);
  }
  function leaveQueue(pid: string): boolean {
    const i = queue.indexOf(pid);
    if (i < 0) return false;
    queue.splice(i, 1);
    const p = peers.get(pid);
    if (p) p.queued = null;
    return true;
  }
  const queueState = (conn: Conn | null, queued: boolean): void => send(conn, { type: "queue.state", queued });

  function parsePrizes(raw: unknown): number | null {
    if (raw === undefined) return 6;
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 6 ? raw : null;
  }

  function onChallengeSend(conn: Conn, me: Peer, msg: any): void {
    const to = typeof msg.to === "string" ? peers.get(msg.to) : undefined;
    const prizes = parsePrizes(msg.prizes);
    if (prizes === null) return err(conn, "challenge.send", "Cantidad de premios inválida.");
    if (!to || !to.conn || to.id === me.id) return err(conn, "challenge.send", "Ese jugador no está conectado.");
    if (me.match) return err(conn, "challenge.send", "Ya estás en una partida.");
    if (me.queued) return err(conn, "challenge.send", "Estás en la cola: salí primero.");
    if (to.match) return err(conn, "challenge.send", "Ese jugador está jugando.");
    if ([...challenges.values()].some((c) => c.from === me.id)) return err(conn, "challenge.send", "Ya tenés un desafío pendiente.");
    if ([...challenges.values()].filter((c) => c.to === to.id).length >= 5) return err(conn, "challenge.send", "Ese jugador tiene demasiados desafíos pendientes.");
    if (overStartBudget(conn, me, "challenge.send")) return;
    const deckId = typeof msg.deckId === "string" ? msg.deckId : undefined;
    const d = deckOf(engine.core(), me.id, deckId);
    if ("error" in d) return err(conn, "challenge.send", d.error);
    const id = `C-${++chalSeq}`;
    const c: Challenge = {
      id, from: me.id, to: to.id, prizes, deckId, expires: Date.now() + cfg.challengeMs,
      timer: setTimeout(() => guard("desafío", () => { if (challenges.get(id)) closeChallenge(c, "expired"); }), cfg.challengeMs),
    };
    challenges.set(id, c);
    send(to.conn, { type: "challenge.incoming", id, from: { id: me.id, name: me.name }, prizes, expires: sec(c.expires) });
    // al que desafía le confirmamos el envío con el id (para poder cancelar por id)
    send(conn, { type: "challenge.update", id, status: "pending", to: to.id, expires: sec(c.expires) });
  }

  function onChallengeReply(conn: Conn, me: Peer, type: string, msg: any): void {
    let c = typeof msg.id === "string" ? challenges.get(msg.id) : undefined;
    // cancel sin id: se busca el desafío pendiente de este jugador hacia `to`
    if (!c && type === "challenge.cancel" && typeof msg.id !== "string" && typeof msg.to === "string") {
      c = [...challenges.values()].find((x) => x.from === me.id && x.to === msg.to);
    }
    if (!c) return err(conn, type, "Ese desafío ya no existe.");
    if (type === "challenge.cancel") {
      if (c.from !== me.id) return err(conn, type, "Ese desafío no es tuyo.");
      return closeChallenge(c, "cancelled");
    }
    if (c.to !== me.id) return err(conn, type, "Ese desafío no es para vos.");
    if (type === "challenge.decline") return closeChallenge(c, "declined");
    // accept
    const from = peers.get(c.from);
    if (!from || !from.conn) return closeChallenge(c, "cancelled", "El rival se desconectó.");
    if (me.match || from.match) return closeChallenge(c, "cancelled", "Alguno de los dos ya está jugando.");
    if (overStartBudget(conn, me, type)) return; // el desafío sigue: puede aceptar más tarde
    if (!startsLeft(from.id)) return closeChallenge(c, "cancelled", "El rival empezó demasiadas partidas seguidas.");
    const core = engine.core();
    const dMe = deckOf(core, me.id, typeof msg.deckId === "string" ? msg.deckId : undefined);
    if ("error" in dMe) return err(conn, type, dMe.error); // el desafío sigue: puede aceptar con otro mazo
    const dFrom = deckOf(core, from.id, c.deckId);
    if ("error" in dFrom) return closeChallenge(c, "cancelled", "El mazo del rival ya no es válido.");
    dropChallenge(c);
    leaveQueue(me.id);
    leaveQueue(from.id);
    if (!beginMatch("pvp", [from, me], [dFrom.deck, dMe.deck], c.prizes, null, core)) {
      chalUpdate(c, "cancelled", "No se pudo empezar la partida.");
      return;
    }
    chalUpdate(c, "accepted");
  }

  // --------------------------------------------------------------- cola
  function onQueueJoin(conn: Conn, me: Peer, msg: any): void {
    if (me.match) return err(conn, "queue.join", "Ya estás en una partida.");
    if (overStartBudget(conn, me, "queue.join")) return;
    const deckId = typeof msg.deckId === "string" ? msg.deckId : undefined;
    const d = deckOf(engine.core(), me.id, deckId);
    if ("error" in d) return err(conn, "queue.join", d.error);
    leaveQueue(me.id);
    cancelChallengesOf(me.id, "Entraste a la cola.");
    queue.push(me.id);
    me.queued = { deckId, prizes: 6 };
    queueState(conn, true);
    pairQueue();
  }

  function pairQueue(): void {
    while (queue.length >= 2) {
      const [a, b] = [peers.get(queue[0]), peers.get(queue[1])];
      const bad = (p: Peer | undefined): boolean => !p || !p.conn || !!p.match || !p.queued;
      if (bad(a)) { queue.shift(); if (a) a.queued = null; continue; }
      if (bad(b)) { queue.splice(1, 1); if (b) b.queued = null; continue; }
      if (!startsLeft(a!.id)) { queue.shift(); a!.queued = null; queueState(a!.conn, false); err(a!.conn!, "queue.join", "Empezaste demasiadas partidas seguidas. Esperá un rato."); continue; }
      if (!startsLeft(b!.id)) { queue.splice(1, 1); b!.queued = null; queueState(b!.conn, false); err(b!.conn!, "queue.join", "Empezaste demasiadas partidas seguidas. Esperá un rato."); continue; }
      const core = engine.core();
      const da = deckOf(core, a!.id, a!.queued!.deckId);
      const db = deckOf(core, b!.id, b!.queued!.deckId);
      if ("error" in da) { queue.shift(); a!.queued = null; queueState(a!.conn, false); err(a!.conn!, "queue.join", da.error); continue; }
      if ("error" in db) { queue.splice(1, 1); b!.queued = null; queueState(b!.conn, false); err(b!.conn!, "queue.join", db.error); continue; }
      queue.splice(0, 2);
      a!.queued = null;
      b!.queued = null;
      queueState(a!.conn, false);
      queueState(b!.conn, false);
      if (!beginMatch("pvp", [a!, b!], [da.deck, db.deck], 6, null, core)) {
        err(a!.conn!, "queue.join", "No se pudo empezar la partida.");
        err(b!.conn!, "queue.join", "No se pudo empezar la partida.");
      }
    }
  }

  // --------------------------------------------------------------- NPC
  function onNpcStart(conn: Conn, me: Peer, msg: any): void {
    if (me.match) return err(conn, "npc.start", "Ya estás en una partida.");
    if (me.queued) return err(conn, "npc.start", "Estás en la cola: salí primero.");
    const world = content.world.objectOrNull();
    const def = typeof msg.npc === "string" && world && Array.isArray(world.npcs) ? world.npcs.find((n: any) => n && n.id === msg.npc) : undefined;
    if (!def || def.battle === false) return err(conn, "npc.start", "Ese NPC no juega partidas.");
    if (overStartBudget(conn, me, "npc.start")) return;
    // premios contra un NPC: si def.prizes > 0, esos (el `prizes` del cliente se ignora); si no, el jugador elige 6 o 1
    // (solo esas dos opciones, como en el diálogo; cualquier otro valor o ausente → 6). Si el NPC da un sobre que se
    // repite (sin `once: true`), siempre 6: si no, ganar a 1 premio en bucle sería una forma barata de farmear sobres
    const fixed = Number(def.prizes) || 0;
    const repeatable = !!def.reward?.booster && def.reward.once !== true;
    const prizes = fixed > 0 ? Math.max(1, Math.min(6, Math.floor(fixed))) : msg.prizes === 1 && !repeatable ? 1 : 6;
    const core = engine.core();
    const mine = deckOf(core, me.id, typeof msg.deckId === "string" ? msg.deckId : undefined);
    if ("error" in mine) return err(conn, "npc.start", mine.error);
    // mismo criterio que el cliente (battle.ts): mazo del NPC si es jugable y tiene un Básico; si no, Overgrowth
    const cards = (Array.isArray(def.deck?.cards) ? def.deck.cards : []).filter((e: any) => isObj(e) && core.isPlayable(e.id) && e.qty > 0)
      .map((e: any) => ({ id: String(e.id), qty: Number(e.qty) }));
    const npcDeck = cards.length && cards.some((e: any) => core.isBasic(core.CARDS[e.id]))
      ? { name: String(def.deck.name || "Mazo"), cards }
      : { name: core.OVERGROWTH.name, cards: core.OVERGROWTH.cards.map((e: any) => ({ id: e.id, qty: e.qty })) };
    cancelChallengesOf(me.id, "Empezaste una partida.");
    if (!beginMatch("npc", [me, null], [mine.deck, npcDeck], prizes, { id: String(def.id), def }, core)) {
      err(conn, "npc.start", "No se pudo empezar la partida.");
    }
  }

  // --------------------------------------------------------------- partidas
  const seatOf = (am: Active, pid: string): 0 | 1 | -1 => (am.seats[0].pid === pid ? 0 : am.seats[1].pid === pid ? 1 : -1);

  /** Arranca una partida. players[1] = null para NPC. Devuelve false (y no deja nada a medias) si el motor falla. */
  function beginMatch(kind: "pvp" | "npc", players: [Peer, Peer | null], decks: [any, any], prizes: number,
    npc: { id: string; def: any } | null, core: Core): boolean {
    const rng = serverRng();
    const names: [string, string] = [players[0].name, players[1] ? players[1].name : String(npc!.def.name || "Rival").slice(0, 24)];
    let m: any;
    try {
      m = core.createMatch(decks, names, { rng, prizes, ai: kind === "npc" ? [false, true] : [false, false] });
    } catch (e) {
      warn("createMatch", e);
      return false;
    }
    const mkSeat = (p: Peer | null, name: string): Seat => ({
      pid: p ? p.id : null, name, deadline: null, timeouts: 0, lastN: -1, online: true, graceTimer: null, graceUntil: 0,
    });
    const am: Active = {
      id: "", kind, core, m, seats: [mkSeat(players[0], names[0]), mkSeat(players[1], names[1])], seed: rng.seed,
      log: [], logBytes: 0, logTruncated: false, flushed: 0, npc, timer: null, npcTimer: null, reason: null, ended: false,
    };
    const raw = content.catalog.raw();
    const catalogRev = raw ? createHash("sha1").update(raw).digest("hex").slice(0, 12) : null;
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) {
      am.id = randId("M-", 6);
      try {
        store.matchStart({
          id: am.id, kind, p0: players[0].id, p1: players[1] ? players[1].id : `npc:${npc!.id}`, seed: rng.seed, catalogRev, decks,
        });
        ok = true;
      } catch (e) {
        if (i === 4) warn("matchStart", e);
      }
    }
    if (!ok) return false;
    actives.add(am);
    for (const p of players) if (p) recordStart(p.id);
    for (const p of players) if (p) { p.match = am; leaveQueue(p.id); cancelChallengesOf(p.id, "Empezó una partida."); }
    refreshDeadlines(am, -1);
    for (let i = 0; i < 2; i++) {
      const s = am.seats[i];
      if (!s.pid) continue;
      const opp = am.seats[1 - i];
      sendPid(s.pid, {
        type: "match.start", match: am.id, vs: kind, opp: { name: opp.name }, seq: m.seq,
        view: core.viewFor(m, i), deadline: deadlineFor(am, i), waiting: waitingFor(am, i),
      });
    }
    armTimer(am);
    scheduleNpc(am);
    scheduleLobby();
    return true;
  }

  function actorsOf(am: Active): number[] {
    const b = am.m.b;
    if (b.phase === "over") return [];
    if (b.phase === "setup") return [0, 1].filter((i) => !am.m.setupDone[i]);
    if (b.phase === "promote") return [...b.promoteQueue].map(Number);
    return [Number(b.cur)];
  }
  const waitingFor = (am: Active, i: number): "you" | "opp" => (actorsOf(am).includes(i) ? "you" : "opp");

  /** Plazos por decisión: el que tiene que actuar tiene TURN_SECONDS; se renueva cuando actúa. */
  function refreshDeadlines(am: Active, actedSeat: number): void {
    const actors = actorsOf(am);
    const t = Date.now();
    am.seats.forEach((s, i) => {
      if (!s.pid || !actors.includes(i)) s.deadline = null;
      else if (s.deadline === null || i === actedSeat) s.deadline = t + cfg.turnMs;
    });
  }
  /** Plazo que ve `i`: el suyo si le toca, si no el del rival (0 si no hay). */
  function deadlineFor(am: Active, i: number): number {
    const d = waitingFor(am, i) === "you" ? am.seats[i].deadline : am.seats[1 - i].deadline;
    return d === null ? 0 : sec(d);
  }

  function armTimer(am: Active): void {
    if (am.timer) clearTimeout(am.timer);
    am.timer = null;
    if (am.ended) return;
    const ds = am.seats.map((s) => s.deadline).filter((d): d is number => d !== null);
    if (!ds.length) return;
    am.timer = setTimeout(() => guard("timer", () => onTimer(am), am), Math.max(0, Math.min(...ds) - Date.now()) + 5);
  }

  function scheduleNpc(am: Active): void {
    if (am.kind !== "npc" || am.ended || am.npcTimer) return;
    am.npcTimer = setTimeout(() => guard("npc", () => {
      am.npcTimer = null;
      if (am.ended) return;
      const before = am.m.b.logCount;
      let acted = false;
      try {
        acted = !!am.core.stepAI(am.m, 1);
      } catch (e) {
        return voidMatch(am, e);
      }
      if (acted) {
        pushLog(am, { pi: 1, k: "ai" });
        afterChange(am, before, -1, -1);
      }
    }, am), cfg.npcStepMs);
  }

  function onTimer(am: Active): void {
    am.timer = null;
    if (am.ended) return;
    const t = Date.now();
    for (let i = 0; i < 2 && !am.ended; i++) {
      const s = am.seats[i];
      if (s.pid && s.deadline !== null && s.deadline <= t) onTimeout(am, i as 0 | 1);
    }
    if (!am.ended) armTimer(am);
  }

  function onTimeout(am: Active, i: 0 | 1): void {
    const s = am.seats[i];
    s.timeouts++;
    pushLog(am, { pi: i, k: "timeout", n: s.timeouts });
    if (s.timeouts >= MAX_TIMEOUTS) return forceEnd(am, i, "timeout");
    const before = am.m.b.logCount;
    let failed = false;
    try {
      if (am.m.b.phase === "setup") {
        for (let k = 0; k < 100 && !am.m.setupDone[i]; k++) {
          const e = am.core.applyIntent(am.m, i, am.core.defaultIntent(am.m, i));
          if (e !== null) { failed = true; break; }
        }
        if (!am.m.setupDone[i]) failed = true;
      } else {
        failed = am.core.applyIntent(am.m, i, am.core.defaultIntent(am.m, i)) !== null;
      }
    } catch (e) {
      return voidMatch(am, e);
    }
    if (failed) return forceEnd(am, i, "timeout"); // no hay jugada por defecto: no se puede seguir esperando
    afterChange(am, before, i, -1);
  }

  /** Termina la partida a la fuerza: pierde el asiento `loser` (timeout/abandon). */
  function forceEnd(am: Active, loser: 0 | 1, reason: string): void {
    if (am.ended) return;
    const before = am.m.b.logCount;
    am.reason = reason;
    try {
      if (am.m.b.phase !== "over") am.core.applyIntent(am.m, loser, { t: "surrender" });
    } catch (e) {
      return voidMatch(am, e);
    }
    afterChange(am, before, -1, -1);
  }

  function stateMsg(am: Active, i: number, extra: Record<string, unknown>): unknown {
    return {
      type: "match.state", match: am.id, seq: am.m.seq, view: am.core.viewFor(am.m, i),
      deadline: deadlineFor(am, i), waiting: waitingFor(am, i), ...extra,
    };
  }

  /** Después de cualquier cambio del estado: plazos, vista a cada jugador, fin de partida, timers. */
  function afterChange(am: Active, logBefore: number, actedSeat: number, ackN: number): void {
    if (am.ended) return;
    try {
      refreshDeadlines(am, actedSeat);
      const log = [...am.core.logSince(am.m, logBefore)] as string[];
      for (let i = 0; i < 2; i++) {
        const s = am.seats[i];
        if (!s.pid || !s.online) continue;
        sendPid(s.pid, stateMsg(am, i, i === actedSeat && ackN >= 0 ? { ack: ackN, log } : { log }));
      }
      if (am.m.b.phase === "over") return finish(am);
    } catch (e) {
      return voidMatch(am, e);
    }
    if (am.log.length - am.flushed >= 20) flushIntents(am);
    armTimer(am);
    scheduleNpc(am);
  }

  function flushIntents(am: Active): void {
    try {
      store.matchIntents(am.id, am.log.slice(am.flushed)); // solo las entradas nuevas (no se reescribe todo el log)
      am.flushed = am.log.length;
    } catch (e) {
      warn("matchIntents", e);
    }
  }

  function sendPeeks(am: Active, i: number): void {
    const infos = am.core.peek(am.m, i);
    if (!infos) return;
    for (const p of [...infos]) {
      sendPid(am.seats[i].pid, { type: "match.peek", match: am.id, card: p.card, step: p.step, mode: p.mode, count: p.count, cards: [...p.cards] });
    }
  }

  function release(am: Active): void {
    am.ended = true;
    if (am.timer) clearTimeout(am.timer);
    if (am.npcTimer) clearTimeout(am.npcTimer);
    am.timer = am.npcTimer = null;
    actives.delete(am);
    for (const s of am.seats) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.graceTimer = null;
      const p = s.pid ? peers.get(s.pid) : undefined;
      if (p && p.match === am) {
        p.match = null;
        if (!p.conn) peers.delete(p.id);
      }
    }
    scheduleLobby();
  }

  function deliverOver(am: Active, i: number, msg: unknown): void {
    const pid = am.seats[i].pid;
    if (!pid) return;
    const peer = peers.get(pid);
    const live = !!peer?.conn && peer.conn.ws.readyState === WebSocket.OPEN;
    finished.set(pid, { match: am.id, msg, sent: live });
    if (live) send(peer!.conn, msg);
  }

  /** Cierra una partida terminada en el motor: reward del NPC (lo decide el servidor), DB y match.over. */
  function finish(am: Active): void {
    if (am.ended) return;
    const w: number = am.m.b.winner;
    const reason = am.reason ?? "normal";
    let reward: { booster: string | null; cards: string[]; defeated: number } | null = null;
    if (am.kind === "npc" && w === 0 && am.npc && am.seats[0].pid) {
      try {
        const def = am.npc.def;
        let given: { booster: string; cards: string[] } | null = null;
        const r = store.npcWin(am.seats[0].pid, am.npc.id, (before) => {
          const rw = def.reward;
          if (!rw || !rw.booster || (rw.once && before > 0)) return null;
          given = engine.rewardBooster(String(rw.booster), serverRng());
          return given ? given.cards : null;
        });
        reward = { booster: given ? (given as { booster: string }).booster : null, cards: r.cards ?? [], defeated: r.defeated };
      } catch (e) {
        warn("premio NPC", e); // el jugador igual ve que ganó; el premio no se perdió ni se duplicó (transacción)
      }
    }
    try {
      store.matchEnd(am.id, w === 0 || w === 1 || w === 2 ? w : null, reason, reward, am.log.slice(am.flushed));
      am.flushed = am.log.length;
    } catch (e) {
      warn("matchEnd", e);
    }
    for (let i = 0; i < 2; i++) {
      deliverOver(am, i, {
        type: "match.over", match: am.id, winner: w === 2 ? "draw" : w === i ? "you" : "opp", reason,
        reward: i === 0 && am.kind === "npc" ? reward : null,
      });
    }
    release(am);
  }

  /** Una excepción del motor (bug): se anula la partida sin tumbar el servidor. */
  function voidMatch(am: Active, e: unknown): void {
    if (am.ended) return;
    warn(`motor, partida ${am.id} anulada`, e);
    abortMatch(am);
  }

  /** Anula la partida sin resultado (void): DB, aviso a los dos y liberación. */
  function abortMatch(am: Active): void {
    if (am.ended) return;
    log(`partida ${am.id} anulada (${am.kind}) jugadores=${am.seats.map((s) => s.pid ?? "npc").join(",")}`);
    try {
      store.matchEnd(am.id, null, "void", null, am.log.slice(am.flushed));
      am.flushed = am.log.length;
    } catch (e2) {
      warn("matchEnd", e2);
    }
    for (let i = 0; i < 2; i++) {
      deliverOver(am, i, { type: "match.over", match: am.id, winner: "draw", reason: "void", reward: null });
    }
    release(am);
  }

  function onIntent(conn: Conn, me: Peer, msg: any): void {
    const n = msg.n;
    const am = me.match;
    const fail = (error: string): void => send(conn, { type: "match.error", match: typeof msg.match === "string" ? msg.match : null, n: Number.isSafeInteger(n) ? n : null, error });
    if (!am || am.id !== msg.match) return fail("No estás en esa partida.");
    if (!Number.isSafeInteger(n) || n < 0) return fail("Número de intención inválido.");
    const i = seatOf(am, me.id);
    if (i === -1) return fail("No estás en esa partida.");
    const seat = am.seats[i];
    if (n <= seat.lastN) { // repetida (por ejemplo tras reconectar): no se vuelve a aplicar; se reenvía el estado
      send(conn, stateMsg(am, i, { ack: n, log: [] }));
      return;
    }
    seat.lastN = n;
    const before = am.m.b.logCount;
    let e: string | null;
    try {
      e = am.core.applyIntent(am.m, i, msg.intent);
    } catch (ex) {
      return voidMatch(am, ex);
    }
    if (e !== null) return fail(e);
    const it = isObj(msg.intent) ? msg.intent : {};
    // se guarda la copia limpia que arma el parser del motor (solo campos conocidos), no el JSON crudo del cliente
    const clean = am.core.mParse(msg.intent);
    pushLog(am, { pi: i, n, it: typeof clean === "string" ? null : JSON.parse(JSON.stringify(clean)) });
    seat.timeouts = 0;
    if (it.t === "surrender") am.reason = "surrender";
    afterChange(am, before, i, n);
    if (!am.ended && it.t === "peek") sendPeeks(am, i);
  }

  function onResume(conn: Conn, me: Peer, msg: any): void {
    const am = me.match;
    if (!am || am.id !== msg.match) {
      const f = finished.get(me.id);
      if (f && f.match === msg.match) return send(conn, f.msg);
      return send(conn, { type: "match.error", match: typeof msg.match === "string" ? msg.match : null, n: null, error: "Esa partida ya terminó o no existe." });
    }
    const i = seatOf(am, me.id);
    send(conn, stateMsg(am, i, { log: [] }));
    sendPeeks(am, i);
  }

  // --------------------------------------------------------------- presencia durante una partida
  function onSeatOffline(am: Active, i: number): void {
    const s = am.seats[i];
    if (!s.online || am.ended) return;
    s.online = false;
    s.graceUntil = Date.now() + cfg.graceMs;
    s.graceTimer = setTimeout(() => guard("gracia", () => {
      s.graceTimer = null;
      if (!am.ended && !s.online) forceEnd(am, i as 0 | 1, "abandon");
    }, am), cfg.graceMs);
    sendPid(am.seats[1 - i].pid, { type: "match.opp", status: "disconnected", graceUntil: sec(s.graceUntil) });
  }
  function onSeatBack(am: Active, i: number): void {
    const s = am.seats[i];
    if (s.online) return;
    s.online = true;
    if (s.graceTimer) clearTimeout(s.graceTimer);
    s.graceTimer = null;
    sendPid(am.seats[1 - i].pid, { type: "match.opp", status: "back", graceUntil: 0 });
  }

  // --------------------------------------------------------------- conexión
  function onAuth(conn: Conn, msg: any): void {
    if (typeof msg.token !== "string" || msg.token.length > 200) {
      logThrottled("auth", `auth fallida (token malformado) ip=${conn.ip}`);
      return kill(conn, 4401, "Token inválido.");
    }
    if (msg.v !== 1) return kill(conn, 4400, "Versión no soportada.");
    const p = store.playerByToken(msg.token);
    if (!p) {
      logThrottled("auth", `auth fallida (token desconocido) ip=${conn.ip}`);
      return kill(conn, 4401, "Token inválido.");
    }
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conn.authTimer = null;
    let peer = peers.get(p.id);
    if (!peer) {
      peer = { id: p.id, name: p.name, conn: null, match: null, queued: null };
      peers.set(p.id, peer);
    }
    peer.name = p.name;
    const old = peer.conn;
    peer.conn = conn;
    conn.pid = p.id;
    if (old && old !== conn) {
      old.replaced = true;
      kill(old, 4409, "Abriste el juego en otra pestaña.");
    }
    const am = peer.match;
    send(conn, {
      type: "hello", you: { id: p.id, name: p.name },
      match: am && !am.ended ? { id: am.id, seq: am.m.seq } : null,
    });
    if (am && !am.ended) {
      const i = seatOf(am, p.id);
      if (i >= 0) onSeatBack(am, i);
    } else {
      const f = finished.get(p.id);
      if (f && !f.sent) { f.sent = true; send(conn, f.msg); } // terminó mientras estaba desconectado
    }
    scheduleLobby();
  }

  function onClose(conn: Conn): void {
    conns.delete(conn);
    if (conn.authTimer) clearTimeout(conn.authTimer);
    if (!conn.pid) return;
    const peer = peers.get(conn.pid);
    if (!peer || peer.conn !== conn) return; // reemplazada por otra pestaña: el jugador sigue conectado
    peer.conn = null;
    cancelChallengesOf(peer.id, "Se desconectó.");
    leaveQueue(peer.id);
    if (peer.match) {
      const i = seatOf(peer.match, peer.id);
      if (i >= 0) onSeatOffline(peer.match, i);
    } else {
      peers.delete(peer.id);
    }
    scheduleLobby();
  }

  /** Todo lo que llega por un socket pasa por acá: una excepción (p. ej. la base bloqueada) cierra ESA conexión con 1011, nunca tumba el servidor. */
  function onMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    try {
      handleMessage(conn, data, isBinary);
    } catch (e) {
      warn(`mensaje (ip=${conn.ip}, jugador=${conn.pid ?? "-"})`, e);
      kill(conn, 1011, "Error interno.");
    }
  }

  function handleMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    conn.lastRx = now;
    conn.stamps.push(now);
    if (conn.stamps.length > cfg.msgsPerSec) {
      if (now - conn.stamps[0] < 1000) {
        logThrottled("rate", `cierre 4429 (demasiados mensajes) ip=${conn.ip} jugador=${conn.pid ?? "-"}`);
        return kill(conn, 4429, "Demasiados mensajes.");
      }
      conn.stamps.shift();
    }
    const buf = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (buf.length > MAX_BYTES) {
      logThrottled("big", `cierre 4429 (mensaje demasiado grande) ip=${conn.ip} jugador=${conn.pid ?? "-"}`);
      return kill(conn, 4429, "Mensaje demasiado grande.");
    }
    if (isBinary) return kill(conn, 4400, "Solo texto.");
    let msg: any;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return kill(conn, 4400, "JSON inválido.");
    }
    if (!isObj(msg) || typeof msg.type !== "string") return kill(conn, 4400, "Mensaje inválido.");
    if (!conn.pid) {
      if (msg.type !== "auth") return kill(conn, 4400, "Primero auth.");
      return onAuth(conn, msg);
    }
    const me = peers.get(conn.pid);
    if (!me || me.conn !== conn) return;
    try {
      switch (msg.type) {
        case "auth": return kill(conn, 4400, "Ya autenticado.");
        case "ping": return send(conn, { type: "pong" });
        case "pong": return;
        case "lobby.sub": conn.sub = true; return send(conn, lobbyFor(me.id));
        case "lobby.unsub": conn.sub = false; return;
        case "challenge.send": return onChallengeSend(conn, me, msg);
        case "challenge.accept": case "challenge.decline": case "challenge.cancel": return onChallengeReply(conn, me, msg.type, msg);
        case "queue.join": return onQueueJoin(conn, me, msg);
        case "queue.leave": leaveQueue(me.id); return queueState(conn, false);
        case "npc.start": return onNpcStart(conn, me, msg);
        case "match.intent": return onIntent(conn, me, msg);
        case "match.resume": return onResume(conn, me, msg);
        default: return kill(conn, 4400, "Tipo de mensaje desconocido.");
      }
    } catch (e) {
      warn(`mensaje ${msg.type} (ip=${conn.ip}, jugador=${conn.pid})`, e);
      err(conn, msg.type, "Error interno.");
      kill(conn, 1011, "Error interno.");
    }
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const conn: Conn = {
      ws, ip: deps.clientIp(req), pid: null, sub: false, stamps: [], lastRx: Date.now(), authTimer: null, replaced: false, strikes: 0,
    };
    conns.add(conn);
    conn.authTimer = setTimeout(() => { if (!conn.pid) kill(conn, 4408, "Falta auth."); }, cfg.authMs);
    ws.on("message", (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on("close", () => guard("close", () => onClose(conn)));
    ws.on("error", () => { /* el cierre se maneja en 'close' */ });
  });

  // Handshake: Host y Origin se validan ANTES del upgrade (evita el secuestro de WebSocket desde otra web).
  const reject = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  srv.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => { /* cliente cortó */ });
    const pathname = (req.url ?? "").split("?", 1)[0];
    if (pathname !== "/ws") return reject(socket, "404 Not Found");
    const ip = deps.clientIp(req);
    // el rechazo es HTTP 403 ANTES del upgrade (el navegador no ve un código 4403: solo falla la conexión)
    if (!access.hostOk(req.headers.host) || !access.originOk(req.headers.origin)) {
      logThrottled("up403", `upgrade rechazado 403 (Host/Origin) ip=${ip}`);
      return reject(socket, "403 Forbidden");
    }
    if (!connLimit.hit(ip)) {
      logThrottled("up429", `upgrade rechazado 429 ip=${ip}`);
      return reject(socket, "429 Too Many Requests");
    }
    if (wss.clients.size >= MAX_SOCKETS) {
      logThrottled("up503", `upgrade rechazado 503 (sockets al tope) ip=${ip}`);
      return reject(socket, "503 Service Unavailable");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Ping de aplicación (Cloudflare corta las conexiones ociosas) y limpieza de conexiones muertas.
  const pinger = setInterval(() => {
    const t = Date.now();
    for (const c of conns) {
      if (t - c.lastRx > cfg.pingMs * 3) { c.ws.terminate(); continue; }
      if (c.pid) send(c, { type: "ping" });
    }
    for (const [pid, arr] of starts) if (!arr.some((x) => x > t - 3_600_000)) starts.delete(pid);
  }, cfg.pingMs);
  pinger.unref();

  // Partidas que quedaron abiertas por un reinicio: se anulan sin resultado (el log de intents queda en la base).
  try {
    const n = store.voidOpenMatches();
    if (n) console.log(`[ws] ${n} partida(s) en curso anuladas por el reinicio.`);
  } catch (e) {
    warn("voidOpenMatches", e);
  }

  return {
    close(): void {
      clearInterval(pinger);
      if (lobbyTimer) clearTimeout(lobbyTimer);
      for (const am of [...actives]) {
        try { store.matchEnd(am.id, null, "void", null, am.log.slice(am.flushed)); } catch { /* base cerrada */ }
        release(am);
      }
      for (const c of challenges.values()) clearTimeout(c.timer);
      for (const c of conns) { try { c.ws.terminate(); } catch { /* nada */ } }
      wss.close();
    },
    dropPlayer(pid: string): void {
      guard("dropPlayer", () => {
        const peer = peers.get(pid);
        cancelChallengesOf(pid, "El jugador ya no existe.");
        leaveQueue(pid);
        starts.delete(pid);
        if (peer?.match && !peer.match.ended) abortMatch(peer.match);
        finished.delete(pid);
        if (peer) {
          const c = peer.conn;
          peers.delete(pid);
          if (c) {
            log(`jugador ${pid} borrado por el admin: cierre 4401 ip=${c.ip}`);
            kill(c, 4401, "Tu cuenta ya no existe.");
          }
        }
        scheduleLobby();
      });
    },
    renamePlayer(pid: string, name: string): void {
      const peer = peers.get(pid);
      if (peer) { peer.name = name; scheduleLobby(); }
    },
    stats: () => ({ sockets: conns.size, peers: peers.size, matches: actives.size, challenges: challenges.size, queue: queue.length }),
  };
}
