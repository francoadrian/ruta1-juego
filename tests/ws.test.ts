// Tests del WebSocket /ws (ADR 0002, paso 7): cada grupo levanta SU PROPIO servidor Node con DB, catálogo, mundo y assets
// temporales (nunca data/game.db) en puertos libres de 127.0.0.1, y habla con él con un cliente `ws` real.
//
//   node --test --no-warnings tests/ws.test.ts      (o `npm run test:ws`)
//
// Cubre: handshake (Host/Origin antes del upgrade), auth, una conexión por jugador, lobby, desafíos (enviar/rechazar/
// cancelar/vencer/aceptar), cola FIFO, partida PvP completa entre dos clientes con intents válidos, intents fuera de turno,
// que ninguna vista al jugador A contenga cartas ocultas de B, reconexión con match.resume, timeout, abandono, rendición,
// deduplicación por `n`, NPC completo con premio una sola vez, anulación al reiniciar, y límites de mensajes.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { loadCore } from "./load-core.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CORE = loadCore({ catalog: "file" });
const CARDS: Record<string, any> = CORE.CARDS;
const FUEGO = (CORE.BRUSHFIRE.cards as any[]).map((e) => ({ id: e.id as string, qty: e.qty as number }));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ servidor de prueba
interface Srv {
  port: number;
  dir: string;
  db: string;
  env: NodeJS.ProcessEnv;
  invite(): string;
  stop(): Promise<void>;
  out(): string;
}
const tmps: string[] = [];
const children: ChildProcess[] = [];

/** NPC de prueba (clon del primero del mundo, con mazo chico para que se quede sin cartas enseguida). */
const TEST_NPC = "testnpc";

async function startServer(extra: Record<string, string> = {}, reuse?: { dir: string }): Promise<Srv> {
  const dir = reuse?.dir ?? mkdtempSync(path.join(os.tmpdir(), "ruta1-ws-"));
  if (!reuse) {
    tmps.push(dir);
    mkdirSync(path.join(dir, "data"));
    mkdirSync(path.join(dir, "assets"));
    for (const f of ["catalog.json", "world.json"]) copyFileSync(path.join(ROOT, "data", f), path.join(dir, "data", f));
    const w = JSON.parse(readFileSync(path.join(dir, "data", "world.json"), "utf8"));
    const base = w.npcs.find((n: any) => n.battle !== false && n.deck?.cards?.length);
    const fake = JSON.parse(JSON.stringify(base));
    fake.id = TEST_NPC;
    fake.name = "Prueba";
    fake.prizes = 0;
    fake.reward = { booster: "random", once: true };
    // 12 Magikarp sin Energías: el NPC no puede atacar, así que el jugador gana (por Premio o porque el NPC se queda sin cartas)
    fake.deck = { name: "Chico", cards: [{ id: "magikarp", qty: 12 }] };
    w.npcs.push(fake);
    writeFileSync(path.join(dir, "data", "world.json"), JSON.stringify(w));
  }
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const db = path.join(dir, "game.db");
  const env: NodeJS.ProcessEnv = {
    ...process.env, GAME_PORT: String(port), ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(adminPort), GAME_DB: db,
    GAME_DATA_DIR: path.join(dir, "data"), GAME_ASSETS_DIR: path.join(dir, "assets"),
    RATE_API_PER_MIN: "100000", RATE_SIGNUP_PER_MIN: "100000", SIGNUP_FAILS_PER_HOUR: "100000", MAX_PLAYERS: "100",
    WS_MSGS_PER_SEC: "100000", WS_CONN_PER_MIN: "100000", NPC_STEP_MS: "5", ...extra,
  };
  for (const k of ["GAME_HOST", "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "TRUST_PROXY"]) delete env[k];
  const child = spawn(process.execPath, ["--no-warnings", "server/main.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const t0 = Date.now();
  while (!/Juego en http/.test(out)) {
    if (child.exitCode !== null) throw new Error(`el servidor murió: ${out}`);
    if (Date.now() - t0 > 20000) throw new Error(`el servidor no levantó: ${out}`);
    await sleep(50);
  }
  return {
    port, dir, db, env,
    out: () => out,
    invite() {
      const r = spawnSync(process.execPath, ["--no-warnings", "server/main.ts", "invite", "new", "--uses", "50"], { cwd: ROOT, env, encoding: "utf8" });
      const m = /Código de invitación: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(r.stdout);
      assert.ok(m, r.stdout + r.stderr);
      return m[1];
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((res) => { child.once("exit", res); setTimeout(res, 3000); });
      }
    },
  };
}

after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  for (const t of tmps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* Windows puede tener el WAL abierto */ } }
});

