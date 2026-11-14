// =====================================================================
//  Driver de combate (ADR 0002, paso 8). Lógica pura: sin DOM ni timers.
//
//  La UI (battle.ts / choices.ts) no toca el motor: le manda `Intent`s a un driver y recibe,
//  por callbacks, lo que ve el jugador (`BattleView`) más las líneas nuevas del log. Hay dos:
//   - createLocalDriver: corre createMatch/applyIntent/stepAI/viewFor acá mismo (sin servidor).
//   - createRemoteDriver: habla con el servidor por mensajes JSON (el WebSocket lo pone net.ts).
//  Los dos exponen la misma interfaz `BattleDriver`; la UI no sabe cuál usa.
//
//  Contrato de callbacks (BattleHandlers):
//   - onState(view, log): estado nuevo (y las líneas de log que se escribieron desde el anterior).
//     Es la respuesta a una intención aceptada, a un paso de la IA/rival o a un resume.
//   - onError(msg): la última intención se rechazó (el estado no cambió).
//   - onPeek(info): el Entrenador que se acaba de "mirar" (intent peek) ya puede jugarse con elección.
//   - onOver(res): terminó la partida (solo el remoto sabe el motivo y el premio).
//   - onOpp(status): el rival se desconectó o volvió (solo PvP).
// =====================================================================

/** Cómo termina una partida contra el servidor (mensaje `match.over`). */
interface MatchResult {
  winner: "you" | "opp" | "draw";
  reason: "normal" | "surrender" | "timeout" | "abandon";
  /** Premio de un NPC (lo decide el servidor). null si no hay. */
  reward: { booster?: string; cards?: string[]; defeated?: number } | null;
}

interface BattleHandlers {
  onState(view: BattleView, log: string[]): void;
  onError(msg: string): void;
  onPeek(info: PeekInfo[]): void;
  onOver?(res: MatchResult): void;
  onOpp?(status: "disconnected" | "back", graceUntil?: number): void;
}

interface BattleDriver {
  readonly kind: "local" | "remote";
  /** La UI se engancha acá antes de llamar a begin(). */
  handlers: BattleHandlers;
  /** Entrega el primer estado (y, si hace falta, deja a la IA lista). */
  begin(): void;
  /** Manda una intención del jugador. La respuesta llega por onState u onError (en el local, antes de volver). */
  send(intent: Intent): void;
  /** Se llama una vez por cuadro mientras el rival juega (local: mueve a la IA con su ritmo; remoto: no hace nada). */
  tick(dt: number): void;
  close(): void;
}

// ---------------------------------------------------------------------
//  Driver local (offline y pruebas): el motor corre en el cliente
// ---------------------------------------------------------------------
const AI_STEP_SECONDS = 0.9; // pausa entre acciones de la IA en su turno
const AI_PROMOTE_SECONDS = 0.7; // pausa antes de que la IA elija su nuevo Activo

/**
 * Partida contra la IA en el propio navegador. El jugador es el 0 y la IA el 1.
 * `rng` por defecto: sfc32 con una semilla aleatoria del cliente (los tests pasan una fija).
 */
function createLocalDriver(
  decks: [Deck, Deck],
  names: [string, string],
  opts: { prizes?: number; rng?: Rng } = {},
): BattleDriver & { match: Match } {
  const m = createMatch(decks, names, { rng: opts.rng ?? sfc32(randomSeed()), prizes: opts.prizes, ai: [false, true] });
  let since = 0;
  let acc = 0;
  let closed = false;
  const d = {
    kind: "local" as const,
    match: m,
    handlers: { onState() {}, onError() {}, onPeek() {} } as BattleHandlers,
    begin() {
      stepAI(m, 1); // la IA arma su mesa de entrada (queda oculta hasta que el jugador termine)
      emit();
    },
    send(intent: Intent) {
      if (closed) return;
      const err = applyIntent(m, 0, intent);
      if (err) return d.handlers.onError(err);
      acc = 0;
      emit();
      if (intent.t === "peek") {
        const info = peek(m, 0);
        if (info?.length) d.handlers.onPeek(info);
      }
    },
    tick(dt: number) {
      if (closed) return;
      const b = m.b;
      if (b.phase === "over" || b.phase === "setup") return;
      const mine = b.phase === "promote" ? b.promoteQueue[0] === 1 : b.cur === 1;
      if (!mine) return;
      acc += dt;
      if (acc < (b.phase === "promote" ? AI_PROMOTE_SECONDS : AI_STEP_SECONDS)) return;
      acc = 0;
      if (stepAI(m, 1)) emit();
    },
    close() {
      closed = true;
    },
  };
  function emit(): void {
    const lines = logSince(m, since);
    since = m.b.logCount;
    d.handlers.onState(viewFor(m, 0), lines);
    if (m.b.phase === "over") {
      const w = m.b.winner;
      d.handlers.onOver?.({ winner: w === 0 ? "you" : w === 1 ? "opp" : "draw", reason: "normal", reward: null });
    }
  }
  return d;
}

