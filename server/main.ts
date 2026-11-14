// Ruta 1 — servidor del juego en Node/TS (port 1:1 de server.py; ADR 0002, paso 5). Solo node:*, sin dependencias.
//
//   node server/main.ts            → http://localhost:8123/
//   node server/main.ts 8127       → mismo, en otro puerto (1er argumento numérico)
//
// Sirve el juego y la API de jugadores:
//   POST /api/players                  crea un jugador (devuelve id + token secreto)
//   GET  /api/me                       datos y partida guardada   (X-Player-Token)
//   PUT  /api/me/save                  guarda la partida {rev, save} → 409 si cambió
//   GET  /api/me/mail                  envíos sin abrir del buzón
//   POST /api/me/mail/<id>/claim       abre un envío {cards?} y suma las cartas
//
// El juego es el único dueño de los datos (data/game.db, catalog.json, world.json, assets/). El backoffice
// los administra por la API de admin /admin/v1 (server/admin.ts), en un listener aparte:
//   ADMIN_HOST:ADMIN_PORT   por defecto 127.0.0.1:8125  (Bearer token)
// Tokens de admin:  node server/main.ts admin-token new [etiqueta] [--write] | list | revoke <id>
//
// Configuración (variables de entorno, las mismas que server.py):
//   GAME_HOST / GAME_PORT   listener público (0.0.0.0:8123); el puerto también va como 1er argumento
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
import { Conflict, MailGone, Store } from "./store.ts";
import { ValueError, isObj, parseJson, pyInt, readBytes } from "./util.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = process.env.GAME_DATA_DIR || path.join(ROOT, "data");
const ASSETS = process.env.GAME_ASSETS_DIR || path.join(ROOT, "assets");
const HOST = process.env.GAME_HOST ?? "0.0.0.0"; // 0.0.0.0: se puede jugar desde el celular en la misma red
const argv = process.argv.slice(2);
const argPort = argv[0] && /^\d+$/.test(argv[0]) ? argv[0] : undefined;
const PORT = Number.parseInt(argPort || process.env.GAME_PORT || process.env.PORT || "8123", 10);
const ADMIN_HOST = process.env.ADMIN_HOST ?? "127.0.0.1";
const ADMIN_PORT = Number.parseInt(process.env.ADMIN_PORT || "8125", 10);
const STORE = new Store(process.env.GAME_DB || path.join(DATA, "game.db"));
const CONTENT = new Content(DATA, ASSETS);

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
      if (!isObj(body)) return sendJson(res, 400, { error: "El cuerpo debe ser un objeto JSON." });
      const [player, token] = STORE.createPlayer(body.save);
      player.token = token;
      player.mail = [];
      return sendJson(res, 201, player);
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
        // el sobre lo arma el juego; acá se controla que las cartas sean de ese sobre
        const b = CONTENT.boosterDef(String(item.payload.booster ?? ""));
        const sent = isObj(body) ? body.cards : undefined;
        if (!b || !Array.isArray(sent)) return sendJson(res, 400, { error: "Sobre desconocido." });
        const slots: any[] = Array.isArray(b.slots) ? b.slots : [];
        const size = slots.reduce((n, s) => n + (isObj(s) ? pyInt(s.count || 0) ?? 0 : 0), 0) || 11;
        const pool = new Set<unknown>(Array.isArray(b.cards) ? b.cards : []);
        if (sent.length > size || sent.some((c) => !pool.has(c))) {
          return sendJson(res, 400, { error: "Las cartas no corresponden a ese sobre." });
        }
        cards = sent as string[];
      }
      try {
        const [mail, player] = STORE.claimMail(p.id, mid, cards);
        return sendJson(res, 200, { mail, player });
      } catch (e) {
        if (e instanceof MailGone) return sendJson(res, 409, { error: "Ese envío ya se abrió." });
        throw e;
      }
    }
    return notFound(res);
  }

  if (method === "PUT") {
    if (apiPath !== "/api/me/save") return notFound(res);
    const p = me(req);
    if (!p) return unauthorized(res);
    try {
      const body = await readJson(req);
      if (!isObj(body)) throw new ValueError("El cuerpo debe ser un objeto JSON.");
      const rev = Object.hasOwn(body, "rev") ? pyInt(body.rev) : -1;
      if (rev === null) throw new ValueError("rev inválido.");
      const player = STORE.saveGame(p.id, rev, body.save);
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

function main(): void {
  if (argv[0] === "admin-token") {
    process.exitCode = adminCli(argv.slice(1), STORE); // sin process.exit: deja vaciar stdout
    return;
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
  srv.listen(PORT, HOST, () => console.log(`Juego en http://localhost:${PORT}/  (Ctrl+C para cerrar)`));
  const bye = () => { srv.close(); admin.close(); STORE.close(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

main();