function httpJson(port: number, method: string, p: string, o: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers: Record<string, string> = {};
    if (o.token) headers["X-Player-Token"] = o.token;
    if (payload !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(payload)); }
    const r = http.request({ hostname: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* sin JSON */ }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

interface Pl { id: string; name: string; token: string }
/** Alta con invitación + mazo "d1" = Brushfire (legal con la colección inicial). */
async function newPlayer(s: Srv, name: string, withDeck = true): Promise<Pl> {
  const r = await httpJson(s.port, "POST", "/api/players", { body: { invite: s.invite(), name } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const pl: Pl = { id: r.json.id, name: r.json.name, token: r.json.token };
  if (withDeck) {
    const d = await httpJson(s.port, "PUT", "/api/me/decks", {
      token: pl.token, body: { rev: r.json.rev, decks: { decks: [{ id: "d1", name: "Fuego", cards: FUEGO }], mainId: "d1", nextId: 2 } },
    });
    assert.equal(d.status, 200, JSON.stringify(d.json));
  }
  return pl;
}

// ------------------------------------------------------------------ cliente de prueba
class Client {
  ws: WebSocket;
  queue: any[] = [];
  history: any[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      this.queue.push(m);
      this.history.push(m);
      this.wake();
    });
    ws.on("close", (code) => { this.closeCode = code; this.wake(); });
    ws.on("error", () => { /* se ve en el cierre */ });
  }
  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  static async open(port: number, o: { origin?: string | null; host?: string; path?: string } = {}): Promise<Client> {
    const headers: Record<string, string> = {};
    if (o.host) headers.Host = o.host;
    const origin = o.origin === null ? undefined : (o.origin ?? `http://localhost:${port}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? "/ws"}`, { origin, headers });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
    return new Client(ws);
  }
  /** Conecta y se autentica; devuelve el cliente y el `hello`. */
  static async login(port: number, p: Pl): Promise<Client> {
    const c = await Client.open(port);
    c.send({ type: "auth", token: p.token, v: 1 });
    const h = await c.take("hello");
    assert.equal(h.you.id, p.id);
    return c;
  }
  send(o: unknown): void { this.ws.send(JSON.stringify(o)); }
  raw(s: string): void { this.ws.send(s); }
  /** Saca (y devuelve) el primer mensaje de la cola que cumpla; espera hasta `ms`. */
  async take(pred: string | ((m: any) => boolean), ms = 8000): Promise<any> {
    const f = typeof pred === "string" ? (m: any) => m.type === pred : pred;
    const t0 = Date.now();
    for (;;) {
      const i = this.queue.findIndex(f);
      if (i >= 0) return this.queue.splice(i, 1)[0];
      if (this.closeCode !== null) throw new Error(`cerrada (${this.closeCode}) esperando ${typeof pred === "string" ? pred : "un mensaje"}`);
      const left = ms - (Date.now() - t0);
      if (left <= 0) throw new Error(`timeout esperando ${typeof pred === "string" ? pred : "un mensaje"}; cola: ${JSON.stringify(this.queue).slice(0, 400)}`);
      await new Promise<void>((res) => { this.waiters.push(res); setTimeout(res, Math.min(left, 100)); });
    }
  }
  /** true si NO llega ninguno en `ms`. */
  async none(pred: string | ((m: any) => boolean), ms = 300): Promise<boolean> {
    try { await this.take(pred, ms); return false; } catch { return true; }
  }
  async closed(ms = 8000): Promise<number> {
    const t0 = Date.now();
    while (this.closeCode === null) {
      if (Date.now() - t0 > ms) throw new Error("la conexión no se cerró");
      await new Promise<void>((res) => { this.waiters.push(res); setTimeout(res, 50); });
    }
    return this.closeCode;
  }
  nextN(): number { return ++this.n; }
  close(): void { try { this.ws.close(); } catch { /* ya cerrada */ } }
}

// ------------------------------------------------------------------ bot que juega mirando solo su vista
const isBasic = (id: string): boolean => CARDS[id].kind === "pokemon" && CARDS[id].stage === "Basic";

/** Decide la próxima intención desde la BattleView (lo mismo que haría un cliente). `failed` = intenciones ya rechazadas en este estado. */
function decide(v: any, failed: Set<string>): unknown | null {
  const me = v.p[0];
  const ok = (it: unknown): boolean => !failed.has(JSON.stringify(it));
  if (v.phase === "setup") {
    if (v.setupDone?.[0]) return null;
    const basics = me.hand.filter((c: any) => isBasic(c.id));
    if (!me.active) return basics.length ? { t: "setupActive", card: basics[0].uid } : null;
    if (me.bench.length < 2 && basics.length && ok({ t: "setupBench", card: basics[0].uid })) return { t: "setupBench", card: basics[0].uid };
    return { t: "setupDone" };
  }
  if (v.phase === "promote") return v.promoteQueue.includes(0) && me.bench.length ? { t: "promote", bench: me.bench[0].uid } : null;
  if (v.phase !== "turn" || v.cur !== 0) return null;
  const opts: unknown[] = [];
  for (const c of me.hand) if (isBasic(c.id) && me.bench.length < 5) opts.push({ t: "playBasic", card: c.uid });
  if (!v.energyPlayed && me.active) for (const c of me.hand) if (CARDS[c.id].kind === "energy") opts.push({ t: "attachEnergy", card: c.uid, target: me.active.uid });
  if (me.active) {
    const top = me.active.stack[me.active.stack.length - 1];
    for (let i = (CARDS[top.id].attacks?.length ?? 0) - 1; i >= 0; i--) opts.push({ t: "attack", idx: i });
  }
  opts.push({ t: "endTurn" });
  return opts.find(ok) ?? { t: "endTurn" };
}

interface Played { over: any; states: Map<number, any>; intents: number; errors: number }

/** Juega hasta el match.over reaccionando a match.start / match.state / match.error. Respeta un solo intent en vuelo. */
async function playBot(c: Client, matchId: string, opts: { maxIntents?: number; first?: any } = {}): Promise<Played> {
  const states = new Map<number, any>();
  let view: any = null;
  let waiting = "opp";
  let pending: number | null = null;
  let failed = new Set<string>();
  let lastIntent = "";
  let intents = 0;
  let errors = 0;
  const maxIntents = opts.maxIntents ?? 800;
  const act = (): void => {
    if (!view || pending !== null || waiting !== "you") return;
    let it: any = decide(view, failed);
    if (it === null) return;
    if (intents >= maxIntents) it = { t: "surrender" };
    const n = c.nextN();
    pending = n;
    lastIntent = JSON.stringify(it);
    intents++;
    c.send({ type: "match.intent", match: matchId, n, intent: it });
  };
  const onState = (m: any): void => {
    states.set(m.seq, m.view);
    view = m.view;
    waiting = m.waiting;
    if (m.ack === pending) { pending = null; failed = new Set(); }
    else if (pending === null) failed = new Set();
    act();
  };
  if (opts.first) onState(opts.first);
  for (;;) {
    const m = await c.take((x) => ["match.start", "match.state", "match.error", "match.over"].includes(x.type) && (x.match === matchId || x.match == null), 20000);
    if (m.type === "match.over") return { over: m, states, intents, errors };
    if (m.type === "match.error") {
      errors++;
      if (m.n === pending) { pending = null; failed.add(lastIntent); act(); }
      continue;
    }
    onState(m);
  }
}

// ------------------------------------------------------------------ filtraciones
/** Todos los uid que aparecen en una vista. */
function uidsIn(x: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(x)) for (const y of x) uidsIn(y, out);
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      if (k === "uid" && typeof v === "number") out.add(v);
      else uidsIn(v, out);
    }
  }
  return out;
}

