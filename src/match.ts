// =====================================================================
//  Partida como intenciones (ADR 0002, sección 3.1). Lógica pura: sin DOM ni timers.
//
//  Un cliente (o el servidor, por la IA) no llama a las funciones de tcg.ts: manda un
//  `Intent` (datos serializables) y recibe un error en español o `null`. Las cartas y los
//  Pokémon en juego se nombran por uid (`Ref`), nunca por índice, así una intención vieja
//  no puede apuntar a otra carta si cambió el estado. Lo que ve cada jugador sale de
//  `viewFor`: es la ÚNICA salida del estado de una partida hacia un cliente.
// =====================================================================

/** uid de una carta (CI) o de un Pokémon en juego (Slot: el uid de su carta Básica). */
type Ref = number;

/** Elecciones de un paso de Entrenador (equivale a TPick, pero con uids). */
interface PickIntent {
  slot?: Ref; // Pokémon en juego (propio o del rival)
  cards?: Ref[]; // cartas de la mano, del mazo propio o de un descarte
  energies?: Ref[]; // Energías unidas a un Pokémon en juego
  order?: number[]; // arrangeTop: nuevo orden de las cartas de arriba (índices 0..k-1)
  stage?: number; // devolve: desde qué fase se descarta (1 o 2)
}

/** Equivale a PowerChoice, con uids. `energy` es una Energía unida a `from`. */
interface PowerIntentChoice {
  hand?: Ref;
  from?: Ref;
  target?: Ref;
  energy?: Ref;
  type?: EType;
}

/** Equivale a AttackChoice. `energy` es una Energía unida al Pokémon Defensor. */
interface AttackIntentChoice {
  attackIdx?: number;
  type?: EType;
  energy?: Ref;
}

type Intent =
  | { t: "setupActive"; card: Ref }
  | { t: "setupBench"; card: Ref }
  | { t: "setupDone" }
  | { t: "playBasic"; card: Ref }
  | { t: "evolve"; card: Ref; target: Ref }
  | { t: "attachEnergy"; card: Ref; target: Ref }
  | { t: "peek"; card: Ref } // Entrenador que busca en el mazo o lo ordena: después hay que jugarlo
  | { t: "playTrainer"; card: Ref; choice?: { slot?: Ref; picks?: Record<number, PickIntent> } }
  | { t: "usePower"; slot: Ref; choice?: PowerIntentChoice }
  | { t: "retreat"; bench: Ref; energies?: Ref[] }
  | { t: "attack"; idx: number; target?: Ref; choice?: AttackIntentChoice }
  | { t: "promote"; bench: Ref }
  | { t: "discardDoll"; slot: Ref }
  | { t: "endTurn" }
  | { t: "surrender" };

interface Match {
  b: Battle;
  /** Quién terminó de armar su Activo y su Banca. La partida arranca cuando están los dos. */
  setupDone: [boolean, boolean];
  /** Un jugador miró su mazo (peek): lo único que puede hacer es jugar ese Entrenador. */
  peekLock?: { pi: 0 | 1; card: Ref };
  /** Sube con cada cambio de estado (intención aceptada o paso de la IA). */
  seq: number;
}

/** Carta tal como viaja al cliente: el cliente la rehidrata con CARDS[id]. */
interface CardView {
  uid: number;
  id: string;
  asEnergy?: { type: EType; n: number };
  bonus?: number;
}

// (sin Omit/Pick: battle.ts declara una interfaz global llamada Pick que choca con la de TypeScript)
type SlotView = { [K in keyof Slot as Exclude<K, "stack" | "energy" | "tools" | "defenders">]: Slot[K] } & {
  stack: CardView[];
  energy: CardView[];
  tools: CardView[];
  defenders: CardView[];
};

interface PlayerView {
  name: string;
  /** Solo el nombre del mazo PROPIO; el del rival no se manda (""), es información de su estrategia. */
  deckName: string;
  /** Propia: las cartas. Del rival: solo la cantidad. */
  hand: CardView[] | number;
  /** Siempre una cantidad (también la propia: el orden del mazo es secreto). */
  deck: number;
  /** Siempre una cantidad. */
  prizes: number;
  discard: CardView[];
  /** Del rival, durante la preparación: null hasta que los dos terminen. */
  active: SlotView | null;
  /** Del rival, durante la preparación: solo la cantidad. */
  bench: SlotView[] | number;
  turns: number;
  mulligans: number;
}

