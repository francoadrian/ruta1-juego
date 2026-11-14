// =====================================================================
//  Utilidades de los tests del motor: mazos al azar, instantáneas, conservación de cartas y un
//  "jugador loco" que prueba intenciones de todo tipo (válidas e inválidas) a través de applyIntent.
// =====================================================================
import { type Core } from "./load-core.ts";

export type Rnd = () => number;

/** Azar de los tests (no del motor): sfc32 del propio núcleo. */
export const rnd = (c: Core, seed: string): Rnd => {
  const r = c.sfc32(seed);
  return () => r.next();
};
export const pick = <T>(r: Rnd, a: T[]): T => a[Math.floor(r() * a.length)];
export const chance = (r: Rnd, p: number): boolean => r() < p;

const ETYPES = ["Fire", "Grass", "Water", "Psychic", "Lightning", "Fighting"];

/**
 * Mazo de 60 cartas armado con el azar de `seed`: unas líneas evolutivas de 2 tipos, Entrenadores
 * y Energías. Respeta 4 copias por nombre (salvo Energías básicas). No mira la colección de nadie.
 */
export function randomDeck(c: Core, seed: string): any {
  const r = rnd(c, "deck:" + seed);
  const cards: any[] = Object.values(c.CARDS).filter((x: any) => c.isPlayable(x.id));
  const types = [pick(r, ETYPES), pick(r, ETYPES)];
  const qty = new Map<string, number>();
  const byName = new Map<string, number>();
  const total = () => [...qty.values()].reduce((a, b) => a + b, 0);
  const add = (card: any, n: number): void => {
    const room = c.isBasicEnergy(card) ? 99 : 4 - (byName.get(card.name) ?? 0);
    n = Math.min(n, room, 60 - total());
    if (n <= 0) return;
    qty.set(card.id, (qty.get(card.id) ?? 0) + n);
    byName.set(card.name, (byName.get(card.name) ?? 0) + n);
  };
  const basics = cards.filter((x) => c.isBasic(x) && (types.includes(x.type) || x.type === "Colorless"));
  const lineOf = (card: any): void => {
    add(card, 2 + Math.floor(r() * 3));
    for (const next of cards.filter((x) => x.kind === "pokemon" && x.evolvesFrom === card.name)) {
      add(next, 1 + Math.floor(r() * 3));
      lineOf2(next);
    }
  };
  const lineOf2 = (card: any): void => {
    for (const next of cards.filter((x) => x.kind === "pokemon" && x.evolvesFrom === card.name)) add(next, 1 + Math.floor(r() * 2));
  };
  for (let i = 0; i < 4 && basics.length; i++) lineOf(pick(r, basics));
  const trainers = cards.filter((x) => x.kind === "trainer" && (x.effect ?? []).length);
  for (let i = 0; i < 8 && trainers.length; i++) add(pick(r, trainers), 1 + Math.floor(r() * 2));
  const special = cards.filter((x) => x.kind === "energy" && x.special);
  if (special.length && chance(r, 0.5)) add(pick(r, special), 1 + Math.floor(r() * 3));
  const energies = types.map((t) => cards.find((x) => c.isBasicEnergy(x) && x.type === t)).filter(Boolean);
  while (total() < 60) add(energies.length ? pick(r, energies) : pick(r, basics), 60 - total() > 6 ? 3 : 1);
  return { name: "Mazo " + seed.slice(-6), cards: [...qty].map(([id, q]) => ({ id, qty: q })) };
}

/** Todas las cartas de un jugador, estén donde estén (mazo, mano, descarte, premios y todo lo que hay en juego). */
export function allCards(c: Core, p: any): any[] {
  const out: any[] = [...p.deck, ...p.hand, ...p.discard, ...p.prizes];
  for (const s of c.inPlay(p)) out.push(...s.stack, ...s.energy, ...s.tools, ...s.defenders);
  return out;
}

/** Texto con TODO el estado de la partida (incluidas las manos y mazos), para comparar. El RNG no es enumerable: no entra. */
export const snapshot = (m: any): string =>
  JSON.stringify({ b: m.b, setupDone: m.setupDone, peekLock: m.peekLock ?? null, seq: m.seq }, (k, v) => (k === "c" ? v.id : v));

/**
 * Chequea que cada jugador siga teniendo exactamente sus cartas (mismos uids que al empezar, sin repetidos).
 * `initial` es lo que devolvió `initialUids`. Lanza Error con detalle si algo falla.
 */
