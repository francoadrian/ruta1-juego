// Tests de viewFor / peek / log (ADR 0002, paso 3): lo que sale hacia un cliente no tiene que
// contener información oculta del rival (ni de uno mismo: mazo y premios), ni el RNG ni la semilla.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadCore, type Core } from "./load-core.ts";
import { allCards, initialUids, assertConserved, newMatch, playAI, playFuzz, snapshot } from "./helpers.ts";

const c = loadCore({ catalog: "file" }); // el catálogo real: trae los Entrenadores que buscan en el mazo
const c0 = loadCore(); // solo Base Set

const FORBIDDEN_KEYS = ["rng", "seed", "uidNext", "log", "logCount", "after", "ai", "c", "deckList", "intents"];

/** Todos los objetos y valores de un JSON (en profundidad). */
function walk(x: any, fn: (key: string, value: any, parent: any) => void, key = "", parent: any = null): void {
  fn(key, x, parent);
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, fn, k, x);
}

/** uids de las cartas que `pi` puede ver (suyas en la mano, descartes y todo lo que está en juego y a la vista). */
function visibleUids(core: Core, m: any, pi: number): Set<number> {
  const out = new Set<number>();
  const b = m.b;
  const addSlot = (s: any) => [...s.stack, ...s.energy, ...s.tools, ...s.defenders].forEach((x) => out.add(x.uid));
  for (const q of [0, 1]) {
    b.p[q].discard.forEach((x: any) => out.add(x.uid));
    if (q === pi || b.phase !== "setup") core.inPlay(b.p[q]).forEach(addSlot);
  }
  b.p[pi].hand.forEach((x: any) => out.add(x.uid));
  return out;
}

/** Revisa la vista de `pi` en el estado actual. Lanza si algo se filtra. */
function checkView(core: Core, m: any, pi: 0 | 1, where: string): any {
  const b = m.b;
  const view = core.viewFor(m, pi);
  const text = JSON.stringify(view);
  const parsed = JSON.parse(text);
  assert.equal(JSON.stringify(parsed), text, `${where}: la vista no es JSON puro`);

  // nada interno
  walk(parsed, (k) => assert.ok(!FORBIDDEN_KEYS.includes(k), `${where}: la vista trae la clave "${k}"`));
  assert.ok(!/match:|sfc32|seed/i.test(text), `${where}: la vista menciona la semilla`);

  // cantidades en vez de cartas
  const me = parsed.p[0];
  const opp = parsed.p[1];
  assert.ok(Array.isArray(me.hand), `${where}: mi mano es un array`);
  assert.equal(me.hand.length, b.p[pi].hand.length);
  assert.equal(typeof opp.hand, "number", `${where}: la mano del rival es un número`);
  assert.equal(opp.hand, b.p[1 - pi].hand.length);
  for (const [v, q] of [[me, pi], [opp, 1 - pi]] as const) {
    assert.equal(v.deck, b.p[q].deck.length, `${where}: mazo es una cantidad`);
    assert.equal(v.prizes, b.p[q].prizes.length, `${where}: premios es una cantidad`);
    assert.equal(v.discard.length, b.p[q].discard.length);
  }
  if (b.phase === "setup") {
    assert.equal(opp.active, null, `${where}: el Activo rival se ve en la preparación`);
    assert.equal(typeof opp.bench, "number");
  } else {
    assert.ok(Array.isArray(opp.bench));
    assert.equal(opp.bench.length, b.p[1 - pi].bench.length);
  }

  // ningún uid oculto (mano, mazo y premios del rival; mazo y premios propios) aparece en la vista
  const hidden = new Set<number>();
  for (const x of [...b.p[1 - pi].hand, ...b.p[1 - pi].deck, ...b.p[1 - pi].prizes, ...b.p[pi].deck, ...b.p[pi].prizes]) hidden.add(x.uid);
  const allowed = visibleUids(core, m, pi);
  const found = new Set<number>();
  walk(parsed, (k, v) => {
    if (k === "uid" && typeof v === "number") found.add(v);
  });
  for (const uid of found) {
    assert.ok(!hidden.has(uid), `${where}: la vista de ${pi} trae el uid oculto ${uid}`);
    assert.ok(allowed.has(uid), `${where}: la vista de ${pi} trae el uid ${uid} que no está a la vista`);
  }
  // y todas las cartas de la vista tienen id de una carta real
  walk(parsed, (k, v, parent) => {
    if (k === "id" && parent && "uid" in parent) assert.ok(core.CARDS[v], `${where}: id ${v} desconocido`);
  });

  // la vista no cambia si cambia lo oculto del rival (otro orden de mazo, otra mano) ni el RNG
  return parsed;
}

