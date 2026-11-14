// =====================================================================
//  Motor del juego de cartas — reglas del Base Set (1999), simplificadas
//  donde se indica. Lógica pura: no dibuja nada.
// =====================================================================

type Status = null | "asleep" | "paralyzed" | "confused";

/** Instancia concreta de una carta (dos Charmander son dos instancias distintas). */
interface CI {
  uid: number;
  c: Card;
  /** Electrode usado con Buzzap: es una Energía que provee 2 del tipo elegido. */
  asEnergy?: { type: EType; n: number };
  /** PlusPower / Defender unidos: cuánto daño suman o restan. */
  bonus?: number;
}

/** Lo que le pasó a un Pokémon la última vez que lo atacaron (para Mirror Move). */
interface LastHit {
  turn: number;
  damage: number;
  status: Status;
  poison: number; // 0 = no lo envenenaron
}

/** Un Pokémon en juego (Activo o en la Banca) con todo lo que tiene unido. */
interface Slot {
  uid: number;
  stack: CI[]; // [básico, fase 1, fase 2] — el de arriba es el que cuenta
  energy: CI[];
  tools: CI[]; // PlusPower unidos
  damage: number;
  poisoned: boolean;
  status: Status;
  statusTurn: number; // turno en que se aplicó el estado
  enteredTurn: number;
  evolvedTurn: number;
  stiffenTurn: number; // Kakuna "Stiffen": turno en el que se previene el daño
  poisonDmg: number; // 10, o 20 si lo envenenó Toxic
  burn: boolean; // Charizard "Energy Burn" activo este turno
  defenders: CI[]; // Defender unidos
  defenderUntil: number; // turno al final del cual se descartan
  // efectos de ataques (duran mientras el Pokémon no se vaya a la Banca ni evolucione)
  protectTurn: number; // Agility / Barrier: se previenen todos los efectos
  hardenTurn: number; // Harden: se previene el daño de 30 o menos
  hardenMax?: number; // hasta cuánto daño previene Harden
  sandTurn: number; // Sand-attack: al atacar, moneda; cruz = no hace nada
  destinyTurn: number; // Destiny Bond
  weakOverride?: EType; // Conversion 1
  resOverride?: EType; // Conversion 2
  amnesia?: { idx: number; turn: number }; // Amnesia
  leekUsed?: number[]; // ataques "una vez mientras siga en juego" ya usados (Leek Slap)
  lastHit?: LastHit;
}

interface PlayerSt {
  name: string;
  deckName: string;
  ai: boolean;
  deck: CI[];
  hand: CI[];
  discard: CI[];
  prizes: CI[];
  active: Slot | null;
  bench: Slot[];
  turns: number; // turnos jugados (para la regla de evolución del primer turno)
  mulligans: number;
}

type Phase = "setup" | "turn" | "promote" | "over";
type After = "endTurn" | "nextTurn" | "resume";

interface Battle {
  p: [PlayerSt, PlayerSt];
  cur: 0 | 1;
  turn: number;
  energyPlayed: boolean;
  retreated: boolean;
  phase: Phase;
  winner: number; // 0 / 1 / 2 = empate / -1 = sin terminar
  log: string[];
  promoteQueue: number[];
  after: After | null;
  first: 0 | 1;
  prizeCount: number;
}

const BENCH_MAX = 5;
const PRIZES = 6;
let CI_UID = 1;

const newCI = (c: Card): CI => ({ uid: CI_UID++, c });

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Clefairy Doll en juego se comporta como este Pokémon Básico de 10 PS sin ataques. */
const DOLL_POKEMON: PokemonCard = {
  kind: "pokemon", id: "clefairyDoll", name: "Clefairy Doll", set: "Base Set", number: 70, rarity: "Rare",
  type: "Colorless", hp: 10, stage: "Basic", attacks: [], retreat: 0,
};

/** Entrenador en juego como si fuera un Pokémon (paso "benchSelf", ej. Clefairy Doll). */
const isDoll = (s: Slot): boolean => s.stack[0].c.kind === "trainer";

const DOLL_CACHE = new Map<string, PokemonCard>();
const topCard = (s: Slot): PokemonCard => {
  const c = s.stack[s.stack.length - 1].c;
  if (c.kind === "pokemon") return c;
  let d = DOLL_CACHE.get(c.id);
  if (!d) {
    const hp = Number(stepsHave(c.kind === "trainer" ? c.effect : undefined, "benchSelf")?.hp) || 10;
    DOLL_CACHE.set(c.id, (d = { ...DOLL_POKEMON, id: c.id, name: c.name, number: c.number, rarity: c.rarity, hp }));
  }
  return d;
};
const toolBonus = (s: Slot): number => s.tools.reduce((n, t) => n + (t.bonus ?? 10), 0);
const defenderBonus = (s: Slot): number => s.defenders.reduce((n, t) => n + (t.bonus ?? 20), 0);
const weaknessOf = (s: Slot): EType | undefined => s.weakOverride ?? topCard(s).weakness;
const resistanceOf = (s: Slot): EType | undefined => s.resOverride ?? topCard(s).resistance;
const maxHp = (s: Slot): number => topCard(s).hp;
const remainingHp = (s: Slot): number => Math.max(0, maxHp(s) - s.damage);
const inPlay = (p: PlayerSt): Slot[] => (p.active ? [p.active, ...p.bench] : [...p.bench]);
const isBasic = (c: Card): c is PokemonCard => c.kind === "pokemon" && c.stage === "Basic";

function log(b: Battle, msg: string): void {
  b.log.push(msg);
  if (b.log.length > 80) b.log.shift();
}

function coin(b: Battle): boolean {
  const heads = Math.random() < 0.5;
  log(b, `Moneda: ${heads ? "CARA" : "CRUZ"}`);
  return heads;
}

function draw(p: PlayerSt, n: number): number {
  let k = 0;
  while (k < n && p.deck.length) {
    p.hand.push(p.deck.shift()!);
    k++;
  }
  return k;
}

function makeSlot(c: CI, turn: number): Slot {
  return {
    uid: c.uid, stack: [c], energy: [], tools: [], damage: 0, poisoned: false,
    status: null, statusTurn: 0, enteredTurn: turn, evolvedTurn: -1, stiffenTurn: -1,
    poisonDmg: 10, burn: false, defenders: [], defenderUntil: -1,
    protectTurn: -1, hardenTurn: -1, sandTurn: -1, destinyTurn: -1,
  };
}

/** Al ir a la Banca o evolucionar: se van los estados y los efectos de ataques. */
function clearConditions(s: Slot): void {
  s.status = null;
  s.poisoned = false;
  s.poisonDmg = 10;
  s.protectTurn = s.hardenTurn = s.sandTurn = s.destinyTurn = -1;
  s.weakOverride = s.resOverride = s.amnesia = undefined;
}

// ---------------- Energía unida (incluye Electrode con Buzzap) ----------------
const ciEnergyType = (e: CI): EType => e.asEnergy?.type ?? (e.c as EnergyCard).type;
const ciEnergyUnits = (e: CI): number => e.asEnergy?.n ?? (e.c as EnergyCard).provides ?? 1;

// ---------------- Poder Pokémon "todas las Energías cuentan como Fuego" (Charizard) ----------------
function canEnergyBurn(s: Slot): boolean {
  return cardPowerHas(topCard(s), "energyBurn") && s.status === null;
}

const STATUS_ES: Record<Exclude<Status, null>, string> = {
  asleep: "Dormido",
  paralyzed: "Paralizado",
  confused: "Confundido",
};

// ---------------------------------------------------------------------
//  Preparación
// ---------------------------------------------------------------------
function newPlayer(deck: Deck, name: string, ai: boolean): PlayerSt {
  const cards = deck.cards.flatMap((e) => Array.from({ length: e.qty }, () => newCI(CARDS[e.id])));
  return {
    name, deckName: deck.name, ai, deck: shuffle(cards), hand: [], discard: [], prizes: [],
    active: null, bench: [], turns: 0, mulligans: 0,
  };
}

function newBattle(myDeck: Deck, oppDeck: Deck, myName: string, oppName: string, prizeCount = PRIZES): Battle {
  const b: Battle = {
    p: [newPlayer(myDeck, myName, false), newPlayer(oppDeck, oppName, true)],
    cur: 0, turn: 0, energyPlayed: false, retreated: false, phase: "setup",
    winner: -1, log: [], promoteQueue: [], after: null, first: 0, prizeCount,
  };
  log(b, `Comienza la partida: ${myDeck.name} vs ${oppDeck.name}.`);
  for (const p of b.p) {
    draw(p, 7);
    while (!p.hand.some((c) => isBasic(c.c))) {
      p.mulligans++;
      log(b, `${p.name} no tiene Pokémon Básicos: muestra la mano y vuelve a mezclar.`);
      p.deck.push(...p.hand.splice(0));
      shuffle(p.deck);
      draw(p, 7);
    }
  }
  // por cada mulligan del rival, se roba 1 carta extra
  b.p.forEach((p, i) => {
    const extra = b.p[1 - i].mulligans;
    if (extra > 0) log(b, `${p.name} roba ${draw(p, extra)} carta(s) extra por los mulligans del rival.`);
  });
  return b;
}

