// =====================================================================
//  Datos de cartas — Pokémon TCG, Base Set (1999), mazo temático "Brushfire"
//  Texto impreso en inglés, tal cual figura en las cartas originales.
//  Fuente: Bulbapedia (lista del mazo y páginas de cada carta).
// =====================================================================

type EType = "Fire" | "Grass" | "Water" | "Psychic" | "Lightning" | "Fighting" | "Colorless";
type Rarity = "Common" | "Uncommon" | "Rare" | "Rare Holo";

/**
 * Un paso de un efecto. Los efectos de ataques y Poderes son listas de pasos que
 * se ejecutan en orden (ver EFFECT_OPS en tcg.ts); el texto impreso es solo descriptivo.
 * Ej. Electrode "Electric Shock": [damage 50] → [flip] → [if tails → hurt self 10].
 */
interface Step {
  op: string;
  then?: Step[];
  else?: Step[];
  [param: string]: any;
}

interface Attack {
  cost: EType[];
  name: string;
  damage: string;
  text?: string;
  effect?: Step[]; // sin pasos: hace el daño impreso y nada más
}

interface CardBase {
  id: string;
  name: string;
  set: string;
  number: number; // número en la expansión (x/102)
  rarity: Rarity;
  holo?: boolean; // carta holográfica (brillo animado)
  enabled?: boolean; // false = deshabilitada en el juego (no sale en sobres ni en la colección)
  image?: string; // imagen del frente (ruta relativa, cargada desde el backoffice)
}

interface PokemonCard extends CardBase {
  kind: "pokemon";
  type: EType;
  hp: number;
  stage: "Basic" | "Stage 1" | "Stage 2";
  evolvesFrom?: string;
  power?: { name: string; text: string; effect?: Step[] };
  attacks: Attack[];
  weakness?: EType;
  resistance?: EType;
  retreat: number;
}

interface TrainerCard extends CardBase {
  kind: "trainer";
  text: string;
  effect?: Step[]; // lo que hace al jugarlo (el texto es solo descriptivo)
}

interface EnergyCard extends CardBase {
  kind: "energy";
  type: EType;
  provides?: number; // Double Colorless Energy = 2
  special?: boolean; // no es Energía básica
}

type Card = PokemonCard | TrainerCard | EnergyCard;

const SET_SIZE = 102;
const BASE = "Base Set";

