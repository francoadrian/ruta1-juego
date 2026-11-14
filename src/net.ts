// =====================================================================
//  Conexión con el servidor del juego (server.py): el jugador, su partida
//  guardada y el buzón. Si no hay servidor (por ejemplo, abierto con
//  "python -m http.server"), el juego sigue andando solo con localStorage.
//
//  Concurrencia: cada guardado lleva la revisión (rev) que conoce el
//  cliente. Si el servidor tiene otra (llegó algo al buzón, otra pestaña…),
//  responde 409 con su versión: se toma la colección del servidor, se le
//  suman las cartas ganadas acá que todavía no se habían guardado, y se
//  reintenta. Las cartas nunca se pierden ni se duplican.
// =====================================================================

interface MailItem {
  id: number;
  kind: "cards" | "booster";
  payload: { cards?: string[]; booster?: string };
  message: string;
  sender: string;
  created: number;
}

const PROGRESS_KEY = "tcglocal.progress.v1";

const NET = {
  online: !!PLAYER?.token,
  rev: PLAYER?.rev ?? 0,
  saving: false,
  dirty: false,
  timer: 0,
  /** Cartas sumadas acá desde el último guardado confirmado (id → copias). */
  pendingAdds: {} as Record<string, number>,
  mail: (PLAYER?.mail ?? []) as MailItem[],
  mailChecked: 0,
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

function currentSave() {
  return { collection: { ...pulledCards }, decks: playerDecks, defeated: PROGRESS.defeated };
}

/** Registra cartas nuevas ganadas en este cliente (para no perderlas si hay conflicto). */
function noteAdds(ids: string[]): void {
  for (const id of ids) NET.pendingAdds[id] = (NET.pendingAdds[id] ?? 0) + 1;
}

/** Guarda en el servidor un ratito después del último cambio. */
function queueSave(): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ defeated: PROGRESS.defeated }));
  } catch {
    /* sin almacenamiento */
  }
  if (!NET.online) return;
  NET.dirty = true;
  clearTimeout(NET.timer);
  NET.timer = window.setTimeout(flushSave, 800);
}

function netFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Player-Token": PLAYER!.token! },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

/** Pone en el juego lo que dice el servidor, más lo ganado acá que falta guardar. */
function applyServerPlayer(p: PlayerProfile, keepLocalDecks = true): void {
  NET.rev = p.rev;
  if (PLAYER) PLAYER.name = p.name;
  const col: Record<string, number> = { ...(p.save?.collection ?? {}) };
  for (const [id, n] of Object.entries(NET.pendingAdds)) col[id] = (col[id] ?? 0) + n;
  for (const k of Object.keys(pulledCards)) delete pulledCards[k];
  for (const [id, n] of Object.entries(col)) if (CARDS[id] && n > 0) pulledCards[id] = n;
  rebuildCollection();
  for (const [id, n] of Object.entries(p.save?.defeated ?? {})) PROGRESS.defeated[id] = Math.max(PROGRESS.defeated[id] ?? 0, n);
  if (!keepLocalDecks && p.save?.decks) Object.assign(playerDecks, readPlayerDecks(p.save.decks));
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(pulledCards));
  } catch {
    /* sin almacenamiento */
  }
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
  const sent = { ...NET.pendingAdds };
  try {
    const r = await netFetch("PUT", "api/me/save", { rev: NET.rev, save: currentSave() });
    if (r.ok) {
      NET.rev = (await r.json()).rev;
      for (const [id, n] of Object.entries(sent)) {
        NET.pendingAdds[id] -= n;
        if (NET.pendingAdds[id] <= 0) delete NET.pendingAdds[id];
      }
    } else if (r.status === 409) {
      applyServerPlayer((await r.json()).player); // y se reintenta con la rev nueva
      NET.dirty = true;
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

/** Espera a que no haya guardados en curso ni pendientes. */
async function settleSave(): Promise<void> {
  for (let i = 0; i < 40 && (NET.saving || NET.dirty); i++) {
    if (!NET.saving && NET.dirty) {
      clearTimeout(NET.timer);
      await flushSave();
    } else await new Promise((r) => setTimeout(r, 150));
  }
}

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

/** Abre un envío del buzón. Las cartas se suman en el servidor, en la misma operación. */
async function claimMail(item: MailItem, cards?: string[]): Promise<string | null> {
  if (!NET.online) return "No hay conexión con el servidor.";
  await settleSave();
  try {
    const r = await netFetch("POST", `api/me/mail/${item.id}/claim`, { cards });
    const j = await r.json();
    if (!r.ok) {
      await refreshMail();
      return j.error ?? "No se pudo abrir el envío.";
    }
    applyServerPlayer(j.player);
    NET.mail = NET.mail.filter((m) => m.id !== item.id);
    return null;
  } catch {
    return "No hay conexión con el servidor.";
  }
}

if (NET.online) {
  window.setInterval(refreshMail, 20000);
  window.addEventListener("pagehide", () => {
    if (NET.dirty) void flushSave();
  });
  // primer guardado: deja en el servidor lo que había en este navegador
  if (!PLAYER?.save?.decks) queueSave();
}