function setupActive(b: Battle, pi: number, hi: number): string | null {
  const p = b.p[pi];
  const c = p.hand[hi];
  if (!c || !isBasic(c.c)) return "Tiene que ser un Pokémon Básico.";
  p.hand.splice(hi, 1);
  p.active = makeSlot(c, 0);
  return null;
}

function setupBench(b: Battle, pi: number, hi: number): string | null {
  const p = b.p[pi];
  const c = p.hand[hi];
  if (!c || !isBasic(c.c)) return "Tiene que ser un Pokémon Básico.";
  if (p.bench.length >= BENCH_MAX) return "La Banca está llena (máximo 5).";
  p.hand.splice(hi, 1);
  p.bench.push(makeSlot(c, 0));
  return null;
}

function finishSetup(b: Battle): void {
  for (const p of b.p) p.prizes = p.deck.splice(0, b.prizeCount);
  log(b, b.prizeCount === 1 ? "Cada jugador separa 1 carta de Premio." : `Cada jugador separa ${b.prizeCount} cartas de Premio.`);
  const heads = coin(b);
  b.first = heads ? 0 : 1;
  log(b, `Empieza ${b.p[b.first].name}.`);
  b.cur = b.first;
  b.turn = 1;
  b.phase = "turn";
  startTurn(b);
}

// ---------------------------------------------------------------------
//  Turnos
// ---------------------------------------------------------------------
function startTurn(b: Battle): void {
  const p = b.p[b.cur];
  p.turns++;
  b.energyPlayed = false;
  b.retreated = false;
  log(b, `— Turno de ${p.name} —`);
  if (!p.deck.length) {
    log(b, `${p.name} no puede robar: ¡se quedó sin mazo!`);
    return gameOver(b, 1 - b.cur);
  }
  draw(p, 1);
}

function gameOver(b: Battle, winner: number): void {
  b.phase = "over";
  b.winner = winner;
  log(b, winner === 2 ? "¡Empate!" : `¡${b.p[winner].name} gana la partida!`);
}

function endTurn(b: Battle): void {
  if (b.phase !== "turn") return;
  const p = b.p[b.cur];
  for (const s of inPlay(p)) {
    s.burn = false; // Energy Burn dura solo el turno
    if (s.tools.length) {
      log(b, `Se descarta ${[...new Set(s.tools.map((t) => t.c.name))].join(" y ")} de ${topCard(s).name}.`);
      p.discard.push(...s.tools.splice(0));
    }
  }
  // Defender se descarta al final del turno siguiente del rival
  for (const q of b.p) {
    for (const s of inPlay(q)) {
      if (s.defenders.length && s.defenderUntil <= b.turn) {
        log(b, `Se descarta ${[...new Set(s.defenders.map((t) => t.c.name))].join(" y ")} de ${topCard(s).name}.`);
        q.discard.push(...s.defenders.splice(0));
      }
    }
  }
  // la parálisis dura hasta el final del siguiente turno de su dueño
  if (p.active?.status === "paralyzed" && p.active.statusTurn < b.turn) {
    p.active.status = null;
    log(b, `${topCard(p.active).name} ya no está Paralizado.`);
  }
  // chequeo entre turnos
  for (const q of b.p) {
    const a = q.active;
    if (!a) continue;
    if (a.poisoned) {
      a.damage += a.poisonDmg;
      log(b, `${topCard(a).name} recibe ${a.poisonDmg} de daño por Veneno.`);
    }
    if (a.status === "asleep") {
      log(b, `${topCard(a).name} está Dormido...`);
      if (coin(b)) {
        a.status = null;
        log(b, `¡${topCard(a).name} se despertó!`);
      }
    }
  }
  resolveKOs(b, "nextTurn");
}

function nextTurn(b: Battle): void {
  b.cur = (1 - b.cur) as 0 | 1;
  b.turn++;
  startTurn(b);
}

function continueAfter(b: Battle, after: After): void {
  if (after === "endTurn") endTurn(b);
  else if (after === "nextTurn") nextTurn(b);
  // "resume": se sigue jugando el mismo turno (por ejemplo, tras Scoop Up)
}

/** Descarta a los Pokémon debilitados, reparte premios y chequea victoria. */
function resolveKOs(b: Battle, after: After): void {
  b.p.forEach((p, pi) => {
    for (const s of inPlay(p)) {
      if (s.damage < maxHp(s)) continue;
      log(b, `¡${topCard(s).name} de ${p.name} quedó Fuera de Combate!`);
      for (const e of s.energy) delete e.asEnergy;
      p.discard.push(...s.stack, ...s.energy, ...s.tools, ...s.defenders);
      if (p.active === s) p.active = null;
      else p.bench.splice(p.bench.indexOf(s), 1);
      if (isDoll(s)) {
        log(b, `${s.stack[0].c.name} no cuenta como Pokémon Fuera de Combate: no se toma Premio.`);
        continue;
      }
      const taker = b.p[1 - pi];
      const prize = taker.prizes.shift();
      if (prize) {
        taker.hand.push(prize);
        log(b, `${taker.name} toma un Premio (quedan ${taker.prizes.length}).`);
      }
    }
  });

  const lost = b.p.map((p, pi) => b.p[1 - pi].prizes.length === 0 || inPlay(p).length === 0);
  if (lost[0] || lost[1]) {
    b.p.forEach((p, pi) => {
      if (inPlay(p).length === 0) log(b, `${p.name} no tiene más Pokémon en juego.`);
      if (b.p[1 - pi].prizes.length === 0) log(b, `${b.p[1 - pi].name} tomó todos sus Premios.`);
    });
    return gameOver(b, lost[0] && lost[1] ? 2 : lost[0] ? 1 : 0);
  }

  b.promoteQueue = [0, 1].filter((pi) => !b.p[pi].active);
  if (b.promoteQueue.length) {
    b.phase = "promote";
    b.after = after;
    return;
  }
  b.phase = "turn";
  continueAfter(b, after);
}

function promote(b: Battle, pi: number, benchIdx: number): string | null {
  if (b.phase !== "promote" || !b.promoteQueue.includes(pi)) return "No hace falta elegir ahora.";
  const p = b.p[pi];
  const s = p.bench[benchIdx];
  if (!s) return "Elegí un Pokémon de tu Banca.";
  p.bench.splice(benchIdx, 1);
  p.active = s;
  log(b, `${p.name} pone a ${topCard(s).name} como Pokémon Activo.`);
  b.promoteQueue = b.promoteQueue.filter((x) => x !== pi);
  if (!b.promoteQueue.length) {
    b.phase = "turn";
    const after = b.after!;
    b.after = null;
    continueAfter(b, after);
  }
  return null;
}

// ---------------------------------------------------------------------
//  Acciones del turno
// ---------------------------------------------------------------------
function turnCheck(b: Battle, pi: number): string | null {
  if (b.phase !== "turn") return "Ahora no se puede.";
  if (b.cur !== pi) return "No es tu turno.";
  return null;
}

function playBasic(b: Battle, pi: number, hi: number): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  const c = p.hand[hi];
  if (!c || !isBasic(c.c)) return "No es un Pokémon Básico.";
  if (p.bench.length >= BENCH_MAX) return "Tu Banca está llena (máximo 5).";
  p.hand.splice(hi, 1);
  p.bench.push(makeSlot(c, b.turn));
  log(b, `${p.name} pone a ${c.c.name} en la Banca.`);
  return null;
}

function evolveError(b: Battle, pi: number, c: Card, s: Slot): string | null {
  if (c.kind !== "pokemon" || c.stage === "Basic") return "No es una carta de evolución.";
  if (c.evolvesFrom !== topCard(s).name) return `${c.name} evoluciona de ${c.evolvesFrom}.`;
  if (b.p[pi].turns <= 1) return "No se puede evolucionar en tu primer turno.";
  if (s.enteredTurn === b.turn) return "Ese Pokémon entró en juego este turno.";
  if (s.evolvedTurn === b.turn) return "Ese Pokémon ya evolucionó este turno.";
  return null;
}

function evolveTargets(b: Battle, pi: number, hi: number): Slot[] {
  const c = b.p[pi].hand[hi]?.c;
  return c ? inPlay(b.p[pi]).filter((s) => !evolveError(b, pi, c, s)) : [];
}

function evolve(b: Battle, pi: number, hi: number, s: Slot): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  const c = p.hand[hi];
  const e = evolveError(b, pi, c.c, s);
  if (e) return e;
  const from = topCard(s).name;
  p.hand.splice(hi, 1);
  s.stack.push(c);
  s.evolvedTurn = b.turn;
  clearConditions(s);
  log(b, `¡${from} evolucionó a ${c.c.name}!`);
  return null;
}

function attachEnergy(b: Battle, pi: number, hi: number, s: Slot): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  if (b.energyPlayed) return "Ya uniste una Energía este turno.";
  const p = b.p[pi];
  const c = p.hand[hi];
  if (!c || c.c.kind !== "energy") return "No es una carta de Energía.";
  p.hand.splice(hi, 1);
  s.energy.push(c);
  b.energyPlayed = true;
  log(b, `${p.name} une ${c.c.name} a ${topCard(s).name}.`);
  return null;
}