const CARDS: Record<string, Card> = {
  // ---------------- Pokémon ----------------
  ninetales: {
    kind: "pokemon", id: "ninetales", name: "Ninetales", set: BASE, number: 12, rarity: "Rare Holo",
    type: "Fire", hp: 80, stage: "Stage 1", evolvesFrom: "Vulpix",
    attacks: [
      {
        cost: ["Colorless", "Colorless"], name: "Lure", damage: "",
        text: "If your opponent has any Benched Pokémon, choose 1 of them and switch it with the Defending Pokémon.",
      },
      {
        cost: ["Fire", "Fire", "Fire", "Fire"], name: "Fire Blast", damage: "80",
        text: "Discard 1 Fire Energy card attached to Ninetales in order to use this attack.",
      },
    ],
    weakness: "Water", retreat: 1,
  },
  arcanine: {
    kind: "pokemon", id: "arcanine", name: "Arcanine", set: BASE, number: 23, rarity: "Uncommon",
    type: "Fire", hp: 100, stage: "Stage 1", evolvesFrom: "Growlithe",
    attacks: [
      {
        cost: ["Fire", "Fire", "Colorless"], name: "Flamethrower", damage: "50",
        text: "Discard 1 Fire Energy card attached to Arcanine in order to use this attack.",
      },
      {
        cost: ["Fire", "Fire", "Colorless", "Colorless"], name: "Take Down", damage: "80",
        text: "Arcanine does 30 damage to itself.",
      },
    ],
    weakness: "Water", retreat: 3,
  },
  charmeleon: {
    kind: "pokemon", id: "charmeleon", name: "Charmeleon", set: BASE, number: 24, rarity: "Uncommon",
    type: "Fire", hp: 80, stage: "Stage 1", evolvesFrom: "Charmander",
    attacks: [
      { cost: ["Colorless", "Colorless", "Colorless"], name: "Slash", damage: "30" },
      {
        cost: ["Fire", "Fire", "Colorless"], name: "Flamethrower", damage: "50",
        text: "Discard 1 Fire Energy card attached to Charmeleon in order to use this attack.",
      },
    ],
    weakness: "Water", retreat: 1,
  },
  growlithe: {
    kind: "pokemon", id: "growlithe", name: "Growlithe", set: BASE, number: 28, rarity: "Uncommon",
    type: "Fire", hp: 60, stage: "Basic",
    attacks: [{ cost: ["Fire", "Colorless"], name: "Flare", damage: "20" }],
    weakness: "Water", retreat: 1,
  },
  charmander: {
    kind: "pokemon", id: "charmander", name: "Charmander", set: BASE, number: 46, rarity: "Common",
    type: "Fire", hp: 50, stage: "Basic",
    attacks: [
      { cost: ["Colorless"], name: "Scratch", damage: "10" },
      {
        cost: ["Fire", "Colorless"], name: "Ember", damage: "30",
        text: "Discard 1 Fire Energy card attached to Charmander in order to use this attack.",
      },
    ],
    weakness: "Water", retreat: 1,
  },
  nidoranM: {
    kind: "pokemon", id: "nidoranM", name: "Nidoran♂", set: BASE, number: 55, rarity: "Common",
    type: "Grass", hp: 40, stage: "Basic",
    attacks: [
      { cost: ["Grass"], name: "Horn Hazard", damage: "30", text: "Flip a coin. If tails, this attack does nothing." },
    ],
    weakness: "Psychic", retreat: 1,
  },
  tangela: {
    kind: "pokemon", id: "tangela", name: "Tangela", set: BASE, number: 66, rarity: "Common",
    type: "Grass", hp: 50, stage: "Basic",
    attacks: [
      {
        cost: ["Grass", "Colorless"], name: "Bind", damage: "20",
        text: "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.",
      },
      { cost: ["Grass", "Grass", "Grass"], name: "Poisonpowder", damage: "20", text: "The Defending Pokémon is now Poisoned." },
    ],
    weakness: "Fire", retreat: 2,
  },
  vulpix: {
    kind: "pokemon", id: "vulpix", name: "Vulpix", set: BASE, number: 68, rarity: "Common",
    type: "Fire", hp: 50, stage: "Basic",
    attacks: [
      {
        cost: ["Fire", "Fire"], name: "Confuse Ray", damage: "10",
        text: "Flip a coin. If heads, the Defending Pokémon is now Confused.",
      },
    ],
    weakness: "Water", retreat: 1,
  },
  weedle: {
    kind: "pokemon", id: "weedle", name: "Weedle", set: BASE, number: 69, rarity: "Common",
    type: "Grass", hp: 40, stage: "Basic",
    attacks: [
      {
        cost: ["Grass"], name: "Poison Sting", damage: "10",
        text: "Flip a coin. If heads, the Defending Pokémon is now Poisoned.",
      },
    ],
    weakness: "Fire", retreat: 1,
  },

  // ---- Cartas sueltas de la colección ----
  charizard: {
    kind: "pokemon", id: "charizard", name: "Charizard", set: BASE, number: 4, rarity: "Rare Holo",
    type: "Fire", hp: 120, stage: "Stage 2", evolvesFrom: "Charmeleon",
    power: {
      name: "Energy Burn",
      text: "As often as you like during your turn (before your attack), you may turn all Energy attached to Charizard into Fire Energy for the rest of the turn. This power can't be used if Charizard is Asleep, Confused, or Paralyzed.",
    },
    attacks: [
      {
        cost: ["Fire", "Fire", "Fire", "Fire"], name: "Fire Spin", damage: "100",
        text: "Discard 2 Energy cards attached to Charizard in order to use this attack.",
      },
    ],
    weakness: "Water", resistance: "Fighting", retreat: 3,
  },
  nidoking: {
    kind: "pokemon", id: "nidoking", name: "Nidoking", set: BASE, number: 11, rarity: "Rare Holo",
    type: "Grass", hp: 90, stage: "Stage 2", evolvesFrom: "Nidorino",
    attacks: [
      {
        cost: ["Grass", "Colorless", "Colorless"], name: "Thrash", damage: "30+",
        text: "Flip a coin. If heads, this attack does 30 damage plus 10 more damage; if tails, this attack does 30 damage and Nidoking does 10 damage to itself.",
      },
      {
        cost: ["Grass", "Grass", "Grass"], name: "Toxic", damage: "20",
        text: "The Defending Pokémon is now Poisoned. It now takes 20 Poison damage instead of 10 after each player's turn (even if it was already Poisoned).",
      },
    ],
    weakness: "Psychic", retreat: 3,
  },
  nidorino: {
    kind: "pokemon", id: "nidorino", name: "Nidorino", set: BASE, number: 37, rarity: "Uncommon",
    type: "Grass", hp: 60, stage: "Stage 1", evolvesFrom: "Nidoran♂",
    attacks: [
      {
        cost: ["Grass", "Colorless", "Colorless"], name: "Double Kick", damage: "30×",
        text: "Flip 2 coins. This attack does 30 damage times the number of heads.",
      },
      { cost: ["Grass", "Grass", "Colorless", "Colorless"], name: "Horn Drill", damage: "50" },
    ],
    weakness: "Psychic", retreat: 1,
  },

  // ---- Pokémon de Overgrowth ----
  gyarados: {
    kind: "pokemon", id: "gyarados", name: "Gyarados", set: BASE, number: 6, rarity: "Rare Holo",
    type: "Water", hp: 100, stage: "Stage 1", evolvesFrom: "Magikarp",
    attacks: [
      { cost: ["Water", "Water", "Water"], name: "Dragon Rage", damage: "50" },
      {
        cost: ["Water", "Water", "Water", "Water"], name: "Bubblebeam", damage: "40",
        text: "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.",
      },
    ],
    weakness: "Grass", resistance: "Fighting", retreat: 3,
  },
  beedrill: {
    kind: "pokemon", id: "beedrill", name: "Beedrill", set: BASE, number: 17, rarity: "Rare",
    type: "Grass", hp: 80, stage: "Stage 2", evolvesFrom: "Kakuna",
    attacks: [
      {
        cost: ["Colorless", "Colorless", "Colorless"], name: "Twineedle", damage: "30×",
        text: "Flip 2 coins. This attack does 30 damage times the number of heads.",
      },
      {
        cost: ["Grass", "Grass", "Grass"], name: "Poison Sting", damage: "40",
        text: "Flip a coin. If heads, the Defending Pokémon is now Poisoned.",
      },
    ],
    weakness: "Fire", resistance: "Fighting", retreat: 0,
  },
  ivysaur: {
    kind: "pokemon", id: "ivysaur", name: "Ivysaur", set: BASE, number: 30, rarity: "Uncommon",
    type: "Grass", hp: 60, stage: "Stage 1", evolvesFrom: "Bulbasaur",
    attacks: [
      { cost: ["Grass", "Colorless", "Colorless"], name: "Vine Whip", damage: "30" },
      { cost: ["Grass", "Grass", "Grass"], name: "Poisonpowder", damage: "20", text: "The Defending Pokémon is now Poisoned." },
    ],
    weakness: "Fire", retreat: 1,
  },
  kakuna: {
    kind: "pokemon", id: "kakuna", name: "Kakuna", set: BASE, number: 33, rarity: "Uncommon",
    type: "Grass", hp: 80, stage: "Stage 1", evolvesFrom: "Weedle",
    attacks: [
      {
        cost: ["Colorless", "Colorless"], name: "Stiffen", damage: "",
        text: "Flip a coin. If heads, prevent all damage done to Kakuna during your opponent's next turn. (Any other effects of attacks still happen.)",
      },
      {
        cost: ["Grass", "Grass"], name: "Poisonpowder", damage: "20",
        text: "Flip a coin. If heads, the Defending Pokémon is now Poisoned.",
      },
    ],
    weakness: "Fire", retreat: 2,
  },
  magikarp: {
    kind: "pokemon", id: "magikarp", name: "Magikarp", set: BASE, number: 35, rarity: "Uncommon",
    type: "Water", hp: 30, stage: "Basic",
    attacks: [
      { cost: ["Colorless"], name: "Tackle", damage: "10" },
      {
        cost: ["Water"], name: "Flail", damage: "10×",
        text: "Does 10 damage times the number of damage counters on Magikarp.",
      },
    ],
    weakness: "Lightning", retreat: 1,
  },
  bulbasaur: {
    kind: "pokemon", id: "bulbasaur", name: "Bulbasaur", set: BASE, number: 44, rarity: "Common",
    type: "Grass", hp: 40, stage: "Basic",
    attacks: [
      {
        cost: ["Grass", "Grass"], name: "Leech Seed", damage: "20",
        text: "Unless all damage from this attack is prevented, you may remove 1 damage counter from Bulbasaur.",
      },
    ],
    weakness: "Fire", retreat: 1,
  },
  starmie: {
    kind: "pokemon", id: "starmie", name: "Starmie", set: BASE, number: 64, rarity: "Common",
    type: "Water", hp: 60, stage: "Stage 1", evolvesFrom: "Staryu",
    attacks: [
      {
        cost: ["Water", "Water"], name: "Recover", damage: "",
        text: "Discard 1 Water Energy card attached to Starmie in order to use this attack. Remove all damage counters from Starmie.",
      },
      {
        cost: ["Water", "Colorless", "Colorless"], name: "Star Freeze", damage: "20",
        text: "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.",
      },
    ],
    weakness: "Lightning", retreat: 1,
  },
  staryu: {
    kind: "pokemon", id: "staryu", name: "Staryu", set: BASE, number: 65, rarity: "Common",
    type: "Water", hp: 40, stage: "Basic",
    attacks: [{ cost: ["Water"], name: "Slap", damage: "20" }],
    weakness: "Lightning", retreat: 1,
  },

  // ---------------- Entrenadores ----------------
  superPotion: {
    kind: "trainer", id: "superPotion", name: "Super Potion", set: BASE, number: 90, rarity: "Uncommon",
    text: "Discard 1 Energy card attached to 1 of your own Pokémon in order to remove up to 4 damage counters from that Pokémon.",
  },
  bill: {
    kind: "trainer", id: "bill", name: "Bill", set: BASE, number: 91, rarity: "Common",
    text: "Draw 2 cards.",
  },
  lass: {
    kind: "trainer", id: "lass", name: "Lass", set: BASE, number: 75, rarity: "Rare",
    text: "You and your opponent show each other your hands, then shuffle all the Trainer cards from your hands into your decks.",
  },
  energyRetrieval: {
    kind: "trainer", id: "energyRetrieval", name: "Energy Retrieval", set: BASE, number: 81, rarity: "Uncommon",
    text: "Trade 1 of the other cards in your hand for up to 2 basic Energy cards from your discard pile.",
  },
  plusPower: {
    kind: "trainer", id: "plusPower", name: "PlusPower", set: BASE, number: 84, rarity: "Uncommon",
    text:
      "Attach PlusPower to your Active Pokémon. At the end of your turn, discard PlusPower. If this Pokémon's attack does damage to the Defending Pokémon (after applying Weakness and Resistance), the attack does 10 more damage to the Defending Pokémon.",
  },
  energyRemoval: {
    kind: "trainer", id: "energyRemoval", name: "Energy Removal", set: BASE, number: 92, rarity: "Common",
    text: "Choose 1 Energy card attached to 1 of your opponent's Pokémon and discard it.",
  },
  gustOfWind: {
    kind: "trainer", id: "gustOfWind", name: "Gust of Wind", set: BASE, number: 93, rarity: "Common",
    text: "Choose 1 of your opponent's Benched Pokémon and switch it with his or her Active Pokémon.",
  },
  potion: {
    kind: "trainer", id: "potion", name: "Potion", set: BASE, number: 94, rarity: "Common",
    text: "Remove up to 2 damage counters from 1 of your Pokémon.",
  },
  switchCard: {
    kind: "trainer", id: "switchCard", name: "Switch", set: BASE, number: 95, rarity: "Common",
    text: "Switch 1 of your Benched Pokémon with your Active Pokémon.",
  },

  // ---------------- Energía ----------------
  fireEnergy: { kind: "energy", id: "fireEnergy", name: "Fire Energy", set: BASE, number: 98, rarity: "Common", type: "Fire" },
  grassEnergy: { kind: "energy", id: "grassEnergy", name: "Grass Energy", set: BASE, number: 99, rarity: "Common", type: "Grass" },
  waterEnergy: { kind: "energy", id: "waterEnergy", name: "Water Energy", set: BASE, number: 102, rarity: "Common", type: "Water" },
};