// ---------------------------------------------------------------------
//  Driver remoto: lo que tiene que cablear el paso 9 (net.ts)
// ---------------------------------------------------------------------
/**
 * net.ts implementa esto con el WebSocket (`ws.send(JSON.stringify(msg))`) y le pasa cada mensaje
 * del servidor a `driver.receive(msg)`. El driver arma los mensajes de ADR 0002 sección 3.2 y
 * lleva el contador `n` de las intenciones.
 */
interface RemoteTransport {
  send(msg: Record<string, unknown>): void;
}

/** Mensajes del servidor que entiende `receive` (los demás se ignoran). */
type ServerMatchMsg =
  | { type: "match.state"; match: string; seq: number; ack?: number; view: BattleView; log?: string[] }
  | { type: "match.error"; match: string; n?: number; error: string }
  // `steps`: un PeekInfo por paso que busca u ordena (como lo devuelve peek() en match.ts).
  // También se acepta un mensaje suelto { card, mode, cards } (uno por paso, en orden): se interpreta como [ese paso].
  | { type: "match.peek"; match: string; card: number; mode?: "search" | "top"; cards?: CardView[]; steps?: PeekInfo[] }
  | { type: "match.over"; match: string; winner: "you" | "opp" | "draw"; reason: MatchResult["reason"]; reward?: MatchResult["reward"] }
  | { type: "match.opp"; status: "disconnected" | "back"; graceUntil?: number };

/**
 * Partida contra el servidor. `start` es el `match.start` (o el match.state completo de un match.resume).
 * Descarta estados viejos (seq menor o igual al último visto, salvo el primero).
 */
function createRemoteDriver(
  t: RemoteTransport,
  start: { match: string; view: BattleView; seq: number; log?: string[] },
): BattleDriver & { receive(msg: ServerMatchMsg): void; resume(): void } {
  let n = 0; // contador de intenciones del cliente (el servidor deduplica por n)
  let seq = -1;
  let last: BattleView = start.view;
  let closed = false;
  const d = {
    kind: "remote" as const,
    handlers: { onState() {}, onError() {}, onPeek() {} } as BattleHandlers,
    begin() {
      seq = start.seq;
      d.handlers.onState(start.view, start.log ?? []);
    },
    send(intent: Intent) {
      if (closed) return;
      n++;
      t.send({ type: "match.intent", match: start.match, n, intent });
    },
    tick() {},
    close() {
      closed = true;
    },
    /** Pide el estado completo (después de reconectar). El servidor contesta con match.state. */
    resume() {
      t.send({ type: "match.resume", match: start.match, seq });
    },
    receive(msg: ServerMatchMsg) {
      if (closed || !msg) return;
      if ("match" in msg && msg.match !== start.match) return;
      switch (msg.type) {
        case "match.state":
          if (msg.seq <= seq) return;
          seq = msg.seq;
          last = msg.view;
          d.handlers.onState(msg.view, msg.log ?? []);
          break;
        case "match.error":
          d.handlers.onError(String(msg.error));
          break;
        case "match.peek": {
          const steps = msg.steps ?? (msg.mode && msg.cards ? [{ card: msg.card, step: 0, mode: msg.mode, count: msg.cards.length, cards: msg.cards }] : []);
          if (steps.length) d.handlers.onPeek(steps);
          break;
        }
        case "match.over": {
          // Si la partida terminó por rendición/tiempo/abandono, el último estado puede no decirlo: se lo marca.
          if (last.phase !== "over") {
            const winner = msg.winner === "you" ? 0 : msg.winner === "opp" ? 1 : 2;
            last = { ...last, phase: "over", winner };
            d.handlers.onState(last, []);
          }
          d.handlers.onOver?.({ winner: msg.winner, reason: msg.reason, reward: msg.reward ?? null });
          break;
        }
        case "match.opp":
          d.handlers.onOpp?.(msg.status, msg.graceUntil);
          break;
      }
    },
  };
  return d;
}

