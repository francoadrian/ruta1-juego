// Tests del servidor que dependen de su configuración (ADR 0002, paso 6): cada grupo levanta SU PROPIO servidor Node
// con DB/datos temporales (nunca data/game.db) en puertos libres de 127.0.0.1.
//
//   node --test --no-warnings tests/server.config.test.ts      (o `npm run test:server`)
//
// Cubre: GAME_HOST por defecto en loopback, ALLOWED_HOSTS / ALLOWED_ORIGINS (incl. *.ts.net), límites por IP y
// TRUST_PROXY, tope de intentos fallidos de alta, MAX_PLAYERS, y la migración idempotente sobre una DB "vieja".

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

interface Srv {
  port: number;
  pid: number;
  env: NodeJS.ProcessEnv;
  stdout: () => string;
  invite(...args: string[]): string;
  cli(...args: string[]): { status: number | null; stdout: string; stderr: string };
  stop(): Promise<void>;
}

const tmps: string[] = [];

/** Levanta un servidor con `extra` en el entorno. Sin GAME_HOST salvo que `extra` lo ponga: se prueba el valor por defecto. */
async function startServer(extra: Record<string, string | undefined> = {}, opts: { seedDb?: (file: string) => void } = {}): Promise<Srv> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ruta1-config-"));
  tmps.push(tmp);
  const dataDir = path.join(tmp, "data");
  const assetsDir = path.join(tmp, "assets");
  mkdirSync(dataDir);
  mkdirSync(assetsDir);
  for (const f of ["catalog.json", "world.json"]) copyFileSync(path.join(ROOT, "data", f), path.join(dataDir, f));
  const db = path.join(tmp, "game.db");
  opts.seedDb?.(db);
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, GAME_PORT: String(port), ADMIN_HOST: "127.0.0.1", ADMIN_PORT: String(adminPort), GAME_DB: db, GAME_DATA_DIR: dataDir, GAME_ASSETS_DIR: assetsDir };
  for (const k of ["GAME_HOST", "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "TRUST_PROXY", "MAX_PLAYERS", "RATE_API_PER_MIN", "RATE_SIGNUP_PER_MIN", "SIGNUP_FAILS_PER_HOUR"]) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;

  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", "server/main.ts", ...args], { cwd: ROOT, env, encoding: "utf8" });
  const invite = (...args: string[]): string => {
    const r = cli("invite", "new", ...args);
    assert.equal(r.status, 0, r.stderr);
    const m = /Código de invitación: ([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(r.stdout);
    assert.ok(m, r.stdout);
    return m[1];
  };

  const child: ChildProcess = spawn(process.execPath, ["--no-warnings", "server/main.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { err += d; });
  const t0 = Date.now();
  for (;;) {
    if (/Juego en http/.test(out)) break;
    if (child.exitCode !== null) throw new Error(`el servidor murió: ${err}`);
    if (Date.now() - t0 > 20000) throw new Error(`el servidor no levantó: ${err}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port, pid: child.pid!, env, invite, cli,
    stdout: () => out + err,
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((res) => { child.once("exit", res); setTimeout(res, 3000); });
      }
    },
  };
}

after(() => {
  for (const t of tmps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* Windows puede tener el WAL abierto un rato */ } }
});

interface R { status: number; json: any; text: string }
function req(port: number, method: string, p: string, o: { headers?: Record<string, string>; body?: unknown; hostname?: string } = {}): Promise<R> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (payload !== undefined) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(Buffer.byteLength(payload)); }
    const r = http.request({ hostname: o.hostname ?? "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try { json = JSON.parse(text); } catch { /* no es JSON */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const signup = (s: Srv, invite: string, headers: Record<string, string> = {}, name = "Tomi") =>
  req(s.port, "POST", "/api/players", { headers, body: { invite, name } });

// ================================================================== GAME_HOST por defecto
describe("GAME_HOST por defecto: solo loopback", () => {
  let s: Srv;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  it("sin GAME_HOST el servidor escucha en 127.0.0.1 (y lo dice en el log)", async () => {
    assert.match(s.stdout(), /Juego en http:\/\/localhost:\d+\//);
    const r = await req(s.port, "GET", "/");
    assert.equal(r.status, 200);
  });

  it("no es alcanzable por las IPs de las interfaces de red (LAN) de esta PC", async () => {
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
    for (const ip of lan) {
      await assert.rejects(req(s.port, "GET", "/", { hostname: ip }), (e: any) => ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"].includes(e.code), `respondió en ${ip}`);
    }
  });

  it("con GAME_HOST=0.0.0.0 sí escucha en todas las interfaces y avisa que no filtra el Host", async () => {
    const t = await startServer({ GAME_HOST: "0.0.0.0" });
    try {
      assert.match(t.stdout(), /ALLOWED_HOSTS no está definido/);
      assert.equal((await req(t.port, "GET", "/", { headers: { Host: "cualquiera.lan" } })).status, 200);
    } finally { await t.stop(); }
  });

  it("el listener de admin sigue en loopback aparte (puerto distinto del juego)", async () => {
    const r = await req(Number(s.env.ADMIN_PORT), "GET", "/admin/v1/health");
    assert.equal(r.status, 401); // existe, pide Bearer
    assert.notEqual(Number(s.env.ADMIN_PORT), s.port);
    assert.equal((await req(s.port, "GET", "/admin/v1/health")).status, 404); // el puerto del juego no expone admin
  });
});

// ================================================================== Host y Origin
describe("ALLOWED_HOSTS / ALLOWED_ORIGINS", () => {
  describe("por defecto (loopback)", () => {
    let s: Srv;
    let code: string;
    before(async () => { s = await startServer({ RATE_API_PER_MIN: "100000", RATE_SIGNUP_PER_MIN: "100000" }); code = s.invite("--uses", "50"); });
    after(() => s.stop());

    it("acepta localhost, 127.0.0.1 y [::1] (con o sin puerto, sin importar mayúsculas)", async () => {
      for (const h of [`localhost:${s.port}`, `LOCALHOST:${s.port}`, `127.0.0.1:${s.port}`, "127.0.0.1", `[::1]:${s.port}`]) {
        assert.equal((await req(s.port, "GET", "/", { headers: { Host: h } })).status, 200, h);
      }
    });

    it("rechaza otros Host con 403 {error:'Host no permitido.'} en estáticos y API", async () => {
      for (const h of ["evil.com", `evil.com:${s.port}`, "127.0.0.1.evil.com", "10.0.0.5", "foo.ts.net", "localhost.evil.com"]) {
        for (const [m, p] of [["GET", "/"], ["GET", "/api/me"], ["POST", "/api/players"]]) {
          const r = await req(s.port, m, p, { headers: { Host: h }, body: m === "POST" ? { invite: code } : undefined });
          assert.equal(r.status, 403, `${m} ${p} Host=${h}`);
          assert.deepEqual(r.json, { error: "Host no permitido." });
        }
      }
    });

    it("un Host malo no consume la invitación", async () => {
      await req(s.port, "POST", "/api/players", { headers: { Host: "evil.com" }, body: { invite: code } });
      const r = s.cli("invite", "list");
      assert.match(r.stdout, /usos restantes: 50 /);
    });

    it("Origin: sin cabecera se acepta; con el propio (loopback) también; con otro sitio o 'null', 403", async () => {
      assert.equal((await signup(s, code)).status, 201);
      assert.equal((await signup(s, code, { Origin: `http://localhost:${s.port}` })).status, 201);
      assert.equal((await signup(s, code, { Origin: `http://127.0.0.1:${s.port}` })).status, 201);
      for (const o of ["http://evil.com", "https://evil.com", "null", "", "file://", "http://localhost.evil.com", "ftp://localhost"]) {
        const r = await signup(s, code, { Origin: o });
        assert.equal(r.status, 403, `Origin=${JSON.stringify(o)}`);
        assert.deepEqual(r.json, { error: "Origin no permitido." });
      }
      // el Origin ajeno también se rechaza en GET y PUT
      assert.equal((await req(s.port, "GET", "/api/me", { headers: { Origin: "http://evil.com" } })).status, 403);
      assert.equal((await req(s.port, "PUT", "/api/me/decks", { headers: { Origin: "http://evil.com" }, body: {} })).status, 403);
    });

    it("un Origin rechazado no crea jugadores ni gasta la invitación", async () => {
      const before = s.cli("invite", "list").stdout.match(/usos restantes: (\d+)/)![1];
      await signup(s, code, { Origin: "http://evil.com" });
      assert.equal(s.cli("invite", "list").stdout.match(/usos restantes: (\d+)/)![1], before);
    });
  });

  describe("con *.ts.net (túnel de Tailscale)", () => {
    let s: Srv;
    let code: string;
    before(async () => {
      s = await startServer({ ALLOWED_HOSTS: "localhost, *.ts.net", ALLOWED_ORIGINS: "https://*.ts.net,http://localhost:5173", RATE_SIGNUP_PER_MIN: "100000", RATE_API_PER_MIN: "100000" });
      code = s.invite("--uses", "50");
    });
    after(() => s.stop());

    it("acepta cualquier subdominio de ts.net (sin puerto, como lo manda `tailscale serve`) y localhost", async () => {
      for (const h of ["mi-pc.tail1234.ts.net", "MI-PC.tail1234.ts.net", "mi-pc.tail1234.ts.net:443", `localhost:${s.port}`]) {
        assert.equal((await req(s.port, "GET", "/", { headers: { Host: h } })).status, 200, h);
      }
    });

    it("no acepta el dominio pelado ni parecidos, ni 127.0.0.1 si no está en la lista", async () => {
      for (const h of ["ts.net", "xts.net", "ts.net.evil.com", "mi-pc.ts.net.evil.com", "evil.com", "127.0.0.1"]) {
        assert.equal((await req(s.port, "GET", "/", { headers: { Host: h } })).status, 403, h);
      }
    });

    it("Origin: https://*.ts.net vale; http://…ts.net (otro esquema) y otros sitios, no; el puerto del patrón se respeta", async () => {
      const h = { Host: "mi-pc.tail1234.ts.net" };
      assert.equal((await signup(s, code, { ...h, Origin: "https://mi-pc.tail1234.ts.net" })).status, 201);
      assert.equal((await signup(s, code, { ...h, Origin: "https://otra.tail9.ts.net" })).status, 201);
      assert.equal((await signup(s, code, { ...h, Origin: "http://mi-pc.tail1234.ts.net" })).status, 403);
      assert.equal((await signup(s, code, { ...h, Origin: "https://ts.net" })).status, 403);
      assert.equal((await signup(s, code, { ...h, Origin: "https://evil.com" })).status, 403);
      assert.equal((await signup(s, code, { ...h, Origin: "http://localhost:5173" })).status, 201);
      assert.equal((await signup(s, code, { ...h, Origin: "http://localhost:5174" })).status, 403);
      assert.equal((await signup(s, code, { ...h, Origin: `http://localhost:${s.port}` })).status, 403); // no está en ALLOWED_ORIGINS
    });
  });

  it("ALLOWED_HOSTS=* acepta cualquier Host", async () => {
    const s = await startServer({ ALLOWED_HOSTS: "*" });
    try {
      assert.equal((await req(s.port, "GET", "/", { headers: { Host: "lo-que-sea.com" } })).status, 200);
      assert.equal((await req(s.port, "GET", "/", { headers: { Host: "lo-que-sea.com", Origin: "https://otro.com" } })).status, 200);
    } finally { await s.stop(); }
  });
});

// ================================================================== límites
describe("límites de altas y de pedidos", () => {
  it("MAX_PLAYERS: al llegar al tope el alta da 503 y NO gasta la invitación", async () => {
    const s = await startServer({ MAX_PLAYERS: "2", RATE_SIGNUP_PER_MIN: "100000" });
    try {
      const code = s.invite("--uses", "5");
      assert.equal((await signup(s, code, {}, "A")).status, 201);
      assert.equal((await signup(s, code, {}, "B")).status, 201);
      const r = await signup(s, code, {}, "C");
      assert.equal(r.status, 503);
      assert.equal(typeof r.json.error, "string");
      assert.match(s.cli("invite", "list").stdout, /usos restantes: 3 /);
    } finally { await s.stop(); }
  });

  it("tope global de intentos fallidos: tras N fallos, 429 incluso con una invitación válida; los aciertos no cuentan", async () => {
    const s = await startServer({ SIGNUP_FAILS_PER_HOUR: "3", RATE_SIGNUP_PER_MIN: "100000" });
    try {
      const code = s.invite("--uses", "20");
      for (let i = 0; i < 2; i++) assert.equal((await signup(s, code)).status, 201); // aciertos: no cuentan
      for (let i = 0; i < 3; i++) assert.equal((await signup(s, "AAAA-BBBB")).status, 403);
      const blocked = await signup(s, code);
      assert.equal(blocked.status, 429);
      assert.deepEqual(blocked.json, { error: "Demasiados intentos. Probá en un rato." });
      assert.equal((await signup(s, "AAAA-BBBB")).status, 429);
      // el bloqueo es global (no depende de la IP) y no afecta a los jugadores ya creados
      assert.equal((await signup(s, code, { "X-Forwarded-For": "9.9.9.9" })).status, 429);
    } finally { await s.stop(); }
  });

  it("límite de altas por IP (RATE_SIGNUP_PER_MIN): los intentos de más dan 429 aunque sean válidos", async () => {
    const s = await startServer({ RATE_SIGNUP_PER_MIN: "2" });
    try {
      const code = s.invite("--uses", "20");
      assert.equal((await signup(s, code)).status, 201);
      assert.equal((await signup(s, code)).status, 201);
      assert.equal((await signup(s, code)).status, 429);
    } finally { await s.stop(); }
  });

  it("límite general de /api por IP (RATE_API_PER_MIN) pero no sobre los estáticos", async () => {
    const s = await startServer({ RATE_API_PER_MIN: "5" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await req(s.port, "GET", "/api/me")).status);
      assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
      assert.equal((await req(s.port, "GET", "/")).status, 200);
    } finally { await s.stop(); }
  });

  it("sin TRUST_PROXY, X-Forwarded-For se ignora (todos comparten la IP de loopback); con TRUST_PROXY=1 cada IP real tiene su cupo", async () => {
    const a = await startServer({ RATE_API_PER_MIN: "2" });
    try {
      const rs: number[] = [];
      for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) rs.push((await req(a.port, "GET", "/api/me", { headers: { "X-Forwarded-For": ip } })).status);
      assert.deepEqual(rs, [401, 401, 429]);
    } finally { await a.stop(); }

    const b = await startServer({ RATE_API_PER_MIN: "2", TRUST_PROXY: "1" });
    try {
      const rs: number[] = [];
      for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "1.1.1.1", "1.1.1.1"]) rs.push((await req(b.port, "GET", "/api/me", { headers: { "X-Forwarded-For": ip } })).status);
      assert.deepEqual(rs, [401, 401, 401, 401, 429]);
      // un cliente no puede esquivar el límite metiendo una IP falsa al principio de la cadena: cuenta la última (la del proxy)
      const spoof: number[] = [];
      for (const chain of ["6.6.6.6, 4.4.4.4", "7.7.7.7, 4.4.4.4", "8.8.8.8, 4.4.4.4"]) spoof.push((await req(b.port, "GET", "/api/me", { headers: { "X-Forwarded-For": chain } })).status);
      assert.deepEqual(spoof, [401, 401, 429]);
    } finally { await b.stop(); }
  });
});

