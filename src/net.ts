// =====================================================================
//  Conexión con el servidor del juego (server/main.ts + server/ws.ts, ADR 0002):
//   - HTTP: el jugador (GET /api/me), los mazos (PUT /api/me/decks con rev y reintento ante 409)
//     y el buzón (el sobre lo sortea el servidor y vuelve en `cards`).
//   - WebSocket /ws: lobby, desafíos, cola, combates contra NPC y PvP. El servidor es la única
//     autoridad: acá solo se mandan intenciones (driver.ts) y se dibuja lo que contesta.
//   Si no hay servidor (por ejemplo, abierto con "python -m http.server"), el juego sigue andando
//   solo con localStorage y los combates corren con el driver local (sin premios que se guarden).
//
//  Concurrencia de los mazos: cada guardado lleva la revisión (rev) que conoce el cliente. Si el
//  servidor tiene otra (llegó algo al buzón, otra pestaña…), responde 409 con su versión: se toma la
//  colección del servidor y se reintenta con los mazos de acá y la rev nueva.
// =====================================================================

interface MailItem {
  id: number;
  kind: "cards" | "booster";
  payload: { cards?: string[]; booster?: string };
  message: string;
  sender: string;
  created: number;
}

interface LobbyEntry {
  id: string;
  name: string;
  status: "libre" | "jugando";
}

interface ChallengeIn {
  id: string;
  from: { id: string; name: string };
  prizes: number;
  /** Segundos Unix en los que vence. */
  expires: number;
}

/** Desafío que mandé yo. El servidor no lo confirma al enviarlo: `id` se conoce cuando llega un challenge.update. */
interface ChallengeOut {
  to: string;
  toName: string;
  prizes: number;
  id?: string;
  until: number; // ms (vence a los 60 s)
}

const PROGRESS_KEY = "tcglocal.progress.v1";

const NET = {
  online: !!PLAYER?.token,
  rev: PLAYER?.rev ?? 0,
  saving: false,
  dirty: false,
  timer: 0,
  mail: (PLAYER?.mail ?? []) as MailItem[],
  mailChecked: 0,
  // ---- WebSocket ----
  /** off: sin servidor · connecting · open (autenticado) · down (esperando para reintentar) · fatal (no reintenta) */
  link: (PLAYER?.token ? "connecting" : "off") as "off" | "connecting" | "open" | "down" | "fatal",
  linkMsg: "",
  ws: null as WebSocket | null,
  wsTimer: 0,
  pingTimer: 0,
  retries: 0,
  lastRx: 0,
  you: null as { id: string; name: string } | null,
  lobby: [] as LobbyEntry[],
  lobbyWanted: false,
  incoming: [] as ChallengeIn[],
  outgoing: null as ChallengeOut | null,
  queued: false,
  // ---- partida ----
  driver: null as (BattleDriver & { receive(msg: ServerMatchMsg): void; resume(): void }) | null,
  matchId: "",
  matchVs: "" as "" | "pvp" | "npc",
  /** Se pidió una partida (npc.start) y todavía no llegó match.start. */
  starting: null as { t0: number; onFail: (msg: string) => void } | null,
  /** Segundos Unix del vencimiento del turno y de quién se espera. */
  deadline: 0,
  waiting: "" as "" | "you" | "opp",
  opp: { status: "back" as "disconnected" | "back", graceUntil: 0 },
  /** Hay un match.resume en vuelo sin driver (se recargó la página en medio de una partida). */
  resuming: "",
};

/** Progreso que no son cartas ni mazos: a qué NPC le ganaste. */
const PROGRESS = {
  defeated: ((): Record<string, number> => {
    if (PLAYER?.save?.defeated) return { ...PLAYER.save.defeated };
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? "{}").defeated ?? {};
    } catch {
      return {};
    }
  })(),
};

const playerName = (): string => (PLAYER?.name || "VOS").toUpperCase();
const playerId = (): string => PLAYER?.id ?? "sin conexión";

function saveProgressLocal(): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ defeated: PROGRESS.defeated }));
  } catch {
    /* sin almacenamiento */
  }
}

// ---------------------------------------------------------------------
//  HTTP: jugador y mazos
// ---------------------------------------------------------------------
function netFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Player-Token": PLAYER!.token! },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

