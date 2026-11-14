// Ruta 1 — servidor del juego en Node/TS (port 1:1 de server.py; ADR 0002, paso 5). Solo node:*, sin dependencias.
//
//   node server/main.ts            → http://localhost:8123/
//   node server/main.ts 8127       → mismo, en otro puerto (1er argumento numérico)
//
// Sirve el juego y la API de jugadores:
//   POST /api/players                  alta {invite, name} con código de invitación (devuelve id + token secreto)
//   GET  /api/me                       datos y partida guardada   (X-Player-Token)
//   PUT  /api/me/decks                 guarda los mazos {rev, decks} (validados contra la colección) → 409 si cambió
//   PUT  /api/me/save                  410: el servidor guarda la colección (ADR 0002)
//   GET  /api/me/mail                  envíos sin abrir del buzón
//   POST /api/me/mail/<id>/claim       abre un envío; el sobre lo sortea el servidor y responde {mail, player, cards}
//
// Autoridad (ADR 0002): el cliente ya no decide la colección ni las cartas de un sobre. En la base el save sigue
// siendo {collection, decks, defeated}; `collection` guarda SOLO lo ganado (`pulled`: sobres y envíos), igual que
// lo mandaba el cliente viejo, así que las colecciones existentes valen tal cual. Lo que tiene el jugador es
// ownedCounts(collection) = colección inicial (Brushfire + extras) + collection.
//
// El juego es el único dueño de los datos (data/game.db, catalog.json, world.json, assets/). El backoffice
// los administra por la API de admin /admin/v1 (server/admin.ts), en un listener aparte:
//   ADMIN_HOST:ADMIN_PORT   por defecto 127.0.0.1:8125  (Bearer token)
// Tokens de admin:  node server/main.ts admin-token new [etiqueta] [--write] | list | revoke <id>
// Invitaciones:     node server/main.ts invite new [--uses N] [--days N] [etiqueta] | list | revoke <código>
//
// WebSocket: GET /ws (ver server/ws.ts: TURN_SECONDS, GRACE_SECONDS, CHALLENGE_SECONDS, NPC_STEP_MS, WS_*).
//
// Configuración (variables de entorno, las mismas que server.py):
//   GAME_HOST / GAME_PORT   listener público (127.0.0.1:8123; 0.0.0.0 solo para LAN); el puerto también va como 1er argumento
//   ALLOWED_HOSTS           nombres de Host permitidos, separados por comas (por defecto loopback); admite *.ts.net y *
//   ALLOWED_ORIGINS         Origins permitidos (esquema://host[:puerto], admite https://*.ts.net); sin esto, vale
//                           cualquier http(s) cuyo host esté en ALLOWED_HOSTS. Sin cabecera Origin se acepta.
//   TRUST_PROXY=1           la IP del cliente sale de la última entrada de X-Forwarded-For (túnel/proxy de confianza)
//   MAX_PLAYERS             tope de jugadores (30)
//   RATE_API_PER_MIN        pedidos /api por IP y minuto (600) · RATE_SIGNUP_PER_MIN altas por IP y minuto (10)
//   SIGNUP_FAILS_PER_HOUR   intentos de alta fallidos globales por hora antes de bloquear (30)
//   ADMIN_HOST / ADMIN_PORT listener de admin (127.0.0.1:8125); ADMIN_ALLOW_NONLOOPBACK=1 para otro host
//   GAME_DB                 base SQLite (por defecto data/game.db)
//   GAME_DATA_DIR           carpeta de catalog.json / world.json (por defecto data/)
//   GAME_ASSETS_DIR         carpeta de imágenes subidas (por defecto assets/)
//   GAME_MAX_ASSETS_MB      tope de espacio de imágenes (500)
//   TCG_ADMIN_TOKEN_FILE    archivo donde `admin-token new --write` deja el token

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cli as adminCli, makeAdminServer } from "./admin.ts";
import { Content } from "./content.ts";
import { validateDecks } from "./decks.ts";
import { Engine } from "./engine.ts";
import { FailureBudget, RateLimiter, accessFromEnv } from "./security.ts";
import { Conflict, InviteError, MailGone, PlayersFull, Store } from "./store.ts";
import { attachWs } from "./ws.ts";
import { ValueError, isObj, parseJson, pyInt, readBytes } from "./util.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = process.env.GAME_DATA_DIR || path.join(ROOT, "data");
const ASSETS = process.env.GAME_ASSETS_DIR || path.join(ROOT, "assets");
const HOST = process.env.GAME_HOST ?? "127.0.0.1"; // el túnel (Tailscale) entra por loopback; 0.0.0.0 solo si se pide LAN
const argv = process.argv.slice(2);
const argPort = argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : undefined;
const PORT = Number.parseInt(argPort || process.env.GAME_PORT || process.env.PORT || "8123", 10);
const ADMIN_HOST = process.env.ADMIN_HOST ?? "127.0.0.1";
const ADMIN_PORT = Number.parseInt(process.env.ADMIN_PORT || "8125", 10);
const STORE = new Store(process.env.GAME_DB || path.join(DATA, "game.db"));
const CONTENT = new Content(DATA, ASSETS);
const ENGINE = new Engine(CONTENT);
const envInt = (name: string, dflt: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const MAX_PLAYERS = envInt("MAX_PLAYERS", 30);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const { access: ACCESS, lanWarning: LAN_WARNING } = accessFromEnv(process.env, HOST);
const API_LIMIT = new RateLimiter(envInt("RATE_API_PER_MIN", 600), 60_000);
const SIGNUP_LIMIT = new RateLimiter(envInt("RATE_SIGNUP_PER_MIN", 10), 60_000);
const SIGNUP_FAILS = new FailureBudget(envInt("SIGNUP_FAILS_PER_HOUR", 30), 3_600_000);
const TOO_MANY = "Demasiados intentos. Probá en un rato.";

/** IP del cliente. Con un túnel todo llega de loopback: solo se mira X-Forwarded-For si TRUST_PROXY=1. */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress ?? "?";
}

