// Tests del driver de combate (ADR 0002, paso 8): driver local jugando una partida entera con un "jugador" que usa
// solo lo que ve la UI (ViewBattle + intents), rehidratación de la vista y driver remoto contra un servidor simulado.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { CORE_FILES, ROOT, readCatalog } from "./load-core.ts";
import { randomDeck } from "./helpers.ts";
import { loadCore } from "./load-core.ts";

/** Núcleo + driver.ts en un mismo contexto (driver.ts no toca el DOM). */
function load(withCatalog = false): any {
  const cat = withCatalog ? readCatalog() : null;
  const ctx = vm.createContext(cat ? { GAME_CATALOG: cat } : {}, { name: "ruta1-driver" });
  vm.runInContext('Math.random = () => { throw new Error("Math.random"); }', ctx);
  for (const f of [...CORE_FILES, "src/driver.ts"]) {
    const code = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, f), "utf8"), { mode: "strip" });
    new vm.Script(code, { filename: f }).runInContext(ctx);
  }
  const names = "CARDS sfc32 createLocalDriver createRemoteDriver hydrateView pickToIntent createMatch applyIntent viewFor stepAI logSince trainerSteps isBasic inPlay topCard trainerError evolveTargets attackError".split(" ");
  const api: any = vm.runInContext(`({ ${names.join(", ")} })`, ctx);
  api.run = (e: string) => vm.runInContext(e, ctx);
  return api;
}

/** Lo que haría la UI: lee la vista hidratada y manda intents. Devuelve cuántas partidas errores/peeks usó. */
function playWithDriver(c: any, seed: string): { over: boolean; errors: string[]; peeks: number; lines: number; hidden: number } {
  const decks = [randomDeck(loadCore({ catalog: "file" }), seed + "a"), randomDeck(loadCore({ catalog: "file" }), seed + "b")];
  const d = c.createLocalDriver(decks, ["YO", "RIVAL"], { prizes: 3, rng: c.sfc32(seed) });
  let b: any = null;
  let peekInfo: any[] | null = null;
  const errors: string[] = [];
  let peeks = 0;
  let lines = 0;
  let hidden = 0;
  d.handlers = {
    onState(view: any, log: string[]) {
      // la vista es JSON puro: lo que llega por el cable
      b = c.hydrateView(JSON.parse(JSON.stringify(view)));
      lines += log.length;
    },
    onError(m: string) { errors.push(m); },
    onPeek(info: any[]) { peekInfo = info; peeks++; },
  };
  d.begin();
  for (let i = 0; i < 6000 && b.phase !== "over"; i++) {
    d.tick(1);
    // nada oculto en lo hidratado: mano rival, mazo y premios son cartas "?"
    hidden += b.p[1].hand.filter((x: any) => x.uid === -1).length + b.p[0].deck.filter((x: any) => x.uid === -1).length;
    if (peekInfo) {
      const info = peekInfo as any[];
      peekInfo = null;
      const card = b.p[0].hand.find((x: any) => x.uid === info[0].card);
      const picks: Record<number, any> = {};
      let k = 0;
      c.trainerSteps(card.c).forEach((st: any, i: number) => {
        if (st.op === "searchDeck") picks[i] = { cards: info[k++].cards.slice(0, Math.max(1, Number(st.count) || 1)).map((x: any) => x.uid) };
        else if (st.op === "arrangeTop") picks[i] = { order: [...info[k++].cards.keys()].reverse() };
      });
      d.send({ t: "playTrainer", card: card.uid, choice: { picks } });
      continue;
    }
    if (b.phase === "setup") {
      const me = b.p[0];
      const basic = me.hand.find((x: any) => c.isBasic(x.c));
      if (b.setupDone?.[0]) continue;
      if (!me.active) d.send({ t: "setupActive", card: basic.uid });
      else if (basic && me.bench.length < 5) d.send({ t: "setupBench", card: basic.uid });
      else d.send({ t: "setupDone" });
      continue;
    }
    if (b.phase === "promote") {
      if (b.promoteQueue[0] === 0) d.send({ t: "promote", bench: b.p[0].bench[0].uid });
      continue;
    }
    if (b.phase !== "turn" || b.cur !== 0) continue;
    const me = b.p[0];
    const err = errors.length;
    const hand = me.hand;
    const energy = hand.findIndex((x: any) => x.c.kind === "energy");
    const basic = hand.findIndex((x: any) => c.isBasic(x.c));
    if (!b.energyPlayed && energy >= 0 && me.active) { d.send({ t: "attachEnergy", card: hand[energy].uid, target: me.active.uid }); }
    else if (basic >= 0 && me.bench.length < 5) d.send({ t: "playBasic", card: hand[basic].uid });
    else {
      const ev = hand.findIndex((x: any, hi: number) => x.c.kind === "pokemon" && c.evolveTargets(b, 0, hi).length);
      const tr = hand.findIndex((x: any, hi: number) => x.c.kind === "trainer" && !c.trainerSteps(x.c).some((s: any) => s.op === "searchDeck" || s.op === "arrangeTop") && !c.trainerError(b, 0, hi) && !c.trainerSteps(x.c).some((s: any) => s.op === "chooseSlot"));
      const sd = hand.findIndex((x: any) => x.c.kind === "trainer" && c.trainerSteps(x.c).some((s: any) => s.op === "searchDeck" || s.op === "arrangeTop"));
      if (ev >= 0) d.send({ t: "evolve", card: hand[ev].uid, target: c.evolveTargets(b, 0, ev)[0].uid });
      else if (tr >= 0 && i % 3 === 0) d.send({ t: "playTrainer", card: hand[tr].uid });
      else if (sd >= 0 && i % 5 === 0) d.send({ t: "peek", card: hand[sd].uid });
      else if (me.active && !c.attackError(b, 0, me.active.stack.length ? c.topCard(me.active).attacks.length - 1 : 0)) d.send({ t: "attack", idx: c.topCard(me.active).attacks.length - 1 });
      else d.send({ t: "endTurn" });
    }
    if (errors.length > err && peekInfo === null && b.phase === "turn" && b.cur === 0) d.send({ t: "endTurn" });
  }
  return { over: b.phase === "over", errors, peeks, lines, hidden };
}

