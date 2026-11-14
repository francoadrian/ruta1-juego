// Ruta 1 — servidor del juego en Node/TS (ADR 0002, paso 5). Solo node:*, sin dependencias.
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
// ownedCounts(collection) = colección inicial (el mazo Brushfire) + collection.
//
// El juego es el único dueño de los datos (data/game.db, catalog.json, world.json, assets/). El backoffice
// los administra por la API de admin /admin/v1 (server/admin.ts), en un listener aparte:
//   ADMIN_HOST:ADMIN_PORT   por defecto 127.0.0.1:8125  (Bearer token)
// Tokens de admin:  node server/main.ts admin-token new [etiqueta] [--write] | list | revoke <id>
// Invitaciones:     node server/main.ts invite new [--uses N] [--days N] [etiqueta] | list | revoke <código>
//
// WebSocket: GET /ws (ver server/ws.ts: TURN_SECONDS, GRACE_SECONDS, CHALLENGE_SECONDS, NPC_STEP_MS, WS_*).
//
// Configuración (variables de entorno, ver también docs/hosting.md):
//   GAME_HOST / GAME_PORT   listener público (127.0.0.1:8123; 0.0.0.0 solo para LAN); el puerto también va como 1er argumento
//   ALLOWED_HOSTS           nombres de Host permitidos, separados por comas (por defecto loopback); admite *.ts.net y *
//   ALLOWED_ORIGINS         Origins permitidos (esquema://host[:puerto], admite https://*.ts.net); sin esto, vale
//                           cualquier http(s) cuyo host esté en ALLOWED_HOSTS. Sin cabecera Origin se acepta.
//   TRUST_PROXY=1           la IP del cliente sale de la última entrada de X-Forwarded-For (túnel/proxy de confianza)
//   DEBUG_HEADERS=1         imprime (a stderr) la cadena de IP de cada pedido: socket, X-Forwarded-For y la IP que se usa (para verificar TRUST_PROXY)
//   MAX_PLAYERS             tope de jugadores (30)
//   RATE_API_PER_MIN        pedidos /api por IP y minuto (600) · RATE_STATIC_PER_MIN estáticos y demás por IP y minuto (2400)
//   RATE_SIGNUP_PER_MIN     altas por IP y minuto (10)
//   SIGNUP_FAILS_PER_HOUR   intentos de alta fallidos POR IP y hora antes de bloquear (10)
//   SIGNUP_FAILS_GLOBAL_PER_HOUR  tope global de fallos (1000): al agotarse se loguea y los intentos inválidos se frenan; un código válido nunca se bloquea por esto
//   MAX_CONNECTIONS         conexiones TCP simultáneas del listener público (512) · MAX_CONNS_PER_IP por IP de socket (40)
//                           · MAX_CONNS_LOOPBACK para loopback, de donde llegan todos los jugadores detrás de un túnel (300)
//   MATCH_RETENTION_DAYS    días que se conservan las partidas terminadas en la tabla matches (30)
//   ADMIN_HOST / ADMIN_PORT listener de admin (127.0.0.1:8125); ADMIN_ALLOW_NONLOOPBACK=1 para otro host
//   GAME_DB                 base SQLite (por defecto data/game.db)
//   GAME_DATA_DIR           carpeta de catalog.json / world.json (por defecto data/)
//   GAME_ASSETS_DIR         carpeta de imágenes subidas (por defecto assets/)
//   GAME_MAX_ASSETS_MB      tope de espacio de imágenes (500)
//   TCG_ADMIN_TOKEN_FILE    archivo donde `admin-token new --write` deja el token

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { pipeline } from "node:stream";
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
const DEBUG_HEADERS = process.env.DEBUG_HEADERS === "1";
const { access: ACCESS, lanWarning: LAN_WARNING } = accessFromEnv(process.env, HOST, PORT);
const API_LIMIT = new RateLimiter(envInt("RATE_API_PER_MIN", 600), 60_000);
const STATIC_LIMIT = new RateLimiter(envInt("RATE_STATIC_PER_MIN", 2400), 60_000); // estáticos y cualquier otra ruta: generoso (una visita pide ~30 archivos)
const SIGNUP_LIMIT = new RateLimiter(envInt("RATE_SIGNUP_PER_MIN", 10), 60_000);
const SIGNUP_FAILS = new FailureBudget(envInt("SIGNUP_FAILS_PER_HOUR", 10), envInt("SIGNUP_FAILS_GLOBAL_PER_HOUR", 1000), 3_600_000);
const MAX_CONNS = envInt("MAX_CONNECTIONS", 512);
const MAX_CONNS_PER_IP = envInt("MAX_CONNS_PER_IP", 40);
const MAX_CONNS_LOOPBACK = envInt("MAX_CONNS_LOOPBACK", 300);
const TOO_MANY = "Demasiados intentos. Probá en un rato.";