// ---------------------------------------------------------------------
//  Rehidratar la vista: lo que dibuja la UI
// ---------------------------------------------------------------------
/** Un Battle con lo que el cliente sí sabe de la partida. La UI lo lee con las mismas funciones de tcg.ts. */
interface ViewBattle extends Battle {
  /** Cartas de la Banca del rival que todavía no se ven (solo en la preparación). */
  oppBenchHidden: number;
  /** El rival todavía no mostró su mesa (preparación). */
  oppHidden: boolean;
  /** Solo en la preparación: [vos, rival] ya terminaron. */
  setupDone?: [boolean, boolean];
}

/** Carta boca abajo: la mano y el mazo del rival, y los Premios y el mazo propios, solo se conocen por cantidad. */
const HIDDEN_CARD: EnergyCard = { kind: "energy", id: "hidden", name: "?", set: "", number: 0, rarity: "Common", type: "Colorless" };
const hiddenPile = (n: number): CI[] => Array.from({ length: n }, () => ({ uid: -1, c: HIDDEN_CARD }));

/** id → carta. Si el id no existe (catálogo desactualizado) la carta queda como oculta en vez de romper el dibujo. */
function hydrateCard(v: CardView): CI {
  const ci: CI = { uid: v.uid, c: CARDS[v.id] ?? HIDDEN_CARD };
  if (v.asEnergy) ci.asEnergy = { ...v.asEnergy };
  if (v.bonus !== undefined) ci.bonus = v.bonus;
  return ci;
}
const hydratePile = (l: CardView[]): CI[] => l.map(hydrateCard);

function hydrateSlot(v: SlotView): Slot {
  const s = {
    ...v,
    stack: hydratePile(v.stack),
    energy: hydratePile(v.energy),
    tools: hydratePile(v.tools),
    defenders: hydratePile(v.defenders),
  } as Slot;
  return s;
}

/** BattleView → ViewBattle. No comparte objetos con la vista. El RNG y los uids siguientes no existen en el cliente. */
function hydrateView(v: BattleView): ViewBattle {
  const side = (pv: PlayerView, mine: boolean): PlayerSt => ({
    name: pv.name,
    deckName: pv.deckName,
    ai: !mine,
    deck: hiddenPile(pv.deck),
    hand: Array.isArray(pv.hand) ? hydratePile(pv.hand) : hiddenPile(pv.hand),
    discard: hydratePile(pv.discard),
    prizes: hiddenPile(pv.prizes),
    active: pv.active ? hydrateSlot(pv.active) : null,
    bench: Array.isArray(pv.bench) ? pv.bench.map(hydrateSlot) : [],
    turns: pv.turns,
    mulligans: pv.mulligans,
  });
  const opp = v.p[1];
  const noRng: Rng = {
    next() {
      throw new Error("El cliente no tiene RNG de la partida: la aleatoriedad es del motor (local o del servidor).");
    },
  };
  const b: ViewBattle = {
    p: [side(v.p[0], true), side(opp, false)],
    cur: v.cur,
    turn: v.turn,
    energyPlayed: v.energyPlayed,
    retreated: v.retreated,
    phase: v.phase,
    winner: v.winner,
    log: [],
    logCount: 0,
    promoteQueue: [...v.promoteQueue],
    after: null,
    first: v.first,
    prizeCount: v.prizeCount,
    rng: noRng,
    uidNext: 0,
    oppHidden: !Array.isArray(opp.bench),
    oppBenchHidden: Array.isArray(opp.bench) ? 0 : opp.bench,
  };
  if (v.setupDone) b.setupDone = [v.setupDone[0], v.setupDone[1]];
  return b;
}

// ---------------------------------------------------------------------
//  Intenciones desde lo que eligió la UI (objetos del ViewBattle → uids)
// ---------------------------------------------------------------------
/** TPick (con objetos hidratados) → PickIntent (uids). */
function pickToIntent(pk: TPick): PickIntent {
  const out: PickIntent = {};
  if (pk.slot) out.slot = pk.slot.uid;
  if (pk.cards) out.cards = pk.cards.map((c) => c.uid);
  if (pk.energies) out.energies = pk.energies.map((c) => c.uid);
  if (pk.order) out.order = [...pk.order];
  if (pk.stage !== undefined) out.stage = pk.stage;
  return out;
}

/** PowerChoice de la UI (objetos) → choice del intent (uids). */
function powerChoiceToIntent(ch: PowerChoice): PowerIntentChoice {
  const out: PowerIntentChoice = {};
  if (ch.from) out.from = ch.from.uid;
  if (ch.target) out.target = ch.target.uid;
  if (ch.type) out.type = ch.type;
  return out;
}