describe("viewFor: forma", () => {
  it("el destinatario es siempre p[0] y la vista es JSON puro", () => {
    const m = newMatch(c, "v1", { ai: [false, false] });
    const v0 = c.viewFor(m, 0);
    const v1 = c.viewFor(m, 1);
    assert.equal(v0.p[0].name, "Ana");
    assert.equal(v0.p[1].name, "Beto");
    assert.equal(v1.p[0].name, "Beto");
    assert.equal(v1.p[1].name, "Ana");
    assert.equal(v0.phase, "setup");
    assert.equal(JSON.stringify(v0.setupDone), "[false,false]");
    assert.ok(v0.p[0].hand.length >= 7);
    assert.equal(v0.p[0].deck + v0.p[0].hand.length, 60);
    assert.equal(v0.p[0].prizes, 0, "los Premios se separan al terminar la preparación");
    assert.equal(v0.prizeCount, 6);
  });

  it("en la preparación el rival no muestra su mesa hasta que los dos terminan", () => {
    const m = newMatch(c, "v2", { ai: [false, false] });
    const set = (pi: 0 | 1) => {
      while (!m.setupDone[pi]) assert.equal(c.applyIntent(m, pi, c.defaultIntent(m, pi)), null);
    };
    set(1);
    let v = c.viewFor(m, 0);
    assert.equal(v.p[1].active, null);
    assert.equal(JSON.stringify(v.setupDone), "[false,true]");
    assert.equal(v.p[0].active, null, "yo todavía no elegí");
    checkView(c, m, 0, "setup parcial");
    checkView(c, m, 1, "setup parcial");
    // el rival que ya terminó ve su propia mesa, pero no la mía
    assert.ok(c.viewFor(m, 1).p[1].active === null);
    assert.ok(c.viewFor(m, 1).p[0].active !== null);
    set(0);
    v = c.viewFor(m, 0);
    assert.equal(v.phase, "turn");
    assert.ok(v.p[1].active && v.p[1].active.stack.length >= 1);
    assert.equal(v.setupDone, undefined);
    assert.equal(v.p[0].prizes, 6);
    assert.equal(v.p[1].prizes, 6);
  });

  it("gira cur, first, winner y promoteQueue según quién mira", () => {
    const m = newMatch(c, "v3", { ai: [false, false] });
    for (const pi of [0, 1] as const) while (!m.setupDone[pi]) c.applyIntent(m, pi, c.defaultIntent(m, pi));
    const cur = m.b.cur;
    assert.equal(c.viewFor(m, cur).cur, 0);
    assert.equal(c.viewFor(m, 1 - cur).cur, 1);
    assert.equal(c.viewFor(m, m.b.first).first, 0);
    assert.equal(c.viewFor(m, 0).winner, -1);
    c.applyIntent(m, 1, { t: "surrender" });
    assert.equal(c.viewFor(m, 0).winner, 0, "ganó el 0: se ve como 0 para el 0");
    assert.equal(c.viewFor(m, 1).winner, 1, "ganó el 0: se ve como 1 (el rival) para el 1");
    assert.equal(c.viewFor(m, 0).phase, "over");
  });

  it("las dos vistas coinciden en lo público y no comparten objetos con la partida", () => {
    const m = newMatch(c, "v4");
    let n = 0;
    playAI(c, m, () => {
      if (++n % 7) return;
      const a = c.viewFor(m, 0);
      const b = c.viewFor(m, 1);
      for (const k of ["active", "bench", "discard", "name", "deck", "prizes", "turns", "mulligans"]) { // deckName no: es solo del propio jugador
        assert.equal(JSON.stringify(a.p[1][k]), JSON.stringify(b.p[0][k]), `p[1].${k} del 0 = p[0].${k} del 1`);
        assert.equal(JSON.stringify(a.p[0][k]), JSON.stringify(b.p[1][k]));
      }
      assert.equal(a.turn, b.turn);
      assert.equal(a.cur, 1 - b.cur);
      // modificar la vista no toca la partida
      const before = snapshot(m);
      const text = JSON.stringify(a);
      a.p[0].active?.stack.push({ uid: -1, id: "x" });
      a.p[0].active?.energy.splice(0);
      if (a.p[0].active?.lastHit) a.p[0].active.lastHit.damage = 999;
      assert.equal(snapshot(m), before);
      assert.equal(JSON.stringify(c.viewFor(m, 0)), text);
    });
  });

  it("los Pokémon en juego conservan su estado (energías, daño, estado, evolución)", () => {
    const m = newMatch(c, "v5");
    let checked = 0;
    playAI(c, m, () => {
      for (const pi of [0, 1] as const) {
        const v = c.viewFor(m, pi);
        const real = [...c.inPlay(m.b.p[pi])];
        const seen = [v.p[0].active, ...v.p[0].bench].filter(Boolean);
        assert.equal(seen.length, real.length);
        seen.forEach((s: any, i: number) => {
          const r = real[i];
          assert.equal(s.uid, r.uid);
          assert.equal(JSON.stringify(s.stack.map((x: any) => x.id)), JSON.stringify(r.stack.map((x: any) => x.c.id)));
          assert.equal(JSON.stringify(s.energy.map((x: any) => x.id)), JSON.stringify(r.energy.map((x: any) => x.c.id)));
          assert.equal(s.damage, r.damage);
          assert.equal(s.status, r.status);
          assert.equal(s.poisoned, r.poisoned);
          assert.equal(s.enteredTurn, r.enteredTurn);
          checked++;
        });
      }
    });
    assert.ok(checked > 50);
  });
});