// Logs a stderr (una línea por evento). NUNCA tokens ni códigos de invitación: solo ids e IP.
const logLine = (msg: string): void => void process.stderr.write(`${new Date().toISOString()} [juego] ${msg}\n`);
const lastLog = new Map<string, number>();
/** Como logLine, pero a lo sumo una vez por segundo por clave (un flood no inunda los logs). */
function logThrottled(key: string, msg: string): void {
  const t = Date.now();
  if (t - (lastLog.get(key) ?? 0) < 1000) return;
  lastLog.set(key, t);
  if (lastLog.size > 500) for (const [k, v] of lastLog) if (t - v > 60_000) lastLog.delete(k);
  logLine(msg);
}

/** IP del cliente. Con un túnel todo llega de loopback: solo se mira X-Forwarded-For si TRUST_PROXY=1. */
function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress ?? "?";
}

let debugLeft = 200; // DEBUG_HEADERS: solo las primeras líneas, para no llenar el disco
/** DEBUG_HEADERS=1: imprime SOLO la cadena de IP (socket, X-Forwarded-For y la elegida), nunca otras cabeceras ni cookies. */
function debugIp(req: IncomingMessage): void {
  if (!DEBUG_HEADERS || debugLeft <= 0) return;
  debugLeft--;
  const xff = String(req.headers["x-forwarded-for"] ?? "").replace(/[^0-9a-fA-F:.,\s]/g, "?").slice(0, 200);
  logLine(`[debug-ip] socket=${req.socket.remoteAddress ?? "?"} x-forwarded-for=[${xff}] usada=${clientIp(req)} trust_proxy=${TRUST_PROXY ? 1 : 0}${debugLeft === 0 ? " (último aviso)" : ""}`);
}

// Solo se publica lo que el juego necesita (nunca la base de datos).
// - /vendor/typescript.js: el compilador que usa el navegador (lo genera `node tools/vendor.mjs`; ver ensureVendor)
// - /assets/fonts/*.woff2: solo fuentes directamente en esa carpeta (las imágenes subidas siguen siendo solo imágenes)
const PUBLIC = /^\/(index\.html|vendor\/typescript\.js|src\/[\w.-]+\.ts|assets\/fonts\/[\w.-]+\.woff2|assets\/[\w.-]+(\/[\w.-]+)*\.(png|jpe?g|webp|gif)|data\/(catalog|world)\.json)$/i;
const MAX_BODY = 2_000_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".js": "text/javascript; charset=utf-8", // solo vendor/typescript.js (lo permite PUBLIC)
  ".woff2": "font/woff2",
};