// ---------------- Costo de energía ----------------
/** Energía que provee un Pokémon (Double Colorless Energy cuenta como 2 Incoloras). */
function energyTypes(s: Slot): EType[] {
  return s.energy.flatMap((e) => Array<EType>(ciEnergyUnits(e)).fill(s.burn ? "Fire" : ciEnergyType(e)));
}

const energyUnits = (s: Slot): number => energyTypes(s).length;

/** ¿Se puede pagar usando Energy Burn (todas las energías como Fuego)? */
const payableWithBurn = (s: Slot, cost: EType[]): boolean =>
  canEnergyBurn(s) && missingEnergy(energyTypes({ ...s, burn: true }), cost) === 0;

/** Cuántas energías faltan para pagar un costo. */
function missingEnergy(have: EType[], cost: EType[]): number {
  const pool = [...have];
  let missing = 0;
  for (const t of cost) {
    if (t === "Colorless") continue;
    const i = pool.indexOf(t);
    if (i >= 0) pool.splice(i, 1);
    else missing++;
  }
  const colorless = cost.filter((t) => t === "Colorless").length;
  return missing + Math.max(0, colorless - pool.length);
}

const canPay = (s: Slot, cost: EType[]): boolean => missingEnergy(energyTypes(s), cost) === 0;

/** Descarta una Energía: la del índice indicado o, si no, la última (del tipo pedido). */
function discardEnergy(p: PlayerSt, s: Slot, type?: EType, index?: number): CI | undefined {
  let i = index !== undefined && s.energy[index] && (!type || ciEnergyType(s.energy[index]) === type) ? index : -1;
  for (let k = s.energy.length - 1; k >= 0 && i < 0; k--) {
    if (!type || ciEnergyType(s.energy[k]) === type) i = k;
  }
  if (i < 0) return undefined;
  const [e] = s.energy.splice(i, 1);
  delete e.asEnergy;
  p.discard.push(e);
  return e;
}

// ---------------- Retirada ----------------
function retreatError(b: Battle, pi: number): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  const a = p.active;
  if (!a) return "No tenés Pokémon Activo.";
  if (b.retreated) return "Ya te retiraste este turno.";
  if (!p.bench.length) return "No tenés Pokémon en la Banca.";
  if (isDoll(a)) return `${topCard(a).name} no puede retirarse.`;
  if (a.status === "asleep" || a.status === "paralyzed") return `No puede retirarse: está ${STATUS_ES[a.status]}.`;
  if (energyUnits(a) < topCard(a).retreat) return `Necesita ${topCard(a).retreat} Energía(s) para retirarse.`;
  return null;
}

/** energies: índices de las Energías a descartar (si no se indican, las últimas). */
function retreat(b: Battle, pi: number, benchIdx: number, energies?: number[]): string | null {
  const err = retreatError(b, pi);
  if (err) return err;
  const p = b.p[pi];
  const a = p.active!;
  const s = p.bench[benchIdx];
  if (!s) return "Elegí un Pokémon de la Banca.";
  b.retreated = true;
  if (a.status === "confused") {
    log(b, `${topCard(a).name} está Confundido e intenta retirarse...`);
    if (!coin(b)) {
      log(b, "¡No pudo retirarse!");
      return null;
    }
  }
  const cost = topCard(a).retreat;
  const chosen = (energies ?? []).filter((i) => a.energy[i]).map((i) => a.energy[i]);
  let paid = 0;
  for (const e of chosen) {
    if (paid >= cost) break;
    discardEnergy(p, a, undefined, a.energy.indexOf(e));
    paid += ciEnergyUnits(e);
  }
  while (paid < cost) {
    const e = discardEnergy(p, a);
    if (!e) break;
    paid += ciEnergyUnits(e);
  }
  p.bench[benchIdx] = a;
  p.active = s;
  clearConditions(a);
  log(b, `${topCard(a).name} se retira. ${topCard(s).name} pasa a ser el Activo.`);
  return null;
}

// ---------------- Entrenadores (como pasos) ----------------
// Cada Entrenador tiene una lista de pasos (card.effect) que se ejecutan en
// orden. Igual que en ataques y Poderes, el texto impreso no se lee.

/** Qué cartas acepta un paso (mano, mazo, pila de descarte). */
function matchFilter(c: Card, f?: string): boolean {
  switch (f) {
    case "pokemon": return c.kind === "pokemon";
    case "basic": return isBasic(c);
    case "evolution": return c.kind === "pokemon" && c.stage !== "Basic";
    case "trainer": return c.kind === "trainer";
    case "energy": return c.kind === "energy";
    case "basicEnergy": return isBasicEnergy(c);
    default: return true;
  }
}
const FILTER_ES: Record<string, [string, string]> = {
  any: ["carta", "cartas"],
  pokemon: ["Pokémon", "Pokémon"],
  basic: ["Pokémon Básico", "Pokémon Básicos"],
  evolution: ["carta de Evolución", "cartas de Evolución"],
  trainer: ["Entrenador", "Entrenadores"],
  energy: ["Energía", "Energías"],
  basicEnergy: ["Energía básica", "Energías básicas"],
};
const filterEs = (f: string | undefined, n: number): string => (FILTER_ES[f || "any"] ?? FILTER_ES.any)[n === 1 ? 0 : 1];

/** Lo que eligió el jugador para un paso. */
interface TPick {
  slot?: Slot;
  cards?: CI[];
  energies?: CI[];
  order?: number[]; // arrangeTop: nuevo orden de las cartas de arriba
  stage?: number; // devolve: desde qué fase se descarta (1 o 2)
}

/** Elecciones con las que se juega un Entrenador. Lo que no se indique se elige solo. */
interface TChoice {
  slot?: Slot; // atajo (la IA): lo que se elige en el primer "Elegir Pokémon"
  picks?: Record<number, TPick>; // por índice de paso
}

const trainerSteps = (c: Card): Step[] => (c.kind === "trainer" ? c.effect ?? [] : []);

/** Pokémon que acepta un paso "Elegir Pokémon". */
function slotCandidates(b: Battle, pi: number, st: Step): Slot[] {
  const side = b.p[st.side === "opp" ? 1 - pi : pi];
  let list = st.where === "active" ? (side.active ? [side.active] : []) : st.where === "bench" ? [...side.bench] : inPlay(side);
  switch (st.where) {
    case "damaged": list = list.filter((s) => s.damage > 0); break;
    case "damagedEnergy": list = list.filter((s) => s.damage > 0 && s.energy.length > 0); break;
    case "energy": list = list.filter((s) => s.energy.length > 0); break;
    case "evolved": list = list.filter((s) => s.stack.length > 1); break;
    case "status": list = list.filter((s) => s.status || s.poisoned); break;
  }
  return list;
}

function slotError(st: Step): string {
  const own = st.side !== "opp";
  switch (st.where) {
    case "active": return own ? "No tenés Pokémon Activo." : "El rival no tiene Pokémon Activo.";
    case "bench": return own ? "No tenés Pokémon en la Banca." : "El rival no tiene Pokémon en la Banca.";
    case "damaged": return own ? "Ninguno de tus Pokémon tiene daño." : "Ningún Pokémon del rival tiene daño.";
    case "damagedEnergy": return "Necesitás un Pokémon con daño y alguna Energía unida.";
    case "energy": return own ? "Ninguno de tus Pokémon tiene Energía unida." : "Los Pokémon del rival no tienen Energía.";
    case "evolved": return own ? "No tenés Pokémon evolucionados." : "El rival no tiene Pokémon evolucionados.";
    case "status": return "Ese Pokémon no tiene ningún estado.";
    default: return "No hay Pokémon para elegir.";
  }
}

/** Básicos en juego sobre los que puede ir esta Fase 2 salteando la Fase 1. */
function breederTargets(b: Battle, pi: number, stage2: Card): Slot[] {
  if (stage2.kind !== "pokemon" || stage2.stage !== "Stage 2") return [];
  const stage1 = Object.values(CARDS).find((c) => c.kind === "pokemon" && c.name === stage2.evolvesFrom) as
    | PokemonCard
    | undefined;
  const p = b.p[pi];
  if (!stage1?.evolvesFrom || p.turns <= 1) return [];
  return inPlay(p).filter(
    (s) =>
      s.stack.length === 1 && !isDoll(s) && topCard(s).name === stage1.evolvesFrom &&
      s.enteredTurn !== b.turn && s.evolvedTurn !== b.turn,
  );
}

/** Índices de la mano con una Fase 2 que se puede poner salteando la Fase 1. */
const breederStage2s = (b: Battle, pi: number): number[] =>
  b.p[pi].hand.map((x, i) => (breederTargets(b, pi, x.c).length ? i : -1)).filter((i) => i >= 0);