/** Pone en el juego lo que dice el servidor (la colección es suya). Los mazos locales se conservan salvo `localDecks=false`. */
function applyServerPlayer(p: PlayerProfile, localDecks = true): void {
  NET.rev = p.rev;
  if (PLAYER) PLAYER.name = p.name;
  const col: Record<string, number> = { ...(p.save?.collection ?? {}) };
  for (const k of Object.keys(pulledCards)) delete pulledCards[k];
  for (const [id, n] of Object.entries(col)) if (CARDS[id] && n > 0) pulledCards[id] = n;
  rebuildCollection();
  for (const [id, n] of Object.entries(p.save?.defeated ?? {})) PROGRESS.defeated[id] = Math.max(PROGRESS.defeated[id] ?? 0, n);
  if (!localDecks && p.save?.decks) {
    const d = readPlayerDecks(p.save.decks);
    playerDecks.decks = d.decks;
    playerDecks.mainId = d.mainId;
    playerDecks.nextId = d.nextId;
  }
  saveProgressLocal();
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(pulledCards));
  } catch {
    /* sin almacenamiento */
  }
}

/** Vuelve a pedir el jugador al servidor (por ejemplo, al terminar una partida con premio). */
async function refreshPlayer(localDecks = true): Promise<boolean> {
  if (!NET.online) return false;
  try {
    const r = await netFetch("GET", "api/me");
    if (!r.ok) return false;
    const p = await r.json();
    NET.mail = p.mail ?? NET.mail;
    applyServerPlayer(p, localDecks);
    return true;
  } catch {
    return false;
  }
}

/** Guarda los mazos en el servidor un ratito después del último cambio. */
function queueSave(): void {
  saveProgressLocal();
  if (!NET.online) return;
  NET.dirty = true;
  clearTimeout(NET.timer);
  NET.timer = window.setTimeout(flushSave, 800);
}

async function flushSave(): Promise<void> {
  if (!NET.online || !NET.dirty) return;
  if (NET.saving) {
    clearTimeout(NET.timer);
    NET.timer = window.setTimeout(flushSave, 400);
    return;
  }
  NET.saving = true;
  NET.dirty = false;
  try {
    const r = await netFetch("PUT", "api/me/decks", { rev: NET.rev, decks: playerDecks });
    if (r.ok) NET.rev = (await r.json()).rev;
    else if (r.status === 409) {
      applyServerPlayer((await r.json()).player); // y se reintenta con la rev nueva
      NET.dirty = true;
    } else if (r.status === 400) {
      // el servidor no acepta esos mazos (otra pestaña cambió la colección, por ejemplo): se queda con los suyos
      const msg = (await r.json().catch(() => null))?.error ?? "El servidor no aceptó los mazos.";
      await refreshPlayer(false);
      if (typeof menuToast === "function") menuToast(String(msg));
    } else NET.dirty = true;
  } catch {
    NET.dirty = true; // sin conexión: se reintenta
  } finally {
    NET.saving = false;
  }
  if (NET.dirty) {
    clearTimeout(NET.timer);
    NET.timer = window.setTimeout(flushSave, 2500);
  }
}