describe("driver local", () => {
  it("juega partidas enteras solo con ViewBattle e intents (varias semillas), sin excepciones", () => {
    let peeks = 0;
    for (const seed of ["d1", "d2", "d3", "d4", "d5", "d6"]) {
      const c = load(true);
      const r = playWithDriver(c, seed);
      assert.ok(r.over, `la partida ${seed} no terminó`);
      assert.ok(r.lines > 10);
      assert.ok(r.hidden > 0);
      peeks += r.peeks;
    }
    console.log("peeks:", peeks);
  });

  it("misma semilla = misma partida (el log coincide)", () => {
    const run = () => {
      const c = load(true);
      const decks = [randomDeck(loadCore({ catalog: "file" }), "x1"), randomDeck(loadCore({ catalog: "file" }), "x2")];
      const d = c.createLocalDriver(decks, ["A", "B"], { prizes: 2, rng: c.sfc32("fija") });
      const log: string[] = [];
      d.handlers = { onState: (_v: any, l: string[]) => log.push(...l), onError() {}, onPeek() {} };
      d.begin();
      return JSON.stringify(log);
    };
    assert.equal(run(), run());
  });
});

describe("hydrateView", () => {
  it("rehidrata id -> carta y deja al rival como cantidades (mano, mazo, premios), sin RNG", () => {
    const c = load(true);
    const decks = [randomDeck(loadCore({ catalog: "file" }), "h1"), randomDeck(loadCore({ catalog: "file" }), "h2")];
    const m = c.createMatch(decks, ["A", "B"], { rng: c.sfc32("h"), prizes: 3 });
    const v = JSON.parse(JSON.stringify(c.viewFor(m, 0)));
    const b = c.hydrateView(v);
    for (const x of b.p[0].hand) assert.equal(x.c, c.CARDS[x.c.id]);
    assert.equal(b.p[1].hand.every((x: any) => x.uid === -1), true);
    assert.equal(b.p[1].hand.length, v.p[1].hand);
    assert.equal(b.p[0].deck.length, v.p[0].deck);
    assert.equal(b.oppHidden, true);
    assert.throws(() => b.rng.next());
    // no comparte objetos con la vista
    assert.notEqual(b.p[0].hand[0], v.p[0].hand[0]);
  });

  it("después de la preparación, los slots del rival se rehidratan completos", () => {
    const c = load(true);
    const decks = [randomDeck(loadCore({ catalog: "file" }), "h3"), randomDeck(loadCore({ catalog: "file" }), "h4")];
    const m = c.createMatch(decks, ["A", "B"], { rng: c.sfc32("h3"), prizes: 3 });
    for (const pi of [0, 1]) {
      const basic = m.b.p[pi].hand.find((x: any) => c.isBasic(x.c));
      assert.equal(c.applyIntent(m, pi, { t: "setupActive", card: basic.uid }), null);
      assert.equal(c.applyIntent(m, pi, { t: "setupDone" }), null);
    }
    const b = c.hydrateView(JSON.parse(JSON.stringify(c.viewFor(m, 0))));
    assert.equal(b.phase, "turn");
    assert.equal(b.oppHidden, false);
    assert.ok(b.p[1].active);
    assert.equal(c.topCard(b.p[1].active).id, c.topCard(m.b.p[1].active).id);
  });

  it("pickToIntent convierte objetos en uids", () => {
    const c = load(true);
    const out = c.pickToIntent({ slot: { uid: 5 }, cards: [{ uid: 7 }, { uid: 9 }], order: [1, 0], stage: 2 });
    assert.equal(JSON.stringify(out), JSON.stringify({ slot: 5, cards: [7, 9], order: [1, 0], stage: 2 }));
  });
});