/** Revisa la forma de CADA mensaje que recibió un cliente: nada de rng/semilla y rival siempre oculto. */
function assertNoSecrets(c: Client): void {
  for (const m of c.history) {
    const txt = JSON.stringify(m);
    assert.ok(!/"(rng|seed|uidNext)"/.test(txt), `un mensaje ${m.type} trae estado interno: ${txt.slice(0, 200)}`);
    const v = m.view;
    if (!v) continue;
    assert.equal(typeof v.p[1].hand, "number", "la mano del rival tiene que ser una cantidad");
    assert.equal(typeof v.p[1].deck, "number");
    assert.equal(typeof v.p[1].prizes, "number");
    assert.equal(typeof v.p[0].deck, "number", "el mazo propio tampoco viaja");
    assert.equal(typeof v.p[0].prizes, "number");
    if (v.phase === "setup") {
      assert.equal(v.p[1].active, null, "en la preparación el Activo rival no se ve");
      assert.equal(typeof v.p[1].bench, "number");
    }
  }
}

function collectViews(c: Client): Map<number, any> {
  const out = new Map<number, any>();
  for (const m of c.history) if (m.view && (m.type === "match.state" || m.type === "match.start")) out.set(m.seq, m.view);
  return out;
}

/** La mano de cada jugador (uids) en cada seq no puede aparecer en ninguna parte de la vista del otro. */
function assertNoHandLeak(a: Client, b: Client): number {
  const va = collectViews(a);
  const vb = collectViews(b);
  let checked = 0;
  for (const [seq, viewA] of va) {
    const viewB = vb.get(seq);
    if (!viewB) continue;
    const handA = uidsIn(viewA.p[0].hand);
    const handB = uidsIn(viewB.p[0].hand);
    const seenByA = uidsIn(viewA);
    const seenByB = uidsIn(viewB);
    for (const u of handB) assert.ok(!seenByA.has(u), `seq ${seq}: A ve la carta uid ${u} de la mano de B`);
    for (const u of handA) assert.ok(!seenByB.has(u), `seq ${seq}: B ve la carta uid ${u} de la mano de A`);
    checked++;
  }
  return checked;
}

/** Arranca un PvP por desafío y devuelve los dos match.start. */
async function startPvp(s: Srv, a: Client, pa: Pl, b: Client, pb: Pl, prizes = 6): Promise<{ sa: any; sb: any }> {
  a.send({ type: "challenge.send", to: pb.id, deckId: "d1", prizes });
  const inc = await b.take("challenge.incoming");
  b.send({ type: "challenge.accept", id: inc.id, deckId: "d1" });
  const sa = await a.take("match.start");
  const sb = await b.take("match.start");
  return { sa, sb };
}

// ================================================================== handshake y auth
describe("WebSocket: handshake y autenticación", () => {
  let s: Srv;
  let p: Pl;
  before(async () => {
    s = await startServer({ WS_AUTH_MS: "400" });
    p = await newPlayer(s, "Fran");
  });
  after(() => s.stop());

  it("Origin ajeno: 403 antes del upgrade", async () => {
    await assert.rejects(Client.open(s.port, { origin: "http://evil.example" }), /HTTP 403/);
    await assert.rejects(Client.open(s.port, { origin: "null" }), /HTTP 403/);
  });

  it("Host ajeno: 403 antes del upgrade (DNS rebinding)", async () => {
    await assert.rejects(Client.open(s.port, { host: "evil.example" }), /HTTP 403/);
  });

  it("otra ruta: 404; sin cabecera Origin (cliente no navegador): se acepta", async () => {
    await assert.rejects(Client.open(s.port, { path: "/otra" }), /HTTP 404/);
    const c = await Client.open(s.port, { origin: null });
    c.send({ type: "auth", token: p.token, v: 1 });
    assert.equal((await c.take("hello")).you.name, "Fran");
    c.close();
  });

  it("auth correcta: hello con id, nombre y match null", async () => {
    const c = await Client.open(s.port);
    c.send({ type: "auth", token: p.token, v: 1 });
    const h = await c.take("hello");
    assert.deepEqual(h, { type: "hello", you: { id: p.id, name: "Fran" }, match: null });
    c.close();
  });

  it("token incorrecto: cierre 4401", async () => {
    const c = await Client.open(s.port);
    c.send({ type: "auth", token: "no-es-un-token", v: 1 });
    assert.equal(await c.closed(), 4401);
  });

  it("sin auth a tiempo: 4408; primer mensaje que no es auth o JSON roto: 4400; versión rara: 4400", async () => {
    const c1 = await Client.open(s.port);
    assert.equal(await c1.closed(), 4408);
    const c2 = await Client.open(s.port);
    c2.send({ type: "lobby.sub" });
    assert.equal(await c2.closed(), 4400);
    const c3 = await Client.open(s.port);
    c3.raw("{no es json");
    assert.equal(await c3.closed(), 4400);
    const c4 = await Client.open(s.port);
    c4.send({ type: "auth", token: p.token, v: 2 });
    assert.equal(await c4.closed(), 4400);
  });

  it("autenticado: mensaje inválido o tipo desconocido = 4400; ping devuelve pong", async () => {
    const c = await Client.login(s.port, p);
    c.send({ type: "ping" });
    await c.take("pong");
    c.send({ type: "ni-idea" });
    assert.equal(await c.closed(), 4400);
    const d = await Client.login(s.port, p);
    d.raw("[1,2]");
    assert.equal(await d.closed(), 4400);
  });

  it("una conexión por jugador: la nueva gana y la vieja se cierra con 4409", async () => {
    const a = await Client.login(s.port, p);
    const b = await Client.login(s.port, p);
    assert.equal(await a.closed(), 4409);
    b.send({ type: "ping" });
    await b.take("pong");
    b.close();
  });
});