// Solo se publica lo que el juego necesita (nunca la base de datos).
const PUBLIC = /^\/(index\.html|src\/[\w.-]+\.ts|assets\/[\w.-]+(\/[\w.-]+)*\.(png|jpe?g|webp|gif)|data\/(catalog|world)\.json)$/i;
const MAX_BODY = 2_000_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Ruta pública ya decodificada y validada, o null. Rechaza ':', '\\', NUL, '..' y '//'. */
export function safePublicPath(raw: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(raw.split("?", 1)[0].split("#", 1)[0]);
  } catch {
    return null; // % mal formado o UTF-8 inválido
  }
  if (p === "/") p = "/index.html";
  if (/[:\\\0]/.test(p) || p.includes("..") || p.includes("//") || !p.startsWith("/")) return null;
  return PUBLIC.test(p) ? p : null;
}

// ------------------------------------------------------------------ respuestas
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function sendBytes(res: ServerResponse, ctype: string, body: Buffer, head: boolean): void {
  res.writeHead(200, { ...BASE_HEADERS, "Content-Type": ctype, "Content-Length": body.length });
  res.end(head ? undefined : body);
}

function notFound(res: ServerResponse, head = false): void {
  const body = Buffer.from("<!doctype html><title>404</title><h1>404 Not Found</h1>");
  res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
  res.end(head ? undefined : body);
}

