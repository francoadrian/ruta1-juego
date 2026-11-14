// Tests de sobres (ADR 0002, paso 3): generateBooster respeta los slots y el pool, es determinista
// con la semilla y no se cuelga con pools chicos o RNGs raros.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadCore, readCatalog, type Core } from "./load-core.ts";

const RANK = ["Common", "Uncommon", "Rare", "Rare Holo"];
const N = 3000;

const rank = (c: Core, id: string): number => {
  const card = c.CARDS[id];
  return c.isBasicEnergy(card) ? 0 : 1 + RANK.indexOf(card.rarity) + (card.holo ? 4 : 0);
};

/** Qué cartas del pool pueden salir en un slot (misma regla que el juego: las Energías básicas solo en "Energy"). */
const candidates = (c: Core, pool: string[], kind: string): string[] =>
  pool.filter((id) => {
    const card = c.CARDS[id];
    if (kind === "Energy") return c.isBasicEnergy(card);
    return !c.isBasicEnergy(card) && (kind === "Any" || card.rarity === kind);
  });

/** Revisa un sobre contra la definición. */
function checkPack(c: Core, def: any, pack: string[], where: string): void {
  const pool: string[] = def.cards.filter((id: string) => c.isPlayable(id));
  const slots: any[] = def.slots?.length ? def.slots : c.DEFAULT_SLOTS;
  const total = slots.reduce((n, s) => n + s.count, 0);
  assert.equal(pack.length, total, `${where}: ${pack.length} cartas, los slots piden ${total}`);
  for (const id of pack) {
    assert.ok(pool.includes(id), `${where}: ${id} no está en el pool del sobre`);
    assert.ok(c.isPlayable(id), `${where}: ${id} no está habilitada`);
  }
  // orden: de menos a más rara
  const ranks = pack.map((id) => rank(c, id));
  assert.equal(JSON.stringify(ranks), JSON.stringify([...ranks].sort((a, b) => a - b)), `${where}: no está ordenado por rareza`);

  // Energías: tantas como pidan los slots "Energy" (si el pool tiene)
  const wantEnergy = slots.filter((s) => s.rarity === "Energy" && candidates(c, pool, "Energy").length).reduce((n, s) => n + s.count, 0);
  const energies = pack.filter((id) => c.isBasicEnergy(c.CARDS[id])).length;
  assert.equal(energies, wantEnergy, `${where}: Energías básicas ${energies}, esperadas ${wantEnergy}`);

  // por rareza: al menos lo que piden los slots de esa rareza (si el pool tiene de esa rareza)
  for (const kind of ["Common", "Uncommon", "Rare"]) {
    const want = slots.filter((s) => s.rarity === kind && candidates(c, pool, kind).length).reduce((n, s) => n + s.count, 0);
    const have = pack.filter((id) => !c.isBasicEnergy(c.CARDS[id]) && c.CARDS[id].rarity === kind).length;
    assert.ok(have >= want, `${where}: ${have} cartas ${kind}, los slots piden ${want}`);
  }
  // sin repetidos (salvo Energías) cuando el pool alcanza para cada slot
  if (slots.every((s) => s.rarity === "Energy" || candidates(c, pool, s.rarity).length >= s.count * 2)) {
    const rest = pack.filter((id) => !c.isBasicEnergy(c.CARDS[id]));
    assert.equal(new Set(rest).size, rest.length, `${where}: cartas repetidas ${rest}`);
  }
}

const configs: { name: string; core: Core }[] = [{ name: "baseset", core: loadCore() }];
if (readCatalog()) configs.push({ name: "catálogo", core: loadCore({ catalog: "file" }) });

for (const { name, core: c } of configs) {
  describe(`sobres (${name})`, () => {
    it("hay al menos un sobre y todos tienen pool", () => {
      assert.ok(c.BOOSTERS.length >= 1);
      for (const def of c.BOOSTERS) assert.ok(def.cards.filter(c.isPlayable).length > 0, def.id);
    });

    for (const def of c.BOOSTERS) {
      it(`${def.id}: ${N} sobres respetan slots, pool y orden`, () => {
        const seen = new Map<string, number>();
        for (let i = 0; i < N; i++) {
          const pack = c.generateBooster(def, c.sfc32(`${def.id}:${i}`));
          checkPack(c, def, pack, `${def.id} #${i}`);
          for (const id of pack) seen.set(id, (seen.get(id) ?? 0) + 1);
        }
        // todas las cartas que algún slot puede dar salen alguna vez
        const slots: any[] = def.slots?.length ? def.slots : c.DEFAULT_SLOTS;
        const pool: string[] = def.cards.filter(c.isPlayable);
        const reachable = new Set(slots.flatMap((s) => candidates(c, pool, s.rarity)));
        for (const id of reachable) assert.ok(seen.has(id), `${def.id}: ${id} nunca salió en ${N} sobres`);
      });

      it(`${def.id}: misma semilla = mismo sobre; semillas distintas = sobres distintos`, () => {
        const a = c.generateBooster(def, c.sfc32("s1"));
        assert.equal(JSON.stringify(c.generateBooster(def, c.sfc32("s1"))), JSON.stringify(a));
        const distinct = new Set<string>();
        for (let i = 0; i < 20; i++) distinct.add(JSON.stringify(c.generateBooster(def, c.sfc32("x" + i))));
        assert.ok(distinct.size > 1, "semillas distintas dieron todas el mismo sobre");
      });
    }

    it("la chance de holo se respeta (sobre normal: 1 Rara por sobre, ≈1/3 holo)", () => {
      const def = c.BOOSTERS.find((b: any) => (b.slots ?? []).some((s: any) => s.holoChance !== undefined));
      if (!def) return;
      const slot = def.slots.find((s: any) => s.holoChance !== undefined);
      const pool = candidates(c, def.cards.filter(c.isPlayable), slot.rarity);
      if (!pool.some((id) => c.CARDS[id].holo) || !pool.some((id) => !c.CARDS[id].holo)) return; // no se puede medir
      let holo = 0;
      for (let i = 0; i < N; i++) {
        const pack = c.generateBooster(def, c.sfc32("holo" + i));
        const best = pack.filter((id: string) => c.CARDS[id].rarity === slot.rarity);
        assert.equal(best.length >= slot.count, true);
        if (best.slice(-slot.count).every((id: string) => c.CARDS[id].holo)) holo++;
      }
      const f = holo / N;
      assert.ok(Math.abs(f - slot.holoChance) < 0.05, `fracción holo ${f}, esperada ≈${slot.holoChance}`);
    });
  });
}