// ---------------------------------------------------------------------
//  Resto del Base Set (src/baseset.ts): se agregan las cartas que no
//  estén ya definidas arriba, con un id derivado del nombre.
// ---------------------------------------------------------------------
const RAW_TYPE: Record<string, EType> = {
  F: "Fire", G: "Grass", W: "Water", P: "Psychic", L: "Lightning", T: "Fighting", C: "Colorless",
};
const RAW_RARITY: Record<string, Rarity> = { H: "Rare Holo", R: "Rare", U: "Uncommon", C: "Common" };

function idFromName(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/♂/g, "M")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean);
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join("");
}

/** Número de carta → id (para encontrar las cartas del Base Set). */
const BASE_SET_IDS: string[] = [];

(() => {
  const byNumber = new Map(Object.values(CARDS).map((c) => [c.number, c.id] as const));
  const add = (c: Card) => {
    CARDS[c.id] = c;
    byNumber.set(c.number, c.id);
  };
  for (const [n, name, r, t, hp, stage, from, weak, res, ret, pow, atks] of BASE_SET_POKEMON) {
    if (byNumber.has(n)) continue;
    add({
      kind: "pokemon", id: idFromName(name), name, set: BASE, number: n, rarity: RAW_RARITY[r],
      type: RAW_TYPE[t], hp, stage: (["Basic", "Stage 1", "Stage 2"] as const)[stage],
      evolvesFrom: from || undefined,
      power: pow ? { name: pow[0], text: pow[1] } : undefined,
      attacks: atks.map(([cost, aname, damage, text]) => ({
        cost: cost.split("").map((x) => RAW_TYPE[x]), name: aname, damage, text: text || undefined,
      })),
      weakness: weak ? RAW_TYPE[weak] : undefined,
      resistance: res ? RAW_TYPE[res] : undefined,
      retreat: ret,
    });
  }
  for (const [n, name, r, text] of BASE_SET_TRAINERS) {
    if (!byNumber.has(n)) add({ kind: "trainer", id: idFromName(name), name, set: BASE, number: n, rarity: RAW_RARITY[r], text });
  }
  for (const [n, name, r, t, provides] of BASE_SET_ENERGY) {
    if (byNumber.has(n)) continue;
    add({
      kind: "energy", id: idFromName(name), name, set: BASE, number: n, rarity: RAW_RARITY[r], type: RAW_TYPE[t],
      provides: provides > 1 ? provides : undefined, special: provides > 1 ? true : undefined,
    });
  }
  for (let n = 1; n <= SET_SIZE; n++) BASE_SET_IDS[n] = byNumber.get(n)!;
  // "Rare Holo" pasa a ser rareza Rara + marca holográfica independiente
  for (const c of Object.values(CARDS)) {
    if (c.rarity === "Rare Holo") {
      c.rarity = "Rare";
      c.holo = true;
    }
  }
})();