export function assertConserved(c: Core, m: any, initial: [Set<number>, Set<number>], where: string): void {
  const seen = new Set<number>();
  for (const pi of [0, 1]) {
    const cards = allCards(c, m.b.p[pi]);
    if (cards.length !== initial[pi].size) throw new Error(`${where}: el jugador ${pi} tiene ${cards.length} cartas (eran ${initial[pi].size})`);
    for (const ci of cards) {
      if (!initial[pi].has(ci.uid)) throw new Error(`${where}: la carta uid ${ci.uid} (${ci.c.id}) no era del jugador ${pi}`);
      if (seen.has(ci.uid)) throw new Error(`${where}: uid ${ci.uid} (${ci.c.id}) repetido`);
      seen.add(ci.uid);
    }
  }
}

export const initialUids = (c: Core, m: any): [Set<number>, Set<number>] =>
  [0, 1].map((pi) => new Set<number>(allCards(c, m.b.p[pi]).map((x: any) => x.uid))) as [Set<number>, Set<number>];

/** Arma un Match con dos mazos al azar. */
export function newMatch(c: Core, seed: string, opts: { ai?: [boolean, boolean]; prizes?: number } = {}): any {
  return c.createMatch([randomDeck(c, seed + "/a"), randomDeck(c, seed + "/b")], ["Ana", "Beto"], {
    rng: c.sfc32("match:" + seed),
    ai: opts.ai ?? [true, true],
    prizes: opts.prizes,
  });
}

/** Corre la IA de los dos lados hasta que termina la partida. Devuelve la cantidad de pasos o lanza si se traba. */
export function playAI(c: Core, m: any, onStep?: (pi: 0 | 1) => void, maxSteps = 20000): number {
  let steps = 0;
  while (m.b.phase !== "over") {
    let acted = false;
    for (const pi of [0, 1] as const) {
      if (c.stepAI(m, pi)) {
        acted = true;
        steps++;
        onStep?.(pi);
        if (m.b.phase === "over") break;
      }
    }
    if (!acted) throw new Error(`IA trabada en fase ${m.b.phase} (turno ${m.b.turn}, cur ${m.b.cur}, cola ${m.b.promoteQueue})`);
    if (steps > maxSteps) throw new Error(`la partida no termina después de ${maxSteps} pasos (turno ${m.b.turn})`);
  }
  return steps;
}

// ---------------------------------------------------------------------
//  Jugador "loco": arma intenciones a partir del estado (con acceso interno, solo para tests)
// ---------------------------------------------------------------------
export type Move = { pi: 0 | 1; intent: unknown };

/** Una intención al azar para `pi`: casi siempre razonable, a veces absurda (carta ajena, mal formada, fuera de turno). */
export function fuzzIntent(c: Core, m: any, pi: 0 | 1, r: Rnd): unknown {
  const b = m.b;
  const p = b.p[pi];
  const o = b.p[1 - pi];
  const slots: any[] = [...c.inPlay(p), ...c.inPlay(o)];
  const uids = (list: any[]) => list.map((x) => x.uid);
  const anyCard = () => pick(r, [...p.hand, ...p.deck, ...p.discard, ...o.hand, ...o.deck, ...o.prizes, ...o.discard, ...p.prizes]).uid;
  if (chance(r, 0.04)) {
    // basura
    return pick(r, [
      null, 7, "attack", {}, { t: "nope" }, { t: "attack" }, { t: "attack", idx: -1 }, { t: "attack", idx: 1.5 },
      { t: "playBasic", card: "1" }, { t: "playTrainer", card: 3, choice: { picks: { x: {} } } },
      { t: "playTrainer", card: 3, choice: { picks: { 0: { cards: [1, "a"] } } } }, { t: "usePower", slot: 1, choice: { type: "Dark" } },
      { t: "retreat", bench: 1, energies: "all" }, { t: "promote" }, { t: "evolve", card: anyCard(), target: anyCard() },
      { t: "attachEnergy", card: anyCard(), target: anyCard() }, { t: "playBasic", card: anyCard() },
    ]);
  }
  if (b.phase === "setup") {
    const basics = p.hand.filter((x: any) => c.isBasic(x.c));
    return chance(r, 0.35) || !basics.length
      ? { t: "setupDone" }
      : { t: chance(r, 0.4) ? "setupActive" : "setupBench", card: pick(r, basics).uid };
  }
  if (b.phase === "promote") return p.bench.length && chance(r, 0.9) ? { t: "promote", bench: pick(r, p.bench).uid } : { t: "endTurn" };
  const slotRef = () => pick(r, slots).uid;
  const opts: unknown[] = [{ t: "endTurn" }, { t: "endTurn" }];
  for (const card of p.hand) {
    if (c.isBasic(card.c)) opts.push({ t: "playBasic", card: card.uid });
    if (card.c.kind === "energy") for (const s of c.inPlay(p)) opts.push({ t: "attachEnergy", card: card.uid, target: s.uid });
    if (card.c.kind === "pokemon" && !c.isBasic(card.c)) for (const s of c.inPlay(p)) opts.push({ t: "evolve", card: card.uid, target: s.uid });
    if (card.c.kind === "trainer") {
      const steps = c.trainerSteps(card.c);
      const picks: any = {};
      steps.forEach((st: any, i: number) => {
        if (!chance(r, 0.6)) return;
        const pool = [...p.hand, ...p.deck, ...p.discard, ...o.discard];
        picks[i] = {
          slot: chance(r, 0.7) ? slotRef() : undefined,
          cards: chance(r, 0.6) ? Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, pool).uid) : undefined,
          energies: chance(r, 0.3) ? uids(pick(r, slots).energy) : undefined,
          order: chance(r, 0.5) ? [4, 3, 2, 1, 0].sort(() => r() - 0.5) : undefined,
          stage: chance(r, 0.3) ? 1 + Math.floor(r() * 2) : undefined,
        };
      });
      const choice = chance(r, 0.3) ? undefined : { slot: chance(r, 0.5) ? slotRef() : undefined, picks };
      if (steps.some((st: any) => st.op === "searchDeck" || st.op === "arrangeTop") && chance(r, 0.5)) opts.push({ t: "peek", card: card.uid });
      opts.push({ t: "playTrainer", card: card.uid, choice }, { t: "playTrainer", card: card.uid, choice });
    }
  }
  for (const s of c.inPlay(p)) opts.push({ t: "usePower", slot: s.uid, choice: { hand: p.hand.length ? pick(r, p.hand).uid : undefined, from: slotRef(), target: slotRef(), type: pick(r, ["Fire", "Water", "Colorless"]) } });
  for (const s of p.bench) opts.push({ t: "retreat", bench: s.uid, energies: p.active ? uids(p.active.energy).slice(0, 2) : undefined });
  const atk = p.active ? c.topCard(p.active).attacks.length : 0;
  for (let i = 0; i < atk; i++) {
    const target = o.bench.length && chance(r, 0.5) ? pick(r, o.bench).uid : undefined;
    const choice = chance(r, 0.4) ? { attackIdx: Math.floor(r() * 2), type: pick(r, ["Fire", "Water", "Grass"]), energy: o.active?.energy[0]?.uid } : undefined;
    for (let k = 0; k < 4; k++) opts.push({ t: "attack", idx: i, target, choice });
  }
  for (const s of c.inPlay(p)) opts.push({ t: "discardDoll", slot: s.uid });
  opts.push({ t: "promote", bench: p.bench.length ? pick(r, p.bench).uid : 1 }, { t: "surrender-not-really" });
  return pick(r, opts);
}