/** Lo que ve un jugador: él siempre es p[0] y el rival p[1] (los índices de cur/first/winner/promoteQueue ya vienen girados). */
interface BattleView {
  turn: number;
  cur: 0 | 1;
  first: 0 | 1;
  phase: Phase;
  /** 0 = ganaste, 1 = ganó el rival, 2 = empate, -1 = sigue. */
  winner: number;
  energyPlayed: boolean;
  retreated: boolean;
  prizeCount: number;
  promoteQueue: number[];
  /** Solo en la preparación: [vos, rival] ya terminaron. */
  setupDone?: [boolean, boolean];
  p: [PlayerView, PlayerView];
}

/** Lo que ve el dueño de un Entrenador que busca en el mazo o lo ordena (mensaje `match.peek`). */
interface PeekInfo {
  card: Ref; // el Entrenador
  step: number; // índice del paso del efecto
  mode: "search" | "top";
  /** search: cuántas cartas puede llevarse. top: cuántas ordena. */
  count: number;
  /** search: solo las que pasan el filtro del paso, ordenadas por número de carta (no por posición en el mazo). top: las de arriba, la primera es la de más arriba. */
  cards: CardView[];
}

// ---------------------------------------------------------------------
//  Crear la partida
// ---------------------------------------------------------------------
/**
 * Arranca una partida (fase "setup"). Lanza Error si un mazo tiene cartas desconocidas o ningún Pokémon Básico
 * (el que llama valida antes con deckProblems). Los nombres de los jugadores van en el log.
 */
function createMatch(decks: [Deck, Deck], names: [string, string], opts: NewBattleOpts): Match {
  for (const d of decks) {
    let basics = 0;
    for (const e of d.cards) {
      const c = CARDS[e.id];
      if (!c || !Number.isInteger(e.qty) || e.qty < 0) throw new Error(`Mazo "${d.name}": carta inválida (${e.id}).`);
      if (e.qty > 0 && isBasic(c)) basics++;
    }
    if (!basics) throw new Error(`Mazo "${d.name}": no tiene Pokémon Básicos.`);
  }
  return { b: newBattle(decks, names, opts), setupDone: [false, false], seq: 0 };
}

// ---------------------------------------------------------------------
//  Validar la forma de una intención (viene de la red: no se confía en nada)
// ---------------------------------------------------------------------
const M_BAD = "Intención inválida.";
const M_TYPES: EType[] = ["Fire", "Grass", "Water", "Psychic", "Lightning", "Fighting", "Colorless"];