const isBasicEnergy = (c: Card): boolean => c.kind === "energy" && !c.special;

// =====================================================================
//  Catálogo del backoffice (data/catalog.json)
//  Si existe, reemplaza a las cartas de arriba y define los sobres.
//  index.html lo deja en window.GAME_CATALOG antes de cargar este archivo.
// =====================================================================
type SlotKind = "Common" | "Uncommon" | "Rare" | "Energy" | "Any";

interface BoosterSlot {
  count: number;
  rarity: SlotKind; // "Energy" = Energías básicas; el resto excluye las Energías básicas
  holoChance?: number; // 0..1: probabilidad de que la carta del espacio sea holo
}

interface BoosterDef {
  id: string;
  name: string;
  enabled?: boolean;
  front?: string | null; // textura del frente del sobre
  back?: string | null; // textura del dorso del sobre
  cards: string[]; // cartas que puede contener
  slots: BoosterSlot[];
}

interface Catalog {
  version: number;
  cardBack?: string | null;
  cards: Card[];
  boosters: BoosterDef[];
}

declare const GAME_CATALOG: Catalog | null | undefined;

const CATALOG: Catalog | null = typeof GAME_CATALOG === "object" && GAME_CATALOG && Array.isArray(GAME_CATALOG.cards) ? GAME_CATALOG : null;

