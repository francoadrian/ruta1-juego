// Núcleo del juego (reglas, cartas, sobres) cargado en node:vm SIN DOM. ADR 0002, 3.1 y 3.4.
//
// Los src/*.ts son scripts globales (no módulos): se les sacan los tipos con node:module.stripTypeScriptTypes
// y se ejecutan en orden en un mismo contexto, igual que en el navegador. Esto es independiente de tests/
// (tests/load-core.ts hace lo mismo para los tests del motor).
//
// Los objetos que devuelve el núcleo viven en OTRO realm (su Array/Object): para comparar usar JSON, y para
// saber si un id existe usar Object.hasOwn(CARDS, id) (un id como "constructor" existe en el prototipo).

import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import type { Content } from "./content.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Orden de carga del núcleo (el de index.html hasta match; player.ts toca el navegador y no va). */
const CORE_FILES = ["baseset", "cards", "rng", "tcg", "ai", "packs", "match"].map((f) => `src/${f}.ts`);

// Lo que el servidor necesita del scope global del núcleo.
const EXPORTS = [
  "CARDS", "BOOSTERS", "DEFAULT_SLOTS", "BRUSHFIRE", "OVERGROWTH", "BENCH_MAX", "DECK_SIZE", "DECK_NAME_MAX",
  "isPlayable", "isBasicEnergy", "isBasic", "ownedCounts", "deckProblems", "shuffle", "newBattle", "generateBooster",
  "createMatch", "applyIntent", "mParse", "viewFor", "defaultIntent", "stepAI", "peek", "logSince",
].join(", ");

export interface Rng {
  /** Número en [0, 1). */
  next(): number;
}

export interface Core {
  // Son los globales del núcleo (ver src/*.ts): se tipan sueltos a propósito.
  [name: string]: any;
}

const sources = new Map<string, string>();
function source(f: string): string {
  let code = sources.get(f);
  if (code === undefined) {
    code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, f), "utf8"), { mode: "strip" });
    sources.set(f, code);
  }
  return code;
}

/** Contexto nuevo (estado limpio) con el núcleo cargado. `catalog` = data/catalog.json o null (solo Base Set). */
export function loadCore(catalog: object | null): Core {
  const sandbox: Record<string, unknown> = {};
  if (catalog) sandbox.GAME_CATALOG = catalog;
  const ctx = vm.createContext(sandbox, { name: "ruta1-core" });
  // el motor saca todo el azar de un Rng inyectado: Math.random es un error
  vm.runInContext('Math.random = () => { throw new Error("Math.random en el núcleo: usar el Rng inyectado"); }', ctx);
  for (const f of CORE_FILES) new vm.Script(source(f), { filename: f }).runInContext(ctx);
  return vm.runInContext(`({ ${EXPORTS} })`, ctx) as Core;
}

/**
 * RNG del servidor: semilla criptográfica de 128 bits y next() = HMAC-SHA256(semilla, contador) → [0,1) con 48 bits.
 * Reproducible con la misma semilla (replays) e impredecible sin ella.
 */
export function serverRng(seed: Buffer = randomBytes(16)): Rng & { seed: string } {
  let counter = 0;
  const buf = Buffer.alloc(8);
  return {
    seed: seed.toString("hex"),
    next(): number {
      buf.writeBigUInt64BE(BigInt(counter++));
      return createHmac("sha256", seed).update(buf).digest().readUIntBE(0, 6) / 2 ** 48;
    },
  };
}

/** Núcleo + catálogo vigente: se recarga solo cuando el backoffice cambia data/catalog.json. */
export class Engine {
  private content: Content;
  private lastCatalog: unknown = Symbol("sin cargar");
  private cached: Core | null = null;

  constructor(content: Content) {
    this.content = content;
  }

  core(): Core {
    const cat = this.content.catalog.objectOrNull() as object | null; // misma instancia mientras el archivo no cambie
    if (this.cached === null || cat !== this.lastCatalog) {
      this.cached = loadCore(cat);
      this.lastCatalog = cat;
    }
    return this.cached;
  }

  /** Copias que tiene un jugador de cada carta: colección inicial + `pulled` (lo que ganó). */
  ownedCounts(pulled: Record<string, number>): Record<string, number> {
    return { ...this.core().ownedCounts(pulled) };
  }

  /** Cartas de un sobre sorteadas con un RNG nuevo del servidor; null si el sobre no existe. */
  openBooster(boosterId: string): string[] | null {
    const def = this.content.boosterDef(boosterId);
    if (!def || def.enabled === false || !Array.isArray(def.cards)) return null;
    return [...this.core().generateBooster(def, serverRng())] as string[];
  }

  /** Sobre de premio de un NPC: `boosterId` o "random" (uno de los habilitados). null si no existe o no tiene cartas. */
  rewardBooster(boosterId: string, rng: Rng = serverRng()): { booster: string; cards: string[] } | null {
    const core = this.core();
    let def: any;
    if (boosterId === "random") {
      const list: any[] = [...core.BOOSTERS];
      def = list.length ? list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))] : null;
    } else {
      def = this.content.boosterDef(boosterId);
      if (def && def.enabled === false) def = null;
    }
    if (!def || !Array.isArray(def.cards)) return null;
    const cards = [...core.generateBooster(def, rng)] as string[];
    return cards.length ? { booster: String(def.id), cards } : null;
  }
}