/** Caché del navegador para lo que no cambia con el contenido del juego (typescript.js pesa ~9 MB: no bajarlo en cada visita). */
const CACHEABLE = /^\/(vendor\/typescript\.js|assets\/fonts\/[\w.-]+\.woff2)$/i;
const CACHE_CONTROL = "public, max-age=604800"; // 1 semana; con ETag el navegador revalida barato y una versión nueva entra sola

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
/**
 * CSP mínima. index.html transpila src/*.ts en el navegador y los ejecuta como <script> en línea creados desde JS
 * (textContent), por eso script-src necesita 'unsafe-inline'. 'unsafe-eval' NO hace falta (se verificó en Chrome sin él).
 * Lo demás sí se cierra: nada de embeber el juego (frame-ancestors), objetos, <base> ni formularios a otro sitio, y las
 * conexiones solo al propio origen (fetch/WebSocket). Las imágenes admiten data:/blob: por el canvas.
 */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
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
  if (p.startsWith("/assets/") && !p.startsWith("/assets/fonts/")) {
    // /assets/* sale de GAME_ASSETS_DIR (puede estar fuera de la raíz del repo)
    try {
      const base = realpathSync(ASSETS);
      const f = realpathSync(path.join(base, p.slice("/assets/".length)));
      return f !== base && f.startsWith(base + path.sep) ? f : null;
    } catch {
      return null;
    }
  }
  return path.join(ROOT, p.slice(1)); // incluye /assets/fonts/ (se maneja antes) y /vendor/
}

async function servePublic(req: IncomingMessage, res: ServerResponse, p: string, head: boolean): Promise<void> {
  const m = /^\/data\/(catalog|world)\.json$/.exec(p);
  if (m) { // salen de la caché del contenido (el juego es su dueño)
    const raw = (m[1] === "catalog" ? CONTENT.catalog : CONTENT.world).raw();
    if (raw === null) return notFound(res, head);
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json", "Content-Length": raw.length });
    return void res.end(head ? undefined : raw);
  }
  const f = filePathFor(p);
  let size = -1;
  let mtime = 0;
  try { const st = f === null ? null : statSync(f); if (st?.isFile()) { size = st.size; mtime = st.mtimeMs; } } catch { /* no existe */ }
  if (size < 0 || f === null) return notFound(res, head);
  const ctype = TYPES[path.extname(f).toLowerCase()];
  if (!ctype) return notFound(res, head);
  let extra: Record<string, string> = {};
  if (CACHEABLE.test(p)) {
    const etag = `W/"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`;
    extra = { "Cache-Control": CACHE_CONTROL, ETag: etag };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...BASE_HEADERS, ...extra });
      return void res.end();
    }
  }
  const headers: Record<string, string | number> = { ...BASE_HEADERS, ...extra, "Content-Type": ctype, "Content-Length": size };
  if (p === "/index.html") headers["Content-Security-Policy"] = CSP;
  res.writeHead(200, headers);
  if (head || size === 0) return void res.end();
  // en streaming y con contrapresión (pipeline): un cliente lento o que no lee no hace que el servidor guarde el archivo entero en memoria
  const file = createReadStream(f, { start: 0, end: size - 1 });
  pipeline(file, res, (err) => {
    if (err) res.destroy(); // el cliente cortó o el archivo cambió a mitad de camino
  });
}