/** Por qué no se puede jugar este Entrenador ahora (null = se puede). */
function trainerError(b: Battle, pi: number, hi: number): string | null {
  const p = b.p[pi];
  const o = b.p[1 - pi];
  const card = p.hand[hi];
  if (!card || card.c.kind !== "trainer") return "No es un Entrenador.";
  const steps = trainerSteps(card.c);
  if (!steps.length) return `${card.c.name} todavía no tiene efecto en el juego.`;
  let others = p.hand.length - 1; // cartas de la mano que quedan para los pasos
  let chosen: Slot[] = [];
  const handLeft = (f?: string) => p.hand.filter((x) => x !== card && matchFilter(x.c, f)).length;
  for (const st of steps) {
    const n = Math.max(1, Number(st.count) || 1);
    switch (st.op) {
      case "chooseSlot":
        chosen = slotCandidates(b, pi, st);
        if (!chosen.length) return slotError(st);
        break;
      case "cureStatus": {
        const s = st.target === "chosen" ? chosen : p.active ? [p.active] : [];
        if (!s.some((x) => x.status || x.poisoned)) return st.target === "chosen" ? "Ese Pokémon no tiene ningún estado." : "Tu Pokémon Activo no tiene ningún estado.";
        break;
      }
      case "healAll":
        if (!inPlay(p).some((s) => s.damage > 0)) return "Ninguno de tus Pokémon tiene daño.";
        break;
      case "draw":
      case "arrangeTop":
        if (st.who !== "opp" && !p.deck.length) return "Tu mazo está vacío.";
        break;
      case "discardFromHand":
      case "handToDeck":
        if ((st.op === "discardFromHand" || st.who === "me" || !st.who) && Number(st.count) > 0) {
          if (handLeft(st.filter) < n || others < n) {
            return n === 1 && st.filter && st.filter !== "any"
              ? `No tenés ${filterEs(st.filter, 2)} en la mano.`
              : `Necesitás otras ${n} carta${n === 1 ? "" : "s"} en la mano.`;
          }
          others -= n;
        }
        break;
      case "searchDeck":
        if (!p.deck.length) return "Tu mazo está vacío.";
        if (!p.deck.some((x) => matchFilter(x.c, st.filter))) return `No quedan ${filterEs(st.filter, 2)} en tu mazo.`;
        break;
      case "fromDiscard": {
        const q = st.side === "opp" ? o : p;
        if (st.to === "bench" && q.bench.length >= BENCH_MAX) return st.side === "opp" ? "La Banca del rival está llena." : "Tu Banca está llena.";
        if (!q.discard.some((x) => matchFilter(x.c, st.filter))) {
          return `No hay ${filterEs(st.filter, 2)} en ${st.side === "opp" ? "el descarte del rival" : "tu pila de descarte"}.`;
        }
        break;
      }
      case "benchSelf":
        if (p.bench.length >= BENCH_MAX) return "Tu Banca está llena.";
        break;
      case "returnToHand":
        if (inPlay(p).length < 2) return "No podés quedarte sin Pokémon en juego.";
        break;
      case "evolveSkip":
        if (!breederStage2s(b, pi).length) return "Necesitás una Fase 2 en la mano y su Básico en juego (y poder evolucionarlo).";
        break;
    }
  }
  return null;
}

interface TrainerCtx {
  b: Battle;
  pi: number;
  p: PlayerSt;
  o: PlayerSt;
  card: CI;
  chosen: Slot | null;
  moved: Set<CI>; // cartas que ya movió este Entrenador (no se eligen dos veces)
  stays: boolean; // la carta queda en juego (PlusPower, Defender, Clefairy Doll)
  checkKO: boolean;
}

const removeFrom = (pile: CI[], x: CI) => {
  const i = pile.indexOf(x);
  if (i >= 0) pile.splice(i, 1);
};
const ownerOf = (b: Battle, s: Slot): PlayerSt => (inPlay(b.p[0]).includes(s) ? b.p[0] : b.p[1]);

function playTrainer(b: Battle, pi: number, hi: number, ch: TChoice = {}): string | null {
  const err = turnCheck(b, pi) ?? trainerError(b, pi, hi);
  if (err) return err;
  const p = b.p[pi];
  const card = p.hand[hi];
  const steps = trainerSteps(card.c);
  const picks: Record<number, TPick> = { ...(ch.picks ?? {}) };
  if (ch.slot) {
    const i = steps.findIndex((s) => s.op === "chooseSlot");
    if (i >= 0 && !picks[i]) picks[i] = { slot: ch.slot };
  }
  // validar lo elegido antes de tocar nada
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const pk = picks[i];
    if (st.op === "chooseSlot" && pk?.slot && !slotCandidates(b, pi, st).includes(pk.slot)) return "Objetivo no válido.";
    if (st.op === "evolveSkip" && pk?.cards?.[0] && pk.slot && !breederTargets(b, pi, pk.cards[0].c).includes(pk.slot)) {
      return "Esa Fase 2 no puede ir sobre ese Pokémon.";
    }
  }

  removeFrom(p.hand, card);
  log(b, `${p.name} juega ${card.c.name}.`);
  const x: TrainerCtx = { b, pi, p, o: b.p[1 - pi], card, chosen: null, moved: new Set([card]), stays: false, checkKO: false };
  steps.forEach((st, i) => runTrainerStep(x, st, picks[i] ?? {}));
  if (!x.stays) p.discard.push(card);
  if (x.checkKO) resolveKOs(b, "resume");
  return null;
}

/** Elige `n` cartas de `pile`: las indicadas (si son válidas) o las que diga `auto`. */
function takeCards(x: TrainerCtx, pile: CI[], f: string | undefined, n: number, picked: CI[] | undefined, auto: (ok: CI[]) => CI[]): CI[] {
  const ok = pile.filter((c) => !x.moved.has(c) && matchFilter(c.c, f));
  const sel = (picked ?? []).filter((c) => ok.includes(c));
  const res = sel.length ? sel.slice(0, n) : auto(ok).slice(0, n);
  for (const c of res) x.moved.add(c);
  return res;
}

