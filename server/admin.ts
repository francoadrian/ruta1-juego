// API de administración del juego (/admin/v1) y CLI de tokens (port 1:1 de juego/admin.py).
//
// Corre en un listener aparte (por defecto 127.0.0.1:8125) dentro del proceso del servidor del
// juego, para que el túnel/hosting público no la exponga. Contrato: ADR 0001 (repo privado del backoffice).
//
//   * Autenticación: `Authorization: Bearer <token>` (se guarda solo el sha256).
//   * Sin CORS y rechaza cualquier pedido con cabecera `Origin`.
//   * Errores: {"error": "<texto>"} con status 400/401/403/404/405/409/413/500.
//
// CLI:
//   node server/main.ts admin-token new [etiqueta] [--write]   crea un token (se muestra una vez)
//   node server/main.ts admin-token list
//   node server/main.ts admin-token revoke <id>
// `--write` guarda el token en TCG_ADMIN_TOKEN_FILE (por defecto ~/.tcglocal/admin-token), fuera del repo.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { AssetQuota, ContentConflict, ContentCorrupt, MAX_UPLOAD } from "./content.ts";
import type { Content } from "./content.ts";
import type { Store } from "./store.ts";
import { ValueError, cut, isObj, parseJson, pyInt, pyStr, readBytes } from "./util.ts";

const API = 1;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_ASSET_BODY = Math.floor((MAX_UPLOAD * 4) / 3) + 64 * 1024; // base64 de 15 MB + sobre del JSON
const PLAYER_ID = "[\\w-]{1,32}";

class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, msg: string, extra: Record<string, unknown> = {}) {
    super(msg);
    this.status = status;
    this.extra = extra;
  }
}

/** Avisos hacia el WebSocket (server/ws.ts) cuando el admin cambia a un jugador conectado. */
export interface AdminHooks {
  /** El jugador se borró: hay que cerrar su socket (4401) y anular su partida. */
  playerDeleted?: (pid: string) => void;
  /** El jugador cambió de nombre: se refresca en el lobby (no se lo desconecta). */
  playerRenamed?: (pid: string, name: string) => void;
}