const DEFAULT_SLOTS: BoosterSlot[] = [
  { count: 2, rarity: "Energy" },
  { count: 5, rarity: "Common" },
  { count: 3, rarity: "Uncommon" },
  { count: 1, rarity: "Rare", holoChance: 1 / 3 },
];

if (CATALOG) {
  for (const k of Object.keys(CARDS)) delete CARDS[k];
  for (const raw of CATALOG.cards) {
    const c = { ...raw } as Card;
    if (c.rarity === "Rare Holo") {
      c.rarity = "Rare";
      c.holo = true;
    }
    if (c.kind === "pokemon") {
      c.attacks = (c.attacks ?? []).map((a) => ({ ...a, cost: a.cost ?? [], damage: a.damage ?? "" }));
      c.retreat = c.retreat || 0;
      c.hp = c.hp || 10;
      if (!c.power?.name) delete c.power;
      if (!c.evolvesFrom) delete c.evolvesFrom;
      if (!c.weakness) delete c.weakness;
      if (!c.resistance) delete c.resistance;
    }
    if (c.kind === "trainer") c.text = c.text ?? "";
    CARDS[c.id] = c;
  }
}

/** La carta existe y está habilitada en el juego. */
const isPlayable = (id: string): boolean => !!CARDS[id] && CARDS[id].enabled !== false;