describe("sobres: casos límite (catálogo armado a mano)", () => {
  const base = readCatalog() as any;
  const ids = (pred: (x: any) => boolean) => base.cards.filter(pred).map((x: any) => x.id);
  const energies = ids((x: any) => x.kind === "energy" && !x.special);
  const commons = ids((x: any) => x.kind === "pokemon" && x.rarity === "Common");
  const rares = ids((x: any) => x.kind === "pokemon" && x.rarity === "Rare Holo" || (x.kind === "pokemon" && x.rarity === "Rare"));

  const catalogWith = (mut: (cat: any) => void): Core => {
    const cat = structuredClone(base);
    mut(cat);
    return loadCore({ catalog: cat });
  };

  it("las cartas deshabilitadas y las que no existen nunca salen", () => {
    assert.ok(commons.length >= 4 && energies.length >= 1);
    const off = commons.slice(0, 2);
    const c = catalogWith((cat) => {
      for (const x of cat.cards) if (off.includes(x.id)) x.enabled = false;
      cat.boosters = [{ id: "t", name: "T", enabled: true, cards: [...commons, ...energies, "noExiste"], slots: [{ count: 1, rarity: "Energy" }, { count: 3, rarity: "Common" }] }];
    });
    const def = c.BOOSTERS[0];
    for (let i = 0; i < 500; i++) {
      const pack = c.generateBooster(def, c.sfc32("o" + i));
      assert.equal(pack.length, 4);
      for (const id of pack) assert.ok(!off.includes(id) && id !== "noExiste", id);
    }
  });

  it("pool más chico que el slot: devuelve igual la cantidad pedida, sin colgarse", () => {
    const c = catalogWith((cat) => {
      cat.boosters = [{ id: "t", name: "T", enabled: true, cards: [...commons.slice(0, 2), energies[0]], slots: [{ count: 2, rarity: "Energy" }, { count: 5, rarity: "Common" }] }];
    });
    const pack = c.generateBooster(c.BOOSTERS[0], c.sfc32("p"));
    assert.equal(pack.length, 7);
    assert.ok(pack.every((id: string) => [...commons.slice(0, 2), energies[0]].includes(id)));
  });

  it("slot de una rareza que el sobre no tiene: usa cualquier carta del pool", () => {
    const c = catalogWith((cat) => {
      cat.boosters = [{ id: "t", name: "T", enabled: true, cards: commons.slice(0, 6), slots: [{ count: 2, rarity: "Rare" }] }];
    });
    const pack = c.generateBooster(c.BOOSTERS[0], c.sfc32("q"));
    assert.equal(pack.length, 2);
    assert.ok(pack.every((id: string) => commons.includes(id)));
  });

  it("holoChance 0 y 1 son absolutos", () => {
    const holos = rares.filter((id: string) => base.cards.find((x: any) => x.id === id).rarity === "Rare Holo");
    const plain = rares.filter((id: string) => base.cards.find((x: any) => x.id === id).rarity === "Rare");
    if (!holos.length || !plain.length) return;
    for (const chance of [0, 1]) {
      const c = catalogWith((cat) => {
        cat.boosters = [{ id: "t", name: "T", enabled: true, cards: [...holos, ...plain], slots: [{ count: 1, rarity: "Rare", holoChance: chance }] }];
      });
      for (let i = 0; i < 200; i++) {
        const [id] = c.generateBooster(c.BOOSTERS[0], c.sfc32("h" + i));
        assert.equal(!!c.CARDS[id].holo, chance === 1);
      }
    }
  });

  it("funciona con cualquier Rng (incluidos los extremos 0 y casi 1) y toda la aleatoriedad sale de él", () => {
    const c = configs[configs.length - 1].core;
    const def = c.BOOSTERS[0];
    for (const v of [0, 0.5, 0.999999999]) {
      const pack = c.generateBooster(def, { next: () => v });
      checkPack(c, def, pack, `rng constante ${v}`);
    }
    // un Rng "de servidor" (contador) reproduce el mismo sobre; cuenta cuántas veces se usó
    const make = () => {
      let n = 0;
      return { r: { next: () => ((n++ * 0.6180339887498949) % 1) }, calls: () => n };
    };
    const a = make();
    const b = make();
    assert.equal(JSON.stringify(c.generateBooster(def, a.r)), JSON.stringify(c.generateBooster(def, b.r)));
    assert.ok(a.calls() > 0);
  });
});