/** Cuerpo JSON del pedido ({} si no hay). Lanza ValueError con el mensaje para el 400. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const hdr = req.headers["content-length"];
  const n = hdr === undefined ? 0 : pyInt(hdr);
  if (n === null) throw new ValueError("Content-Length inválido.");
  if (n <= 0) return {};
  if (n > MAX_BODY) throw new ValueError("Pedido demasiado grande.");
  try {
    return parseJson(await readBytes(req, n));
  } catch {
    throw new ValueError("JSON inválido.");
  }
}

const unauthorized = (res: ServerResponse): void => sendJson(res, 401, { error: "Jugador desconocido." });

// ------------------------------------------------------------------ estáticos
/** Archivo en disco para una ruta pública (null = no existe o fuera de la carpeta permitida). */
function filePathFor(p: string): string | null {
  if (p.startsWith("/assets/")) {
    // /assets/* sale de GAME_ASSETS_DIR (puede estar fuera de la raíz del repo)
    try {
      const base = realpathSync(ASSETS);
      const f = realpathSync(path.join(base, p.slice("/assets/".length)));
      return f !== base && f.startsWith(base + path.sep) ? f : null;
    } catch {
      return null;
    }
  }
  return path.join(ROOT, p.slice(1));
}

async function servePublic(res: ServerResponse, p: string, head: boolean): Promise<void> {
  const m = /^\/data\/(catalog|world)\.json$/.exec(p);
  if (m) { // salen de la caché del contenido (el juego es su dueño)
    const raw = (m[1] === "catalog" ? CONTENT.catalog : CONTENT.world).raw();
    if (raw === null) return notFound(res, head);
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json", "Content-Length": raw.length });
    return void res.end(head ? undefined : raw);
  }
  const f = filePathFor(p);
  let ok = false;
  try { ok = f !== null && statSync(f).isFile(); } catch { /* no existe */ }
  if (!ok || f === null) return notFound(res, head);
  const ctype = TYPES[path.extname(f).toLowerCase()];
  if (!ctype) return notFound(res, head);
  try {
    sendBytes(res, ctype, await readFile(f), head);
  } catch {
    notFound(res, head);
  }
}