/** Dorso común de todas las cartas (null = dibujo por defecto). */
const CARD_BACK_IMAGE: string | null = CATALOG?.cardBack || null;

/** Sobres que el juego puede regalar. */
const BOOSTERS: BoosterDef[] = CATALOG
  ? (CATALOG.boosters ?? []).filter((b) => b.enabled !== false && b.cards?.length)
  : [{ id: "baseSet", name: "Base Set", enabled: true, cards: BASE_SET_IDS.slice(1), slots: DEFAULT_SLOTS }];

// ---------------------------------------------------------------------
//  Imágenes (frente de cartas, dorso, texturas de sobres)
// ---------------------------------------------------------------------
const IMG_CACHE = new Map<string, HTMLImageElement>();

/** Devuelve la imagen si ya terminó de cargar (si no, la empieza a cargar y devuelve null). */
function loadedImage(src?: string | null): HTMLImageElement | null {
  if (!src) return null;
  let img = IMG_CACHE.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    IMG_CACHE.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

for (const src of [CARD_BACK_IMAGE, ...Object.values(CARDS).map((c) => c.image), ...BOOSTERS.flatMap((b) => [b.front, b.back])]) {
  loadedImage(src);
}

const cardImage = (card: Card): HTMLImageElement | null => loadedImage(card.image);

interface DeckEntry {
  id: string;
  qty: number;
}

interface Deck {
  id?: string;
  name: string;
  info?: string;
  cards: DeckEntry[];
}

/** Mazo temático "Brushfire" (Base Set, 9 de enero de 1999) — 60 cartas. */
const BRUSHFIRE: Deck = {
  name: "Brushfire",
  info: "Mazo temático de Base Set (1999). Pokémon de tipo Fuego y Planta.",
  cards: [
    { id: "charmander", qty: 4 },
    { id: "charmeleon", qty: 2 },
    { id: "vulpix", qty: 2 },
    { id: "ninetales", qty: 1 },
    { id: "growlithe", qty: 2 },
    { id: "arcanine", qty: 1 },
    { id: "weedle", qty: 4 },
    { id: "nidoranM", qty: 4 },
    { id: "tangela", qty: 2 },
    { id: "lass", qty: 1 },
    { id: "plusPower", qty: 1 },
    { id: "energyRetrieval", qty: 2 },
    { id: "switchCard", qty: 1 },
    { id: "potion", qty: 3 },
    { id: "gustOfWind", qty: 1 },
    { id: "energyRemoval", qty: 1 },
    { id: "grassEnergy", qty: 10 },
    { id: "fireEnergy", qty: 18 },
  ],
};

/** Mazo temático "Overgrowth" (Base Set, 1999) — 60 cartas. Lo usa el NPC. */
const OVERGROWTH: Deck = {
  name: "Overgrowth",
  info: "Mazo temático de Base Set (1999). Pokémon de tipo Planta y Agua.",
  cards: [
    { id: "bulbasaur", qty: 4 },
    { id: "ivysaur", qty: 2 },
    { id: "weedle", qty: 4 },
    { id: "kakuna", qty: 2 },
    { id: "beedrill", qty: 1 },
    { id: "staryu", qty: 4 },
    { id: "starmie", qty: 3 },
    { id: "magikarp", qty: 2 },
    { id: "gyarados", qty: 1 },
    { id: "potion", qty: 1 },
    { id: "superPotion", qty: 2 },
    { id: "bill", qty: 2 },
    { id: "switchCard", qty: 2 },
    { id: "gustOfWind", qty: 2 },
    { id: "grassEnergy", qty: 16 },
    { id: "waterEnergy", qty: 12 },
  ],
};

// =====================================================================
//  Colección y mazos del jugador
// =====================================================================

/** Cartas sueltas que el jugador tiene además de las del mazo Brushfire (para probar el editor). */
const EXTRA_OWNED: DeckEntry[] = [
  { id: "charizard", qty: 4 },
  { id: "nidorino", qty: 4 },
  { id: "nidoking", qty: 4 },
];

// Cartas deshabilitadas o borradas en el backoffice: fuera de los mazos fijos.
for (const list of [BRUSHFIRE.cards, OVERGROWTH.cards, EXTRA_OWNED]) {
  const keep = list.filter((e) => isPlayable(e.id));
  list.length = 0;
  list.push(...keep);
}

const COLLECTION_KEY = "tcglocal.collection.v1";

/** Jugador conectado al servidor (index.html lo deja en window.GAME_PLAYER). */
interface PlayerProfile {
  id: string;
  token?: string;
  name: string;
  rev: number;
  save?: { collection?: Record<string, number>; decks?: PlayerDecks; defeated?: Record<string, number> };
  mail?: unknown[];
}
declare const GAME_PLAYER: PlayerProfile | null | undefined;
const PLAYER: PlayerProfile | null = typeof GAME_PLAYER === "object" && GAME_PLAYER?.id ? GAME_PLAYER : null;

/** Cartas ganadas en sobres o recibidas en el buzón (id → copias). Fuente: el servidor (o el navegador). */
const pulledCards: Record<string, number> = (() => {
  try {
    const data = (PLAYER?.save?.collection ?? JSON.parse(localStorage.getItem(COLLECTION_KEY) ?? "{}")) as Record<string, number>;
    return Object.fromEntries(Object.entries(data).filter(([id, q]) => CARDS[id] && q > 0));
  } catch {
    return {};
  }
})();

/** La colección del jugador: cada carta una vez, con la cantidad de copias que tiene. */
const COLLECTION: DeckEntry[] = [];

function rebuildCollection(): void {
  const qty = new Map<string, number>();
  const all = [...BRUSHFIRE.cards, ...EXTRA_OWNED, ...Object.entries(pulledCards).map(([id, q]) => ({ id, qty: q }))];
  for (const e of all) if (isPlayable(e.id)) qty.set(e.id, (qty.get(e.id) ?? 0) + e.qty);
  COLLECTION.length = 0;
  COLLECTION.push(...[...qty].map(([id, q]) => ({ id, qty: q })).sort((a, b) => CARDS[a.id].number - CARDS[b.id].number));
}
rebuildCollection();

/** Suma cartas a la colección (por ejemplo, las de un sobre) y lo guarda. */
function addToCollection(ids: string[]): void {
  for (const id of ids) pulledCards[id] = (pulledCards[id] ?? 0) + 1;
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(pulledCards));
  } catch {
    /* sin almacenamiento: dura hasta recargar */
  }
  rebuildCollection();
  noteAdds(ids);
  queueSave();
}