function runTrainerStep(x: TrainerCtx, st: Step, pk: TPick): void {
  const { b, p, o } = x;
  const target = (): Slot | null => (st.target === "myActive" ? p.active : st.target === "oppActive" ? o.active : x.chosen);
  const n = Number(st.count) || 0;
  switch (st.op) {
    case "chooseSlot": {
      const cands = slotCandidates(b, x.pi, st);
      x.chosen = pk.slot && cands.includes(pk.slot) ? pk.slot : cands[0] ?? null;
      break;
    }
    case "heal": {
      const s = target();
      if (!s) break;
      const amt = Number(st.amount) || 0;
      const h = amt > 0 ? Math.min(amt, s.damage) : s.damage;
      s.damage -= h;
      log(b, `${topCard(s).name} recupera ${h} PS.`);
      break;
    }
    case "discardEnergyOf": {
      const s = target();
      if (!s) break;
      const q = ownerOf(b, s);
      const type = (st.type || undefined) as EType | undefined;
      const ok = s.energy.filter((e) => !type || ciEnergyType(e) === type);
      const want = n > 0 ? n : ok.length;
      const sel = (pk.energies ?? []).filter((e) => ok.includes(e)).slice(0, want);
      const list = sel.length ? sel : ok.slice(-want);
      for (const e of list) {
        discardEnergy(q, s, undefined, s.energy.indexOf(e));
        log(b, `Se descarta ${e.c.name} de ${topCard(s).name}.`);
      }
      break;
    }
    case "switchIn": {
      const s = target();
      if (!s) break;
      const q = ownerOf(b, s);
      const i = q.bench.indexOf(s);
      if (i < 0 || !q.active) break;
      const old = q.active;
      q.bench[i] = old;
      q.active = s;
      clearConditions(old);
      log(b, q === p ? `${topCard(s).name} pasa a ser el Pokémon Activo.` : `¡${topCard(s).name} del rival es arrastrado al frente!`);
      break;
    }
    case "attachTool": {
      const s = target();
      if (!s) break;
      x.card.bonus = Number(st.amount) || (st.mode === "minus" ? 20 : 10);
      if (st.mode === "minus") {
        s.defenders.push(x.card);
        s.defenderUntil = b.turn + 1;
        log(b, `${x.card.c.name} queda unido a ${topCard(s).name}: recibe ${x.card.bonus} de daño menos hasta el final del próximo turno del rival.`);
      } else {
        s.tools.push(x.card);
        log(b, `${x.card.c.name} queda unido a ${topCard(s).name}: sus ataques hacen ${x.card.bonus} más este turno.`);
      }
      x.stays = true;
      break;
    }
    case "cureStatus": {
      const s = st.target === "chosen" ? x.chosen : p.active;
      if (!s) break;
      s.status = null;
      s.poisoned = false;
      s.poisonDmg = 10;
      log(b, `${topCard(s).name} ya no tiene estados.`);
      break;
    }
    case "healAll":
      for (const q of inPlay(p).filter((s) => s.damage > 0)) {
        q.damage = 0;
        if (st.discardEnergy) {
          for (const e of q.energy) delete e.asEnergy;
          p.discard.push(...q.energy.splice(0));
        }
        log(b, `${topCard(q).name} se cura por completo${st.discardEnergy ? " y descarta sus Energías" : ""}.`);
      }
      break;
    case "returnToHand": {
      const s = target();
      if (!s) break;
      const [basic, ...rest] = s.stack;
      for (const e of s.energy) delete e.asEnergy;
      p.discard.push(...rest, ...s.energy, ...s.tools, ...s.defenders);
      p.hand.push(basic);
      log(b, `${basic.c.name} vuelve a la mano. Se descarta todo lo que tenía unido.`);
      if (p.active === s) {
        p.active = null;
        b.promoteQueue = [x.pi];
        b.phase = "promote";
        b.after = "resume";
      } else p.bench.splice(p.bench.indexOf(s), 1);
      break;
    }
    case "devolve": {
      const s = target();
      if (!s || s.stack.length < 2) break;
      const stage = Math.max(1, Math.min(s.stack.length - 1, pk.stage ?? s.stack.length - 1));
      const removed = s.stack.splice(stage);
      ownerOf(b, s).discard.push(...removed);
      clearConditions(s);
      log(b, `${removed.map((c) => c.c.name).join(" y ")} se descarta: queda ${topCard(s).name}.`);
      x.checkKO = true; // con menos PS puede quedar Fuera de Combate
      break;
    }
    case "evolveSkip": {
      let s2 = pk.cards?.[0];
      let s = pk.slot;
      if (!s2 || !p.hand.includes(s2) || !s || !breederTargets(b, x.pi, s2.c).includes(s)) {
        s2 = p.hand.find((c) => breederTargets(b, x.pi, c.c).length);
        s = s2 && breederTargets(b, x.pi, s2.c)[0];
      }
      if (!s2 || !s) break;
      const from = topCard(s).name;
      removeFrom(p.hand, s2);
      s.stack.push(s2);
      s.evolvedTurn = b.turn;
      clearConditions(s);
      log(b, `¡${from} evoluciona directamente a ${s2.c.name}!`);
      break;
    }
    case "draw": {
      const who = st.who === "opp" ? [o] : st.who === "both" ? [p, o] : [p];
      for (const q of who) log(b, `${q.name} roba ${draw(q, Math.max(1, n))} carta(s).`);
      break;
    }
    case "discardHand": {
      const who = st.who === "opp" ? [o] : st.who === "both" ? [p, o] : [p];
      for (const q of who) {
        const k = q.hand.length;
        q.discard.push(...q.hand.splice(0));
        log(b, `${q.name} descarta su mano (${k}).`);
      }
      break;
    }
    case "handToDeck": {
      const who = st.who === "opp" ? [o] : st.who === "both" ? [p, o] : [p];
      for (const q of who) {
        const moving = n > 0 && q === p
          ? takeCards(x, q.hand, st.filter, n, pk.cards, (ok) => ok)
          : q.hand.filter((c) => matchFilter(c.c, st.filter) && !x.moved.has(c));
        for (const c of moving) removeFrom(q.hand, c);
        q.deck.push(...moving);
        shuffle(q.deck);
        log(b, `${q.name} mezcla ${moving.length} carta(s) de su mano en su mazo.`);
      }
      break;
    }
    case "discardFromHand": {
      const list = takeCards(x, p.hand, st.filter, Math.max(1, n), pk.cards, (ok) => ok);
      for (const c of list) removeFrom(p.hand, c);
      p.discard.push(...list);
      log(b, `${p.name} descarta ${list.map((c) => c.c.name).join(" y ")}.`);
      break;
    }
    case "searchDeck": {
      const list = takeCards(x, p.deck, st.filter, Math.max(1, n), pk.cards, (ok) => ok);
      for (const c of list) removeFrom(p.deck, c);
      p.hand.push(...list);
      shuffle(p.deck);
      log(b, `${p.name} busca ${list.map((c) => c.c.name).join(" y ") || "nada"} en su mazo.`);
      break;
    }
    case "fromDiscard": {
      const q = st.side === "opp" ? o : p;
      const hp = (c: CI) => (c.c.kind === "pokemon" ? c.c.hp : 0);
      const room = st.to === "bench" ? BENCH_MAX - q.bench.length : Infinity;
      const list = takeCards(x, q.discard, st.filter, Math.min(Math.max(1, n), room), pk.cards, (ok) =>
        st.to === "bench" ? [...ok].sort((a, c) => (q === p ? hp(c) - hp(a) : hp(a) - hp(c))) : [...ok].reverse());
      for (const c of list) {
        removeFrom(q.discard, c);
        if (st.to === "bench" && c.c.kind === "pokemon") {
          const ns = makeSlot(c, b.turn);
          if (st.halfHp) ns.damage = Math.floor(c.c.hp / 2 / 10) * 10;
          q.bench.push(ns);
          log(b, `${c.c.name} vuelve a la Banca de ${q.name}${ns.damage ? ` con ${ns.damage} de daño` : ""}.`);
        } else {
          q.hand.push(c);
          log(b, `${q.name} recupera ${c.c.name} de la pila de descarte.`);
        }
      }
      break;
    }
    case "arrangeTop": {
      const k = Math.min(Math.max(1, n || 5), p.deck.length);
      const top = p.deck.splice(0, k);
      const ord = pk.order;
      const valid = ord && ord.length === k && new Set(ord).size === k && ord.every((i) => i >= 0 && i < k);
      p.deck.unshift(...(valid ? ord!.map((i) => top[i]) : top));
      log(b, `${p.name} mira y ordena las ${k} cartas de arriba de su mazo.`);
      break;
    }
    case "benchSelf":
      p.bench.push(makeSlot(x.card, b.turn));
      log(b, `${p.name} pone a ${x.card.c.name} en la Banca como si fuera un Pokémon Básico.`);
      x.stays = true;
      break;
    case "log":
      if (st.text) log(b, String(st.text));
      break;
  }
}

/** Descartar Clefairy Doll en cualquier momento de tu turno (no cuenta como Fuera de Combate). */
function discardDoll(b: Battle, pi: number, s: Slot): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  if (!isDoll(s) || !inPlay(p).includes(s)) return "Elegí un Entrenador que esté en juego como Pokémon.";
  if (inPlay(p).length < 2) return "No podés quedarte sin Pokémon en juego.";
  for (const e of s.energy) delete e.asEnergy;
  p.discard.push(...s.stack, ...s.energy, ...s.tools, ...s.defenders);
  log(b, `${p.name} descarta ${s.stack[0].c.name}.`);
  if (p.active === s) {
    p.active = null;
    b.promoteQueue = [pi];
    b.phase = "promote";
    b.after = "resume";
  } else p.bench.splice(p.bench.indexOf(s), 1);
  return null;
}

// ---------------------------------------------------------------------
//  Efectos como pasos
//  Cada ataque y cada Poder tiene una lista de pasos (card.attacks[i].effect,
//  card.power.effect) que se ejecutan en orden. El texto impreso NO se lee:
//  cambiar la redacción de una carta no cambia lo que hace.
// ---------------------------------------------------------------------

/** Busca un paso (también dentro de los "si…") y lo devuelve. */
function stepsHave(steps: Step[] | undefined, op: string): Step | undefined {
  for (const s of steps ?? []) {
    if (s.op === op) return s;
    const inner = stepsHave(s.then, op) ?? stepsHave(s.else, op);
    if (inner) return inner;
  }
  return undefined;
}

/** Pasos de Poder que se usan a mano (desde PODERES). Los demás son automáticos. */
const ACTIVE_POWER_OPS = ["attachFromHand", "moveEnergy", "moveDamage", "knockOutSelf", "becomeEnergy"];
const powerSteps = (s: Slot): Step[] => topCard(s).power?.effect ?? [];
const cardPowerHas = (c: Card | undefined, op: string): boolean =>
  c?.kind === "pokemon" && !!stepsHave(c.power?.effect, op);
const isActivePowerCard = (c: Card): boolean =>
  c.kind === "pokemon" && ACTIVE_POWER_OPS.some((op) => !!stepsHave(c.power?.effect, op));

/** Energía básica de un tipo (por sus datos, no por su id). */
const isBasicEnergyOf = (x: CI, type?: EType): boolean =>
  !x.asEnergy && x.c.kind === "energy" && !x.c.special && (!type || x.c.type === type);

// ---------------------------------------------------------------------
//  Poderes Pokémon que se activan
// ---------------------------------------------------------------------
interface PowerChoice {
  hand?: number; // attachFromHand: la Energía de la mano
  from?: Slot; // moveEnergy / moveDamage: origen
  target?: Slot; // destino
  energy?: number; // moveEnergy: cuál Energía mover (índice en from.energy)
  type?: EType; // becomeEnergy: tipo de Energía
}

/** Pokémon propios con un Poder que se puede usar ahora mismo. */
function powerSlots(b: Battle, pi: number): Slot[] {
  return inPlay(b.p[pi]).filter((s) => isActivePowerCard(topCard(s)) && !powerError(b, pi, s));
}