/** Espera a que no haya guardados en curso ni pendientes (antes de empezar una partida con el mazo). */
async function settleSave(): Promise<void> {
  for (let i = 0; i < 40 && (NET.saving || NET.dirty); i++) {
    if (!NET.saving && NET.dirty) {
      clearTimeout(NET.timer);
      await flushSave();
    } else await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------
//  Buzón
// ---------------------------------------------------------------------
async function refreshMail(): Promise<void> {
  if (!NET.online) return;
  try {
    const r = await netFetch("GET", "api/me/mail");
    if (!r.ok) return;
    const j = await r.json();
    NET.mail = j.mail ?? [];
    if (PLAYER && j.name) PLAYER.name = j.name;
    NET.mailChecked = Date.now();
  } catch {
    /* sin conexión: se intenta más tarde */
  }
}

/**
 * Abre un envío del buzón. El sobre lo sortea el servidor y las cartas vuelven en `cards`
 * (el cliente no elige nada). `isNew` se calcula ANTES de sumarlas a la colección local.
 */
async function claimMail(item: MailItem): Promise<{ err?: string; cards?: string[]; isNew?: boolean[] }> {
  if (!NET.online) return { err: "No hay conexión con el servidor." };
  try {
    const r = await netFetch("POST", `api/me/mail/${item.id}/claim`, {});
    const j = await r.json();
    if (!r.ok) {
      await refreshMail();
      return { err: j.error ?? "No se pudo abrir el envío." };
    }
    const cards = ((j.cards ?? []) as string[]).filter((id) => CARDS[id]);
    const isNew = newFlags(cards);
    applyServerPlayer(j.player);
    NET.mail = NET.mail.filter((m) => m.id !== item.id);
    return { cards, isNew };
  } catch {
    return { err: "No hay conexión con el servidor." };
  }
}

// ---------------------------------------------------------------------
//  WebSocket
// ---------------------------------------------------------------------
const WS_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const PING_EVERY = 25000;

function wsUrl(): string {
  const u = new URL("ws", location.href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

function netSend(msg: Record<string, unknown>): boolean {
  const ws = NET.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || NET.link !== "open") return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function wsConnect(): void {
  if (!NET.online || NET.link === "fatal") return;
  clearTimeout(NET.wsTimer);
  NET.link = "connecting";
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    return wsDown();
  }
  NET.ws = ws;
  ws.onopen = () => {
    NET.lastRx = Date.now();
    ws.send(JSON.stringify({ type: "auth", token: PLAYER!.token, v: 1 }));
  };
  ws.onmessage = (ev) => {
    NET.lastRx = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg && typeof msg.type === "string") onWsMessage(msg);
  };
  ws.onclose = (ev) => {
    if (NET.ws !== ws) return; // un socket viejo
    NET.ws = null;
    onWsClosed(ev.code);
  };
  ws.onerror = () => {
    /* el cierre lo maneja onclose */
  };
}

function onWsClosed(code: number): void {
  clearInterval(NET.pingTimer);
  NET.lobby = [];
  NET.queued = false;
  NET.outgoing = null;
  NET.incoming = [];
  if (code === 4401) {
    NET.link = "fatal";
    NET.linkMsg = "Tu sesión no es válida. Recargá la página.";
  } else if (code === 4403) {
    NET.link = "fatal";
    NET.linkMsg = "El servidor no acepta esta dirección.";
  } else if (code === 4409) {
    NET.link = "fatal";
    NET.linkMsg = "Abriste el juego en otra pestaña. Cerrá esta o recargá.";
  } else wsDown(code === 4429 ? 15000 : 0);
}

function wsDown(minMs = 0): void {
  NET.link = "down";
  NET.linkMsg = "";
  const wait = Math.max(minMs, WS_BACKOFF[Math.min(NET.retries, WS_BACKOFF.length - 1)]);
  NET.retries++;
  clearTimeout(NET.wsTimer);
  NET.wsTimer = window.setTimeout(wsConnect, wait);
}

function wsStartPing(): void {
  clearInterval(NET.pingTimer);
  NET.pingTimer = window.setInterval(() => {
    // sin nada del servidor en ~70 s la conexión está muerta (túneles que cortan sin avisar)
    if (Date.now() - NET.lastRx > 70000) {
      NET.ws?.close();
      return;
    }
    netSend({ type: "ping" });
  }, PING_EVERY);
}

function onWsMessage(msg: any): void {
  switch (msg.type) {
    case "hello": {
      NET.link = "open";
      NET.linkMsg = "";
      NET.retries = 0;
      NET.you = msg.you ?? null;
      wsStartPing();
      if (NET.lobbyWanted) netSend({ type: "lobby.sub" });
      const m = msg.match as { id: string; seq: number } | null;
      if (m?.id) {
        if (NET.driver && NET.matchId === m.id) NET.driver.resume();
        else if (!NET.driver) {
          NET.resuming = m.id;
          netSend({ type: "match.resume", match: m.id, seq: -1 });
        }
      } else if (NET.driver) {
        // el servidor ya no tiene esa partida (se reinició o terminó mientras no estábamos)
        abortRemoteMatch("La partida ya no existe en el servidor.");
      }
      return;
    }
    case "ping":
      netSend({ type: "pong" });
      return;
    case "pong":
      return;
    case "lobby":
      NET.lobby = ((msg.online ?? []) as LobbyEntry[]).filter((e) => e.id !== NET.you?.id);
      return;
    case "queue.state":
      NET.queued = !!msg.queued;
      return;
    case "challenge.incoming":
      if (!NET.incoming.some((c) => c.id === msg.id)) NET.incoming.push({ id: msg.id, from: msg.from, prizes: msg.prizes, expires: msg.expires });
      return;
    case "challenge.update":
      onChallengeUpdate(msg);
      return;
    case "error":
      onWsError(msg);
      return;
    case "match.start":
      onMatchStart(msg);
      return;
    case "match.state":
    case "match.error":
    case "match.peek":
    case "match.over":
    case "match.opp":
      onMatchMsg(msg);
      return;
  }
}

function notify(msg: string): void {
  if (game.mode === "battle" && typeof toast === "function") toast(msg);
  else if (typeof menuToast === "function") menuToast(msg);
}

function onChallengeUpdate(msg: { id: string; status: string; error?: string }): void {
  const inc = NET.incoming.findIndex((c) => c.id === msg.id);
  if (msg.status === "pending" || msg.status === "sent") {
    if (NET.outgoing && !NET.outgoing.id) NET.outgoing.id = msg.id;
    return;
  }
  if (inc >= 0) NET.incoming.splice(inc, 1);
  const out = NET.outgoing;
  if (inc < 0 && out && (out.id === msg.id || !out.id)) {
    NET.outgoing = null;
    const who = out.toName;
    const txt: Record<string, string> = {
      declined: `${who} rechazó el desafío.`,
      cancelled: `Se canceló el desafío${msg.error ? ": " + msg.error : "."}`,
      expired: `${who} no contestó a tiempo.`,
    };
    if (txt[msg.status]) notify(txt[msg.status]);
  } else if (msg.error && inc >= 0) notify(msg.error);
}

/** Errores del servidor que no son de una partida: {type:"error", ref, error}. */
function onWsError(msg: { ref?: string; error?: string }): void {
  const text = String(msg.error ?? "Error del servidor.");
  if (msg.ref === "npc.start" && NET.starting) {
    const f = NET.starting;
    NET.starting = null;
    return f.onFail(text);
  }
  if (msg.ref === "challenge.send") NET.outgoing = null;
  if (msg.ref === "queue.join") NET.queued = false;
  notify(text);
}

// ---------------------------------------------------------------------
//  Comandos del lobby
// ---------------------------------------------------------------------
function lobbySub(on: boolean): void {
  NET.lobbyWanted = on;
  netSend({ type: on ? "lobby.sub" : "lobby.unsub" });
}

/** Id del mazo con el que se va a jugar, ya guardado en el servidor. null (y aviso) si no sirve. */
async function battleDeckId(): Promise<string | null> {
  const d = playerDecks.decks.find((x) => x.id === playerDecks.mainId);
  if (!d) {
    notify("No tenés un mazo principal.");
    return null;
  }
  const problems = deckProblems(d, ownedNow());
  if (problems.length) {
    notify(`Tu mazo principal no es válido: ${problems[0]}`);
    return null;
  }
  await settleSave();
  return d.id!;
}

async function sendChallenge(to: LobbyEntry, prizes: number): Promise<void> {
  if (NET.outgoing) return;
  const deckId = await battleDeckId();
  if (!deckId) return;
  if (!netSend({ type: "challenge.send", to: to.id, deckId, prizes })) return notify("Sin conexión con el servidor.");
  NET.outgoing = { to: to.id, toName: to.name, prizes, until: Date.now() + 60000 };
}

function cancelChallenge(): void {
  const o = NET.outgoing;
  if (!o) return;
  // sin id todavía (el servidor no confirmó el envío): se manda por destinatario además del id
  netSend({ type: "challenge.cancel", id: o.id, to: o.to });
  NET.outgoing = null;
}

async function acceptChallenge(c: ChallengeIn): Promise<void> {
  const deckId = await battleDeckId();
  if (!deckId) return;
  if (!netSend({ type: "challenge.accept", id: c.id, deckId })) notify("Sin conexión con el servidor.");
}

function declineChallenge(c: ChallengeIn): void {
  netSend({ type: "challenge.decline", id: c.id });
  NET.incoming = NET.incoming.filter((x) => x.id !== c.id);
}

async function toggleQueue(): Promise<void> {
  if (NET.queued) {
    netSend({ type: "queue.leave" });
    NET.queued = false;
    return;
  }
  const deckId = await battleDeckId();
  if (!deckId) return;
  if (netSend({ type: "queue.join", deckId })) NET.queued = true;
  else notify("Sin conexión con el servidor.");
}

/** Pide una partida contra un NPC al servidor. Si no se puede, `onFail(motivo)`; si sale bien llega match.start. */
async function netStartNpc(npcId: string, prizes: number, onFail: (msg: string) => void): Promise<void> {
  if (NET.link !== "open") return onFail("No hay conexión con el servidor. Probá de nuevo en un momento.");
  const deckId = await battleDeckId();
  if (!deckId) return onFail("Tu mazo principal no sirve para jugar. Revisalo en MAZO.");
  if (NET.starting) return;
  NET.starting = { t0: Date.now(), onFail };
  if (!netSend({ type: "npc.start", npc: npcId, deckId })) {
    NET.starting = null;
    return onFail("No hay conexión con el servidor.");
  }
  window.setTimeout(() => {
    if (NET.starting && Date.now() - NET.starting.t0 >= 9000) {
      const f = NET.starting;
      NET.starting = null;
      f.onFail("El servidor no contestó. Probá de nuevo.");
    }
  }, 9500);
}

// ---------------------------------------------------------------------
//  Partidas
// ---------------------------------------------------------------------
function onMatchStart(msg: any): void {
  if (NET.driver) return; // ya hay una partida
  NET.starting = null;
  NET.queued = false;
  NET.outgoing = null;
  NET.incoming = [];
  NET.matchVs = msg.vs === "npc" ? "npc" : "pvp";
  beginRemoteMatch({ match: msg.match, view: msg.view, seq: msg.seq, log: msg.log }, msg);
}

function beginRemoteMatch(start: { match: string; view: BattleView; seq: number; log?: string[] }, meta: any): void {
  const drv = createRemoteDriver({ send: (m) => void netSend(m) }, start);
  NET.driver = drv;
  NET.matchId = start.match;
  NET.resuming = "";
  NET.deadline = Number(meta?.deadline) || 0;
  NET.waiting = meta?.waiting ?? "";
  NET.opp = { status: "back", graceUntil: 0 };
  startBattle(6, drv);
}

/** Mensajes de una partida en curso: se le pasan al driver, que descarta lo viejo. */
function onMatchMsg(msg: any): void {
  if (msg.type === "match.state") {
    if (!NET.driver && NET.resuming && msg.match === NET.resuming) {
      // la página se recargó en medio de una partida: se retoma con el estado completo
      NET.matchVs = "";
      return beginRemoteMatch({ match: msg.match, view: msg.view, seq: msg.seq, log: msg.log }, msg);
    }
    if (msg.match === NET.matchId) {
      if (msg.deadline) NET.deadline = Number(msg.deadline);
      if (msg.waiting) NET.waiting = msg.waiting;
    }
  }
  if (msg.type === "match.error" && !NET.driver) {
    // p. ej. un resume de una partida que ya terminó
    NET.resuming = "";
    if (NET.starting) {
      const f = NET.starting;
      NET.starting = null;
      f.onFail(String(msg.error));
    }
    return;
  }
  if (msg.type === "match.opp") NET.opp = { status: msg.status, graceUntil: Number(msg.graceUntil) || 0 };
  NET.driver?.receive(msg);
}

/** La partida terminó para el cliente (se salió de la pantalla de combate). */
function endRemoteMatch(): void {
  NET.driver?.close();
  NET.driver = null;
  NET.matchId = "";
  NET.deadline = 0;
  NET.waiting = "";
}

/** La partida se anuló del lado del servidor: se vuelve al mapa o al lobby con un aviso. */
function abortRemoteMatch(why: string): void {
  const vs = NET.matchVs;
  endRemoteMatch();
  BT.driver = null;
  BT.b = null;
  game.opponent = null;
  game.netWait = false;
  if (vs === "pvp") {
    game.mode = "menu";
    menu.screen = "lobby";
  } else game.mode = "explore";
  notify(why);
}

if (NET.online) {
  window.setInterval(refreshMail, 20000);
  window.addEventListener("pagehide", () => {
    if (NET.dirty) void flushSave();
  });
  // primer guardado: deja en el servidor los mazos iniciales
  if (!PLAYER?.save?.decks) queueSave();
  wsConnect();
}