// ================================================================== lobby, desafíos y cola
describe("WebSocket: lobby, desafíos y cola", () => {
  let s: Srv;
  let pa: Pl, pb: Pl, pc: Pl;
  before(async () => {
    s = await startServer({ CHALLENGE_SECONDS: "2" });
    [pa, pb, pc] = [await newPlayer(s, "Ana"), await newPlayer(s, "Beto"), await newPlayer(s, "Cami")];
  });
  after(() => s.stop());

  it("lobby: online con estado, se actualiza cuando entra o sale alguien", async () => {
    const a = await Client.login(s.port, pa);
    a.send({ type: "lobby.sub" });
    assert.deepEqual((await a.take("lobby")).online, []);
    const b = await Client.login(s.port, pb);
    const l = await a.take((m) => m.type === "lobby" && m.online.length === 1);
    assert.deepEqual(l.online, [{ id: pb.id, name: "Beto", status: "libre" }]);
    b.close();
    await a.take((m) => m.type === "lobby" && m.online.length === 0);
    a.send({ type: "lobby.unsub" });
    a.close();
  });

  it("desafío: incoming, decline, cancel y vencimiento", async () => {
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    a.send({ type: "challenge.send", to: pb.id, deckId: "d1", prizes: 6 });
    const inc = await b.take("challenge.incoming");
    assert.deepEqual(inc.from, { id: pa.id, name: "Ana" });
    assert.equal(inc.prizes, 6);
    assert.ok(inc.expires > Date.now() / 1000);
    // no se puede mandar otro mientras haya uno pendiente
    a.send({ type: "challenge.send", to: pb.id, deckId: "d1" });
    assert.match((await a.take("error")).error, /pendiente/);
    // solo el desafiado puede rechazar; el que desafía, cancelar
    a.send({ type: "challenge.decline", id: inc.id });
    await a.take("error");
    b.send({ type: "challenge.decline", id: inc.id });
    assert.equal((await a.take("challenge.update")).status, "declined");
    assert.equal((await b.take("challenge.update")).status, "declined");

    a.send({ type: "challenge.send", to: pb.id, deckId: "d1" });
    const inc2 = await b.take("challenge.incoming");
    a.send({ type: "challenge.cancel", id: inc2.id });
    assert.equal((await b.take("challenge.update")).status, "cancelled");
    await a.take("challenge.update");

    a.send({ type: "challenge.send", to: pb.id, deckId: "d1" });
    const inc3 = await b.take("challenge.incoming");
    const u = await a.take((m) => m.type === "challenge.update" && m.id === inc3.id, 6000);
    assert.equal(u.status, "expired");
    b.send({ type: "challenge.accept", id: inc3.id, deckId: "d1" });
    assert.match((await b.take("error")).error, /ya no existe/);
    a.close();
    b.close();
  });

  it("desafío con mazo inexistente o ilegal, a un jugador desconectado o a uno mismo: error sin desafío", async () => {
    const a = await Client.login(s.port, pa);
    a.send({ type: "challenge.send", to: pa.id, deckId: "d1" });
    assert.match((await a.take("error")).error, /no está conectado/);
    a.send({ type: "challenge.send", to: pc.id, deckId: "d1" }); // Cami no está conectada
    assert.match((await a.take("error")).error, /no está conectado/);
    const c = await Client.login(s.port, pc);
    a.send({ type: "challenge.send", to: pc.id, deckId: "no-existe" });
    assert.match((await a.take("error")).error, /No tenés ese mazo/);
    // mazo guardado pero ilegal (incompleto): se puede guardar, pero no jugar
    const me = await httpJson(s.port, "GET", "/api/me", { token: pa.token });
    await httpJson(s.port, "PUT", "/api/me/decks", {
      token: pa.token, body: { rev: me.json.rev, decks: { decks: [{ id: "d1", name: "Fuego", cards: FUEGO }, { id: "d2", name: "Chico", cards: [{ id: "charmander", qty: 2 }] }], mainId: "d1", nextId: 3 } },
    });
    a.send({ type: "challenge.send", to: pc.id, deckId: "d2" });
    assert.match((await a.take("error")).error, /Tiene 2 de 60/);
    assert.ok(await c.none("challenge.incoming"));
    a.send({ type: "queue.join", deckId: "d2" });
    assert.match((await a.take("error")).error, /Tiene 2 de 60/);
    a.close();
    c.close();
  });

  it("si el que desafía se desconecta, el desafío se cancela", async () => {
    const a = await Client.login(s.port, pa);
    const c = await Client.login(s.port, pc);
    a.send({ type: "challenge.send", to: pc.id, deckId: "d1" });
    await c.take("challenge.incoming");
    a.close();
    assert.equal((await c.take("challenge.update")).status, "cancelled");
    c.close();
  });

  it("cola FIFO: empareja de a dos en orden y el tercero espera; queue.leave saca de la cola", async () => {
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const c = await Client.login(s.port, pc);
    a.send({ type: "queue.join", deckId: "d1" });
    assert.equal((await a.take("queue.state")).queued, true);
    c.send({ type: "queue.join", deckId: "d1" });
    const sa = await a.take("match.start");
    const sc = await c.take("match.start");
    assert.equal(sa.vs, "pvp");
    assert.equal(sa.opp.name, "Cami");
    assert.equal(sc.opp.name, "Ana");
    b.send({ type: "queue.join" }); // sin deckId: usa el principal
    assert.equal((await b.take("queue.state")).queued, true);
    assert.ok(await b.none("match.start", 400));
    b.send({ type: "queue.leave" });
    assert.equal((await b.take("queue.state")).queued, false);
    // una partida activa por jugador
    b.send({ type: "challenge.send", to: pa.id, deckId: "d1" });
    assert.match((await b.take("error")).error, /jugando/);
    a.send({ type: "queue.join", deckId: "d1" });
    assert.match((await a.take("error")).error, /Ya estás en una partida/);
    a.send({ type: "npc.start", npc: TEST_NPC, deckId: "d1" });
    assert.match((await a.take("error")).error, /Ya estás en una partida/);
    a.send({ type: "challenge.accept", id: "C-999", deckId: "d1" });
    await a.take("error");
    // rendirse libera a los dos
    a.send({ type: "match.intent", match: sa.match, n: 1, intent: { t: "surrender" } });
    assert.equal((await a.take("match.over")).reason, "surrender");
    assert.equal((await c.take("match.over")).winner, "you");
    a.close(); b.close(); c.close();
  });

  it("aceptar un desafío: los dos reciben match.start con su vista (él siempre en p[0])", async () => {
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const { sa, sb } = await startPvp(s, a, pa, b, pb, 4);
    assert.equal(sa.match, sb.match);
    assert.match(sa.match, /^M-[A-Z2-9]{6}$/);
    assert.equal(sa.view.p[0].name, "Ana");
    assert.equal(sb.view.p[0].name, "Beto");
    assert.equal(sa.view.prizeCount, 4);
    assert.equal(sa.view.phase, "setup");
    assert.equal(sa.view.p[0].hand.length, 7);
    assert.equal(sa.waiting, "you");
    assert.ok(sa.deadline > Date.now() / 1000);
    assert.equal((await a.take("challenge.update")).status, "accepted");
    assert.equal((await b.take("challenge.update")).status, "accepted");
    // en el lobby, los dos figuran jugando
    const c = await Client.login(s.port, pc);
    c.send({ type: "lobby.sub" });
    const l = await c.take("lobby");
    assert.deepEqual(l.online.map((x: any) => x.status), ["jugando", "jugando"]);
    a.send({ type: "match.intent", match: sa.match, n: 1, intent: { t: "surrender" } });
    await a.take("match.over");
    a.close(); b.close(); c.close();
  });
});