function powerError(b: Battle, pi: number, s: Slot): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  if (!isActivePowerCard(topCard(s))) return "Ese Pokémon no tiene un Poder que se active.";
  if (s.status) return `No puede usar su Poder: está ${STATUS_ES[s.status]}.`;
  const mine = inPlay(p);
  for (const st of powerSteps(s)) {
    switch (st.op) {
      case "attachFromHand":
        if (!p.hand.some((x) => isBasicEnergyOf(x, st.energy))) return `No tenés ${st.energy ? `${TYPE_NAMES_ES[st.energy as EType]} ` : ""}Energía en la mano.`;
        if (st.toType && !mine.some((x) => topCard(x).type === st.toType)) return `No tenés Pokémon de tipo ${TYPE_NAMES_ES[st.toType as EType]}.`;
        break;
      case "moveEnergy":
        if (!mine.some((x) => x.energy.some((e) => isBasicEnergyOf(e, st.type)))) return "Ninguno de tus Pokémon tiene esa Energía.";
        if (mine.length < 2) return "Necesitás otro Pokémon para mover la Energía.";
        break;
      case "moveDamage":
        if (!mine.some((x) => x.damage > 0)) return "Ninguno de tus Pokémon tiene daño.";
        if (mine.length < 2) return "Necesitás otro Pokémon para mover el daño.";
        break;
      case "becomeEnergy":
        if (mine.length < 2) return `Necesitás otro Pokémon para unirle a ${topCard(s).name}.`;
        break;
    }
  }
  return null;
}

function usePower(b: Battle, pi: number, s: Slot, ch: PowerChoice = {}): string | null {
  const err = powerError(b, pi, s);
  if (err) return err;
  const p = b.p[pi];
  const card = topCard(s);
  const name = card.name;
  const pw = card.power!.name;
  const mine = inPlay(p);
  const others = mine.filter((x) => x !== s);
  let selfCard: CI | null = null; // knockOutSelf: la carta que quedó fuera de juego
  let koed = false;
  for (const st of powerSteps(s)) {
    switch (st.op) {
      case "attachFromHand": {
        const ok = (x: CI) => isBasicEnergyOf(x, st.energy);
        const hi = ch.hand !== undefined && p.hand[ch.hand] && ok(p.hand[ch.hand]) ? ch.hand : p.hand.findIndex(ok);
        const fits = (x: Slot) => !st.toType || topCard(x).type === st.toType;
        const t = ch.target && mine.includes(ch.target) && fits(ch.target) ? ch.target : mine.find(fits)!;
        const [e] = p.hand.splice(hi, 1);
        t.energy.push(e);
        log(b, `${name} usa ${pw}: une ${e.c.name} a ${topCard(t).name}.`);
        break;
      }
      case "moveEnergy": {
        const ok = (e: CI) => isBasicEnergyOf(e, st.type);
        const from = ch.from && mine.includes(ch.from) && ch.from.energy.some(ok) ? ch.from : mine.find((x) => x.energy.some(ok))!;
        const t = ch.target && ch.target !== from && mine.includes(ch.target) ? ch.target : mine.find((x) => x !== from)!;
        const i = ch.energy !== undefined && from.energy[ch.energy] && ok(from.energy[ch.energy]) ? ch.energy : from.energy.findIndex(ok);
        const [e] = from.energy.splice(i, 1);
        t.energy.push(e);
        log(b, `${name} usa ${pw}: mueve ${e.c.name} de ${topCard(from).name} a ${topCard(t).name}.`);
        break;
      }
      case "moveDamage": {
        const n = 10 * (Number(st.counters) || 1);
        const from = ch.from && ch.from.damage > 0 && mine.includes(ch.from) ? ch.from : mine.find((x) => x.damage > 0)!;
        const t = ch.target && ch.target !== from && mine.includes(ch.target) ? ch.target : mine.find((x) => x !== from && remainingHp(x) > n);
        if (!t || remainingHp(t) <= n) return "Ese Pokémon quedaría Fuera de Combate: elegí otro.";
        const moved = Math.min(n, from.damage);
        from.damage -= moved;
        t.damage += moved;
        log(b, `${name} usa ${pw}: mueve ${moved / 10} contador(es) de daño de ${topCard(from).name} a ${topCard(t).name}.`);
        break;
      }
      case "knockOutSelf": {
        // queda Fuera de Combate: lo que tenía debajo y unido se descarta y el rival toma un Premio
        selfCard = s.stack[s.stack.length - 1];
        for (const e of s.energy) delete e.asEnergy;
        p.discard.push(...s.stack.slice(0, -1), ...s.energy, ...s.tools, ...s.defenders);
        if (p.active === s) p.active = null;
        else p.bench.splice(p.bench.indexOf(s), 1);
        log(b, `¡${name} usa ${pw} y queda Fuera de Combate!`);
        koed = true;
        const taker = b.p[1 - pi];
        const prize = taker.prizes.shift();
        if (prize) {
          taker.hand.push(prize);
          log(b, `${taker.name} toma un Premio (quedan ${taker.prizes.length}).`);
        }
        break;
      }
      case "becomeEnergy": {
        const t = ch.target && others.includes(ch.target) ? ch.target : others[0];
        const type: EType = ch.type && ch.type !== "Colorless" ? ch.type : topCard(t).type === "Colorless" ? "Lightning" : topCard(t).type;
        const ci = selfCard ?? s.stack[s.stack.length - 1];
        ci.asEnergy = { type, n: Number(st.provides) || 2 };
        t.energy.push(ci);
        selfCard = null;
        log(b, `${card.name} se une a ${topCard(t).name} como Energía (${ci.asEnergy.n} de ${TYPE_NAMES_ES[type]}).`);
        break;
      }
      case "log":
        if (st.text) log(b, String(st.text));
        break;
    }
  }
  if (selfCard) p.discard.push(selfCard);
  if (koed) resolveKOs(b, "resume"); // chequea victoria y si hace falta un nuevo Activo
  return null;
}

// ---------------------------------------------------------------------
//  Ataques
// ---------------------------------------------------------------------
/** Elecciones del atacante (lo que no se indique se elige solo). */
interface AttackChoice {
  attackIdx?: number; // Metronome / Amnesia: ataque del Pokémon Defensor
  type?: EType; // cambiar Debilidad / Resistencia
  energy?: number; // descartar Energía del Defensor
}

interface AtkCtx {
  b: Battle;
  me: PlayerSt;
  opp: PlayerSt;
  a: Slot;
  d: Slot;
  atk: Attack;
  target?: Slot;
  choice?: AttackChoice;
  copy?: boolean; // Metronome: no se pagan costos adicionales (descartes)
  flips: number; // monedas de la última tirada
  heads: number;
  tails: number;
  dealt: number; // daño hecho al Defensor por este ataque
  stopped: boolean;
}

/** Agility / Barrier: el Defensor está protegido de todos los efectos de ataques. */
function shielded(x: AtkCtx): boolean {
  if (x.d.protectTurn !== x.b.turn) return false;
  log(x.b, `${topCard(x.d).name} está protegido: el ataque no le hace efecto.`);
  return true;
}

/** Aplica daño al Pokémon Defensor con Debilidad, Resistencia, PlusPower y protecciones. */
function dealDamage(x: AtkCtx, base: number): number {
  if (base <= 0) return 0;
  if (shielded(x)) return 0;
  const atkType = topCard(x.a).type;
  const def = topCard(x.d);
  let dmg = base;
  if (weaknessOf(x.d) === atkType) dmg *= 2;
  if (resistanceOf(x.d) === atkType) dmg = Math.max(0, dmg - 30);
  if (dmg > 0) dmg += toolBonus(x.a);
  if (dmg > 0 && x.d.defenders.length) dmg = Math.max(0, dmg - defenderBonus(x.d));
  if (x.d.stiffenTurn === x.b.turn) {
    log(x.b, `¡${def.name} está protegido y no recibe daño!`);
    return 0;
  }
  if (x.d.hardenTurn === x.b.turn && dmg <= (x.d.hardenMax ?? 30)) {
    log(x.b, `¡${def.name} está endurecido: se previenen los ${dmg} de daño!`);
    return 0;
  }
  x.d.damage += dmg;
  if (x.d.lastHit?.turn === x.b.turn) x.d.lastHit.damage += dmg;
  log(x.b, `${def.name} recibe ${dmg} de daño.`);
  // Poder automático "devolver daño" (Machamp: Strikes Back)
  const back = stepsHave(def.power?.effect, "strikesBack");
  if (dmg > 0 && back && x.d.status === null) {
    const n = Number(back.amount) || 10;
    x.a.damage += n;
    log(x.b, `${def.power!.name} de ${def.name}: ${topCard(x.a).name} recibe ${n} de daño.`);
  }
  return dmg;
}

function benchDamage(b: Battle, p: PlayerSt, dmg: number): void {
  for (const s of p.bench) {
    s.damage += dmg;
    log(b, `${topCard(s).name} (Banca) recibe ${dmg} de daño.`);
  }
}