export interface FuzzRun {
  m: any;
  moves: Move[];
  results: (string | null)[];
  snaps: string[];
}

/**
 * Juega una partida entera con intenciones al azar (las dos manos) usando solo applyIntent.
 * Si `opts.check` está, se llama después de cada intención. Una intención rechazada tiene que dejar el
 * estado igual: se verifica acá. Si la partida no termina en `maxMoves`, un jugador se rinde (así siempre termina).
 */
export function playFuzz(c: Core, seed: string, opts: { maxMoves?: number; check?: (m: any, move: Move, err: string | null) => void } = {}): FuzzRun {
  const m = newMatch(c, seed, { ai: [false, false] });
  const r = rnd(c, "fuzz:" + seed);
  const moves: Move[] = [];
  const results: (string | null)[] = [];
  const snaps: string[] = [];
  const maxMoves = opts.maxMoves ?? 4000;
  while (m.b.phase !== "over") {
    if (moves.length >= maxMoves) break;
    // en setup y promote juega cualquiera; en turno, casi siempre el que tiene el turno
    const pi = (m.b.phase === "turn" && chance(r, 0.93) ? m.b.cur : r() < 0.5 ? 0 : 1) as 0 | 1;
    const intent = fuzzIntent(c, m, pi, r);
    const before = snapshot(m);
    const err = c.applyIntent(m, pi, JSON.parse(JSON.stringify(intent ?? null)));
    const after = snapshot(m);
    if (err !== null && typeof err !== "string") throw new Error("applyIntent devolvió algo que no es string|null");
    if (err !== null && before !== after) throw new Error(`intención rechazada ("${err}") pero cambió el estado: ${JSON.stringify(intent)}`);
    if (err === null && before === after) throw new Error(`intención aceptada sin cambios: ${JSON.stringify(intent)}`);
    moves.push({ pi, intent });
    results.push(err);
    snaps.push(after);
    opts.check?.(m, moves[moves.length - 1], err);
  }
  if (m.b.phase !== "over") {
    const err = c.applyIntent(m, 0, { t: "surrender" });
    if (err) throw new Error("surrender falló: " + err);
    moves.push({ pi: 0, intent: { t: "surrender" } });
    results.push(null);
    snaps.push(snapshot(m));
  }
  return { m, moves, results, snaps };
}
