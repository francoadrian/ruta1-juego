// Tests de caracterización (caja negra) del servidor del juego.
//
// Fijan el comportamiento ACTUAL del servidor Python (server.py + juego/*.py) para poder
// portarlo a Node (ADR 0002, paso 5) y comprobar que el contrato no cambió. Hablan solo por HTTP.
//
//   GAME_URL         juego público, p. ej. http://127.0.0.1:8123
//   GAME_ADMIN_URL   listener de admin, p. ej. http://127.0.0.1:8125
//   ADMIN_TOKEN      token de admin válido
//   REVOKED_ADMIN_TOKEN   (opcional) token que ya fue revocado; sin él se saltea ese test
//   ASSETS_QUOTA_MB       (opcional) tope de GAME_MAX_ASSETS_MB del servidor; sin él se saltea el 413 por cuota
//
// ATENCIÓN: estos tests ESCRIBEN (crean/borran jugadores, mandan buzón, suben imágenes y
// reescriben catalog.json/world.json con el mismo contenido). Correrlos solo contra un servidor
// de prueba con DB/datos temporales: usá tests/run-against-python.mjs.
//
// Los tests marcados `// CAMBIA en paso 6` describen comportamiento que el ADR 0002 modifica
// (invitaciones, PUT /api/me/save → 410, claim de sobres en el servidor); hay que adaptarlos entonces.
//
// Solo sintaxis "borrable" de TypeScript (node ejecuta el .ts quitando tipos).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Falta la variable de entorno ${n} (ver tests/run-against-python.mjs)`);
  return v;
};
const GAME = need("GAME_URL");
const ADMIN = need("GAME_ADMIN_URL");
const TOKEN = need("ADMIN_TOKEN");
const REVOKED = process.env.REVOKED_ADMIN_TOKEN || "";
const QUOTA_MB = Number(process.env.ASSETS_QUOTA_MB || 0);

// ---------------------------------------------------------------- HTTP crudo
interface Res { status: number; headers: http.IncomingHttpHeaders; buf: Buffer; text: string; json: any }
interface Opts {
  headers?: Record<string, string>;
  body?: unknown;            // objeto → JSON
  raw?: string | Buffer;     // cuerpo tal cual
  contentLength?: number;    // declara este largo y no manda cuerpo (para probar los topes)
}

function request(base: string, method: string, path: string, o: Opts = {}): Promise<Res> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(o.headers || {}) };
    let payload: string | Buffer | undefined;
    if (o.raw !== undefined) payload = o.raw;
    else if (o.body !== undefined) {
      payload = JSON.stringify(o.body);
      headers["Content-Type"] ??= "application/json";
    }
    if (o.contentLength !== undefined) headers["Content-Length"] = String(o.contentLength);
    else if (payload !== undefined) headers["Content-Length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: u.hostname, port: u.port, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json: any = undefined;
          try { json = JSON.parse(text); } catch { /* no es JSON */ }
          resolve({ status: res.statusCode || 0, headers: res.headers, buf, text, json });
        });
      },
    );
    r.on("error", reject);
    if (payload !== undefined && o.contentLength === undefined) r.write(payload);
    r.end();
  });
}

const game = (m: string, p: string, o?: Opts) => request(GAME, m, p, o);
const me = (token: string, m: string, p: string, o: Opts = {}) =>
  game(m, p, { ...o, headers: { "X-Player-Token": token, ...(o.headers || {}) } });
const adm = (m: string, p: string, o: Opts & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = o;
  const headers = { ...(rest.headers || {}) };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return request(ADMIN, m, p, { ...rest, headers });
};

// ---------------------------------------------------------------- utilidades
const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db40000000049454e44ae426082", "hex"),
]);
const dataUrl = (mime: string, buf: Buffer | string) =>
  `data:${mime};base64,${Buffer.isBuffer(buf) ? buf.toString("base64") : buf}`;
const uniq = () => Math.random().toString(36).slice(2, 8);

const createdPlayers: string[] = [];
async function newPlayer(save?: unknown) {
  const r = await game("POST", "/api/players", { body: save === undefined ? {} : { save } });
  assert.equal(r.status, 201, r.text);
  createdPlayers.push(r.json.id);
  return { id: r.json.id as string, token: r.json.token as string, player: r.json };
}

let catalog: any;       // data/catalog.json tal como lo sirve el juego
let catalogRev: string;
let CARD: string;       // un id de carta válido
let BOOSTER: any;       // un sobre con pool y slots

before(async () => {
  const h = await adm("GET", "/admin/v1/health");
  assert.equal(h.status, 200, `la API de admin no responde con ADMIN_TOKEN: ${h.text}`);
  const c = await adm("GET", "/admin/v1/catalog");
  assert.equal(c.status, 200);
  catalog = c.json.catalog;
  catalogRev = c.json.rev;
  CARD = catalog.cards[0].id;
  BOOSTER = catalog.boosters.find((b: any) => b.id === "baseSet") || catalog.boosters[0];
  assert.ok(CARD && BOOSTER, "el catálogo de prueba necesita cartas y al menos un sobre");
});

after(async () => {
  for (const id of createdPlayers) await adm("DELETE", `/admin/v1/players/${id}`).catch(() => {});
});