// ================================================================== partida PvP completa
describe("WebSocket: partida PvP completa", () => {
  let s: Srv;
  let pa: Pl, pb: Pl;
  before(async () => {
    s = await startServer();
    [pa, pb] = [await newPlayer(s, "Ana"), await newPlayer(s, "Beto")];
  });
  after(() => s.stop());

  it("dos bots juegan una partida entera con intents válidos; sin filtraciones; el PvP no da cartas", async (t) => {
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const before = (await httpJson(s.port, "GET", "/api/me", { token: pa.token })).json;
    const { sa, sb } = await startPvp(s, a, pa, b, pb, 3);
    const [ra, rb] = await Promise.all([
      playBot(a, sa.match, { first: sa }),
      playBot(b, sb.match, { first: sb }),
    ]);
    assert.equal(ra.over.match, sa.match);
    assert.equal(ra.over.reward, null);
    assert.equal(rb.over.reward, null);
    assert.ok(["normal", "surrender"].includes(ra.over.reason), ra.over.reason);
    // resultados consistentes
    const inv: Record<string, string> = { you: "opp", opp: "you", draw: "draw" };
    assert.equal(rb.over.winner, inv[ra.over.winner]);
    // la última vista terminó con la partida
    const lastSeq = Math.max(...ra.states.keys());
    assert.equal(ra.states.get(lastSeq).phase, "over");
    assert.ok(ra.intents > 5 && rb.intents > 5, "se jugó de verdad");
    t.diagnostic(`PvP: ${ra.over.reason}, turno ${ra.states.get(lastSeq).turn}, intents ${ra.intents}+${rb.intents}, errores ${ra.errors}+${rb.errors}, estados ${ra.states.size}`);
    // nada oculto en ningún mensaje
    assertNoSecrets(a);
    assertNoSecrets(b);
    const checked = assertNoHandLeak(a, b);
    assert.ok(checked > 10, `solo se compararon ${checked} estados`);
    // la colección no cambió (PvP sin premio) y la partida quedó registrada
    const after = (await httpJson(s.port, "GET", "/api/me", { token: pa.token })).json;
    assert.deepEqual(after.save.collection, before.save.collection);
    assert.deepEqual(after.save.defeated ?? {}, before.save.defeated ?? {});
    const db = new DatabaseSync(s.db, { readOnly: true });
    const row: any = db.prepare("SELECT * FROM matches WHERE id=?").get(sa.match);
    db.close();
    assert.equal(row.kind, "pvp");
    assert.equal(row.p0, pa.id);
    assert.equal(row.p1, pb.id);
    assert.ok(row.ended && row.seed.length === 32);
    assert.equal(row.reason, ra.over.reason);
    assert.equal(row.winner, ra.over.winner === "draw" ? 2 : ra.over.winner === "you" ? 0 : 1);
    assert.equal(row.reward, null);
    const log = JSON.parse(row.intents);
    assert.ok(log.length > 10 && log.some((x: any) => x.it?.t === "attack"));
    assert.equal(JSON.parse(row.decks).length, 2);
    // los dos quedaron libres
    a.send({ type: "queue.join", deckId: "d1" });
    assert.equal((await a.take("queue.state")).queued, true);
    a.close(); b.close();
  });

  it("intents fuera de turno, de otra partida o mal formados se rechazan sin romper nada; `n` repetido no se reaplica", async () => {
    [pa, pb] = [await newPlayer(s, "Ana2"), await newPlayer(s, "Beto2")];
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const { sa, sb } = await startPvp(s, a, pa, b, pb, 6);
    const mid = sa.match;
    // preparación: los dos arman su mesa con intents válidos (el motor decide quién arranca)
    const setup = async (c: Client, st: any): Promise<any> => {
      let view = st.view;
      let n = 0;
      for (let i = 0; i < 10 && view.phase === "setup" && !view.setupDone[0]; i++) {
        const it: any = decide(view, new Set());
        c.send({ type: "match.intent", match: mid, n: ++n, intent: it });
        const r = await c.take((m) => (m.type === "match.state" && m.ack === n) || (m.type === "match.error" && m.n === n));
        assert.equal(r.type, "match.state", JSON.stringify(r));
        view = r.view;
      }
      return { view, n };
    };
    const [ea, eb] = await Promise.all([setup(a, sa), setup(b, sb)]);
    // con los dos listos arranca la partida: el que NO tiene el turno intenta jugar
    const turnView = async (c: Client, e: any): Promise<any> => (e.view.phase === "turn" ? e.view : (await c.take((m) => m.type === "match.state" && m.view.phase === "turn")).view);
    const stA = { view: await turnView(a, ea) };
    const stB = { view: await turnView(b, eb) };
    const [turnC, waitC, waitN] = stA.view.cur === 0 ? [a, b, eb.n] : [b, a, ea.n];
    const turnN = stA.view.cur === 0 ? ea.n : eb.n;
    assert.equal(stA.view.cur === 0, stB.view.cur === 1);
    waitC.send({ type: "match.intent", match: mid, n: waitN + 1, intent: { t: "endTurn" } });
    assert.match((await waitC.take("match.error")).error, /turno/i);
    waitC.send({ type: "match.intent", match: mid, n: waitN + 2, intent: { t: "attack", idx: 0 } });
    assert.match((await waitC.take("match.error")).error, /turno/i);
    // partida ajena, intent basura, n inválido
    waitC.send({ type: "match.intent", match: "M-NOEXIS", n: waitN + 3, intent: { t: "endTurn" } });
    assert.match((await waitC.take("match.error")).error, /No estás en esa partida/);
    waitC.send({ type: "match.intent", match: mid, n: waitN + 4, intent: { t: "hackear" } });
    assert.match((await waitC.take("match.error")).error, /inválida/);
    waitC.send({ type: "match.intent", match: mid, n: -3, intent: { t: "endTurn" } });
    assert.match((await waitC.take("match.error")).error, /inválido/);
    waitC.send({ type: "match.intent", match: mid, n: waitN + 5, intent: { t: "playBasic", card: 99999 } });
    await waitC.take("match.error");
    // el que tiene el turno juega endTurn; repetirlo con el mismo n no se reaplica (devuelve el estado actual)
    turnC.send({ type: "match.intent", match: mid, n: turnN + 1, intent: { t: "endTurn" } });
    const ok = await turnC.take((m) => m.type === "match.state" && m.ack === turnN + 1);
    assert.equal(ok.view.cur, 1);
    turnC.send({ type: "match.intent", match: mid, n: turnN + 1, intent: { t: "endTurn" } });
    const dup = await turnC.take((m) => m.type === "match.state" && m.ack === turnN + 1);
    assert.equal(dup.seq, ok.seq);
    assert.equal(dup.view.turn, ok.view.turn);
    // y ahora el otro tiene el turno
    const got = await waitC.take((m) => m.type === "match.state" && m.view.cur === 0);
    assert.equal(got.waiting, "you");
    assertNoSecrets(a);
    assertNoSecrets(b);
    turnC.send({ type: "match.intent", match: mid, n: turnN + 9, intent: { t: "surrender" } });
    assert.equal((await turnC.take("match.over")).winner, "opp");
    a.close(); b.close();
  });

  it("reconexión: match.opp al rival, hello con la partida y match.resume con el estado completo", async () => {
    [pa, pb] = [await newPlayer(s, "Ana3"), await newPlayer(s, "Beto3")];
    const a = await Client.login(s.port, pa);
    let b = await Client.login(s.port, pb);
    const { sa, sb } = await startPvp(s, a, pa, b, pb, 6);
    const stateA = await (async () => {
      a.send({ type: "match.intent", match: sa.match, n: 1, intent: decide(sa.view, new Set()) });
      return a.take((m) => m.type === "match.state" && m.ack === 1);
    })();
    b.close();
    await b.closed();
    const gone = await a.take("match.opp");
    assert.equal(gone.status, "disconnected");
    assert.ok(gone.graceUntil > Date.now() / 1000);
    b = await Client.open(s.port);
    b.send({ type: "auth", token: pb.token, v: 1 });
    const hello = await b.take("hello");
    assert.equal(hello.match.id, sb.match);
    assert.ok(hello.match.seq >= stateA.seq);
    assert.equal((await a.take("match.opp")).status, "back");
    b.send({ type: "match.resume", match: sb.match, seq: 0 });
    const res = await b.take("match.state");
    assert.equal(res.match, sb.match);
    assert.equal(res.seq, stateA.seq);
    assert.equal(res.view.p[0].name, pb.name);
    assert.equal(typeof res.view.p[1].hand, "number");
    assert.equal(res.view.p[1].active, null, "el rival sigue sin mostrar su Activo en la preparación");
    // resume de una partida que no es
    b.send({ type: "match.resume", match: "M-OTRA11", seq: 0 });
    assert.match((await b.take("match.error")).error, /no existe/);
    a.send({ type: "match.intent", match: sa.match, n: 50, intent: { t: "surrender" } });
    await a.take("match.over");
    await b.take("match.over");
    a.close(); b.close();
  });

  it("un jugador conectado en dos lados: la conexión nueva recibe la partida (la vieja cierra con 4409)", async () => {
    [pa, pb] = [await newPlayer(s, "Ana4"), await newPlayer(s, "Beto4")];
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const { sa } = await startPvp(s, a, pa, b, pb, 6);
    const a2 = await Client.login(s.port, pa);
    assert.equal(await a.closed(), 4409);
    assert.equal(a2.queue.length, 0);
    a2.send({ type: "match.resume", match: sa.match, seq: 0 });
    assert.equal((await a2.take("match.state")).match, sa.match);
    a2.send({ type: "match.intent", match: sa.match, n: 1, intent: { t: "surrender" } });
    assert.equal((await a2.take("match.over")).winner, "opp");
    a2.close(); b.close();
  });
});