export function makeAdminServer(store: Store, content: Content, hooks: AdminHooks = {}): http.Server {
  function sendJson(res: ServerResponse, status: number, obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  async function readJson(req: IncomingMessage, limit = MAX_JSON): Promise<Record<string, any>> {
    const hdr = req.headers["content-length"];
    const n = hdr === undefined ? 0 : pyInt(hdr);
    if (n === null) throw new HttpError(400, "Content-Length inválido.");
    if (n > limit) throw new HttpError(413, "Pedido demasiado grande.");
    if (n <= 0) throw new HttpError(400, "Cuerpo vacío.");
    let body: unknown;
    try {
      body = parseJson(await readBytes(req, n));
    } catch {
      throw new HttpError(400, "JSON inválido.");
    }
    if (!isObj(body)) throw new HttpError(400, "El cuerpo debe ser un objeto JSON.");
    return body;
  }

  function authorize(req: IncomingMessage): void {
    const port = req.socket.localPort;
    const host = String(req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) {
      throw new HttpError(403, "Host no permitido.");
    }
    if (req.headers.origin !== undefined) throw new HttpError(403, "Origen no permitido.");
    const h = String(req.headers.authorization ?? "");
    if (!h.startsWith("Bearer ") || !store.checkAdminToken(h.slice(7).trim())) throw new HttpError(401, "No autorizado.");
  }

  // ------------------------------------------------------------ rutas
  async function route(req: IncomingMessage, res: ServerResponse, method: string, p: string): Promise<void> {
    if (p === "/admin/v1/health" && method === "GET") return sendJson(res, 200, { ok: true, api: API });
    if (p === "/admin/v1/catalog" || p === "/admin/v1/world") {
      const name = p === "/admin/v1/catalog" ? "catalog" : "world";
      const doc = name === "catalog" ? content.catalog : content.world;
      if (method === "GET") {
        const [rev, obj] = doc.get();
        if (rev === null) return sendJson(res, 200, { exists: false, rev: null });
        return sendJson(res, 200, { exists: true, rev, [name]: obj });
      }
      if (method === "PUT") return putDoc(req, res, name, doc);
      throw new HttpError(405, "Método no permitido.");
    }
    if (p === "/admin/v1/players" && method === "GET") return sendJson(res, 200, { players: store.listPlayers() });
    let m = new RegExp(`^/admin/v1/players/(${PLAYER_ID})$`).exec(p);
    if (m) return player(req, res, method, m[1]);
    if (p === "/admin/v1/mail" && method === "POST") return postMail(req, res);
    m = /^\/admin\/v1\/mail\/(\d{1,12})$/.exec(p);
    if (m && method === "DELETE") {
      const mid = Number(m[1]);
      if (!store.mailExists(mid)) throw new HttpError(404, "No existe ese envío.");
      if (!store.cancelMail(mid)) throw new HttpError(409, "Ese envío ya se abrió.");
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/admin/v1/assets" && method === "POST") return postAsset(req, res);
    throw new HttpError(404, "Ruta desconocida.");
  }

  async function putDoc(req: IncomingMessage, res: ServerResponse, name: string, doc: Content["catalog"]): Promise<void> {
    const body = await readJson(req);
    const rev = body.rev ?? null;
    if (rev !== null && typeof rev !== "string") throw new HttpError(400, "rev inválido.");
    if (!Object.hasOwn(body, name)) throw new HttpError(400, `Falta '${name}' en el cuerpo.`);
    let newRev: string;
    try {
      newRev = doc.put(rev, body[name]);
    } catch (e) {
      if (e instanceof ContentConflict) throw new HttpError(409, "conflict", { rev: e.rev });
      if (e instanceof ValueError) throw new HttpError(400, e.message);
      throw e;
    }
    sendJson(res, 200, { ok: true, rev: newRev });
  }

  async function player(req: IncomingMessage, res: ServerResponse, method: string, pid: string): Promise<void> {
    if (method === "GET") {
      const p = store.getPlayer(pid);
      if (!p) throw new HttpError(404, "No existe ese jugador.");
      p.mail = store.mailFor(pid, true);
      return sendJson(res, 200, p);
    }
    if (method === "PATCH") {
      const body = await readJson(req, 64 * 1024);
      let p;
      try {
        p = store.renamePlayer(pid, Object.hasOwn(body, "name") ? pyStr(body.name) : "");
      } catch (e) {
        if (e instanceof ValueError) throw new HttpError(400, e.message);
        throw e;
      }
      if (!p) throw new HttpError(404, "No existe ese jugador.");
      try { hooks.playerRenamed?.(pid, p.name); } catch (e) { process.stderr.write(`[admin] hook playerRenamed: ${(e as Error)?.message}\n`); }
      delete p.save;
      return sendJson(res, 200, p);
    }
    if (method === "DELETE") {
      if (!store.deletePlayer(pid)) throw new HttpError(404, "No existe ese jugador.");
      try { hooks.playerDeleted?.(pid); } catch (e) { process.stderr.write(`[admin] hook playerDeleted: ${(e as Error)?.message}\n`); }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, "Método no permitido.");
  }

  /** {to: "all"|[ids], kind: "cards"|"booster", cards?, booster?, count?, message?, sender?} */
  async function postMail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, 1024 * 1024);
    const to = body.to;
    let players: string[] | null;
    if (to === "all") players = null;
    else if (Array.isArray(to) && to.every((x) => typeof x === "string")) {
      players = to.slice(0, 1000);
      if (players.length === 0) throw new HttpError(400, "Elegí a quién mandarlo.");
    } else throw new HttpError(400, "Elegí a quién mandarlo.");
    const msg = Object.hasOwn(body, "message") ? pyStr(body.message) : "";
    const sender = (Object.hasOwn(body, "sender") ? pyStr(body.sender) : "") || "Backoffice";
    const kind = body.kind;
    let sent = 0;
    if (kind === "cards") {
      const cards = body.cards;
      if (!Array.isArray(cards) || cards.length === 0 || cards.length > 200 || cards.some((c) => typeof c !== "string")) {
        throw new HttpError(400, "Elegí entre 1 y 200 cartas.");
      }
      const known = content.cardIds();
      if (known === null) throw new HttpError(400, "No hay catálogo publicado.");
      const bad = [...new Set<string>(cards.filter((c: string) => !known.has(c)))].sort();
      if (bad.length) throw new HttpError(400, `Cartas que no están en el catálogo: ${bad.slice(0, 5).map((b) => cut(b, 40)).join(", ")}.`);
      sent = store.sendMail(players, "cards", { cards }, msg, sender);
    } else if (kind === "booster") {
      const bid = body.booster;
      if (typeof bid !== "string" || !bid) throw new HttpError(400, "Elegí un sobre.");
      const known = content.boosterIds();
      if (known === null) throw new HttpError(400, "No hay catálogo publicado.");
      if (!known.has(bid)) throw new HttpError(400, "Ese sobre no está en el catálogo.");
      const raw = body.count;
      const c = raw === undefined || raw === null || raw === 0 || raw === "" || raw === false ? 1 : pyInt(raw);
      if (c === null) throw new HttpError(400, "count inválido.");
      const count = Math.max(1, Math.min(50, c));
      for (let i = 0; i < count; i++) sent += store.sendMail(players, "booster", { booster: bid }, msg, sender); // un envío por sobre
    } else throw new HttpError(400, "Tipo de envío desconocido.");
    sendJson(res, 200, { sent });
  }

  async function postAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, MAX_ASSET_BODY);
    let file: string;
    try {
      file = content.saveAsset(body.kind, body.name, body.dataUrl);
    } catch (e) {
      if (e instanceof AssetQuota) throw new HttpError(413, e.message);
      if (e instanceof ValueError) throw new HttpError(400, e.message);
      throw e;
    }
    sendJson(res, 201, { path: file });
  }

  // ------------------------------------------------------------ despacho
  const METHODS = new Set(["GET", "PUT", "POST", "PATCH", "DELETE"]);
  return http.createServer(async (req, res) => {
    const method = req.method ?? "";
    if (!METHODS.has(method)) {
      // como http.server de Python: 501 sin pasar por la autenticación
      const body = Buffer.from("Unsupported method");
      res.writeHead(501, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    const p = (req.url ?? "").split("?", 1)[0];
    try {
      authorize(req);
      await route(req, res, method, p);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) {
        // si se rechazó sin leer el cuerpo, que el cliente no lo siga mandando
        res.setHeader("Connection", "close");
        sendJson(res, e.status, { error: e.message, ...e.extra });
      } else if (e instanceof ContentCorrupt) sendJson(res, 500, { error: e.message });
      else {
        process.stderr.write(`[admin] error interno: ${(e as Error)?.stack ?? e}\n`); // no filtrar detalles al cliente
        sendJson(res, 500, { error: "Error interno." });
      }
    }
  });
}

