// =====================================================================
//  Jugador en el navegador: imágenes de cartas, colección y mazos guardados.
//  Todo lo que toca el DOM o localStorage vive acá y NO se carga en el servidor:
//  el núcleo (baseset, cards, rng, tcg, ai, packs) es lógica pura (ADR 0002).
// =====================================================================

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

// =====================================================================
//  Colección y mazos del jugador
// =====================================================================

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
  COLLECTION.length = 0;
  COLLECTION.push(
    ...Object.entries(ownedCounts(pulledCards))
      .map(([id, q]) => ({ id, qty: q }))
      .sort((a, b) => CARDS[a.id].number - CARDS[b.id].number),
  );
}
rebuildCollection();

const ownedQty = (id: string): number => COLLECTION.find((e) => e.id === id)?.qty ?? 0;

/** Copias que tiene el jugador de cada carta (para deckProblems). */
const ownedNow = (): Record<string, number> => Object.fromEntries(COLLECTION.map((e) => [e.id, e.qty]));

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
          .map((e) => ({ id: e.id, qty: Math.min(e.qty, ownedQty(e.id)) }))
          .filter((e) => e.qty > 0), // lo que ya no tiene (p. ej. cartas que ya no se regalan) se saca de la vista; el mazo queda incompleto, no se rompe
      }));
    if (!decks.length) return defaultPlayerDecks();
    const res: PlayerDecks = { decks, mainId: data.mainId, nextId: Math.max(data.nextId || 1, decks.length + 1) };
    const main = decks.find((d) => d.id === res.mainId);
    if (!main || !isDeckValid(main, ownedNow())) res.mainId = (decks.find((d) => isDeckValid(d, ownedNow())) ?? decks[0]).id!;
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
  return d && isDeckValid(d, ownedNow()) ? d : BRUSHFIRE;
}