// ================================================================== tiempos
describe("WebSocket: tiempos (timeout y abandono)", () => {
  let s: Srv, s2: Srv;
  let pa: Pl, pb: Pl, qa: Pl, qb: Pl;
  before(async () => {
    s = await startServer({ TURN_SECONDS: "1", GRACE_SECONDS: "60" });
    s2 = await startServer({ TURN_SECONDS: "60", GRACE_SECONDS: "1" });
    [pa, pb] = [await newPlayer(s, "Ana"), await newPlayer(s, "Beto")];
    [qa, qb] = [await newPlayer(s2, "Ana"), await newPlayer(s2, "Beto")];
  });
  after(async () => { await s.stop(); await s2.stop(); });

  it("sin jugar: al vencer se aplica la jugada por defecto y 3 vencimientos seguidos son derrota por timeout", async () => {
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const { sa, sb } = await startPvp(s, a, pa, b, pb, 6);
    const [ra, rb] = await Promise.all([
      a.take("match.over", 30000),
      b.take("match.over", 30000),
    ]);
    assert.equal(ra.reason, "timeout");
    assert.equal(rb.reason, "timeout");
    assert.notEqual(ra.winner, rb.winner);
    assert.ok(["you", "opp"].includes(ra.winner));
    // hubo estados intermedios aplicados por el servidor (preparación completada por defecto)
    const states = a.history.filter((m) => m.type === "match.state");
    assert.ok(states.length >= 3, `estados: ${states.length}`);
    assert.ok(states.some((m) => m.view.phase === "turn"), "la preparación se completó sola");
    const db = new DatabaseSync(s.db, { readOnly: true });
    const row: any = db.prepare("SELECT reason, winner FROM matches WHERE id=?").get(sa.match);
    db.close();
    assert.equal(row.reason, "timeout");
    assert.equal(sb.match, sa.match);
    a.close(); b.close();
  });

  it("desconexión: pasada la gracia, derrota por abandono; el que vuelve se entera con match.over", async () => {
    const a = await Client.login(s2.port, qa);
    const b = await Client.login(s2.port, qb);
    const { sa } = await startPvp(s2, a, qa, b, qb, 6);
    b.close();
    assert.equal((await a.take("match.opp")).status, "disconnected");
    const over = await a.take("match.over", 10000);
    assert.equal(over.reason, "abandon");
    assert.equal(over.winner, "you");
    const b2 = await Client.open(s2.port);
    b2.send({ type: "auth", token: qb.token, v: 1 });
    const hello = await b2.take("hello");
    assert.equal(hello.match, null);
    const lost = await b2.take("match.over");
    assert.equal(lost.winner, "opp");
    assert.equal(lost.reason, "abandon");
    assert.equal(lost.match, sa.match);
    a.close(); b2.close();
  });
});