describe("viewFor: nada oculto sale hacia el cliente", () => {
  it("20 partidas IA vs IA: en cada paso, para los dos jugadores", () => {
    let views = 0;
    for (let i = 0; i < 20; i++) {
      const m = newMatch(c, "vi-" + i);
      checkView(c, m, 0, `ia ${i} inicio`);
      playAI(c, m, (pi) => {
        for (const q of [0, 1] as const) checkView(c, m, q, `ia ${i}, tras la IA ${pi}`), views++;
      });
    }
    assert.ok(views > 2000);
  });

  it("partidas con intents al azar (incluida la preparación y las rechazadas)", () => {
    for (let i = 0; i < 12; i++) {
      playFuzz(c, "vz-" + i, {
        maxMoves: 1200,
        check: (m, mv) => {
          for (const q of [0, 1] as const) checkView(c, m, q, `fuzz ${i} tras ${JSON.stringify(mv.intent)}`);
        },
      });
    }
  });

  it("cambiar lo oculto del rival no cambia mi vista (orden del mazo, mano, premios, RNG)", () => {
    for (let i = 0; i < 6; i++) {
      const m = newMatch(c, "vh-" + i);
      let n = 0;
      playAI(c, m, () => {
        if (++n % 5 || m.b.phase === "over") return;
        for (const me of [0, 1] as const) {
          const before = JSON.stringify(c.viewFor(m, me));
          const o = m.b.p[1 - me];
          const swap = (a: any[], b: any[]) => {
            if (a.length && b.length) [a[0], b[0]] = [b[0], a[0]];
          };
          // lo que mueve el test es info oculta del rival; las cantidades quedan igual
          swap(o.hand, o.deck);
          swap(o.prizes, o.deck);
          o.deck.reverse();
          m.b.rng.next();
          m.b.uidNext += 5;
          assert.equal(JSON.stringify(c.viewFor(m, me)), before, `partida ${i}: la vista de ${me} depende de algo oculto`);
          // mi propio mazo y premios tampoco se ven
          const mine = m.b.p[me];
          swap(mine.prizes, mine.deck);
          mine.deck.reverse();
          assert.equal(JSON.stringify(c.viewFor(m, me)), before, `partida ${i}: la vista de ${me} depende de su mazo/premios`);
          // (se deja el estado alterado: la partida sigue siendo consistente porque solo se permutaron cartas)
        }
      });
    }
  });

  it("los uids no revelan la posición inicial en el mazo", () => {
    // Si los uids se repartieran en orden, las 7 cartas de la mano inicial serían siempre las más bajas.
    let allLow = 0;
    for (let i = 0; i < 30; i++) {
      const m = newMatch(c0, "uid-" + i, { ai: [false, false] });
      const ids = m.b.p[0].hand.map((x: any) => x.uid);
      if (ids.every((u: number) => u <= 7 + m.b.p[1].mulligans + 10)) allLow++;
    }
    assert.ok(allLow < 3, `la mano inicial casi siempre tiene los uids más bajos (${allLow}/30)`);
    // y son únicos entre los dos jugadores, de 1 a 120
    const m = newMatch(c0, "uid-x", { ai: [false, false] });
    const all = [0, 1].flatMap((pi) => allCards(c0, m.b.p[pi]).map((x: any) => x.uid)).sort((a, b) => a - b);
    assert.equal(JSON.stringify(all), JSON.stringify(Array.from({ length: 120 }, (_, i) => i + 1)));
  });
});