// ================================================================== estáticos
describe("estáticos: lista blanca PUBLIC", () => {
  it("sirve / e /index.html como HTML, con no-store y nosniff", async () => {
    for (const p of ["/", "/index.html", "/index.html?x=1"]) {
      const r = await game("GET", p);
      assert.equal(r.status, 200, p);
      assert.match(String(r.headers["content-type"]), /^text\/html/);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.match(r.text, /<canvas|<script/i);
    }
  });

  it("sirve src/*.ts del juego", async () => {
    for (const p of ["/src/art.ts", "/src/tcg.ts"]) {
      const r = await game("GET", p);
      assert.equal(r.status, 200, p);
      assert.ok(r.buf.length > 1000, p);
    }
  });

  it("sirve data/catalog.json y data/world.json desde el contenido del juego", async () => {
    const c = await game("GET", "/data/catalog.json");
    assert.equal(c.status, 200);
    assert.match(String(c.headers["content-type"]), /^application\/json/);
    assert.deepEqual(c.json, catalog);
    const w = await game("GET", "/data/world.json");
    assert.equal(w.status, 200);
    assert.ok(Array.isArray(w.json.maps) && w.json.maps.length > 0);
  });

  it("HEAD funciona en lo público y da 404 en la API y en lo prohibido", async () => {
    assert.equal((await game("HEAD", "/index.html")).status, 200);
    assert.equal((await game("HEAD", "/api/me")).status, 404);
    assert.equal((await game("HEAD", "/data/game.db")).status, 404);
  });

  it("no sirve nada fuera de la lista blanca", async () => {
    const prohibidos = [
      "/data/game.db", "/data/game.db-wal", "/data/catalog.backup.json", "/data/world.backup.json",
      "/data/", "/data", "/server.py", "/juego/store.py", "/juego/admin.py", "/CLAUDE.md",
      "/docs/adr/0002-pvp-autoritativo-websockets.md", "/tsconfig.json", "/.git/config", "/.gitignore",
      "/src/", "/src", "/src/nope.ts", "/src/art.js", "/src/sub/art.ts", "/tools/backup_db.py",
      "/assets", "/assets/", "/assets/cards/", "/assets/cards", "/assets/nope.png",
      "/assets/cards/x.svg", "/assets/cards/x.html", "/assets/cards/x.txt", "/assets/cards/x.PNG.exe",
      "/index.htm", "/INDEX.HTML.bak", "/api", "/api/", "/api/nope", "/admin/v1/health", "/admin/v1/catalog",
    ];
    for (const p of prohibidos) assert.equal((await game("GET", p)).status, 404, p);
  });

  it("rechaza path traversal y rutas disfrazadas", async () => {
    const trampas = [
      "/assets/../server.py", "/assets/cards/../../server.py", "/src/../server.py", "/src/../data/game.db",
      "/%2e%2e/server.py", "/assets/%2e%2e/%2e%2e/server.py", "/src/..%2fserver.py", "/assets/cards/..%2f..%2fserver.py",
      "/assets/cards/%2e%2e%2f%2e%2e%2fserver.py", "/src/%2E%2E/server.py",
      "/assets/..%5cserver.py", "/assets\\cards\\x.png", "/src/art.ts%00.png", "/assets/cards/x.png%00",
      "//server.py", "/assets//cards/x.png", "/src//art.ts", "/assets/C:/Windows/win.ini", "/assets/cards/C:evil.png",
      "/index.html/../server.py", "/data/catalog.json/../game.db", "/src/art.ts/..", "/%ff", "/assets/%c0%af..%c0%afserver.py",
    ];
    for (const p of trampas) {
      const r = await game("GET", p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
    }
  });
});

describe("estáticos: /assets solo sirve imágenes subidas", () => {
  it("una imagen subida por admin se sirve con su tipo, y un .svg/.html no", async () => {
    const up = await adm("POST", "/admin/v1/assets", { body: { kind: "card", name: `estatico-${uniq()}`, dataUrl: dataUrl("image/png", PNG) } });
    assert.equal(up.status, 201, up.text);
    const r = await game("GET", "/" + up.json.path);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/png");
    assert.deepEqual(r.buf, PNG);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    // mismo archivo con otra extensión: no existe → 404
    assert.equal((await game("GET", "/" + up.json.path.replace(/\.png$/, ".svg"))).status, 404);
  });
});

// ================================================================== API de jugador
describe("API de jugador: alta y consulta", () => {
  // CAMBIA en paso 6: el alta exigirá {invite, name} (403 sin invitación válida, 429, 503 por MAX_PLAYERS)
  // y la colección inicial la pondrá el servidor, ignorando `save`.
  it("POST /api/players crea un jugador (201) con id, token, rev 1 y buzón vacío", async () => {
    const r = await game("POST", "/api/players", { body: {} });
    assert.equal(r.status, 201);
    createdPlayers.push(r.json.id);
    assert.match(r.json.id, /^J-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(typeof r.json.token, "string");
    assert.ok(r.json.token.length >= 20);
    assert.equal(r.json.rev, 1);
    assert.match(r.json.name, /^Jugador \d+$/);
    assert.deepEqual(r.json.mail, []);
    assert.deepEqual(r.json.save, { collection: {} });
    assert.equal(typeof r.json.created, "number");
    assert.equal(typeof r.json.lastSeen, "number");
    assert.equal("token_hash" in r.json, false);
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
  });

  // CAMBIA en paso 6: `save` pasa a ignorarse (arranca con la colección inicial del servidor).
  it("POST /api/players acepta un save inicial y lo normaliza (descarta basura)", async () => {
    const { player } = await newPlayer({
      collection: { [CARD]: 3, malo: -1, cero: 0, texto: "5", flot: 1.5, enorme: 100000, ["x".repeat(80)]: 2 },
      decks: { decks: [], mainId: null },
      defeated: { "npc-a": 2, "npc-b": "x" },
      extra: "se descarta",
    });
    assert.equal(player.save.collection[CARD], 3);
    for (const k of ["malo", "cero", "texto", "flot", "enorme"]) assert.equal(k in player.save.collection, false, k);
    assert.equal(player.save.collection["x".repeat(64)], 2); // clave truncada a 64
    assert.deepEqual(player.save.decks, { decks: [], mainId: null });
    assert.deepEqual(player.save.defeated, { "npc-a": 2 });
    assert.equal("extra" in player.save, false);
  });

  // CAMBIA en paso 6: el alta ignora `name`; con invitación el nombre sí vendrá en el body.
  it("POST /api/players ignora `name` y un save que no es objeto", async () => {
    const r = await game("POST", "/api/players", { body: { name: "Tomi", save: "basura" } });
    assert.equal(r.status, 201);
    createdPlayers.push(r.json.id);
    assert.match(r.json.name, /^Jugador \d+$/);
    assert.deepEqual(r.json.save, { collection: {} });
  });

  it("POST con JSON inválido da 400 y un cuerpo declarado de más de 2 MB también", async () => {
    const a = await game("POST", "/api/players", { raw: "{no es json" });
    assert.equal(a.status, 400);
    assert.equal(typeof a.json.error, "string");
    const b = await game("POST", "/api/players", { contentLength: 2_000_001, headers: { "Content-Type": "application/json" } });
    assert.equal(b.status, 400);
    assert.match(b.json.error, /demasiado grande/i);
  });

  it("GET /api/me devuelve el jugador con save y buzón; sin token o con token malo, 401", async () => {
    const { id, token } = await newPlayer({ collection: { [CARD]: 1 } });
    const r = await me(token, "GET", "/api/me");
    assert.equal(r.status, 200);
    assert.equal(r.json.id, id);
    assert.equal(r.json.rev, 1);
    assert.deepEqual(r.json.save.collection, { [CARD]: 1 });
    assert.deepEqual(r.json.mail, []);
    assert.equal(JSON.stringify(r.json).includes("token_hash"), false);

    for (const h of [{}, { "X-Player-Token": "" }, { "X-Player-Token": "inventado" }, { "X-Player-Token": token + "x" }]) {
      const e = await game("GET", "/api/me", { headers: h });
      assert.equal(e.status, 401, JSON.stringify(h));
      assert.deepEqual(e.json, { error: "Jugador desconocido." });
    }
  });

  it("un token no sirve como credencial de admin", async () => {
    const { token } = await newPlayer();
    assert.equal((await adm("GET", "/admin/v1/health", { token })).status, 401);
  });

  it("GET /api/me/mail devuelve {mail, name} y exige token", async () => {
    const { token, player } = await newPlayer();
    const r = await me(token, "GET", "/api/me/mail");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { mail: [], name: player.name });
    assert.equal((await game("GET", "/api/me/mail")).status, 401);
  });

  it("rutas de API desconocidas dan 404 y la API ignora la query string", async () => {
    const { token } = await newPlayer();
    assert.equal((await me(token, "GET", "/api/me/otra")).status, 404);
    assert.equal((await game("POST", "/api/nada", { body: {} })).status, 404);
    assert.equal((await game("PUT", "/api/players", { body: {} })).status, 404);
    assert.equal((await me(token, "GET", "/api/me?x=1")).status, 200);
  });
});

describe("API de jugador: PUT /api/me/save con rev", () => {
  // CAMBIA en paso 6: PUT /api/me/save pasa a responder 410 {error:"Ahora el servidor guarda la colección; actualizá la página."}
  // (y se agrega PUT /api/me/decks con el mismo esquema de rev/409).
  it("guarda con la rev vigente, sube la rev y normaliza el save", async () => {
    const { token } = await newPlayer();
    const r = await me(token, "PUT", "/api/me/save", {
      body: { rev: 1, save: { collection: { [CARD]: 2, malo: 0 }, decks: { decks: [{ id: "d1" }] }, defeated: { a: 1 } } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { rev: 2 });
    const g = await me(token, "GET", "/api/me");
    assert.equal(g.json.rev, 2);
    assert.deepEqual(g.json.save, { collection: { [CARD]: 2 }, decks: { decks: [{ id: "d1" }] }, defeated: { a: 1 } });
  });

  // CAMBIA en paso 6 (pasa a 410)
  it("con una rev vieja responde 409 {error:'conflict', player} con el estado vigente", async () => {
    const { token, id } = await newPlayer({ collection: { [CARD]: 1 } });
    assert.equal((await me(token, "PUT", "/api/me/save", { body: { rev: 1, save: { collection: { [CARD]: 5 } } } })).status, 200);
    const r = await me(token, "PUT", "/api/me/save", { body: { rev: 1, save: { collection: { [CARD]: 9 } } } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "conflict");
    assert.equal(r.json.player.id, id);
    assert.equal(r.json.player.rev, 2);
    assert.deepEqual(r.json.player.save.collection, { [CARD]: 5 });
    assert.equal((await me(token, "GET", "/api/me")).json.save.collection[CARD], 5); // no se pisó
  });

  // CAMBIA en paso 6 (pasa a 410)
  it("sin rev (o con rev adelantada) responde 409; con rev no numérica, 400", async () => {
    const { token } = await newPlayer();
    assert.equal((await me(token, "PUT", "/api/me/save", { body: { save: {} } })).status, 409);
    assert.equal((await me(token, "PUT", "/api/me/save", { body: { rev: 99, save: {} } })).status, 409);
    assert.equal((await me(token, "PUT", "/api/me/save", { body: { rev: "abc", save: {} } })).status, 400);
    assert.equal((await me(token, "PUT", "/api/me/save", { raw: "{roto" })).status, 400);
  });

  // CAMBIA en paso 6 (pasa a 410 también sin token válido, o se mantiene 401 según el orden de chequeo)
  it("sin token responde 401 y otras rutas PUT dan 404", async () => {
    assert.equal((await game("PUT", "/api/me/save", { body: { rev: 1, save: {} } })).status, 401);
    const { token } = await newPlayer();
    assert.equal((await me(token, "PUT", "/api/me", { body: {} })).status, 404);
  });

  // CAMBIA en paso 6 (pasa a 410)
  it("dos guardados concurrentes con la misma rev: exactamente uno gana", async () => {
    const { token } = await newPlayer();
    const rs = await Promise.all(
      [1, 2, 3, 4].map((n) => me(token, "PUT", "/api/me/save", { body: { rev: 1, save: { collection: { [CARD]: n } } } })),
    );
    const codes = rs.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409, 409]);
  });
});

// ================================================================== buzón
describe("buzón: envíos de admin y claim", () => {
  it("un envío de cartas aparece en /api/me/mail y /api/me, y se cobra una sola vez", async () => {
    const { id, token } = await newPlayer({ collection: { [CARD]: 1 } });
    const s = await adm("POST", "/admin/v1/mail", {
      body: { to: [id], kind: "cards", cards: [CARD, CARD], message: "Regalo", sender: "Prof" },
    });
    assert.deepEqual(s.json, { sent: 1 });

    const list = await me(token, "GET", "/api/me/mail");
    assert.equal(list.json.mail.length, 1);
    const m = list.json.mail[0];
    assert.equal(m.kind, "cards");
    assert.equal(m.player, id);
    assert.equal(m.message, "Regalo");
    assert.equal(m.sender, "Prof");
    assert.deepEqual(m.payload, { cards: [CARD, CARD] });
    assert.equal(m.claimed, null);
    assert.equal(m.result, null);
    assert.equal((await me(token, "GET", "/api/me")).json.mail.length, 1);

    const c = await me(token, "POST", `/api/me/mail/${m.id}/claim`, { body: {} });
    assert.equal(c.status, 200);
    assert.equal(c.json.mail.id, m.id);
    assert.equal(typeof c.json.mail.claimed, "number");
    assert.deepEqual(c.json.mail.result, [CARD, CARD]);
    assert.equal(c.json.player.rev, 2);
    assert.equal(c.json.player.save.collection[CARD], 3);

    const again = await me(token, "POST", `/api/me/mail/${m.id}/claim`, { body: {} });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: "Ese envío ya se abrió o no existe." });
    assert.deepEqual((await me(token, "GET", "/api/me/mail")).json.mail, []);
    assert.equal((await me(token, "GET", "/api/me")).json.save.collection[CARD], 3); // no se sumó dos veces
  });

  it("el claim de un envío de cartas ignora el body del cliente", async () => {
    const { id, token } = await newPlayer();
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    const m = (await me(token, "GET", "/api/me/mail")).json.mail[0];
    const c = await me(token, "POST", `/api/me/mail/${m.id}/claim`, { body: { cards: ["otra", "otra2"] } });
    assert.equal(c.status, 200);
    assert.deepEqual(c.json.player.save.collection, { [CARD]: 1 });
  });

  it("claim: 401 sin token; 409 si el envío es de otro jugador o no existe; 404 si el id no es numérico", async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    await adm("POST", "/admin/v1/mail", { body: { to: [a.id], kind: "cards", cards: [CARD] } });
    const mid = (await me(a.token, "GET", "/api/me/mail")).json.mail[0].id;
    assert.equal((await game("POST", `/api/me/mail/${mid}/claim`, { body: {} })).status, 401);
    assert.equal((await me(b.token, "POST", `/api/me/mail/${mid}/claim`, { body: {} })).status, 409);
    assert.equal((await me(a.token, "POST", `/api/me/mail/999999999/claim`, { body: {} })).status, 409);
    assert.equal((await me(a.token, "POST", `/api/me/mail/abc/claim`, { body: {} })).status, 404);
    assert.equal((await me(a.token, "GET", "/api/me/mail")).json.mail.length, 1); // intacto
  });

  it("dos claims simultáneos del mismo envío: uno cobra y el otro recibe 409", async () => {
    const { id, token } = await newPlayer();
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    const mid = (await me(token, "GET", "/api/me/mail")).json.mail[0].id;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => me(token, "POST", `/api/me/mail/${mid}/claim`, { body: {} })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409, 409]);
    assert.deepEqual((await me(token, "GET", "/api/me")).json.save.collection, { [CARD]: 1 });
  });

  it("el claim sube la rev y un PUT /api/me/save con la rev anterior da 409 (no se pierde lo del buzón)", async () => {
    const { id, token } = await newPlayer();
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    const mid = (await me(token, "GET", "/api/me/mail")).json.mail[0].id;
    assert.equal((await me(token, "POST", `/api/me/mail/${mid}/claim`, { body: {} })).status, 200);
    const r = await me(token, "PUT", "/api/me/save", { body: { rev: 1, save: { collection: {} } } }); // CAMBIA en paso 6 (410)
    assert.equal(r.status, 409);
    assert.deepEqual(r.json.player.save.collection, { [CARD]: 1 });
  });

  describe("sobres (kind=booster)", () => {
    const size = () => (BOOSTER.slots || []).reduce((n: number, s: any) => n + (s.count || 0), 0) || 11;
    const sendBooster = async () => {
      const p = await newPlayer();
      const s = await adm("POST", "/admin/v1/mail", { body: { to: [p.id], kind: "booster", booster: BOOSTER.id } });
      assert.deepEqual(s.json, { sent: 1 });
      const m = (await me(p.token, "GET", "/api/me/mail")).json.mail[0];
      assert.equal(m.kind, "booster");
      assert.deepEqual(m.payload, { booster: BOOSTER.id });
      return { ...p, mid: m.id as number };
    };
    const claim = (p: { token: string; mid: number }, body: unknown) =>
      me(p.token, "POST", `/api/me/mail/${p.mid}/claim`, { body });

    // CAMBIA en paso 6: el servidor sortea el sobre; el body se ignora y la respuesta trae `cards`.
    it("con cartas del pool y cantidad válida, suma esas cartas a la colección", async () => {
      const p = await sendBooster();
      const pick = (BOOSTER.cards as string[]).slice(0, size());
      const c = await claim(p, { cards: pick });
      assert.equal(c.status, 200);
      assert.deepEqual(c.json.mail.result, pick);
      const total = Object.values(c.json.player.save.collection as Record<string, number>).reduce((a, b) => a + b, 0);
      assert.equal(total, pick.length);
    });

    // CAMBIA en paso 6 (el body deja de importar)
    it("sin `cards` (o no-lista) da 400 'Sobre desconocido.' y el envío sigue sin abrir", async () => {
      const p = await sendBooster();
      for (const body of [{}, { cards: "x" }, { cards: null }]) {
        const c = await claim(p, body);
        assert.equal(c.status, 400, JSON.stringify(body));
        assert.deepEqual(c.json, { error: "Sobre desconocido." });
      }
      assert.equal((await me(p.token, "GET", "/api/me/mail")).json.mail.length, 1);
    });

    // CAMBIA en paso 6 (el body deja de importar)
    it("con una carta fuera del pool o de más da 400 'Las cartas no corresponden a ese sobre.'", async () => {
      const p = await sendBooster();
      const fuera = await claim(p, { cards: ["carta-que-no-esta-en-el-sobre"] });
      assert.equal(fuera.status, 400);
      assert.deepEqual(fuera.json, { error: "Las cartas no corresponden a ese sobre." });
      const demas = await claim(p, { cards: Array(size() + 1).fill(BOOSTER.cards[0]) });
      assert.equal(demas.status, 400);
      assert.deepEqual(demas.json, { error: "Las cartas no corresponden a ese sobre." });
      assert.equal((await me(p.token, "GET", "/api/me/mail")).json.mail.length, 1);
    });
  });
});