const mIsRef = (x: unknown): x is Ref => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 1_000_000;
const mIsInt = (x: unknown, min: number, max: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
const mIsObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function mRefs(x: unknown): Ref[] | null {
  if (!Array.isArray(x) || x.length > 60) return null;
  // sin repetidos: la misma carta dos veces la duplicaría (p. ej. Maintenance la mezclaba dos veces en el mazo)
  return x.every(mIsRef) && new Set(x).size === x.length ? [...x] : null;
}

/** Devuelve una copia limpia de la intención (solo los campos conocidos) o un error en español. */
function mParse(raw: unknown): Intent | string {
  if (!mIsObj(raw)) return M_BAD;
  switch (raw.t) {
    case "setupDone": case "endTurn": case "surrender":
      return { t: raw.t };
    case "setupActive": case "setupBench": case "playBasic": case "peek":
      return mIsRef(raw.card) ? { t: raw.t, card: raw.card } : M_BAD;
    case "evolve": case "attachEnergy":
      return mIsRef(raw.card) && mIsRef(raw.target) ? { t: raw.t, card: raw.card, target: raw.target } : M_BAD;
    case "promote":
      return mIsRef(raw.bench) ? { t: "promote", bench: raw.bench } : M_BAD;
    case "discardDoll":
      return mIsRef(raw.slot) ? { t: "discardDoll", slot: raw.slot } : M_BAD;
    case "retreat": {
      if (!mIsRef(raw.bench)) return M_BAD;
      if (raw.energies === undefined) return { t: "retreat", bench: raw.bench };
      const energies = mRefs(raw.energies);
      return energies ? { t: "retreat", bench: raw.bench, energies } : M_BAD;
    }
    case "usePower": {
      if (!mIsRef(raw.slot)) return M_BAD;
      if (raw.choice === undefined) return { t: "usePower", slot: raw.slot };
      const c = raw.choice;
      if (!mIsObj(c)) return M_BAD;
      const choice: PowerIntentChoice = {};
      for (const k of ["hand", "from", "target", "energy"] as const) {
        if (c[k] === undefined) continue;
        if (!mIsRef(c[k])) return M_BAD;
        choice[k] = c[k] as Ref;
      }
      if (c.type !== undefined) {
        if (!M_TYPES.includes(c.type as EType)) return M_BAD;
        choice.type = c.type as EType;
      }
      return { t: "usePower", slot: raw.slot, choice };
    }
    case "attack": {
      if (!mIsInt(raw.idx, 0, 9)) return M_BAD;
      const out: Intent = { t: "attack", idx: raw.idx };
      if (raw.target !== undefined) {
        if (!mIsRef(raw.target)) return M_BAD;
        out.target = raw.target;
      }
      if (raw.choice !== undefined) {
        const c = raw.choice;
        if (!mIsObj(c)) return M_BAD;
        const choice: AttackIntentChoice = {};
        if (c.attackIdx !== undefined) {
          if (!mIsInt(c.attackIdx, 0, 9)) return M_BAD;
          choice.attackIdx = c.attackIdx;
        }
        if (c.type !== undefined) {
          if (!M_TYPES.includes(c.type as EType)) return M_BAD;
          choice.type = c.type as EType;
        }
        if (c.energy !== undefined) {
          if (!mIsRef(c.energy)) return M_BAD;
          choice.energy = c.energy;
        }
        out.choice = choice;
      }
      return out;
    }
    case "playTrainer": {
      if (!mIsRef(raw.card)) return M_BAD;
      if (raw.choice === undefined) return { t: "playTrainer", card: raw.card };
      const c = raw.choice;
      if (!mIsObj(c)) return M_BAD;
      const choice: { slot?: Ref; picks?: Record<number, PickIntent> } = {};
      if (c.slot !== undefined) {
        if (!mIsRef(c.slot)) return M_BAD;
        choice.slot = c.slot;
      }
      if (c.picks !== undefined) {
        if (!mIsObj(c.picks)) return M_BAD;
        const picks: Record<number, PickIntent> = {};
        for (const [key, v] of Object.entries(c.picks)) {
          if (!/^\d{1,2}$/.test(key) || !mIsObj(v)) return M_BAD;
          const pk: PickIntent = {};
          if (v.slot !== undefined) {
            if (!mIsRef(v.slot)) return M_BAD;
            pk.slot = v.slot;
          }
          if (v.cards !== undefined) {
            const cards = mRefs(v.cards);
            if (!cards) return M_BAD;
            pk.cards = cards;
          }
          if (v.energies !== undefined) {
            const energies = mRefs(v.energies);
            if (!energies) return M_BAD;
            pk.energies = energies;
          }
          if (v.order !== undefined) {
            if (!Array.isArray(v.order) || v.order.length > 20 || !v.order.every((n) => mIsInt(n, 0, 19))) return M_BAD;
            pk.order = [...v.order];
          }
          if (v.stage !== undefined) {
            if (!mIsInt(v.stage, 1, 2)) return M_BAD;
            pk.stage = v.stage;
          }
          picks[Number(key)] = pk;
        }
        choice.picks = picks;
      }
      return { t: "playTrainer", card: raw.card, choice };
    }
    default:
      return M_BAD;
  }
}

// ---------------------------------------------------------------------
//  Resolver uids a objetos del Battle (en el momento de aplicar la intención)
// ---------------------------------------------------------------------
const mHandIdx = (p: PlayerSt, ref: Ref): number => p.hand.findIndex((c) => c.uid === ref);
const mOwnSlot = (p: PlayerSt, ref: Ref): Slot | undefined => inPlay(p).find((s) => s.uid === ref);
const mAnySlot = (b: Battle, ref: Ref): Slot | undefined => mOwnSlot(b.p[0], ref) ?? mOwnSlot(b.p[1], ref);

/**
 * Carta que un jugador puede nombrar: su mano, su mazo, su descarte, el del rival y las Energías unidas a
 * Pokémon en juego. Nunca la mano, el mazo ni los Premios del rival, ni los Premios propios.
 */
function mFindCI(b: Battle, pi: number, ref: Ref): CI | undefined {
  const p = b.p[pi];
  const o = b.p[1 - pi];
  return (
    [p.hand, p.deck, p.discard, o.discard].reduce<CI | undefined>((f, pile) => f ?? pile.find((c) => c.uid === ref), undefined) ??
    [...inPlay(p), ...inPlay(o)].reduce<CI | undefined>((f, s) => f ?? s.energy.find((c) => c.uid === ref), undefined)
  );
}

// ---------------------------------------------------------------------
//  Aplicar una intención
// ---------------------------------------------------------------------
/**
 * Aplica la intención de un jugador. Devuelve un error en español (y el estado no cambia) o null.
 * No lanza por intenciones mal formadas; si el motor lanzara por un bug, la excepción sube
 * (el servidor la atrapa y anula la partida).
 */
function applyIntent(m: Match, pi: 0 | 1, raw: Intent): string | null {
  if (pi !== 0 && pi !== 1) return "Jugador inválido.";
  const it = mParse(raw);
  if (typeof it === "string") return it;
  const err = mApply(m, pi, it);
  if (err === null) {
    m.seq++;
    if (m.b.phase === "over") m.peekLock = undefined;
  }
  return err;
}

function mApply(m: Match, pi: 0 | 1, it: Intent): string | null {
  const b = m.b;
  if (b.phase === "over") return "La partida ya terminó.";
  if (it.t === "surrender") {
    surrender(b, pi);
    return null;
  }
  if (b.phase === "setup") return mSetup(m, pi, it);
  if (it.t === "setupActive" || it.t === "setupBench" || it.t === "setupDone") return "La preparación ya terminó.";

  if (m.peekLock?.pi === pi && !(it.t === "playTrainer" && it.card === m.peekLock.card)) {
    return "Ya miraste tu mazo: jugá ese Entrenador.";
  }
  if (it.t === "promote") {
    const idx = b.p[pi].bench.findIndex((s) => s.uid === it.bench);
    return promote(b, pi, idx);
  }
  const tc = turnCheck(b, pi);
  if (tc) return tc;

  const p = b.p[pi];
  const o = b.p[1 - pi];
  switch (it.t) {
    case "endTurn":
      log(b, `${p.name} termina su turno.`);
      endTurn(b);
      return null;
    case "playBasic": {
      const hi = mHandIdx(p, it.card);
      return hi < 0 ? "Esa carta no está en tu mano." : playBasic(b, pi, hi);
    }
    case "evolve": {
      const hi = mHandIdx(p, it.card);
      const s = mOwnSlot(p, it.target);
      if (hi < 0) return "Esa carta no está en tu mano.";
      if (!s) return "Elegí un Pokémon tuyo en juego.";
      return evolve(b, pi, hi, s);
    }
    case "attachEnergy": {
      const hi = mHandIdx(p, it.card);
      const s = mOwnSlot(p, it.target);
      if (hi < 0) return "Esa carta no está en tu mano.";
      if (!s) return "Elegí un Pokémon tuyo en juego.";
      return attachEnergy(b, pi, hi, s);
    }
    case "peek": {
      const hi = mHandIdx(p, it.card);
      if (hi < 0) return "Esa carta no está en tu mano.";
      const card = p.hand[hi];
      if (!trainerSteps(card.c).some((st) => st.op === "searchDeck" || st.op === "arrangeTop")) return "Esa carta no necesita mirar el mazo.";
      const err = trainerError(b, pi, hi);
      if (err) return err;
      m.peekLock = { pi, card: card.uid };
      return null;
    }
    case "playTrainer": {
      const hi = mHandIdx(p, it.card);
      if (hi < 0) return "Esa carta no está en tu mano.";
      const ch = mTrainerChoice(b, pi, it.choice);
      if (typeof ch === "string") return ch;
      const err = playTrainer(b, pi, hi, ch);
      if (!err && m.peekLock?.pi === pi) m.peekLock = undefined;
      return err;
    }
    case "usePower": {
      const s = mOwnSlot(p, it.slot);
      if (!s) return "Elegí un Pokémon tuyo en juego.";
      const ch: PowerChoice = {};
      const c = it.choice ?? {};
      if (c.hand !== undefined) {
        ch.hand = mHandIdx(p, c.hand);
        if (ch.hand < 0) return "Esa carta no está en tu mano.";
      }
      for (const k of ["from", "target"] as const) {
        if (c[k] === undefined) continue;
        const x = mOwnSlot(p, c[k]!);
        if (!x) return "Elegí un Pokémon tuyo en juego.";
        ch[k] = x;
      }
      if (c.energy !== undefined) {
        const holder = inPlay(p).find((x) => x.energy.some((e) => e.uid === c.energy));
        if (!holder || (ch.from && ch.from !== holder)) return "Esa Energía no está unida a ese Pokémon.";
        ch.from = holder;
        ch.energy = holder.energy.findIndex((e) => e.uid === c.energy);
      }
      if (c.type) ch.type = c.type;
      return usePower(b, pi, s, ch);
    }
    case "retreat": {
      const bi = p.bench.findIndex((s) => s.uid === it.bench);
      if (bi < 0) return "Elegí un Pokémon de la Banca.";
      let energies: number[] | undefined;
      if (it.energies) {
        energies = [];
        for (const ref of it.energies) {
          const i = p.active ? p.active.energy.findIndex((e) => e.uid === ref) : -1;
          if (i < 0) return "Esa Energía no está unida a tu Pokémon Activo.";
          energies.push(i);
        }
      }
      return retreat(b, pi, bi, energies);
    }
    case "attack": {
      let target: Slot | undefined;
      if (it.target !== undefined) {
        target = o.bench.find((s) => s.uid === it.target);
        if (!target) return "Elegí un Pokémon de la Banca del rival.";
      }
      const ch: AttackChoice = {};
      if (it.choice?.attackIdx !== undefined) ch.attackIdx = it.choice.attackIdx;
      if (it.choice?.type) ch.type = it.choice.type;
      if (it.choice?.energy !== undefined) {
        const i = o.active ? o.active.energy.findIndex((e) => e.uid === it.choice!.energy) : -1;
        if (i < 0) return "Esa Energía no está unida al Pokémon Defensor.";
        ch.energy = i;
      }
      return attack(b, pi, it.idx, target, ch);
    }
    case "discardDoll": {
      const s = mOwnSlot(p, it.slot);
      return s ? discardDoll(b, pi, s) : "Elegí un Pokémon tuyo en juego.";
    }
    default:
      return M_BAD;
  }
}

/** Convierte lo elegido para un Entrenador (uids) en objetos del Battle. Error en español si algo no existe. */
function mTrainerChoice(b: Battle, pi: number, c?: { slot?: Ref; picks?: Record<number, PickIntent> }): TChoice | string {
  const out: TChoice = {};
  if (!c) return out;
  if (c.slot !== undefined) {
    out.slot = mAnySlot(b, c.slot);
    if (!out.slot) return "Objetivo no válido.";
  }
  if (c.picks) {
    out.picks = {};
    for (const [key, v] of Object.entries(c.picks)) {
      const pk: TPick = {};
      if (v.slot !== undefined) {
        pk.slot = mAnySlot(b, v.slot);
        if (!pk.slot) return "Objetivo no válido.";
      }
      if (v.cards) {
        pk.cards = [];
        for (const ref of v.cards) {
          const ci = mFindCI(b, pi, ref);
          if (!ci) return "Carta no válida.";
          pk.cards.push(ci);
        }
      }
      if (v.energies) {
        pk.energies = [];
        for (const ref of v.energies) {
          const ci = mFindCI(b, pi, ref);
          if (!ci) return "Carta no válida.";
          pk.energies.push(ci);
        }
      }
      if (v.order) pk.order = v.order;
      if (v.stage !== undefined) pk.stage = v.stage;
      out.picks[Number(key)] = pk;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
//  Preparación de dos lados
// ---------------------------------------------------------------------
function mSetup(m: Match, pi: 0 | 1, it: Intent): string | null {
  const b = m.b;
  const p = b.p[pi];
  if (it.t !== "setupActive" && it.t !== "setupBench" && it.t !== "setupDone") return "Todavía se está armando la partida.";
  if (m.setupDone[pi]) return "Ya terminaste de armar tu mesa: esperá al rival.";
  if (it.t === "setupDone") {
    if (!p.active) return "Elegí tu Pokémon Activo.";
    m.setupDone[pi] = true;
    mMaybeStart(m);
    return null;
  }
  const hi = mHandIdx(p, it.card);
  if (hi < 0) return "Esa carta no está en tu mano.";
  if (it.t === "setupActive") {
    const prev = p.active;
    const err = setupActive(b, pi, hi);
    if (!err && prev) p.hand.push(prev.stack[0]); // cambiar de Activo: el anterior vuelve a la mano
    return err;
  }
  return setupBench(b, pi, hi);
}

/** Cuando los dos terminaron: Premios, moneda y primer turno. */
function mMaybeStart(m: Match): void {
  if (m.b.phase === "setup" && m.setupDone[0] && m.setupDone[1]) finishSetup(m.b);
}

// ---------------------------------------------------------------------
//  Mirar el mazo (Entrenadores que buscan u ordenan)
// ---------------------------------------------------------------------
const mCardView = (c: CI): CardView => {
  const v: CardView = { uid: c.uid, id: c.c.id };
  if (c.asEnergy) v.asEnergy = { ...c.asEnergy };
  if (c.bonus !== undefined) v.bonus = c.bonus;
  return v;
};

/**
 * Lo que tiene que ver el jugador que hizo `peek` (null si no tiene ninguno pendiente). Solo se manda a él.
 * Una entrada por cada paso del Entrenador que busca u ordena.
 */
function peek(m: Match, pi: 0 | 1): PeekInfo[] | null {
  const lock = m.peekLock;
  if (!lock || lock.pi !== pi) return null;
  const p = m.b.p[pi];
  const card = p.hand.find((c) => c.uid === lock.card);
  if (!card) return null;
  const out: PeekInfo[] = [];
  trainerSteps(card.c).forEach((st, step) => {
    if (st.op === "searchDeck") {
      const cards = p.deck
        .filter((c) => matchFilter(c.c, st.filter))
        .sort((x, y) => x.c.number - y.c.number || x.uid - y.uid) // por número de carta: no delata el orden del mazo
        .map(mCardView);
      out.push({ card: lock.card, step, mode: "search", count: Math.max(1, Number(st.count) || 1), cards });
    } else if (st.op === "arrangeTop") {
      const k = Math.min(Math.max(1, Number(st.count) || 5), p.deck.length);
      out.push({ card: lock.card, step, mode: "top", count: k, cards: p.deck.slice(0, k).map(mCardView) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------
//  Vista de un jugador
// ---------------------------------------------------------------------
function mSlotView(s: Slot): SlotView {
  const { stack, energy, tools, defenders, lastHit, amnesia, leekUsed, ...rest } = s;
  const v: SlotView = {
    ...rest,
    stack: stack.map(mCardView),
    energy: energy.map(mCardView),
    tools: tools.map(mCardView),
    defenders: defenders.map(mCardView),
  };
  // copias: la vista no comparte objetos con el estado de la partida
  if (lastHit) v.lastHit = { ...lastHit };
  if (amnesia) v.amnesia = { ...amnesia };
  if (leekUsed) v.leekUsed = [...leekUsed];
  return v;
}

/** Lo que ve `pi`: sin la mano, el mazo ni los Premios del rival, sin la semilla ni el RNG. Es JSON puro. */
function viewFor(m: Match, pi: 0 | 1): BattleView {
  const b = m.b;
  const rel = (x: number): number => (x === 0 || x === 1 ? (x === pi ? 0 : 1) : x); // gira un índice de jugador (0/1) al punto de vista de pi
  const hidden = b.phase === "setup"; // en la preparación el rival todavía no muestra su mesa
  const side = (q: number): PlayerView => {
    const p = b.p[q];
    const mine = q === pi;
    return {
      name: p.name,
      deckName: mine ? p.deckName : "",
      hand: mine ? p.hand.map(mCardView) : p.hand.length,
      deck: p.deck.length,
      prizes: p.prizes.length,
      discard: p.discard.map(mCardView),
      active: !mine && hidden ? null : p.active ? mSlotView(p.active) : null,
      bench: !mine && hidden ? p.bench.length : p.bench.map(mSlotView),
      turns: p.turns,
      mulligans: p.mulligans,
    };
  };
  const v: BattleView = {
    turn: b.turn,
    cur: rel(b.cur) as 0 | 1,
    first: rel(b.first) as 0 | 1,
    phase: b.phase,
    winner: rel(b.winner),
    energyPlayed: b.energyPlayed,
    retreated: b.retreated,
    prizeCount: b.prizeCount,
    promoteQueue: b.promoteQueue.map(rel),
    p: [side(pi), side(1 - pi)],
  };
  if (b.phase === "setup") v.setupDone = [m.setupDone[pi], m.setupDone[1 - pi]];
  return v;
}

/** Líneas de log escritas desde que `logCount` valía `since` (el log solo guarda las últimas 80). Ninguna revela cartas ocultas. */
function logSince(m: Match, since: number): string[] {
  const n = m.b.logCount - since;
  return n > 0 ? m.b.log.slice(Math.max(0, m.b.log.length - n)) : [];
}

// ---------------------------------------------------------------------
//  Jugar solo: tiempo vencido e IA
// ---------------------------------------------------------------------
/**
 * La intención que se aplica cuando a un jugador se le acaba el tiempo.
 * En la preparación devuelve el siguiente paso (Activo, luego Banca, luego setupDone): hay que llamarla en bucle
 * hasta que `m.setupDone[pi]` sea true. Con un `peek` pendiente juega ese Entrenador con elección automática.
 * Si no es el turno de `pi` ni tiene nada que decidir, devuelve endTurn (que será rechazado).
 */
function defaultIntent(m: Match, pi: 0 | 1): Intent {
  const b = m.b;
  const p = b.p[pi];
  if (b.phase === "setup") {
    const basics = p.hand.filter((c) => isBasic(c.c)).sort((x, y) => (y.c as PokemonCard).hp - (x.c as PokemonCard).hp);
    if (!p.active && basics.length) return { t: "setupActive", card: basics[0].uid };
    if (p.active && basics.length && p.bench.length < BENCH_MAX) return { t: "setupBench", card: basics[0].uid };
    return { t: "setupDone" };
  }
  if (b.phase === "promote" && b.promoteQueue.includes(pi) && p.bench.length) {
    return { t: "promote", bench: p.bench[bestBenchIndex(p)].uid };
  }
  if (m.peekLock?.pi === pi) return { t: "playTrainer", card: m.peekLock.card };
  return { t: "endTurn" };
}

/**
 * Hace UNA acción de la IA para `pi` (preparación, elegir Activo o un paso del turno).
 * Devuelve false si no tenía nada que hacer ahora (no es su turno, espera al rival o terminó la partida).
 * El servidor la llama cada tanto mientras devuelva true.
 */
function stepAI(m: Match, pi: 0 | 1): boolean {
  const b = m.b;
  const p = b.p[pi];
  if (b.phase === "over") return false;
  if (b.phase === "setup") {
    if (m.setupDone[pi]) return false;
    if (!p.active) aiSetup(b, pi);
    else for (let c = p.hand.findIndex((x) => isBasic(x.c)); c >= 0 && p.bench.length < BENCH_MAX; c = p.hand.findIndex((x) => isBasic(x.c))) setupBench(b, pi, c);
    m.setupDone[pi] = true;
    mMaybeStart(m);
  } else if (b.phase === "promote") {
    if (!b.promoteQueue.includes(pi)) return false;
    aiPromote(b, pi);
  } else {
    if (b.cur !== pi) return false;
    aiStep(b, pi);
  }
  m.seq++;
  if ((b.phase as Phase) === "over") m.peekLock = undefined;
  return true;
}