// ---------------------------------------------------------------------
//  Textos de log: no pueden decir qué carta oculta se movió
// ---------------------------------------------------------------------
type Zone = "hand" | "deck" | "prizes";

/** Vigila que ninguna línea de log nombre una carta que cambió de lugar entre zonas ocultas. */
function logWatcher(core: Core, m: any) {
  let prev: Map<number, { zone: Zone; owner: number; name: string }> | undefined;
  let cursor = m.b.logCount;
  const leaks: string[] = [];
  const hiddenNow = () => {
    const out = new Map<number, { zone: Zone; owner: number; name: string }>();
    m.b.p.forEach((p: any, owner: number) => {
      for (const zone of ["hand", "deck", "prizes"] as Zone[]) for (const x of p[zone]) out.set(x.uid, { zone, owner, name: x.c.name });
    });
    return out;
  };
  const publicNames = () => {
    const names = new Set<string>();
    for (const p of m.b.p) {
      p.discard.forEach((x: any) => names.add(x.c.name));
      core.inPlay(p).forEach((s: any) => [...s.stack, ...s.energy, ...s.tools, ...s.defenders].forEach((x: any) => names.add(x.c.name)));
    }
    return names;
  };
  let prevPublic = new Set<string>();
  const sync = () => {
    prev = hiddenNow();
    prevPublic = publicNames();
    cursor = m.b.logCount;
  };
  sync();
  return {
    sync,
    /** Llamar después de cada paso. */
    step(where: string): number {
      const now = hiddenNow();
      const lines = core.logSince(m, cursor);
      cursor = m.b.logCount;
      const pub = new Set([...prevPublic, ...publicNames()]);
      const known = [...pub].sort((a, b) => b.length - a.length);
      let moved = 0;
      for (const [uid, was] of prev!) {
        const is = now.get(uid);
        if (!is || is.zone === was.zone || is.owner !== was.owner) continue; // salió de las zonas ocultas (se jugó/descartó: es público) o no se movió
        moved++;
        if (pub.has(was.name)) continue; // el nombre ya era conocido por otra carta a la vista
        for (const line of lines) {
          let rest: string = line;
          for (const n of known) rest = rest.split(n).join("·");
          if (rest.includes(was.name)) leaks.push(`${where}: "${line}" nombra ${was.name} (${was.zone} → ${is.zone})`);
        }
      }
      prev = now;
      prevPublic = publicNames();
      return moved;
    },
    leaks,
  };
}

describe("log: no filtra cartas ocultas", () => {
  it("partidas IA y con intents al azar: ninguna línea nombra una carta que pasó de una zona oculta a otra", () => {
    let moved = 0;
    for (let i = 0; i < 40; i++) {
      const m = newMatch(c, "lg-" + i);
      const w = logWatcher(c, m);
      playAI(c, m, (pi) => (moved += w.step(`ia ${i} (IA ${pi})`)));
      assert.deepEqual([...w.leaks], []);
    }
    for (let i = 0; i < 20; i++) {
      let w: ReturnType<typeof logWatcher> | undefined;
      let leaks: string[] = [];
      playFuzz(c, "lz-" + i, {
        maxMoves: 1500,
        check: (m, mv) => {
          w ??= logWatcher(c, m);
          moved += w.step(`fuzz ${i} ${JSON.stringify(mv.intent)}`);
          leaks = w.leaks;
        },
      });
      assert.deepEqual([...leaks], []);
    }
    assert.ok(moved > 500, "el test tiene que ver movimientos entre zonas ocultas (robar, Premios...)");
  });
});