// ------------------------------------------------------------------ rutas
const me = (req: IncomingMessage) => STORE.playerByToken(String(req.headers["x-player-token"] ?? ""));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "";
  const url = req.url ?? "/";
  const apiPath = url.split("?", 1)[0];

  // DNS rebinding / CSRF: Host y Origin tienen que estar permitidos (también para los estáticos).
  debugIp(req);
  if (!ACCESS.hostOk(req.headers.host)) {
    logThrottled("403host", `403 Host no permitido ip=${clientIp(req)}`);
    return sendJson(res, 403, { error: "Host no permitido." });
  }
  if (!ACCESS.originOk(req.headers.origin)) {
    logThrottled("403origin", `403 Origin no permitido ip=${clientIp(req)}`);
    return sendJson(res, 403, { error: "Origin no permitido." });
  }
  const ip = clientIp(req);
  // /api tiene su límite; todo lo demás (estáticos, rutas desconocidas, POST a cualquier lado) otro, más generoso
  if (!(apiPath.startsWith("/api/") ? API_LIMIT : STATIC_LIMIT).hit(ip)) {
    logThrottled(`429:${ip}`, `429 límite de pedidos ip=${ip}`);
    res.setHeader("Connection", "close");
    return sendJson(res, 429, { error: TOO_MANY });
  }

  if (method === "HEAD") {
    const p = apiPath.startsWith("/api/") ? null : safePublicPath(url);
    if (p === null) return notFound(res, true);
    return servePublic(req, res, p, true);
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
    return servePublic(req, res, p, false);
  }

  if (method === "POST") {
    if (apiPath !== "/api/players" && !/^\/api\/me\/mail\/(\d+)\/claim$/.test(apiPath)) {
      res.setHeader("Connection", "close"); // ruta desconocida: ni se lee el cuerpo
      return notFound(res);
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      res.setHeader("Connection", "close"); // no se leyó el cuerpo (o estaba roto)
      return sendJson(res, 400, { error: (e as Error).message });
    }

    if (apiPath === "/api/players") {
      if (!SIGNUP_LIMIT.hit(ip) || SIGNUP_FAILS.blocked(ip)) {
        logThrottled(`429signup:${ip}`, `429 altas: límite o intentos fallidos agotados ip=${ip}`);
        return sendJson(res, 429, { error: TOO_MANY });
      }
      if (!isObj(body)) return sendJson(res, 400, { error: "El cuerpo debe ser un objeto JSON." });
      if (body.name !== undefined && typeof body.name !== "string") return sendJson(res, 400, { error: "El nombre debe ser texto." });
      try {
        // `save` (y cualquier otro campo) se ignora: la colección inicial la pone el servidor
        const [player, token] = STORE.createPlayer(body.name, body.invite, MAX_PLAYERS);
        player.token = token;
        player.mail = [];
        logLine(`alta jugador=${player.id} ip=${ip}`);
        return sendJson(res, 201, player);
      } catch (e) {
        if (e instanceof InviteError) {
          SIGNUP_FAILS.fail(ip);
          if (SIGNUP_FAILS.globalExhausted()) {
            // último recurso: el presupuesto global de fallos se agotó (ataque distribuido). Un código válido NUNCA llega acá
            // (se creó el jugador arriba); los inválidos se frenan con una demora y un 429.
            logThrottled("signup-global", "ATENCIÓN: se agotó el tope global de intentos de alta fallidos (SIGNUP_FAILS_GLOBAL_PER_HOUR)");
            await new Promise((r) => setTimeout(r, 1000));
            return sendJson(res, 429, { error: TOO_MANY });
          }
          logThrottled(`invite:${ip}`, `invitación inválida o agotada ip=${ip}`);
          return sendJson(res, 403, { error: "Código de invitación inválido o usado." });
        }
        if (e instanceof PlayersFull) {
          logThrottled("full", `alta rechazada: servidor lleno (MAX_PLAYERS) ip=${ip}`);
          return sendJson(res, 503, { error: "El servidor está lleno." });
        }
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

/** vendor/typescript.js lo necesita el navegador (/vendor/typescript.js). Si falta, se copia desde node_modules (como tools/vendor.mjs). */
function ensureVendor(): void {
  const out = path.join(ROOT, "vendor", "typescript.js");
  const src = path.join(ROOT, "node_modules", "typescript", "lib", "typescript.js");
  if (!existsSync(src)) {
    if (!existsSync(out)) {
      console.error('Falta vendor/typescript.js y typescript no está instalado. Corré "npm ci" y después "node tools/vendor.mjs".');
      process.exit(1);
    }
    console.error('AVISO: no hay node_modules/typescript: no puedo verificar que vendor/typescript.js sea el original. Corré "npm ci".');
    return;
  }
  // lo que se le sirve al navegador tiene que ser idéntico (byte a byte) al paquete fijado en package-lock.json
  if (existsSync(out) && readFileSync(out).equals(readFileSync(src))) return;
  const existed = existsSync(out);
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(src, out);
  console.log(existed ? "vendor/typescript.js no coincidía con node_modules/typescript: regenerado." : "vendor/typescript.js generado desde node_modules.");
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
  ensureVendor();
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
  // errores que se escapan de un manejador (un bug, la base bloqueada): se registran y el servidor sigue. Si se repiten
  // sin parar (más de 25 en un minuto) algo está roto de verdad: se sale con error para que lo reinicie quien lo supervisa.
  let escaped: number[] = [];
  const survive = (kind: string) => (e: unknown): void => {
    logLine(`${kind}: ${(e as Error)?.stack ?? e}`);
    const t = Date.now();
    escaped = escaped.filter((x) => x > t - 60_000);
    escaped.push(t);
    if (escaped.length > 25) {
      logLine("demasiados errores seguidos: salgo.");
      process.exit(1);
    }
  };
  process.on("uncaughtException", survive("uncaughtException"));
  process.on("unhandledRejection", survive("unhandledRejection"));

  let wsHandle: ReturnType<typeof attachWs> | null = null;
  const admin = makeAdminServer(STORE, CONTENT, {
    playerDeleted: (pid) => wsHandle?.dropPlayer(pid),
    playerRenamed: (pid, name) => wsHandle?.renamePlayer(pid, name),
  });
  admin.on("error", onError("la API de admin"));
  admin.listen(ADMIN_PORT, ADMIN_HOST, () => console.log(`API de admin en http://${ADMIN_HOST}:${ADMIN_PORT}/admin/v1  (Bearer token)`));

  const srv = http.createServer({ connectionsCheckingInterval: 5000 }, (req, res) => {
    handle(req, res).catch((e) => {
      logLine(`error interno: ${e?.stack ?? e}`);
      if (!res.headersSent) sendJson(res, 500, { error: "Error interno." });
      else res.end();
    });
  });
  // Tiempos y topes contra clientes lentos o que abren sockets sin parar (slowloris, lectores que no leen)
  srv.maxConnections = MAX_CONNS;
  srv.headersTimeout = 15_000;
  srv.requestTimeout = 30_000;
  srv.keepAliveTimeout = 10_000;
  srv.setTimeout(120_000); // socket sin actividad (por ejemplo, uno que pidió un archivo y no lo lee): se cierra. El WebSocket lo apaga al hacer el upgrade
  const connsByIp = new Map<string, number>();
  srv.on("connection", (sock) => {
    const ip = sock.remoteAddress ?? "?";
    const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    const n = (connsByIp.get(ip) ?? 0) + 1;
    if (n > (loopback ? MAX_CONNS_LOOPBACK : MAX_CONNS_PER_IP)) {
      logThrottled(`connip:${ip}`, `conexión rechazada: demasiadas simultáneas ip=${ip}`);
      sock.destroy();
      return;
    }
    connsByIp.set(ip, n);
    sock.once("close", () => {
      const c = (connsByIp.get(ip) ?? 1) - 1;
      if (c <= 0) connsByIp.delete(ip); else connsByIp.set(ip, c);
    });
  });
  srv.on("error", onError("el juego"));
  srv.listen(PORT, HOST, () => console.log(`Juego en http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}/  (Ctrl+C para cerrar)`));
  // WebSocket /ws (ADR 0002, 3.2): lobby, desafíos, cola y partidas; el upgrade valida Host y Origin antes de aceptar
  const ws = attachWs(srv, { store: STORE, content: CONTENT, engine: ENGINE, access: ACCESS, clientIp });
  wsHandle = ws;
  // las partidas terminadas se guardan para depurar (log de intents), no como historial: se podan por antigüedad
  const retention = envInt("MATCH_RETENTION_DAYS", 30);
  const prune = (): void => {
    try {
      const n = STORE.pruneMatches(retention);
      if (n) logLine(`partidas viejas borradas (más de ${retention} días): ${n}`);
    } catch (e) {
      logLine(`no pude podar partidas: ${(e as Error)?.message}`);
    }
  };
  prune();
  setInterval(prune, 6 * 3600_000).unref();
  const bye = () => { ws.close(); srv.close(); admin.close(); STORE.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main();