// ------------------------------------------------------------------ rutas
const me = (req: IncomingMessage) => STORE.playerByToken(String(req.headers["x-player-token"] ?? ""));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "";
  const url = req.url ?? "/";
  const apiPath = url.split("?", 1)[0];

  // DNS rebinding / CSRF: Host y Origin tienen que estar permitidos (también para los estáticos).
  if (!ACCESS.hostOk(req.headers.host)) return sendJson(res, 403, { error: "Host no permitido." });
  if (!ACCESS.originOk(req.headers.origin)) return sendJson(res, 403, { error: "Origin no permitido." });
  if (apiPath.startsWith("/api/") && !API_LIMIT.hit(clientIp(req))) return sendJson(res, 429, { error: TOO_MANY });

  if (method === "HEAD") {
    const p = apiPath.startsWith("/api/") ? null : safePublicPath(url);
    if (p === null) return notFound(res, true);
    return servePublic(res, p, true);
  }

  if (method === "GET") {
    if (apiPath === "/api/me") {
      const p = me(req);
      if (!p) return unauthorized(res);
      p.mail = STORE.mailFor(p.id);
      return sendJson(res, 200, p);
    }
    if (apiPath === "/api/me/mail") {
      const p = me(req);
      if (!p) return unauthorized(res);
      return sendJson(res, 200, { mail: STORE.mailFor(p.id), name: p.name });
    }
    const p = safePublicPath(url);
    if (p === null) return notFound(res);
    return servePublic(res, p, false);
  }

  if (method === "POST") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      res.setHeader("Connection", "close"); // no se leyó el cuerpo (o estaba roto)
      return sendJson(res, 400, { error: (e as Error).message });
    }

    if (apiPath === "/api/players") {
      if (!SIGNUP_LIMIT.hit(clientIp(req)) || SIGNUP_FAILS.blocked()) return sendJson(res, 429, { error: TOO_MANY });
      if (!isObj(body)) return sendJson(res, 400, { error: "El cuerpo debe ser un objeto JSON." });
      if (body.name !== undefined && typeof body.name !== "string") return sendJson(res, 400, { error: "El nombre debe ser texto." });
      try {
        // `save` (y cualquier otro campo) se ignora: la colección inicial la pone el servidor
        const [player, token] = STORE.createPlayer(body.name, body.invite, MAX_PLAYERS);
        player.token = token;
        player.mail = [];
        return sendJson(res, 201, player);
      } catch (e) {
        if (e instanceof InviteError) {
          SIGNUP_FAILS.fail();
          return sendJson(res, 403, { error: "Código de invitación inválido o usado." });
        }
        if (e instanceof PlayersFull) return sendJson(res, 503, { error: "El servidor está lleno." });
        throw e;
      }
    }

    const m = /^\/api\/me\/mail\/(\d+)\/claim$/.exec(apiPath);
    if (m) {
      const p = me(req);
      if (!p) return unauthorized(res);
      const mid = Number(m[1]);
      const item = STORE.mailFor(p.id).find((x) => x.id === mid);
      if (!item) return sendJson(res, 409, { error: "Ese envío ya se abrió o no existe." });
      let cards: string[];
      if (item.kind === "cards") {
        cards = (Array.isArray(item.payload.cards) ? item.payload.cards : []).filter((c: unknown) => typeof c === "string");
      } else {
        // el sobre lo sortea el servidor con su RNG; el cuerpo del cliente se ignora
        const drawn = ENGINE.openBooster(String(item.payload.booster ?? ""));
        if (drawn === null) return sendJson(res, 400, { error: "Sobre desconocido." });
        if (drawn.length === 0) return sendJson(res, 400, { error: "Ese sobre no tiene cartas." });
        cards = drawn;
      }
      try {
        const [mail, player] = STORE.claimMail(p.id, mid, cards);
        return sendJson(res, 200, { mail, player, cards });
      } catch (e) {
        if (e instanceof MailGone) return sendJson(res, 409, { error: "Ese envío ya se abrió." });
        throw e;
      }
    }
    return notFound(res);
  }

  if (method === "PUT") {
    if (apiPath !== "/api/me/save" && apiPath !== "/api/me/decks") return notFound(res);
    const p = me(req);
    if (!p) return unauthorized(res);
    if (apiPath === "/api/me/save") {
      // el cliente ya no manda la colección: la deriva el servidor (ADR 0002)
      res.setHeader("Connection", "close"); // no se lee el cuerpo
      return sendJson(res, 410, { error: "Ahora el servidor guarda la colección; actualizá la página." });
    }
    try {
      const body = await readJson(req);
      if (!isObj(body)) throw new ValueError("El cuerpo debe ser un objeto JSON.");
      const rev = Object.hasOwn(body, "rev") ? pyInt(body.rev) : -1;
      if (rev === null) throw new ValueError("rev inválido.");
      const core = ENGINE.core();
      const player = STORE.saveDecks(p.id, rev, (save) =>
        validateDecks(core, ENGINE.ownedCounts(isObj(save.collection) ? save.collection : {}), body.decks));
      return sendJson(res, 200, { rev: player.rev });
    } catch (e) {
      if (e instanceof Conflict) return sendJson(res, 409, { error: "conflict", player: e.player });
      if (e instanceof ValueError) return sendJson(res, 400, { error: e.message });
      throw e;
    }
  }

  // como http.server de Python: método no soportado
  const body = Buffer.from("Unsupported method");
  res.writeHead(501, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

/** CLI de invitaciones: `invite new [--uses N] [--days N] [etiqueta]`, `invite list`, `invite revoke <código>`. */
function inviteCli(args: string[], store: Store): number {
  const [cmd, ...rest] = args;
  if (cmd === "new") {
    let uses = 1;
    let days = 7;
    const label: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--uses" || rest[i] === "--days") {
        const n = /^\d+$/.test(rest[i + 1] ?? "") ? Number(rest[i + 1]) : NaN;
        if (!Number.isSafeInteger(n) || n < 1 || n > (rest[i] === "--uses" ? 1000 : 365)) {
          console.error(`${rest[i]} necesita un entero (usos 1-1000, días 1-365).`);
          return 2;
        }
        if (rest[i] === "--uses") uses = n; else days = n;
        i++;
      } else label.push(rest[i]);
    }
    const code = store.createInvite(label.join(" "), uses, days);
    console.log(`Código de invitación: ${code}`);
    console.log(`Usos: ${uses} · vence en ${days} día(s). Se muestra una sola vez (en la base queda solo su hash).`);
    console.log(`Link para invitar: https://<host>/#invite=${code}`);
    return 0;
  }
  if (cmd === "list") {
    const t = Date.now() / 1000;
    const rows = store.listInvites();
    if (!rows.length) console.log("(sin invitaciones)");
    for (const r of rows) {
      const estado = r.uses_left <= 0 ? "agotada" : r.expires !== null && r.expires <= t ? "vencida" : "vigente";
      const vence = r.expires === null ? "nunca" : new Date(r.expires * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(`${r.id}  ${estado.padEnd(8)} usos restantes: ${r.uses_left}  vence: ${vence}  ${r.label}`);
    }
    return 0;
  }
  if (cmd === "revoke" && rest[0]) {
    if (store.revokeInvite(rest[0])) { console.log("Invitación revocada."); return 0; }
    console.error("No existe esa invitación.");
    return 1;
  }
  console.error("Uso: invite new [--uses N] [--days N] [etiqueta] | invite list | invite revoke <código o id>");
  return 2;
}