// ---------------------------------------------------------------------
//  Entrenadores que miran el mazo (peek)
// ---------------------------------------------------------------------
describe("peek: buscar y ordenar el mazo", () => {
  /** Partida en el turno 1 de `pi` con `id` en su mano (se la saca de donde esté). */
  function withTrainer(id: string, seed: string) {
    const base = c.BRUSHFIRE.cards.map((e: any) => ({ ...e }));
    base.find((e: any) => e.id === "fireEnergy").qty -= 1;
    const deck = { name: "Prueba", cards: [...base, { id, qty: 1 }] };
    const m = c.createMatch([deck, deck], ["Ana", "Beto"], { rng: c.sfc32("pk:" + seed), ai: [false, false] });
    for (const pi of [0, 1] as const) while (!m.setupDone[pi]) assert.equal(c.applyIntent(m, pi, c.defaultIntent(m, pi)), null);
    const pi = m.b.cur as 0 | 1;
    const p = m.b.p[pi];
    for (const zone of ["deck", "prizes", "discard"]) {
      const i = p[zone].findIndex((x: any) => x.c.id === id);
      if (i >= 0 && !p.hand.some((x: any) => x.c.id === id)) p.hand.push(...p[zone].splice(i, 1));
    }
    assert.ok(p.hand.some((x: any) => x.c.id === id));
    // para el trueque: un Pokémon en la mano (la preparación los puso en juego)
    if (!p.hand.some((x: any) => x.c.kind === "pokemon")) p.hand.push(...p.deck.splice(p.deck.findIndex((x: any) => x.c.kind === "pokemon"), 1));
    return { m, pi, p, o: m.b.p[1 - pi], card: p.hand.find((x: any) => x.c.id === id) };
  }

  const available = (id: string) => !!c.CARDS[id] && c.CARDS[id].enabled !== false;

  it("Pokédex (ordenar las 5 de arriba): peek las muestra en orden, solo al dueño, y jugarlo reordena", { skip: !available("pokedex") }, () => {
    const { m, pi, p, card } = withTrainer("pokedex", "a");
    assert.equal(c.peek(m, pi), null, "todavía no miró");
    const top = p.deck.slice(0, 5).map((x: any) => x.uid);
    assert.equal(c.applyIntent(m, pi, { t: "peek", card: card.uid }), null);
    const info = c.peek(m, pi);
    assert.equal(info.length, 1);
    assert.equal(info[0].mode, "top");
    assert.equal(info[0].count, 5);
    assert.equal(JSON.stringify(info[0].cards.map((x: any) => x.uid)), JSON.stringify(top));
    assert.equal(c.peek(m, (1 - pi) as 0 | 1), null, "el rival no ve nada");
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(info))), JSON.stringify(info), "serializable");
    // la vista sigue sin mostrar el mazo, ni siquiera durante el peek
    checkView(c, m, pi, "durante peek");
    checkView(c, m, (1 - pi) as 0 | 1, "durante peek (rival)");

    // bloqueado: solo puede jugar esa carta
    for (const intent of [{ t: "endTurn" }, { t: "attack", idx: 0 }, { t: "peek", card: card.uid }]) {
      const before = snapshot(m);
      assert.match(c.applyIntent(m, pi, intent), /mazo/);
      assert.equal(snapshot(m), before);
    }
    assert.equal(JSON.stringify(c.defaultIntent(m, pi)), JSON.stringify({ t: "playTrainer", card: card.uid }));

    const initial = initialUids(c, m);
    const order = [4, 3, 2, 1, 0];
    assert.equal(c.applyIntent(m, pi, { t: "playTrainer", card: card.uid, choice: { picks: { 0: { order } } } }), null);
    assert.equal(JSON.stringify(p.deck.slice(0, 5).map((x: any) => x.uid)), JSON.stringify([...top].reverse()));
    assert.equal(c.peek(m, pi), null, "se levantó el bloqueo");
    assert.equal(m.peekLock, undefined);
    assertConserved(c, m, initial, "tras Pokédex");
    assert.equal(c.applyIntent(m, pi, { t: "endTurn" }), null);
  });

  it("si se vence el tiempo con un peek pendiente, defaultIntent juega el Entrenador con orden automático", { skip: !available("pokedex") }, () => {
    const { m, pi, p, card } = withTrainer("pokedex", "b");
    const top = p.deck.slice(0, 5).map((x: any) => x.uid);
    c.applyIntent(m, pi, { t: "peek", card: card.uid });
    assert.equal(c.applyIntent(m, pi, c.defaultIntent(m, pi)), null);
    assert.equal(JSON.stringify(p.deck.slice(0, 5).map((x: any) => x.uid)), JSON.stringify(top), "sin elección queda como estaba");
    assert.equal(m.peekLock, undefined);
  });

  it("Computer Search: peek muestra todo el mazo ordenado por número (no por posición) y jugarlo no nombra la carta en el log", { skip: !available("computerSearch") }, () => {
    const { m, pi, p, o, card } = withTrainer("computerSearch", "c");
    const discards = p.hand.filter((x: any) => x !== card).slice(0, 2);
    assert.equal(c.applyIntent(m, pi, { t: "peek", card: card.uid }), null);
    const info = c.peek(m, pi);
    assert.equal(info[0].mode, "search");
    assert.equal(info[0].cards.length, p.deck.length);
    const numbers = info[0].cards.map((x: any) => c.CARDS[x.id].number);
    assert.equal(JSON.stringify(numbers), JSON.stringify([...numbers].sort((a: number, b: number) => a - b)), "ordenadas por número de carta");
    assert.notEqual(JSON.stringify(info[0].cards.map((x: any) => x.uid)), JSON.stringify(p.deck.map((x: any) => x.uid)), "no sale en el orden del mazo");

    // elige una carta cuyo nombre no esté a la vista, para que el log no pueda nombrarla "de casualidad"
    const publicNames = new Set([...p.discard, ...o.discard, ...c.inPlay(p).flatMap((s: any) => s.stack), ...c.inPlay(o).flatMap((s: any) => s.stack), ...discards].map((x: any) => x.c.name));
    const wanted = p.deck.find((x: any) => !publicNames.has(x.c.name) && !x.c.name.includes("Energy") && x.c.name !== card.c.name);
    assert.ok(wanted);
    const initial = initialUids(c, m);
    const cursor = m.b.logCount;
    const err = c.applyIntent(m, pi, {
      t: "playTrainer", card: card.uid,
      choice: { picks: { 0: { cards: discards.map((x: any) => x.uid) }, 1: { cards: [wanted.uid] } } },
    });
    assert.equal(err, null);
    assert.ok(p.hand.some((x: any) => x.uid === wanted.uid), "la carta pedida está en la mano");
    const lines = c.logSince(m, cursor).join("\n");
    assert.ok(/busca 1 carta/.test(lines), lines);
    assert.ok(!lines.includes(wanted.c.name), `el log nombra la carta buscada: ${lines}`);
    assertConserved(c, m, initial, "tras Computer Search");
    // el rival no se entera de cuál fue (su vista no tiene la mano)
    assert.equal(typeof c.viewFor(m, (1 - pi) as 0 | 1).p[1].hand, "number");
  });

  it("Pokémon Trader: peek muestra solo Pokémon, y se juega con elección automática", { skip: !available("pokemonTrader") }, () => {
    const { m, pi, p, card } = withTrainer("pokemonTrader", "d");
    const initial = initialUids(c, m);
    assert.equal(c.applyIntent(m, pi, { t: "peek", card: card.uid }), null);
    const info = c.peek(m, pi);
    assert.ok(info.length >= 1 && info.every((x: any) => x.mode === "search"));
    for (const x of info.at(-1).cards) assert.equal(c.CARDS[x.id].kind, "pokemon");
    assert.equal(c.applyIntent(m, pi, { t: "playTrainer", card: card.uid }), null);
    assertConserved(c, m, initial, "tras Pokémon Trader");
    assert.ok(p.discard.some((x: any) => x.uid === card.uid));
  });

  it("peek se rechaza con cartas que no buscan, fuera de turno o con cartas ajenas", () => {
    const m = newMatch(c, "pk-x", { ai: [false, false] });
    for (const pi of [0, 1] as const) while (!m.setupDone[pi]) c.applyIntent(m, pi, c.defaultIntent(m, pi));
    const cur = m.b.cur as 0 | 1;
    const before = snapshot(m);
    const any = m.b.p[cur].hand[0];
    assert.ok(c.applyIntent(m, cur, { t: "peek", card: any.uid }), "una carta que no busca");
    assert.ok(c.applyIntent(m, (1 - cur) as 0 | 1, { t: "peek", card: any.uid }), "fuera de turno");
    assert.ok(c.applyIntent(m, cur, { t: "peek", card: m.b.p[1 - cur].hand[0].uid }), "carta del rival");
    assert.equal(snapshot(m), before);
  });

  it("no se pueden nombrar cartas ocultas del rival ni los Premios propios al jugar un Entrenador", { skip: !available("computerSearch") }, () => {
    const { m, pi, p, o, card } = withTrainer("computerSearch", "e");
    const others = p.hand.filter((x: any) => x !== card).slice(0, 2).map((x: any) => x.uid);
    for (const bad of [o.hand[0].uid, o.deck[0].uid, o.prizes[0].uid, p.prizes[0].uid]) {
      const before = snapshot(m);
      const err = c.applyIntent(m, pi, { t: "playTrainer", card: card.uid, choice: { picks: { 0: { cards: others }, 1: { cards: [bad] } } } });
      assert.match(err, /no válida/);
      assert.equal(snapshot(m), before);
    }
  });
});