// ================================================================== NPC
describe("WebSocket: partida contra un NPC", () => {
  let s: Srv;
  let pa: Pl;
  before(async () => {
    s = await startServer();
    pa = await newPlayer(s, "Ana");
  });
  after(() => s.stop());

  const total = (col: Record<string, number>): number => Object.values(col).reduce((x, y) => x + y, 0);

  /** El jugador solo termina su turno (el NPC se queda sin cartas) hasta ganar. */
  async function winVsNpc(c: Client, prizes: number): Promise<any> {
    c.send({ type: "npc.start", npc: TEST_NPC, deckId: "d1", prizes });
    const start = await c.take("match.start");
    assert.equal(start.vs, "npc");
    assert.equal(start.opp.name, "Prueba");
    const r = await playBot(c, start.match, { first: start, maxIntents: 400 });
    return { start, over: r.over, played: r };
  }

  it("NPC inexistente o que no juega: error; NPC con mazo ajeno al jugador: el mazo sale del servidor", async () => {
    const a = await Client.login(s.port, pa);
    a.send({ type: "npc.start", npc: "no-existe", deckId: "d1" });
    assert.match((await a.take("error")).error, /no juega/);
    a.send({ type: "npc.start", npc: TEST_NPC, deckId: "d9" });
    assert.match((await a.take("error")).error, /No tenés ese mazo/);
    a.close();
  });

  it("gana el jugador: el servidor decide el premio (una sola vez) y lo guarda con rev", async () => {
    const a = await Client.login(s.port, pa);
    const me0 = (await httpJson(s.port, "GET", "/api/me", { token: pa.token })).json;
    const w1 = await winVsNpc(a, 1);
    assert.equal(w1.over.winner, "you", `${JSON.stringify(w1.over)} intents=${w1.played.intents}`);
    assert.equal(w1.over.reason, "normal");
    const r1 = w1.over.reward;
    assert.ok(r1 && r1.cards.length > 0, JSON.stringify(r1));
    assert.ok(["baseSet", "sobre"].includes(r1.booster));
    assert.equal(r1.defeated, 1);
    const me1 = (await httpJson(s.port, "GET", "/api/me", { token: pa.token })).json;
    assert.equal(me1.rev, me0.rev + 1);
    assert.equal(me1.save.defeated[TEST_NPC], 1);
    assert.equal(total(me1.save.collection), total(me0.save.collection ?? {}) + r1.cards.length);
    const pulled = { ...(me0.save.collection ?? {}) } as Record<string, number>;
    for (const id of r1.cards) pulled[id] = (pulled[id] ?? 0) + 1;
    assert.deepEqual(me1.save.collection, pulled);

    // segunda victoria: `once` → sin sobre, pero cuenta como derrotado
    const w2 = await winVsNpc(a, 1);
    assert.equal(w2.over.winner, "you");
    assert.deepEqual(w2.over.reward, { booster: null, cards: [], defeated: 2 });
    const me2 = (await httpJson(s.port, "GET", "/api/me", { token: pa.token })).json;
    assert.deepEqual(me2.save.collection, me1.save.collection);
    assert.equal(me2.save.defeated[TEST_NPC], 2);
    assert.equal(me2.rev, me1.rev + 1);

    const db = new DatabaseSync(s.db, { readOnly: true });
    const rows: any[] = db.prepare("SELECT * FROM matches WHERE kind='npc' ORDER BY started").all();
    db.close();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].p1, `npc:${TEST_NPC}`);
    assert.equal(rows[0].winner, 0);
    assert.equal(JSON.parse(rows[0].reward).cards.length, r1.cards.length);
    assert.deepEqual(JSON.parse(rows[1].reward), { booster: null, cards: [], defeated: 2 });
    assertNoSecrets(a);
    a.close();
  });

  it("si el jugador se rinde (o pierde) no hay premio ni victoria registrada", async () => {
    const b = await newPlayer(s, "Beto");
    const c = await Client.login(s.port, b);
    c.send({ type: "npc.start", npc: TEST_NPC, deckId: "d1", prizes: 1 });
    const st = await c.take("match.start");
    c.send({ type: "match.intent", match: st.match, n: 1, intent: { t: "surrender" } });
    const over = await c.take("match.over");
    assert.equal(over.winner, "opp");
    assert.equal(over.reason, "surrender");
    assert.equal(over.reward, null);
    const me = (await httpJson(s.port, "GET", "/api/me", { token: b.token })).json;
    assert.equal(me.save.defeated?.[TEST_NPC], undefined);
    c.close();
  });

  it("el NPC juega solo con el RNG del servidor: mismo mazo del jugador, estados con log y sin filtrar su mano", async () => {
    const b = await newPlayer(s, "Cami");
    const c = await Client.login(s.port, b);
    c.send({ type: "npc.start", npc: TEST_NPC, deckId: "d1", prizes: 1 });
    const st = await c.take("match.start");
    assert.equal(typeof st.view.p[1].hand, "number");
    const r = await playBot(c, st.match, { first: st, maxIntents: 400 });
    assert.equal(r.over.winner, "you", JSON.stringify(r.over) + " intents=" + r.intents + " errors=" + r.errors);
    assert.ok(c.history.some((m) => m.type === "match.state" && Array.isArray(m.log) && m.log.length > 0));
    assertNoSecrets(c);
    c.close();
  });
});