const ownedQty = (id: string): number => COLLECTION.find((e) => e.id === id)?.qty ?? 0;

const DECK_SIZE = 60;
const MAX_COPIES = 4;
const DECK_NAME_MAX = 14;

function deckCount(deck: Deck, kind?: Card["kind"]): number {
  return deck.cards.filter((e) => !kind || CARDS[e.id].kind === kind).reduce((n, e) => n + e.qty, 0);
}

const qtyInDeck = (deck: Deck, id: string): number => deck.cards.find((e) => e.id === id)?.qty ?? 0;

/** Copias en el mazo con el mismo nombre (la regla de 4 copias es por nombre). */
const copiesByName = (deck: Deck, name: string): number =>
  deck.cards.filter((e) => CARDS[e.id].name === name).reduce((n, e) => n + e.qty, 0);

/** Problemas que impiden usar el mazo (lista vacía = mazo válido). */
function deckProblems(deck: Deck): string[] {
  const out: string[] = [];
  const n = deckCount(deck);
  if (n !== DECK_SIZE) out.push(`Tiene ${n} de ${DECK_SIZE} cartas.`);
  if (!deck.cards.some((e) => e.qty > 0 && isBasicCard(CARDS[e.id]))) out.push("Necesita al menos un Pokémon Básico.");
  const names = new Set(deck.cards.map((e) => CARDS[e.id].name));
  for (const name of names) {
    const c = deck.cards.find((e) => CARDS[e.id].name === name)!;
    if (!isBasicEnergy(CARDS[c.id]) && copiesByName(deck, name) > MAX_COPIES) out.push(`Más de ${MAX_COPIES} copias de ${name}.`);
  }
  for (const e of deck.cards) if (e.qty > ownedQty(e.id)) out.push(`Solo tenés ${ownedQty(e.id)} ${CARDS[e.id].name}.`);
  return out;
}