// ================================================================== migración sobre una DB existente
describe("DB existente (esquema del hito 1): migración idempotente y colecciones conservadas", () => {
  const TOKEN = "token-de-un-jugador-viejo";
  const OLD_SCHEMA = `
    CREATE TABLE players (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created REAL NOT NULL, last_seen REAL NOT NULL, rev INTEGER NOT NULL DEFAULT 1, save TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE mail (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('cards', 'booster')), payload TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '', created REAL NOT NULL, claimed REAL, result TEXT);
    CREATE INDEX mail_by_player ON mail(player_id, claimed);
    CREATE TABLE admin_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '', created REAL NOT NULL, last_used REAL, revoked REAL);
  `;
  const seed = (file: string): void => {
    const db = new DatabaseSync(file);
    db.exec(OLD_SCHEMA);
    const hash = createHash("sha256").update(TOKEN, "utf8").digest("hex");
    const save = { collection: { charmander: 2 }, decks: { decks: [{ id: "d1", name: "Viejo", cards: [{ id: "charmander", qty: 1 }] }], mainId: "d1", nextId: 2 }, defeated: { "npc-a": 1 } };
    db.prepare("INSERT INTO players (id, token_hash, name, created, last_seen, rev, save) VALUES (?,?,?,?,?,?,?)")
      .run("J-VIEJO2", hash, "Viejo", 1, 1, 7, JSON.stringify(save));
    db.close();
  };

  it("arranca sobre la DB vieja, crea invites y matches, no toca los jugadores y se puede reiniciar", async () => {
    let s = await startServer({}, { seedDb: seed });
    try {
      const me = await req(s.port, "GET", "/api/me", { headers: { "X-Player-Token": TOKEN } });
      assert.equal(me.status, 200);
      assert.equal(me.json.rev, 7);
      assert.deepEqual(me.json.save.collection, { charmander: 2 }); // lo ganado se conserva tal cual
      assert.deepEqual(me.json.save.defeated, { "npc-a": 1 });
      // la colección inicial (Brushfire) se suma a lo ganado: se puede guardar un mazo con charmander
      const put = await req(s.port, "PUT", "/api/me/decks", {
        headers: { "X-Player-Token": TOKEN },
        body: { rev: 7, decks: { decks: [{ id: "d1", name: "Viejo", cards: [{ id: "charmander", qty: 2 }] }], mainId: "d1", nextId: 2 } },
      });
      assert.equal(put.status, 200, put.text);
      const again = await req(s.port, "GET", "/api/me", { headers: { "X-Player-Token": TOKEN } });
      assert.deepEqual(again.json.save.collection, { charmander: 2 }); // los mazos no tocan la colección
      assert.deepEqual(again.json.save.defeated, { "npc-a": 1 });
      assert.equal(again.json.rev, 8);
      await s.stop();

      // reinicio sobre la misma DB: nada se rompe
      const db = new DatabaseSync(s.env.GAME_DB!);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
      db.close();
      for (const t of ["players", "mail", "admin_tokens", "invites", "matches"]) assert.ok(tables.includes(t), `falta ${t}`);
      const port2 = await freePort();
      const r = spawnSync(process.execPath, ["--no-warnings", "server/main.ts", "invite", "list"], { cwd: ROOT, env: { ...s.env, GAME_PORT: String(port2) }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    } finally { await s.stop(); }
  });
});

// ================================================================== endurecimiento (auditoría de seguridad)
/** Memoria residente (MB) de un proceso. */
function rssMb(pid: number): number {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    const m = /"([\d.,\s ]+)\s*KB?"\s*$/m.exec(r.stdout);
    assert.ok(m, r.stdout);
    return Number(m[1].replace(/\D/g, "")) / 1024;
  }
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(r.stdout.trim()) / 1024;
}
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("M2: estáticos en streaming, topes de conexiones y límites", () => {
  it("80 sockets que piden /vendor/typescript.js (9 MB) y no leen: la memoria del servidor no crece proporcionalmente", { timeout: 60000 }, async () => {
    const s = await startServer();
    try {
      const warm = await req(s.port, "GET", "/vendor/typescript.js");
      assert.equal(warm.status, 200);
      assert.ok(warm.text.length > 5_000_000, "el archivo grande tiene que estar");
      await sleepMs(500);
      const before = rssMb(s.pid);
      const socks: net.Socket[] = [];
      for (let i = 0; i < 80; i++) {
        const sock = net.connect(s.port, "127.0.0.1");
        sock.on("error", () => { /* se destruye al final */ });
        sock.write(`GET /vendor/typescript.js HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
        sock.pause(); // no lee
        socks.push(sock);
      }
      await sleepMs(2500);
      const after = rssMb(s.pid);
      for (const k of socks) k.destroy();
      // con readFile serían ~80 x 9 MB = 720 MB; en streaming cada socket retiene unos cientos de KB
      assert.ok(after - before < 150, `la memoria creció ${(after - before).toFixed(0)} MB (de ${before.toFixed(0)} a ${after.toFixed(0)})`);
      assert.equal((await req(s.port, "GET", "/")).status, 200, "sigue sirviendo");
    } finally { await s.stop(); }
  });

  it("el archivo grande sale completo, con ETag y 304 (el streaming mantiene las cabeceras)", async () => {
    const s = await startServer();
    try {
      const a = await new Promise<http.IncomingMessage & { len: number }>((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port: s.port, path: "/vendor/typescript.js", agent: false }, (res) => {
          let len = 0;
          res.on("data", (c) => { len += c.length; });
          res.on("end", () => resolve(Object.assign(res, { len })));
        }).on("error", reject);
      });
      assert.equal(a.statusCode, 200);
      assert.equal(a.len, Number(a.headers["content-length"]));
      assert.match(String(a.headers["cache-control"]), /max-age/);
      const etag = String(a.headers.etag);
      assert.ok(etag);
      const b = await req(s.port, "GET", "/vendor/typescript.js", { headers: { "If-None-Match": etag } });
      assert.equal(b.status, 304);
      const h = await req(s.port, "HEAD", "/vendor/typescript.js");
      assert.equal(h.status, 200);
      assert.equal(h.text, "");
    } finally { await s.stop(); }
  });

  it("tope de conexiones simultáneas por IP de socket (MAX_CONNS_LOOPBACK): las de más se cierran y el servidor sigue", async () => {
    const s = await startServer({ MAX_CONNS_LOOPBACK: "5" });
    try {
      let closed = 0;
      const socks: net.Socket[] = [];
      for (let i = 0; i < 12; i++) {
        const sock = net.connect(s.port, "127.0.0.1");
        sock.on("error", () => { /* reset */ });
        sock.on("close", () => { closed++; });
        socks.push(sock);
      }
      await sleepMs(800);
      assert.ok(closed >= 7, `se cerraron ${closed} de 12`);
      for (const k of socks) k.destroy();
      await sleepMs(200);
      assert.equal((await req(s.port, "GET", "/")).status, 200);
      assert.match(s.stdout(), /conexión rechazada: demasiadas simultáneas/);
    } finally { await s.stop(); }
  });

  it("los estáticos y las rutas desconocidas también tienen límite por IP (RATE_STATIC_PER_MIN); un POST a una ruta desconocida no lee el cuerpo", async () => {
    const s = await startServer({ RATE_STATIC_PER_MIN: "6" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await req(s.port, "GET", "/")).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
      assert.match(s.stdout(), /429 límite de pedidos/);
    } finally { await s.stop(); }
    const t = await startServer();
    try {
      const r = await req(t.port, "POST", "/otra/cosa", { body: { x: "y".repeat(1000) } });
      assert.equal(r.status, 404);
    } finally { await t.stop(); }
  });
});

describe("M4: presupuesto de fallos de invitación por IP, con tope global como último recurso", () => {
  it("una IP que falla se bloquea sola; otra IP con un código válido entra", async () => {
    const s = await startServer({ TRUST_PROXY: "1", SIGNUP_FAILS_PER_HOUR: "3", RATE_SIGNUP_PER_MIN: "100000", RATE_API_PER_MIN: "100000" });
    try {
      const code = s.invite("--uses", "20");
      const atacante = { "X-Forwarded-For": "6.6.6.6" };
      for (let i = 0; i < 3; i++) assert.equal((await signup(s, "AAAA-BBBB", atacante)).status, 403);
      assert.equal((await signup(s, "AAAA-BBBB", atacante)).status, 429);
      assert.equal((await signup(s, code, atacante)).status, 429, "esa IP quedó bloqueada");
      assert.equal((await signup(s, code, { "X-Forwarded-For": "7.7.7.7" })).status, 201, "otra IP no se ve afectada");
    } finally { await s.stop(); }
  });

  it("tope global agotado: se loguea, los inválidos se frenan con 429, pero un código válido nunca se bloquea", { timeout: 30000 }, async () => {
    const s = await startServer({ TRUST_PROXY: "1", SIGNUP_FAILS_PER_HOUR: "100", SIGNUP_FAILS_GLOBAL_PER_HOUR: "4", RATE_SIGNUP_PER_MIN: "100000", RATE_API_PER_MIN: "100000" });
    try {
      const code = s.invite("--uses", "20");
      const seen: number[] = [];
      for (let i = 0; i < 6; i++) seen.push((await signup(s, "AAAA-BBBB", { "X-Forwarded-For": `10.0.0.${i}` })).status);
      assert.deepEqual(seen.slice(0, 3), [403, 403, 403]);
      assert.equal(seen[5], 429, "con el global agotado los inválidos reciben 429");
      assert.match(s.stdout(), /tope global de intentos de alta fallidos/);
      const ok = await signup(s, code, { "X-Forwarded-For": "11.0.0.1" });
      assert.equal(ok.status, 201, "un código válido pasa aunque el global esté agotado");
      assert.ok(!s.stdout().includes(code), "el log no debe tener códigos de invitación");
    } finally { await s.stop(); }
  });
});

describe("B3/B6/B9: Host estricto, cabeceras de seguridad y logs sin secretos", () => {
  it("Host con userinfo, puerto ajeno o caracteres raros: 403; el normal sigue andando", async () => {
    const s = await startServer();
    try {
      for (const h of [`localhost:${s.port}@evil.com`, `evil.com@localhost:${s.port}`, "localhost:1", `localhost:${s.port} evil.com`, `127.0.0.1:${s.port}/x`]) {
        assert.equal((await req(s.port, "GET", "/", { headers: { Host: h } })).status, 403, h);
      }
      assert.equal((await req(s.port, "GET", "/", { headers: { Host: `localhost:${s.port}` } })).status, 200);
      assert.match(s.stdout(), /403 Host no permitido/);
    } finally { await s.stop(); }
  });

  it("Origin: localhost solo con el puerto del juego (y bind en loopback)", async () => {
    const s = await startServer();
    try {
      const code = s.invite("--uses", "5");
      assert.equal((await signup(s, code, { Origin: `http://localhost:${s.port}` })).status, 201);
      assert.equal((await signup(s, code, { Origin: "http://localhost:5173" })).status, 403);
      assert.equal((await signup(s, code, { Origin: "http://localhost" })).status, 403);
    } finally { await s.stop(); }
  });

  it("cabeceras: X-Frame-Options, Referrer-Policy, nosniff y CSP en index.html", async () => {
    const s = await startServer();
    try {
      const get = (p: string) => new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        http.get({ hostname: "127.0.0.1", port: s.port, path: p, agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.headers)); }).on("error", reject);
      });
      for (const p of ["/", "/api/me", "/data/catalog.json", "/src/cards.ts"]) {
        const h = await get(p);
        assert.equal(h["x-frame-options"], "DENY", p);
        assert.equal(h["referrer-policy"], "no-referrer", p);
        assert.equal(h["x-content-type-options"], "nosniff", p);
      }
      const csp = String((await get("/"))["content-security-policy"]);
      for (const d of ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'", "connect-src 'self' ws: wss:", "default-src 'self'"]) {
        assert.ok(csp.includes(d), `CSP sin ${d}: ${csp}`);
      }
      assert.ok(!csp.includes("unsafe-eval"), "no hace falta 'unsafe-eval'");
    } finally { await s.stop(); }
  });

  it("DEBUG_HEADERS=1 imprime solo la cadena de IP; sin esa variable no imprime nada", async () => {
    const s = await startServer({ DEBUG_HEADERS: "1", TRUST_PROXY: "1" });
    try {
      await req(s.port, "GET", "/", { headers: { "X-Forwarded-For": "8.8.8.8, 9.9.9.9", Cookie: "secreto=1", "X-Player-Token": "TOKENSECRETO" } });
      const out = s.stdout();
      assert.match(out, /\[debug-ip\] socket=\S+ x-forwarded-for=\[8\.8\.8\.8, 9\.9\.9\.9\] usada=9\.9\.9\.9 trust_proxy=1/);
      assert.ok(!out.includes("secreto") && !out.includes("TOKENSECRETO"));
    } finally { await s.stop(); }
    const t = await startServer();
    try {
      await req(t.port, "GET", "/");
      assert.ok(!t.stdout().includes("debug-ip"));
    } finally { await t.stop(); }
  });

  it("el alta queda en el log con el id y la IP, sin el token ni el código", async () => {
    const s = await startServer();
    try {
      const code = s.invite();
      const r = await signup(s, code);
      assert.equal(r.status, 201);
      assert.match(s.stdout(), new RegExp(`alta jugador=${r.json.id} ip=`));
      assert.ok(!s.stdout().includes(r.json.token) && !s.stdout().includes(code));
      await signup(s, "AAAA-BBBB");
      assert.match(s.stdout(), /invitación inválida o agotada ip=/);
      assert.ok(!s.stdout().includes("AAAA-BBBB"));
    } finally { await s.stop(); }
  });
});
