// Validación de mazos del jugador (ADR 0002, 3.3: PUT /api/me/decks). El cliente solo manda mazos; el servidor
// comprueba contra la colección real que las cartas existan y que no pida más copias de las que tiene.
// Mazos incompletos se pueden guardar: la legalidad completa (deckProblems) se exige al empezar una partida.

import type { Core } from "./engine.ts";
import { ValueError, cut, isObj } from "./util.ts";

export const MAX_DECKS = 20;
export const MAX_DECK_ENTRIES = 60;

/** Devuelve los mazos normalizados {decks, mainId, nextId} o lanza ValueError (400) con el motivo en español. */
export function validateDecks(core: Core, owned: Record<string, number>, input: unknown): Record<string, any> {
  if (!isObj(input) || !Array.isArray(input.decks)) throw new ValueError("Los mazos tienen que ser {decks:[…], mainId, nextId}.");
  if (input.decks.length > MAX_DECKS) throw new ValueError(`Máximo ${MAX_DECKS} mazos.`);
  const nameMax: number = core.DECK_NAME_MAX;
  const ids = new Set<string>();
  const decks = input.decks.map((d: unknown) => {
    if (!isObj(d)) throw new ValueError("Cada mazo debe ser un objeto.");
    if (typeof d.id !== "string" || !/^[\w-]{1,16}$/.test(d.id)) throw new ValueError("Id de mazo inválido.");
    if (ids.has(d.id)) throw new ValueError("Hay dos mazos con el mismo id.");
    ids.add(d.id);
    const name = typeof d.name === "string" ? d.name.trim() : "";
    if (!name || Array.from(name).length > nameMax) throw new ValueError(`El nombre del mazo va de 1 a ${nameMax} caracteres.`);
    if (!Array.isArray(d.cards)) throw new ValueError("Las cartas del mazo deben ser una lista.");
    if (d.cards.length > MAX_DECK_ENTRIES) throw new ValueError(`Un mazo admite hasta ${MAX_DECK_ENTRIES} entradas.`);
    const used: Record<string, number> = Object.create(null);
    const cards = d.cards.map((e: unknown) => {
      if (!isObj(e) || typeof e.id !== "string" || !Object.hasOwn(core.CARDS, e.id) || !core.isPlayable(e.id)) {
        throw new ValueError(`Carta desconocida: ${cut(isObj(e) ? String(e.id) : "?", 40)}.`);
      }
      if (typeof e.qty !== "number" || !Number.isInteger(e.qty) || e.qty < 1 || e.qty > MAX_DECK_ENTRIES) {
        throw new ValueError(`Cantidad inválida de ${core.CARDS[e.id].name}.`);
      }
      used[e.id] = (used[e.id] ?? 0) + e.qty;
      const have = Object.hasOwn(owned, e.id) ? owned[e.id] : 0;
      if (used[e.id] > have) throw new ValueError(`Solo tenés ${have} ${core.CARDS[e.id].name}.`);
      return { id: e.id, qty: e.qty };
    });
    const out: Record<string, any> = { id: d.id, name, cards };
    if (d.info !== undefined) {
      if (typeof d.info !== "string") throw new ValueError("La descripción del mazo debe ser texto.");
      out.info = cut(d.info, 200);
    }
    return out;
  });
  let mainId: string | null = null;
  if (typeof input.mainId === "string" && input.mainId !== "") {
    if (!ids.has(input.mainId)) throw new ValueError("El mazo principal no existe.");
    mainId = input.mainId;
  } else if (input.mainId !== undefined && input.mainId !== null && input.mainId !== "") {
    throw new ValueError("mainId inválido.");
  }
  const nextId =
    typeof input.nextId === "number" && Number.isInteger(input.nextId) && input.nextId >= 1 && input.nextId <= 1_000_000
      ? Math.max(input.nextId, decks.length + 1)
      : decks.length + 1;
  return { decks, mainId, nextId };
}