/** Condiciones que pueden usar los pasos "si…" y "requiere…". */
const EFFECT_CONDS: Record<string, (x: AtkCtx) => boolean> = {
  heads: (x) => x.heads > 0,
  tails: (x) => x.tails > 0,
  allHeads: (x) => x.flips > 0 && x.tails === 0,
  noHeads: (x) => x.heads === 0,
  dealtDamage: (x) => x.dealt > 0,
  selfDamaged: (x) => x.a.damage > 0,
  defHasEnergy: (x) => x.d.energy.length > 0,
  defHasWeakness: (x) => !!weaknessOf(x.d),
  oppHasBench: (x) => x.opp.bench.length > 0,
  defAsleep: (x) => x.d.status === "asleep",
  defConfused: (x) => x.d.status === "confused",
  defParalyzed: (x) => x.d.status === "paralyzed",
  defPoisoned: (x) => x.d.poisoned,
};
const REQUIRE_ES: Record<string, string> = {
  defAsleep: "Solo se puede usar si el Pokémon Defensor está Dormido.",
  defConfused: "Solo se puede usar si el Pokémon Defensor está Confundido.",
  defParalyzed: "Solo se puede usar si el Pokémon Defensor está Paralizado.",
  defPoisoned: "Solo se puede usar si el Pokémon Defensor está Envenenado.",
  defHasEnergy: "Solo se puede usar si el Pokémon Defensor tiene Energía.",
  defHasWeakness: "Solo se puede usar si el Pokémon Defensor tiene Debilidad.",
  oppHasBench: "Solo se puede usar si el rival tiene Pokémon en la Banca.",
  selfDamaged: "Solo se puede usar si este Pokémon tiene daño.",
};

/** Daño impreso como número ("30+" → 30, "?" → 0). */
const printedDamage = (atk: Attack): number => parseInt(atk.damage, 10) || 0;

/** Cuántas Energías de un tipo sobran después de pagar el costo (Hydro Pump, Water Gun). */
function extraEnergy(a: Slot, atk: Attack, type: EType): number {
  const have = energyTypes(a);
  const typed = have.filter((e) => e === type).length;
  const others = have.length - typed;
  const colorless = atk.cost.filter((c) => c === "Colorless").length;
  const usedForColorless = Math.max(0, colorless - others);
  return Math.max(0, typed - atk.cost.filter((c) => c === type).length - usedForColorless);
}

/** El valor que multiplica un paso de daño. */
function effectCount(x: { a: Slot; d: Slot; atk: Attack; heads: number }, st: Step): number {
  let n = 0;
  switch (st.count) {
    case "heads": n = x.heads; break;
    case "defEnergy": n = x.d.energy.length; break;
    case "defCounters": n = x.d.damage / 10; break;
    case "selfCounters": n = x.a.damage / 10; break;
    case "extraEnergy": n = extraEnergy(x.a, x.atk, (st.type as EType) || topCard(x.a).type); break;
  }
  return st.max ? Math.min(Number(st.max), n) : n;
}

/** Daño que calcula un paso "damage" (antes de Debilidad y Resistencia). */
function stepDamage(x: { a: Slot; d: Slot; atk: Attack; heads: number }, st: Step): number {
  const base = st.amount !== undefined && st.amount !== "" ? Number(st.amount) : printedDamage(x.atk);
  const per = Number(st.per) || 10;
  switch (st.mode) {
    case "times": return per * effectCount(x, st);
    case "plus": return base + per * effectCount(x, st);
    case "minus": return Math.max(0, base - per * effectCount(x, st));
    case "half": return Math.ceil(remainingHp(x.d) / 2 / 10) * 10;
    default: return base;
  }
}

const STATUS_OF: Record<string, Exclude<Status, null>> = { asleep: "asleep", confused: "confused", paralyzed: "paralyzed" };

/** Ejecuta una lista de pasos de ataque, en orden. */
function runSteps(x: AtkCtx, steps: Step[] | undefined): void {
  for (const st of steps ?? []) {
    if (x.stopped) return;
    runStep(x, st);
  }
}

function runStep(x: AtkCtx, st: Step): void {
  const b = x.b;
  const aName = topCard(x.a).name;
  switch (st.op) {
    case "flip": {
      const n = Math.max(1, Number(st.count) || 1);
      x.flips = n;
      x.heads = 0;
      for (let k = 0; k < n; k++) if (coin(b)) x.heads++;
      x.tails = n - x.heads;
      break;
    }
    case "if":
      runSteps(x, (EFFECT_CONDS[st.cond]?.(x) ?? false) ? st.then : st.else);
      break;
    case "damage": {
      const dmg = stepDamage(x, st);
      if (dmg > 0) x.dealt += dealDamage(x, dmg);
      break;
    }
    case "stop":
      log(b, st.message || "El ataque no hace nada.");
      x.stopped = true;
      break;
    case "status": {
      const poisonDmg = Number(st.poison) || 10;
      if (st.target === "self") {
        if (st.status === "poisoned") {
          x.a.poisoned = true;
          x.a.poisonDmg = poisonDmg;
        } else if (STATUS_OF[st.status]) {
          x.a.status = STATUS_OF[st.status];
          x.a.statusTurn = b.turn;
        }
        log(b, `¡${aName} ahora está ${st.status === "poisoned" ? "Envenenado" : STATUS_ES[STATUS_OF[st.status]]}!`);
      } else if (st.status === "poisoned") poison(x, poisonDmg);
      else if (STATUS_OF[st.status]) setStatus(x, STATUS_OF[st.status]);
      break;
    }
    case "hurt": {
      const n = Number(st.amount) || 0;
      if (n <= 0) break;
      if (st.target === "self") {
        x.a.damage += n;
        log(b, `${aName} se hace ${n} de daño a sí mismo.`);
      } else if (st.target === "defending") {
        if (!shielded(x)) {
          x.d.damage += n;
          log(b, `${topCard(x.d).name} recibe ${n} de daño.`);
        }
      } else {
        if (st.target === "myBench" || st.target === "allBench") benchDamage(b, x.me, n);
        if (st.target === "oppBench" || st.target === "allBench") benchDamage(b, x.opp, n);
      }
      break;
    }
    case "heal": {
      const n = Number(st.amount) || 0;
      if (!x.a.damage) break;
      const h = n > 0 ? Math.min(x.a.damage, n) : x.a.damage;
      x.a.damage -= h;
      log(b, n > 0 ? `${aName} recupera ${h} PS.` : `${aName} recupera todos sus PS.`);
      break;
    }
    case "discardEnergy": {
      const n = Number(st.count) || Infinity; // 0 = todas
      const type = (st.type || undefined) as EType | undefined;
      if (st.from === "defending") {
        if (!x.d.energy.length || x.d.protectTurn === b.turn) break;
        for (let k = 0; k < n; k++) {
          const e = discardEnergy(x.opp, x.d, type, k === 0 ? x.choice?.energy : undefined);
          if (!e) break;
          log(b, `Se descarta ${e.c.name} de ${topCard(x.d).name}.`);
        }
      } else {
        if (x.copy) break; // Metronome no paga los descartes
        for (let k = 0; k < n; k++) {
          const e = discardEnergy(x.me, x.a, type);
          if (!e) break;
          log(b, `Se descarta ${e.c.name} de ${aName}.`);
        }
      }
      break;
    }
    case "protect":
      if (st.kind === "all") {
        x.a.protectTurn = b.turn + 1;
        log(b, `¡${aName} queda protegido de todos los efectos de ataques el próximo turno!`);
      } else if (st.kind === "small") {
        x.a.hardenTurn = b.turn + 1;
        x.a.hardenMax = Number(st.amount) || 30;
        log(b, `¡${aName} se endurece: el próximo turno ignora daños de ${x.a.hardenMax} o menos!`);
      } else {
        x.a.stiffenTurn = b.turn + 1;
        log(b, `¡${aName} queda protegido de todo el daño el próximo turno!`);
      }
      break;
    case "sandAttack":
      if (x.d.protectTurn === b.turn) break;
      x.d.sandTurn = b.turn + 1;
      log(b, `${topCard(x.d).name} tiene arena en los ojos: el próximo turno puede fallar su ataque.`);
      break;
    case "destinyBond":
      x.a.destinyTurn = b.turn + 1;
      log(b, `${aName} se prepara: si lo dejan Fuera de Combate, se lleva al atacante.`);
      break;
    case "changeWeakness":
      if (!weaknessOf(x.d)) log(b, `${topCard(x.d).name} no tiene Debilidad: no pasa nada.`);
      else if (!shielded(x)) {
        const type = pickType(x, x.choice?.type);
        x.d.weakOverride = type;
        log(b, `La Debilidad de ${topCard(x.d).name} ahora es ${TYPE_NAMES_ES[type]}.`);
      }
      break;
    case "changeResistance": {
      const type = pickType(x, x.choice?.type, true);
      x.a.resOverride = type;
      log(b, `La Resistencia de ${aName} ahora es ${TYPE_NAMES_ES[type]}.`);
      break;
    }
    case "amnesia": {
      if (shielded(x)) break;
      const atks = topCard(x.d).attacks;
      if (!atks.length) break;
      const idx = x.choice?.attackIdx !== undefined && atks[x.choice.attackIdx] ? x.choice.attackIdx : strongestAttack(x.d);
      x.d.amnesia = { idx, turn: b.turn + 1 };
      log(b, `${topCard(x.d).name} olvida ${atks[idx].name} durante su próximo turno.`);
      break;
    }
    case "mirrorMove": {
      const h = x.a.lastHit;
      if (h && h.turn === b.turn - 1) {
        log(b, `${aName} devuelve el ataque que recibió.`);
        if (h.damage > 0 && !shielded(x)) {
          x.d.damage += h.damage;
          log(b, `${topCard(x.d).name} recibe ${h.damage} de daño.`);
        }
        if (h.status) setStatus(x, h.status);
        if (h.poison) poison(x, h.poison);
      } else log(b, `${aName} no fue atacado el turno pasado: no pasa nada.`);
      break;
    }
    case "switchDefending": {
      if (!x.opp.bench.length || x.opp.active !== x.d) {
        if (st.chooser === "me") log(b, "El rival no tiene Pokémon en la Banca.");
        break;
      }
      if (x.d.protectTurn === b.turn) {
        shielded(x);
        break;
      }
      if (st.chooser === "me") {
        const t = x.target && x.opp.bench.includes(x.target) ? x.target : x.opp.bench[0];
        const i = x.opp.bench.indexOf(t);
        x.opp.bench[i] = x.d;
        x.opp.active = t;
        clearConditions(x.d);
        log(b, `¡${topCard(t).name} pasa al frente!`);
      } else if (x.d.damage < maxHp(x.d)) {
        // el rival elige (la IA elige su mejor Pokémon de la Banca)
        const i = bestBenchIndex(x.opp);
        const next = x.opp.bench[i];
        x.opp.bench[i] = x.d;
        x.opp.active = next;
        clearConditions(x.d);
        log(b, `${x.opp.name} cambia a ${topCard(next).name} al frente.`);
      }
      break;
    }
    case "metronome":
      runMetronome(x);
      break;
    case "log":
      if (st.text) log(b, String(st.text));
      break;
    // "require" y "oncePerPlay" se controlan antes de atacar (attackError / attack)
  }
}