describe("driver remoto (servidor simulado)", () => {
  it("manda match.intent con n creciente, aplica estados nuevos, ignora los viejos y traduce error/peek/over", () => {
    const c = load(true);
    const sent: any[] = [];
    const fakeView = (turn: number, phase = "turn", winner = -1): any => ({ ...JSON.parse(JSON.stringify(c.viewFor(c.createMatch([randomDeck(loadCore({ catalog: "file" }), "r1"), randomDeck(loadCore({ catalog: "file" }), "r2")], ["A", "B"], { rng: c.sfc32("r") }), 0))), turn, phase, winner });
    const d = c.createRemoteDriver({ send: (m: any) => sent.push(m) }, { match: "M-1", view: fakeView(1, "setup"), seq: 0 });
    const got: any = { states: 0, errors: [] as string[], peek: null, over: null, opp: null };
    d.handlers = {
      onState: () => got.states++,
      onError: (e: string) => got.errors.push(e),
      onPeek: (i: any) => (got.peek = i),
      onOver: (r: any) => (got.over = r),
      onOpp: (s: string) => (got.opp = s),
    };
    d.begin();
    assert.equal(got.states, 1);
    d.send({ t: "endTurn" });
    d.send({ t: "surrender" });
    assert.deepEqual(sent.map((m) => [m.type, m.match, m.n, m.intent.t]), [["match.intent", "M-1", 1, "endTurn"], ["match.intent", "M-1", 2, "surrender"]]);
    d.receive({ type: "match.state", match: "M-1", seq: 3, ack: 2, view: fakeView(2) });
    d.receive({ type: "match.state", match: "M-1", seq: 2, view: fakeView(9) }); // viejo
    d.receive({ type: "match.state", match: "OTRA", seq: 50, view: fakeView(9) }); // otra partida
    assert.equal(got.states, 2);
    d.receive({ type: "match.error", match: "M-1", n: 2, error: "No es tu turno." });
    assert.deepEqual(got.errors, ["No es tu turno."]);
    d.receive({ type: "match.peek", match: "M-1", card: 23, mode: "search", cards: [{ uid: 31, id: "charmeleon" }] });
    assert.equal(got.peek[0].cards[0].id, "charmeleon");
    d.receive({ type: "match.opp", status: "disconnected" });
    assert.equal(got.opp, "disconnected");
    // terminó por abandono del rival: el último estado no lo decía, el driver lo marca
    let last: any = null;
    d.handlers.onState = (v: any) => (last = v);
    d.receive({ type: "match.over", match: "M-1", winner: "you", reason: "abandon", reward: null });
    assert.equal(last.phase, "over");
    assert.equal(last.winner, 0);
    assert.equal(got.over.reason, "abandon");
    d.resume();
    assert.equal(sent.at(-1).type, "match.resume");
    assert.equal(sent.at(-1).seq, 3);
  });
});
