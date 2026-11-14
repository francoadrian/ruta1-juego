// =====================================================================
//  Carga el núcleo del juego (el mismo que corre en el navegador) en un contexto de node:vm
//  SIN DOM: sin document, window, localStorage ni Math.random. Lo usan los tests y, en el paso 5
//  del ADR 0002, el servidor. Los src/*.ts son scripts globales (no módulos): se les sacan los
//  tipos con node:module.stripTypeScriptTypes y se ejecutan en orden en un mismo contexto.
//
//  Ojo: los objetos que devuelve el núcleo viven en OTRO "realm" (Array/Object del contexto), así
//  que assert.deepStrictEqual falla por prototipos distintos: comparar con JSON.stringify.
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

export const ROOT = path.resolve(import.meta.dirname, "..");

/** Orden de carga (el mismo que index.html, hasta match; player.ts toca el navegador y no va). */
export const CORE_FILES = ["baseset", "cards", "rng", "tcg", "ai", "packs", "match"].map((f) => `src/${f}.ts`);

/** Catálogo del backoffice (data/catalog.json) o null si no existe. */
export function readCatalog(): object | null {
  const f = path.join(ROOT, "data", "catalog.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

// Lo que los tests y el servidor necesitan del scope global del núcleo.
const EXPORTS = [
  "CARDS", "BOOSTERS", "DEFAULT_SLOTS", "BRUSHFIRE", "OVERGROWTH", "BENCH_MAX", "DECK_SIZE",
  "isPlayable", "isBasicEnergy", "isBasic", "ownedCounts", "deckProblems", "matchFilter", "trainerSteps",
  "inPlay", "topCard", "sfc32", "shuffle", "newBattle", "generateBooster",
  "createMatch", "applyIntent", "viewFor", "defaultIntent", "stepAI", "peek", "logSince",
].join(", ");

export interface Core {
  // Se tipa suelto a propósito: son los globales del núcleo (ver src/*.ts).
  [name: string]: any;
  /** Evalúa una expresión en el scope global del núcleo (para cosas que no se exportan). */
  run(expr: string): any;
}

/**
 * Crea un contexto nuevo (estado limpio: nada se comparte entre llamadas) con el núcleo cargado.
 * catalog: null/omitido = solo el Base Set de src/baseset.ts; "file" = data/catalog.json; u objeto = ese catálogo.
 */
export function loadCore(opts: { catalog?: null | "file" | object } = {}): Core {
  const catalog = opts.catalog === "file" ? readCatalog() : opts.catalog ?? null;
  const sandbox: Record<string, unknown> = {};
  if (catalog) sandbox.GAME_CATALOG = catalog;
  const ctx = vm.createContext(sandbox, { name: "ruta1-core" });
  // el motor tiene que sacar todo el azar de un Rng inyectado: Math.random es un error
  vm.runInContext('Math.random = () => { throw new Error("Math.random en el núcleo: usar el Rng inyectado"); }', ctx);
  for (const f of CORE_FILES) {
    const code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, f), "utf8"), { mode: "strip" });
    new vm.Script(code, { filename: f }).runInContext(ctx);
  }
  const api = vm.runInContext(`({ ${EXPORTS} })`, ctx) as Core;
  api.run = (expr: string) => vm.runInContext(expr, ctx);
  return api;
}