const isBasicCard = (c: Card): boolean => c.kind === "pokemon" && c.stage === "Basic";
const isDeckValid = (deck: Deck): boolean => deckProblems(deck).length === 0;

/** Descripción corta de un mazo según los tipos de sus Pokémon. */
function deckInfo(deck: Deck): string {
  const types = new Map<EType, number>();
  for (const e of deck.cards) {
    const c = CARDS[e.id];
    if (c.kind === "pokemon") types.set(c.type, (types.get(c.type) ?? 0) + e.qty);
  }
  const top = [...types].sort((a, b) => b[1] - a[1]).map(([t]) => TYPE_NAMES_ES[t]);
  return top.length ? `Pokémon de tipo ${top.slice(0, 3).join(" / ")}.` : "Todavía no tiene Pokémon.";
}

const TYPE_NAMES_ES: Record<EType, string> = {
  Fire: "Fuego", Grass: "Planta", Water: "Agua", Psychic: "Psíquico",
  Lightning: "Rayo", Fighting: "Lucha", Colorless: "Incoloro",
};

// ---------------------------------------------------------------------
//  Mazos guardados (localStorage) y mazo principal
// ---------------------------------------------------------------------
interface PlayerDecks {
  decks: Deck[];
  mainId: string;
  nextId: number;
}

const STORAGE_KEY = "tcglocal.decks.v1";

function defaultPlayerDecks(): PlayerDecks {
  return {
    decks: [{ id: "d1", name: "Brushfire", cards: BRUSHFIRE.cards.map((e) => ({ ...e })) }],
    mainId: "d1",
    nextId: 2,
  };
}

function loadPlayerDecks(): PlayerDecks {
  if (PLAYER?.save?.decks) return readPlayerDecks(PLAYER.save.decks);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? readPlayerDecks(JSON.parse(raw)) : defaultPlayerDecks();
  } catch {
    return defaultPlayerDecks();
  }
}

/** Valida mazos guardados (del servidor o del navegador). */
function readPlayerDecks(data: PlayerDecks): PlayerDecks {
  try {
    const decks = (data.decks ?? [])
      .filter((d) => d && typeof d.id === "string")
      .map((d) => ({
        id: d.id,
        name: String(d.name || "Mazo").slice(0, DECK_NAME_MAX),
        cards: (d.cards ?? [])
          .filter((e) => isPlayable(e.id) && e.qty > 0)
          .map((e) => ({ id: e.id, qty: Math.min(e.qty, ownedQty(e.id)) })),
      }));
    if (!decks.length) return defaultPlayerDecks();
    const res: PlayerDecks = { decks, mainId: data.mainId, nextId: Math.max(data.nextId || 1, decks.length + 1) };
    const main = decks.find((d) => d.id === res.mainId);
    if (!main || !isDeckValid(main)) res.mainId = (decks.find(isDeckValid) ?? decks[0]).id!;
    return res;
  } catch {
    return defaultPlayerDecks();
  }
}

function savePlayerDecks(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(playerDecks));
  } catch {
    /* sin almacenamiento: los cambios duran hasta recargar la página */
  }
  queueSave();
}

const playerDecks: PlayerDecks = loadPlayerDecks();

/** El mazo con el que se juega cada combate. */
function mainDeck(): Deck {
  const d = playerDecks.decks.find((x) => x.id === playerDecks.mainId);
  return d && isDeckValid(d) ? d : BRUSHFIRE;
}