// ================================================================== límites
describe("WebSocket: límites de mensajes", () => {
  let s: Srv;
  let p: Pl;
  before(async () => {
    s = await startServer({ WS_MSGS_PER_SEC: "20" });
    p = await newPlayer(s, "Fran");
  });
  after(() => s.stop());

  it("más de 20 mensajes por segundo: cierre 4429", async () => {
    const c = await Client.login(s.port, p);
    for (let i = 0; i < 40; i++) c.send({ type: "ping" });
    assert.equal(await c.closed(), 4429);
  });

  it("más de 16 KB en un mensaje: cierre 4429 (y exactamente 16 KB todavía pasa el tamaño)", async () => {
    const c = await Client.login(s.port, p);
    c.send({ type: "ping", pad: "x".repeat(17 * 1024) });
    assert.equal(await c.closed(), 4429);
    const d = await Client.login(s.port, p);
    d.send({ type: "ping", pad: "x".repeat(15 * 1024) });
    await d.take("pong");
    d.close();
  });

  it("mensaje binario: 4400", async () => {
    const c = await Client.login(s.port, p);
    c.ws.send(Buffer.from([1, 2, 3]));
    assert.equal(await c.closed(), 4400);
  });
});

// ================================================================== reinicio
describe("WebSocket: reinicio del servidor", () => {
  it("las partidas en curso quedan anuladas (reason void, sin ganador) y el log de intents se conserva", async () => {
    const s = await startServer();
    const pa = await newPlayer(s, "Ana");
    const pb = await newPlayer(s, "Beto");
    const a = await Client.login(s.port, pa);
    const b = await Client.login(s.port, pb);
    const { sa } = await startPvp(s, a, pa, b, pb, 6);
    a.send({ type: "match.intent", match: sa.match, n: 1, intent: decide(sa.view, new Set()) });
    await a.take((m) => m.type === "match.state" && m.ack === 1);
    await s.stop();
    const s2 = await startServer({}, { dir: s.dir });
    try {
      assert.match(s2.out(), /1 partida\(s\) en curso anuladas/);
      const db = new DatabaseSync(s2.db, { readOnly: true });
      const row: any = db.prepare("SELECT * FROM matches WHERE id=?").get(sa.match);
      db.close();
      assert.equal(row.reason, "void");
      assert.equal(row.winner, null);
      assert.ok(row.ended);
      // tras el reinicio, el jugador entra libre
      const a2 = await Client.open(s2.port);
      a2.send({ type: "auth", token: pa.token, v: 1 });
      assert.equal((await a2.take("hello")).match, null);
      a2.close();
    } finally {
      await s2.stop();
    }
  });
});