// ---------------------------------------------------------------------- CLI
export function defaultTokenFile(): string {
  return process.env.TCG_ADMIN_TOKEN_FILE || path.join(os.homedir(), ".tcglocal", "admin-token");
}

export function cli(args: string[], store: Store): number {
  const cmd = args[0] ?? "";
  if (cmd === "new") {
    const rest = args.slice(1).filter((a) => a !== "--write");
    const [tid, token] = store.createAdminToken(rest[0] ?? "");
    if (args.includes("--write")) {
      const f = defaultTokenFile();
      mkdirSync(path.dirname(f), { recursive: true });
      // Se crea con 0600 desde el inicio: no hay ventana en la que otro usuario pueda leerlo.
      writeFileSync(f, token + "\n", { encoding: "utf8", mode: 0o600 });
      try { chmodSync(f, 0o600); } catch { /* en Windows casi no hace nada */ }
      if (process.platform === "win32") {
        try {
          const user = process.env.USERNAME || "";
          const r = spawnSync("icacls", [f, "/inheritance:r", "/grant:r", `${user}:F`], { timeout: 15000 });
          if (!user || r.status !== 0) throw new Error("icacls falló");
        } catch {
          console.error(`AVISO: no pude restringir los permisos de ${f}; revisalos a mano.`);
        }
      }
      console.log(`Token de admin #${tid} guardado en ${f} (no se muestra por pantalla).`);
    } else {
      console.log(`Token de admin #${tid} (se muestra una sola vez; el juego guarda solo el hash):\n${token}`);
    }
    return 0;
  }
  if (cmd === "list") {
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (x: number | null) => {
      if (!x) return "-";
      const d = new Date(x * 1000);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    for (const t of store.listAdminTokens()) {
      console.log(
        `#${t.id}  ${t.label || "(sin etiqueta)"}  creado ${fmt(t.created)}  último uso ${fmt(t.last_used)}  ` +
        `${t.revoked ? "REVOCADO " + fmt(t.revoked) : "activo"}`,
      );
    }
    return 0;
  }
  if (cmd === "revoke" && args.length === 2 && /^\d+$/.test(args[1])) {
    const ok = store.revokeAdminToken(Number(args[1]));
    console.log(ok ? "Revocado." : "No existe o ya estaba revocado.");
    return ok ? 0 : 1;
  }
  console.error("Uso: node server/main.ts admin-token new [etiqueta] [--write] | list | revoke <id>");
  return 2;
}