// ================================================================== admin: autenticación
describe("admin: autenticación, Host y Origin", () => {
  it("GET /health con token válido: 200 {ok, api:1}, sin CORS y no-store", async () => {
    const r = await adm("GET", "/admin/v1/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, api: 1 });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(Object.keys(r.headers).some((h) => h.startsWith("access-control-")), false);
  });

  it("sin Authorization o con un esquema/token incorrecto: 401 {error:'No autorizado.'}", async () => {
    const casos: Array<string | null> = [null, "", "Bearer", "Bearer ", "Bearer inventado", `Basic ${TOKEN}`, `bearer ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`];
    for (const h of casos) {
      const r = await request(ADMIN, "GET", "/admin/v1/health", { headers: h === null ? {} : { Authorization: h } });
      assert.equal(r.status, 401, String(h));
      assert.deepEqual(r.json, { error: "No autorizado." }, String(h));
    }
  });

  it("un token revocado da 401", { skip: !REVOKED && "falta REVOKED_ADMIN_TOKEN" }, async () => {
    const r = await adm("GET", "/admin/v1/health", { token: REVOKED });
    assert.equal(r.status, 401);
  });

  it("la autenticación vale para todas las rutas (también las que escriben)", async () => {
    for (const [m, p] of [["GET", "/admin/v1/catalog"], ["PUT", "/admin/v1/world"], ["GET", "/admin/v1/players"],
      ["POST", "/admin/v1/mail"], ["POST", "/admin/v1/assets"], ["DELETE", "/admin/v1/mail/1"], ["GET", "/admin/v1/nada"]]) {
      const r = await adm(m, p, { token: null, body: {} });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  it("Host que no es loopback:puerto-real da 403 (aunque el token sea válido)", async () => {
    const port = new URL(ADMIN).port;
    for (const host of ["evil.com", `evil.com:${port}`, "127.0.0.1", "127.0.0.1:1", `10.0.0.5:${port}`, `127.0.0.1.evil.com:${port}`]) {
      const r = await adm("GET", "/admin/v1/health", { headers: { Host: host } });
      assert.equal(r.status, 403, `Host=${JSON.stringify(host)}`);
      assert.deepEqual(r.json, { error: "Host no permitido." });
    }
  });

  it("el Host se chequea antes que el token (Host malo sin token → 403)", async () => {
    const r = await adm("GET", "/admin/v1/health", { token: null, headers: { Host: "evil.com" } });
    assert.equal(r.status, 403);
  });

  it("acepta los Host loopback con el puerto real (localhost, 127.0.0.1, [::1], sin importar mayúsculas)", async () => {
    const port = new URL(ADMIN).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      const r = await adm("GET", "/admin/v1/health", { headers: { Host: host } });
      assert.equal(r.status, 200, host);
    }
  });

  it("cualquier cabecera Origin da 403, también con token válido", async () => {
    for (const origin of ["http://evil.com", "http://127.0.0.1:8124", "null", ""]) {
      const r = await adm("GET", "/admin/v1/health", { headers: { Origin: origin } });
      assert.equal(r.status, 403, `Origin=${JSON.stringify(origin)}`);
      assert.deepEqual(r.json, { error: "Origen no permitido." });
    }
    const w = await adm("PUT", "/admin/v1/catalog", { headers: { Origin: "http://evil.com" }, body: { catalog } });
    assert.equal(w.status, 403);
  });

  it("no hay preflight CORS: OPTIONS no está soportado", async () => {
    const r = await adm("OPTIONS", "/admin/v1/health", { headers: { Origin: "http://evil.com", "Access-Control-Request-Method": "GET" } });
    assert.ok(r.status >= 400, String(r.status));
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  });

  it("el listener público no expone /admin/v1", async () => {
    const r = await game("GET", "/admin/v1/health", { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 404);
  });

  it("rutas desconocidas: 404 'Ruta desconocida.'; método no permitido en catálogo/mundo: 405", async () => {
    for (const p of ["/admin/v1/nada", "/admin/v1/", "/admin/v1", "/admin/v1/players/a b", `/admin/v1/players/${"x".repeat(33)}`, "/admin/v1/mail/abc", "/otra/cosa", "/admin/v1/health/x"]) {
      const r = await adm("GET", p.replace(" ", "%20"));
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.json, { error: "Ruta desconocida." }, p);
    }
    for (const name of ["catalog", "world"]) {
      for (const m of ["POST", "DELETE", "PATCH"]) {
        const r = await adm(m, `/admin/v1/${name}`, { body: {} });
        assert.equal(r.status, 405, `${m} ${name}`);
        assert.deepEqual(r.json, { error: "Método no permitido." });
      }
    }
    assert.equal((await adm("POST", "/admin/v1/health", { body: {} })).status, 404);
  });
});

// ================================================================== admin: catálogo y mundo
for (const [name, key] of [["catalog", "catalog"], ["world", "world"]] as const) {
  describe(`admin: /admin/v1/${name}`, () => {
    let doc: any;
    let rev: string;
    before(async () => {
      const r = await adm("GET", `/admin/v1/${name}`);
      doc = r.json[key];
      rev = r.json.rev;
    });
    // Deja el archivo como estaba (mismo contenido) para no ensuciar el servidor de prueba.
    after(async () => {
      const cur = await adm("GET", `/admin/v1/${name}`);
      await adm("PUT", `/admin/v1/${name}`, { body: { rev: cur.json.rev, [key]: doc } });
    });
    const put = (body: unknown) => adm("PUT", `/admin/v1/${name}`, { body });

    it("GET devuelve {exists:true, rev (16 hex), <doc>} y coincide con lo que sirve el juego", async () => {
      const r = await adm("GET", `/admin/v1/${name}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.exists, true);
      assert.match(r.json.rev, /^[0-9a-f]{16}$/);
      assert.deepEqual(r.json[key], (await game("GET", `/data/${name}.json`)).json);
    });

    it("PUT con la rev vigente guarda, devuelve {ok, rev nueva} y el cambio se ve en el juego", async () => {
      const cur = (await adm("GET", `/admin/v1/${name}`)).json;
      const edited = structuredClone(cur[key]);
      edited.__marca = uniq();
      const r = await put({ rev: cur.rev, [key]: edited });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      assert.match(r.json.rev, /^[0-9a-f]{16}$/);
      assert.notEqual(r.json.rev, cur.rev);
      assert.equal((await adm("GET", `/admin/v1/${name}`)).json.rev, r.json.rev);
      assert.equal((await game("GET", `/data/${name}.json`)).json.__marca, edited.__marca);
    });

    it("PUT con una rev vieja o sin rev da 409 {error:'conflict', rev: vigente} y no pisa nada", async () => {
      const cur = (await adm("GET", `/admin/v1/${name}`)).json;
      const edited = structuredClone(cur[key]);
      edited.__pisado = true;
      for (const body of [{ rev: "0000000000000000", [key]: edited }, { rev: null, [key]: edited }, { [key]: edited }]) {
        const r = await put(body);
        assert.equal(r.status, 409, JSON.stringify(body).slice(0, 60));
        assert.deepEqual(r.json, { error: "conflict", rev: cur.rev });
      }
      assert.equal("__pisado" in (await adm("GET", `/admin/v1/${name}`)).json[key], false);
    });

    it("dos PUT con la misma rev: uno gana (200) y el otro recibe 409", async () => {
      const cur = (await adm("GET", `/admin/v1/${name}`)).json;
      const mk = (n: number) => { const d = structuredClone(cur[key]); d.__n = n; return put({ rev: cur.rev, [key]: d }); };
      const codes = (await Promise.all([mk(1), mk(2), mk(3)])).map((r) => r.status).sort();
      assert.deepEqual(codes, [200, 409, 409]);
    });

    it("PUT con cuerpo mal formado: 400 (rev no string, falta el documento, JSON roto, vacío, no-objeto)", async () => {
      const cur = (await adm("GET", `/admin/v1/${name}`)).json;
      const r1 = await put({ rev: 123, [key]: doc });
      assert.equal(r1.status, 400);
      assert.deepEqual(r1.json, { error: "rev inválido." });
      const r2 = await put({ rev: cur.rev });
      assert.equal(r2.status, 400);
      assert.deepEqual(r2.json, { error: `Falta '${key}' en el cuerpo.` });
      const r3 = await adm("PUT", `/admin/v1/${name}`, { raw: "{roto" });
      assert.deepEqual([r3.status, r3.json.error], [400, "JSON inválido."]);
      const r4 = await adm("PUT", `/admin/v1/${name}`, { contentLength: 0 });
      assert.deepEqual([r4.status, r4.json.error], [400, "Cuerpo vacío."]);
      const r5 = await adm("PUT", `/admin/v1/${name}`, { raw: "[1,2]" });
      assert.deepEqual([r5.status, r5.json.error], [400, "El cuerpo debe ser un objeto JSON."]);
      const r6 = await adm("PUT", `/admin/v1/${name}`, { contentLength: 8 * 1024 * 1024 + 1 });
      assert.equal(r6.status, 413);
      assert.deepEqual(r6.json, { error: "Pedido demasiado grande." });
    });
  });
}

describe("admin: validación del catálogo", () => {
  after(async () => {
    const cur = await adm("GET", "/admin/v1/catalog");
    await adm("PUT", "/admin/v1/catalog", { body: { rev: cur.json.rev, catalog } });
  });
  const intentar = async (nuevo: unknown) => {
    const cur = (await adm("GET", "/admin/v1/catalog")).json;
    return adm("PUT", "/admin/v1/catalog", { body: { rev: cur.rev, catalog: nuevo } });
  };
  it("rechaza (400) lo que no es un catálogo válido y deja el archivo como estaba", async () => {
    const antes = (await adm("GET", "/admin/v1/catalog")).json.rev;
    const malos: unknown[] = [
      null, 5, [], {}, { cards: "x" }, { cards: [1] }, { cards: [{}] }, { cards: [{ id: "" }] }, { cards: [{ id: 3 }] },
      { cards: [{ id: "a" }, { id: "a" }] }, { cards: [], boosters: "x" }, { cards: [], boosters: [1] },
    ];
    for (const m of malos) {
      const r = await intentar(m);
      assert.equal(r.status, 400, JSON.stringify(m));
      assert.equal(typeof r.json.error, "string");
    }
    assert.equal((await adm("GET", "/admin/v1/catalog")).json.rev, antes);
  });
  it("acepta un catálogo mínimo válido (cartas sin sobres)", async () => {
    const r = await intentar({ version: 1, cards: [{ id: "solo" }] });
    assert.equal(r.status, 200, r.text);
    // vuelve a quedar el original en after()
  });
});

describe("admin: validación del mundo", () => {
  let world: any;
  before(async () => { world = (await adm("GET", "/admin/v1/world")).json.world; });
  after(async () => {
    const cur = await adm("GET", "/admin/v1/world");
    await adm("PUT", "/admin/v1/world", { body: { rev: cur.json.rev, world } });
  });
  const intentar = async (nuevo: unknown) => {
    const cur = (await adm("GET", "/admin/v1/world")).json;
    return adm("PUT", "/admin/v1/world", { body: { rev: cur.rev, world: nuevo } });
  };
  it("rechaza (400) mundos inválidos", async () => {
    const m = (id: string, tiles: unknown) => ({ id, tiles });
    const malos: unknown[] = [
      null, [], {}, { maps: [] }, { maps: "x" }, { maps: [1] },
      { maps: [m("", ["..", ".."])] }, { maps: [m("a", ["..", ".."]), m("a", ["..", ".."])] },
      { maps: [m("a", [])] }, { maps: [m("a", "..")] }, { maps: [m("a", ["..", "."])] }, { maps: [m("a", [1, 2])] },
      { maps: [m("a", ["..", ".."])], npcs: "x" }, { maps: [m("a", ["..", ".."])], npcs: [1] },
      { maps: [m("a", ["..", ".."])], npcs: [{ id: "n" }, { id: "n" }] }, { maps: [m("a", ["..", ".."])], npcs: [{}] },
    ];
    for (const w of malos) {
      const r = await intentar(w);
      assert.equal(r.status, 400, JSON.stringify(w));
      assert.equal(typeof r.json.error, "string");
    }
  });
  it("acepta un mundo mínimo válido", async () => {
    const r = await intentar({ maps: [{ id: "a", tiles: ["..", ".."] }] });
    assert.equal(r.status, 200, r.text);
  });
});

// ================================================================== admin: jugadores
describe("admin: jugadores", () => {
  it("GET /players lista a todos con totales y sin el save", async () => {
    const { id } = await newPlayer({ collection: { [CARD]: 3, otra: 2 } });
    const r = await adm("GET", "/admin/v1/players");
    assert.equal(r.status, 200);
    const p = r.json.players.find((x: any) => x.id === id);
    assert.ok(p);
    assert.equal(p.cards, 5);
    assert.equal(p.distinct, 2);
    assert.equal(p.pending, 0);
    assert.equal(p.rev, 1);
    assert.equal("save" in p, false);
    assert.equal(JSON.stringify(r.json).includes("token"), false);
  });

  it("GET /players/<id> trae save y buzón (incluye lo ya cobrado); 404 si no existe", async () => {
    const { id, token } = await newPlayer({ collection: { [CARD]: 1 } });
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    const mid = (await me(token, "GET", "/api/me/mail")).json.mail[0].id;
    await me(token, "POST", `/api/me/mail/${mid}/claim`, { body: {} });

    const r = await adm("GET", `/admin/v1/players/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, id);
    assert.deepEqual(r.json.save.collection, { [CARD]: 2 });
    assert.equal(r.json.mail.length, 2);
    assert.equal(r.json.mail.filter((m: any) => m.claimed !== null).length, 1);
    assert.equal(JSON.stringify(r.json).includes("token_hash"), false);
    const list = (await adm("GET", "/admin/v1/players")).json.players.find((x: any) => x.id === id);
    assert.equal(list.pending, 1);

    const nf = await adm("GET", "/admin/v1/players/J-NOEXIS");
    assert.equal(nf.status, 404);
    assert.deepEqual(nf.json, { error: "No existe ese jugador." });
  });

  it("PATCH renombra (recorta espacios y a 24 caracteres) y no devuelve el save", async () => {
    const { id, token } = await newPlayer();
    const r = await adm("PATCH", `/admin/v1/players/${id}`, { body: { name: "  Fran  " } });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, "Fran");
    assert.equal(r.json.id, id);
    assert.equal("save" in r.json, false);
    assert.equal((await me(token, "GET", "/api/me")).json.name, "Fran");
    const largo = await adm("PATCH", `/admin/v1/players/${id}`, { body: { name: "x".repeat(40) } });
    assert.equal(largo.json.name, "x".repeat(24));
  });

  it("PATCH: nombre vacío o ausente → 400; jugador inexistente → 404; cuerpo no objeto → 400", async () => {
    const { id } = await newPlayer();
    for (const body of [{ name: "" }, { name: "   " }, {}]) {
      const r = await adm("PATCH", `/admin/v1/players/${id}`, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.json, { error: "El nombre no puede estar vacío." });
    }
    const nf = await adm("PATCH", "/admin/v1/players/J-NOEXIS", { body: { name: "A" } });
    assert.equal(nf.status, 404);
    assert.equal((await adm("PATCH", `/admin/v1/players/${id}`, { raw: "[]" })).status, 400);
    assert.equal((await adm("PATCH", `/admin/v1/players/${id}`, { contentLength: 0 })).status, 400);
  });

  it("DELETE borra al jugador, su token deja de servir y el buzón se va con él; luego 404", async () => {
    const { id, token } = await newPlayer();
    await adm("POST", "/admin/v1/mail", { body: { to: [id], kind: "cards", cards: [CARD] } });
    const r = await adm("DELETE", `/admin/v1/players/${id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await me(token, "GET", "/api/me")).status, 401);
    assert.equal((await adm("GET", `/admin/v1/players/${id}`)).status, 404);
    const again = await adm("DELETE", `/admin/v1/players/${id}`);
    assert.equal(again.status, 404);
    assert.deepEqual(again.json, { error: "No existe ese jugador." });
  });

  it("PUT/POST sobre /players/<id> da 405", async () => {
    const { id } = await newPlayer();
    for (const m of ["PUT", "POST"]) {
      const r = await adm(m, `/admin/v1/players/${id}`, { body: {} });
      assert.equal(r.status, 405, m);
    }
  });
});

// ================================================================== admin: buzón
describe("admin: POST /admin/v1/mail y DELETE /admin/v1/mail/<id>", () => {
  const mail = (body: unknown) => adm("POST", "/admin/v1/mail", { body });

  it("destinatarios inválidos → 400 'Elegí a quién mandarlo.'; ids inexistentes se saltean (sent 0)", async () => {
    for (const to of [undefined, null, "", "todos", [], [1], "J-X", {}]) {
      const r = await mail({ to, kind: "cards", cards: [CARD] });
      assert.equal(r.status, 400, JSON.stringify(to));
      assert.deepEqual(r.json, { error: "Elegí a quién mandarlo." });
    }
    const r = await mail({ to: ["J-NOEXIS", "J-NOEXI2"], kind: "cards", cards: [CARD] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { sent: 0 });
  });

  it("kind=cards: valida la lista y que las cartas estén en el catálogo", async () => {
    const { id } = await newPlayer();
    const e = (b: any) => mail({ to: [id], kind: "cards", ...b });
    for (const cards of [undefined, [], "x", [1], Array(201).fill(CARD)]) {
      const r = await e({ cards });
      assert.equal(r.status, 400, JSON.stringify(cards)?.slice(0, 30));
      assert.deepEqual(r.json, { error: "Elegí entre 1 y 200 cartas." });
    }
    const r = await e({ cards: [CARD, "no-existe-1", "no-existe-2"] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /^Cartas que no están en el catálogo: no-existe-1, no-existe-2\.$/);
    assert.equal((await e({ cards: Array(200).fill(CARD) })).json.sent, 1);
  });

  it("kind=booster: valida el sobre, acota count a 1..50 y manda un envío por sobre", async () => {
    const { id, token } = await newPlayer();
    const e = (b: any) => mail({ to: [id], kind: "booster", ...b });
    for (const booster of [undefined, "", 5]) {
      const r = await e({ booster });
      assert.deepEqual([r.status, r.json.error], [400, "Elegí un sobre."]);
    }
    const nf = await e({ booster: "no-existe" });
    assert.deepEqual([nf.status, nf.json.error], [400, "Ese sobre no está en el catálogo."]);
    const bad = await e({ booster: BOOSTER.id, count: "x" });
    assert.deepEqual([bad.status, bad.json.error], [400, "count inválido."]);
    assert.deepEqual((await e({ booster: BOOSTER.id })).json, { sent: 1 });
    assert.deepEqual((await e({ booster: BOOSTER.id, count: 3 })).json, { sent: 3 });
    assert.deepEqual((await e({ booster: BOOSTER.id, count: 0 })).json, { sent: 1 });
    assert.deepEqual((await e({ booster: BOOSTER.id, count: -7 })).json, { sent: 1 });
    assert.deepEqual((await e({ booster: BOOSTER.id, count: 999 })).json, { sent: 50 });
    assert.equal((await me(token, "GET", "/api/me/mail")).json.mail.length, 1 + 3 + 1 + 1 + 50);
  });

  it("tipo desconocido → 400; cuerpo inválido → 400; demasiado grande → 413", async () => {
    const { id } = await newPlayer();
    assert.deepEqual((await mail({ to: [id], kind: "otro" })).json, { error: "Tipo de envío desconocido." });
    assert.deepEqual((await mail({ to: [id] })).json, { error: "Tipo de envío desconocido." });
    assert.equal((await adm("POST", "/admin/v1/mail", { raw: "{roto" })).status, 400);
    assert.equal((await adm("POST", "/admin/v1/mail", { contentLength: 1024 * 1024 + 1 })).status, 413);
  });

  it("recorta message (200) y sender (40) y el remitente por defecto es 'Backoffice'", async () => {
    const { id, token } = await newPlayer();
    await mail({ to: [id], kind: "cards", cards: [CARD], message: "m".repeat(300), sender: "s".repeat(60) });
    await mail({ to: [id], kind: "cards", cards: [CARD] });
    const [b, a] = (await me(token, "GET", "/api/me/mail")).json.mail; // más nuevo primero
    assert.equal(a.message.length, 200);
    assert.equal(a.sender.length, 40);
    assert.equal(b.message, "");
    assert.equal(b.sender, "Backoffice");
  });

  it("`to: 'all'` llega a todos los jugadores existentes", async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const total = (await adm("GET", "/admin/v1/players")).json.players.length;
    const r = await mail({ to: "all", kind: "cards", cards: [CARD], message: `all-${uniq()}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.sent, total);
    for (const p of [a, b]) assert.equal((await me(p.token, "GET", "/api/me/mail")).json.mail.length, 1);
  });

  it("DELETE /mail/<id> cancela un envío pendiente; 404 si no existe; 409 si ya se cobró", async () => {
    const { id, token } = await newPlayer();
    await mail({ to: [id], kind: "cards", cards: [CARD] });
    await mail({ to: [id], kind: "cards", cards: [CARD] });
    const [m2, m1] = (await me(token, "GET", "/api/me/mail")).json.mail;

    const ok = await adm("DELETE", `/admin/v1/mail/${m1.id}`);
    assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
    const gone = await adm("DELETE", `/admin/v1/mail/${m1.id}`);
    assert.deepEqual([gone.status, gone.json], [404, { error: "No existe ese envío." }]);
    assert.equal((await me(token, "POST", `/api/me/mail/${m1.id}/claim`, { body: {} })).status, 409);

    assert.equal((await me(token, "POST", `/api/me/mail/${m2.id}/claim`, { body: {} })).status, 200);
    const cobrado = await adm("DELETE", `/admin/v1/mail/${m2.id}`);
    assert.deepEqual([cobrado.status, cobrado.json], [409, { error: "Ese envío ya se abrió." }]);
    assert.equal((await adm("DELETE", "/admin/v1/mail/999999999")).status, 404);
  });
});

// ================================================================== admin: assets
describe("admin: POST /admin/v1/assets", () => {
  const up = (b: unknown) => adm("POST", "/admin/v1/assets", { body: b });

  it("sube una imagen: 201 {path} con carpeta por tipo, slug y sha1; es idempotente y se sirve en el juego", async () => {
    const sha = (await import("node:crypto")).createHash("sha1").update(PNG).digest("hex").slice(0, 10);
    const base = `Mi Carta! ${uniq()}`;
    const slug = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    for (const [kind, dir] of [["card", "cards"], ["back", "backs"], ["pack", "packs"]]) {
      const r = await up({ kind, name: base, dataUrl: dataUrl("image/png", PNG) });
      assert.equal(r.status, 201, r.text);
      assert.deepEqual(r.json, { path: `assets/${dir}/${slug}-${sha}.png` });
      const f = await game("GET", "/" + r.json.path);
      assert.equal(f.status, 200);
      assert.deepEqual(f.buf, PNG);
    }
    const a = await up({ kind: "card", name: base, dataUrl: dataUrl("image/png", PNG) });
    const b = await up({ kind: "card", name: base, dataUrl: dataUrl("image/png", PNG) });
    assert.deepEqual(a.json, b.json);
  });

  it("sin nombre usa 'img'; con nombre vacío de símbolos también; el nombre se corta a 48", async () => {
    const sin = await up({ kind: "card", dataUrl: dataUrl("image/png", PNG) });
    assert.match(sin.json.path, /^assets\/cards\/img-[0-9a-f]{10}\.png$/);
    const simb = await up({ kind: "card", name: "!!!", dataUrl: dataUrl("image/png", PNG) });
    assert.match(simb.json.path, /^assets\/cards\/img-[0-9a-f]{10}\.png$/);
    const largo = await up({ kind: "card", name: "a".repeat(100), dataUrl: dataUrl("image/png", PNG) });
    assert.match(largo.json.path, /^assets\/cards\/a{48}-[0-9a-f]{10}\.png$/);
    const traversal = await up({ kind: "card", name: "../../server", dataUrl: dataUrl("image/png", PNG) });
    assert.match(traversal.json.path, /^assets\/cards\/[\w-]+-[0-9a-f]{10}\.png$/);
  });

  it("acepta jpeg, webp y gif por sus magic bytes", async () => {
    const casos: Array<[string, string, Buffer]> = [
      ["image/jpeg", "jpg", Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex")],
      ["image/gif", "gif", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
      ["image/webp", "webp", Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")])],
    ];
    for (const [mime, ext, raw] of casos) {
      const r = await up({ kind: "card", name: `fmt-${ext}`, dataUrl: dataUrl(mime, raw) });
      assert.equal(r.status, 201, `${mime}: ${r.text}`);
      assert.ok(r.json.path.endsWith("." + ext), r.json.path);
      assert.deepEqual((await game("GET", "/" + r.json.path)).buf, raw);
    }
  });

  it("errores 400: tipo desconocido, formato no soportado, base64 inválido, vacío, contenido que no coincide", async () => {
    const png = dataUrl("image/png", PNG);
    const casos: Array<[any, string]> = [
      [{ kind: "otro", dataUrl: png }, "Tipo de imagen desconocido."],
      [{ dataUrl: png }, "Tipo de imagen desconocido."],
      [{ kind: 5, dataUrl: png }, "Tipo de imagen desconocido."],
      [{ kind: "card" }, "Formato no soportado (usá PNG, JPG, WEBP o GIF)."],
      [{ kind: "card", dataUrl: 5 }, "Formato no soportado (usá PNG, JPG, WEBP o GIF)."],
      [{ kind: "card", dataUrl: "no es un data url" }, "Formato no soportado (usá PNG, JPG, WEBP o GIF)."],
      [{ kind: "card", dataUrl: dataUrl("image/svg+xml", Buffer.from("<svg/>")) }, "Formato no soportado (usá PNG, JPG, WEBP o GIF)."],
      [{ kind: "card", dataUrl: dataUrl("text/html", Buffer.from("<script>")) }, "Formato no soportado (usá PNG, JPG, WEBP o GIF)."],
      [{ kind: "card", dataUrl: dataUrl("image/png", "!!!no-base64!!!") }, "Imagen inválida."],
      [{ kind: "card", dataUrl: dataUrl("image/png", "") }, "Imagen vacía."],
      [{ kind: "card", dataUrl: dataUrl("image/jpeg", PNG) }, "El contenido no coincide con el formato declarado."],
      [{ kind: "card", dataUrl: dataUrl("image/png", Buffer.from("<svg onload=alert(1)>")) }, "El contenido no coincide con el formato declarado."],
    ];
    for (const [body, msg] of casos) {
      const r = await up(body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(r.json, { error: msg }, JSON.stringify(body).slice(0, 80));
    }
  });

  it("cuerpo demasiado grande → 413; JSON roto → 400", async () => {
    const big = await adm("POST", "/admin/v1/assets", { contentLength: Math.floor((15 * 1024 * 1024 * 4) / 3) + 64 * 1024 + 1 });
    assert.equal(big.status, 413);
    assert.equal((await adm("POST", "/admin/v1/assets", { raw: "{roto" })).status, 400);
  });

  it("al pasar el tope de espacio responde 413", { skip: !QUOTA_MB && "falta ASSETS_QUOTA_MB (GAME_MAX_ASSETS_MB del servidor)" }, async () => {
    const raw = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc((QUOTA_MB + 1) * 1024 * 1024)]);
    const r = await up({ kind: "card", name: "cuota", dataUrl: dataUrl("image/png", raw) });
    assert.equal(r.status, 413);
    assert.deepEqual(r.json, { error: "Se alcanzó el tope de espacio para imágenes." });
  });
});