function main(): void {
  if (argv[0] === "admin-token") {
    process.exitCode = adminCli(argv.slice(1), STORE); // sin process.exit: deja vaciar stdout
    return;
  }
  if (argv[0] === "invite") {
    process.exitCode = inviteCli(argv.slice(1), STORE);
    return;
  }
  if (LAN_WARNING) {
    console.error(`ADVERTENCIA: el juego escucha en ${HOST} y ALLOWED_HOSTS no está definido: no se filtra el Host. ` +
      "Definí ALLOWED_HOSTS si lo exponés.");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(ADMIN_HOST)) {
    if (process.env.ADMIN_ALLOW_NONLOOPBACK !== "1") {
      console.error(`Me niego a escuchar la API de admin en '${ADMIN_HOST}' (no es loopback). ` +
        "Si de verdad lo querés, definí ADMIN_ALLOW_NONLOOPBACK=1.");
      process.exit(1);
    }
    console.error(`ADVERTENCIA: la API de admin escucha en ${ADMIN_HOST}, no en loopback. El token es obligatorio, ` +
      "pero no la expongas a Internet.");
  }
  const onError = (what: string) => (e: Error) => {
    console.error(`No pude abrir ${what}: ${e.message}`);
    process.exit(1);
  };
  const admin = makeAdminServer(STORE, CONTENT);
  admin.on("error", onError("la API de admin"));
  admin.listen(ADMIN_PORT, ADMIN_HOST, () => console.log(`API de admin en http://${ADMIN_HOST}:${ADMIN_PORT}/admin/v1  (Bearer token)`));

  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      process.stderr.write(`[juego] error interno: ${e?.stack ?? e}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: "Error interno." });
      else res.end();
    });
  });
  srv.on("error", onError("el juego"));
  srv.listen(PORT, HOST, () => console.log(`Juego en http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}/  (Ctrl+C para cerrar)`));
  // WebSocket /ws (ADR 0002, 3.2): lobby, desafíos, cola y partidas; el upgrade valida Host y Origin antes de aceptar
  const ws = attachWs(srv, { store: STORE, content: CONTENT, engine: ENGINE, access: ACCESS, clientIp });
  const bye = () => { ws.close(); srv.close(); admin.close(); STORE.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main();