/** Tipo elegido para cambiar Debilidad/Resistencia (o uno razonable). Nunca Incoloro. */
function pickType(x: AtkCtx, chosen: EType | undefined, forResistance = false): EType {
  if (chosen && chosen !== "Colorless") return chosen;
  const t = topCard(forResistance ? x.d : x.a).type;
  if (t !== "Colorless") return t;
  const mine = inPlay(x.me).map((s) => topCard(s).type).find((ty) => ty !== "Colorless");
  return mine ?? "Fire";
}

/** El ataque de más daño de un Pokémon (para elecciones automáticas). */
function strongestAttack(s: Slot): number {
  const atks = topCard(s).attacks;
  let best = 0;
  atks.forEach((a, i) => {
    if (printedDamage(a) > printedDamage(atks[best])) best = i;
  });
  return best;
}

function setStatus(x: AtkCtx, st: Exclude<Status, null>): void {
  if (isDoll(x.d)) return log(x.b, `A ${topCard(x.d).name} no le afectan los estados.`);
  if (shielded(x)) return;
  x.d.status = st;
  if (x.d.lastHit?.turn === x.b.turn) x.d.lastHit.status = st;
  x.d.statusTurn = x.b.turn;
  log(x.b, `¡${topCard(x.d).name} ahora está ${STATUS_ES[st]}!`);
}

function poison(x: AtkCtx, dmg = 10): void {
  if (isDoll(x.d)) return log(x.b, `A ${topCard(x.d).name} no le afectan los estados.`);
  if (shielded(x)) return;
  x.d.poisoned = true;
  if (x.d.lastHit?.turn === x.b.turn) x.d.lastHit.poison = dmg;
  x.d.poisonDmg = dmg;
  log(x.b, `¡${topCard(x.d).name} ahora está Envenenado${dmg > 10 ? ` (${dmg} por turno)` : ""}!`);
}

/** Lure y parecidos: el atacante elige qué Pokémon de la Banca rival pasa al frente. */
const attackNeedsOppBench = (atk: Attack): boolean => stepsHave(atk.effect, "switchDefending")?.chooser === "me";

function newAtkCtx(b: Battle, pi: number, atk: Attack, target?: Slot, choice?: AttackChoice): AtkCtx {
  const me = b.p[pi];
  const opp = b.p[1 - pi];
  return { b, me, opp, a: me.active!, d: opp.active!, atk, target, choice, flips: 0, heads: 0, tails: 0, dealt: 0, stopped: false };
}

function attackError(b: Battle, pi: number, idx: number): string | null {
  const err = turnCheck(b, pi);
  if (err) return err;
  const p = b.p[pi];
  const a = p.active;
  if (!a) return "No tenés Pokémon Activo.";
  if (!b.p[1 - pi].active) return "El rival no tiene Pokémon Activo.";
  if (a.status === "asleep" || a.status === "paralyzed") return `No puede atacar: está ${STATUS_ES[a.status]}.`;
  const atk = topCard(a).attacks[idx];
  if (!atk) return "Ataque no válido.";
  if (a.amnesia && a.amnesia.turn === b.turn && a.amnesia.idx === idx) return `No puede usar ${atk.name} este turno (Amnesia).`;
  if (a.leekUsed?.includes(idx) && stepsHave(atk.effect, "oncePerPlay")) return `${atk.name} ya se usó mientras siga en juego.`;
  if (!canPay(a, atk.cost) && !payableWithBurn(a, atk.cost)) return "No tiene la Energía necesaria.";
  const x = newAtkCtx(b, pi, atk);
  for (const st of atk.effect ?? []) {
    if (st.op === "require" && EFFECT_CONDS[st.cond] && !EFFECT_CONDS[st.cond](x)) return REQUIRE_ES[st.cond] ?? "No se cumple lo que pide el ataque.";
  }
  return null;
}

function attack(b: Battle, pi: number, idx: number, target?: Slot, choice?: AttackChoice): string | null {
  const err = attackError(b, pi, idx);
  if (err) return err;
  const a = b.p[pi].active!;
  const atk = topCard(a).attacks[idx];
  if (!canPay(a, atk.cost)) {
    // solo se llega acá si Energy Burn alcanza para pagar: se activa el Poder
    a.burn = true;
    log(b, `${topCard(a).name} usa su Poder Pokémon ${topCard(a).power?.name ?? ""}: sus Energías cuentan como Fuego.`);
  }
  log(b, `¡${topCard(a).name} usa ${atk.name}!`);

  if (a.status === "confused") {
    log(b, `${topCard(a).name} está Confundido...`);
    if (!coin(b)) {
      a.damage += 20;
      log(b, `¡Se lastima a sí mismo! Recibe 20 de daño.`);
      resolveKOs(b, "endTurn");
      return null;
    }
  }

  // Sand-attack: moneda; cruz = el ataque no hace nada
  if (a.sandTurn === b.turn) {
    log(b, `${topCard(a).name} tiene arena en los ojos...`);
    if (!coin(b)) {
      log(b, "¡El ataque no hace nada!");
      resolveKOs(b, "endTurn");
      return null;
    }
  }
  if (stepsHave(atk.effect, "oncePerPlay")) (a.leekUsed ??= []).push(idx);

  const d = b.p[1 - pi].active!;
  d.lastHit = { turn: b.turn, damage: 0, status: null, poison: 0 };
  const x = newAtkCtx(b, pi, atk, target, choice);
  if (atk.effect?.length) runSteps(x, atk.effect);
  else dealDamage(x, printedDamage(atk)); // sin pasos: el daño impreso

  // Destiny Bond: si el Defensor cae por este ataque, el atacante también
  if (d.destinyTurn === b.turn && d.damage >= maxHp(d) && a.damage < maxHp(a)) {
    log(b, `¡Destiny Bond! ${topCard(a).name} también queda Fuera de Combate.`);
    a.damage = maxHp(a);
  }
  resolveKOs(b, "endTurn");
  return null;
}

/** Ataques del Defensor que Metronome puede copiar (no se copia a sí mismo). */
function metronomeOptions(d: Slot): number[] {
  return topCard(d).attacks.map((_, j) => j).filter((j) => !stepsHave(topCard(d).attacks[j].effect, "metronome"));
}

/** Metronome (Clefairy): copia un ataque del Defensor sin pagar costos. */
function runMetronome(x: AtkCtx): void {
  const opts = metronomeOptions(x.d);
  if (!opts.length) return log(x.b, `${topCard(x.d).name} no tiene ataques para copiar.`);
  const j = x.choice?.attackIdx !== undefined && opts.includes(x.choice.attackIdx) ? x.choice.attackIdx : strongestAttack(x.d);
  const copied = topCard(x.d).attacks[opts.includes(j) ? j : opts[0]];
  log(x.b, `Metronome copia ${copied.name}.`);
  const y: AtkCtx = { ...x, atk: copied, copy: true, flips: 0, heads: 0, tails: 0, dealt: 0, stopped: false };
  if (attackNeedsOppBench(copied) && !y.target) y.target = y.opp.bench[0];
  if (copied.effect?.length) runSteps(y, copied.effect.filter((s) => s.op !== "require" && s.op !== "oncePerPlay"));
  else dealDamage(y, printedDamage(copied));
  x.dealt += y.dealt;
}

function surrender(b: Battle, pi: number): void {
  log(b, `${b.p[pi].name} se rinde.`);
  gameOver(b, 1 - pi);
}
