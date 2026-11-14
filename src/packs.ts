// =====================================================================
//  Sobres: generación de cartas (lógica pura, sin DOM). ADR 0002.
//  Composición por defecto: 2 Energías, 5 Comunes, 3 Poco comunes, 1 Rara (≈1/3 holo).
// =====================================================================

function slotPool(pool: string[], kind: SlotKind): string[] {
  return pool.filter((id) => {
    const c = CARDS[id];
    if (kind === "Energy") return isBasicEnergy(c);
    if (isBasicEnergy(c)) return false;
    return kind === "Any" || c.rarity === kind;
  });
}

/** n cartas al azar; sin repetir mientras alcance el pool. */
function pickCards(pool: string[], n: number, rng: Rng): string[] {
  const out: string[] = [];
  while (out.length < n && pool.length) out.push(...shuffle([...pool], rng).slice(0, n - out.length));
  return out;
}

/** Genera las cartas de un sobre. Toda la aleatoriedad sale de `rng` (en el servidor, el RNG de la partida/sobre). */
function generateBooster(def: BoosterDef, rng: Rng): string[] {
  const pool = def.cards.filter(isPlayable);
  const out: string[] = [];
  for (const slot of def.slots?.length ? def.slots : DEFAULT_SLOTS) {
    let candidates = slotPool(pool, slot.rarity);
    if (slot.holoChance !== undefined) {
      const wantHolo = rng.next() < slot.holoChance;
      const sub = candidates.filter((id) => !!CARDS[id].holo === wantHolo);
      if (sub.length) candidates = sub;
    }
    if (!candidates.length) candidates = slotPool(pool, "Any"); // el sobre no tiene de esa rareza
    if (!candidates.length) candidates = pool;
    out.push(...pickCards(candidates.filter((id) => !out.includes(id) || slot.rarity === "Energy"), slot.count, rng));
  }
  // de menos raras a más raras: la mejor carta queda para el final
  const rank = (id: string) => (isBasicEnergy(CARDS[id]) ? 0 : 1 + ["Common", "Uncommon", "Rare", "Rare Holo"].indexOf(CARDS[id].rarity) + (CARDS[id].holo ? 4 : 0));
  return out.sort((a, b) => rank(a) - rank(b));
}
