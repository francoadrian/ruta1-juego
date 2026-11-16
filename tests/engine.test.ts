// Tests del motor (ADR 0002, paso 3): determinismo, conservación de cartas, partidas IA vs IA,
// intenciones inválidas, preparación de dos lados y que el núcleo no use Math.random ni el DOM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CORE_FILES, ROOT, loadCore, readCatalog } from "./load-core.ts";
import { assertConserved, initialUids, newMatch, playAI, playFuzz, snapshot } from "./helpers.ts";

const catalog = readCatalog();
// Se prueba con el Base Set de src/ y con el catálogo real del juego (si está), que es el que usa el servidor.
const CONFIGS: { name: string; opts: Parameters<typeof loadCore>[0] }[] = [{ name: "baseset", opts: {} }];
if (catalog) CONFIGS.push({ name: "catálogo", opts: { catalog: "file" } });

describe("carga del núcleo", () => {
  it("corre sin DOM y sin Math.random", () => {
    const c = loadCore();
    assert.ok(Object.keys(c.CARDS).length >= 102);
    assert.throws(() => c.run("Math.random()"), /Math\.random/);
    assert.equal(c.run("typeof document + typeof window + typeof localStorage"), "undefinedundefinedundefined");
  });

  it("el código del núcleo no menciona Math.random ni el DOM (salvo randomSeed del cliente)", () => {
    for (const f of CORE_FILES) {
      const code = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "");
      const bad = code.match(/\b(document|window|localStorage|setTimeout|setInterval|requestAnimationFrame)\b/);
      assert.equal(bad, null, `${f} usa ${bad?.[0]}`);
      if (f !== "src/rng.ts") assert.ok(!/Math\.random/.test(code), `${f} usa Math.random`);
    }
  });

  it("index.html carga match.ts justo después de packs.ts y antes de player.ts", () => {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const files = [...(html.match(/const FILES = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(files.length > 10, "no se encontró FILES");
    const order = (f: string) => files.indexOf(f);
    assert.ok(order("src/packs.ts") >= 0 && order("src/match.ts") === order("src/packs.ts") + 1);
    assert.ok(order("src/match.ts") < order("src/player.ts"));
    // el núcleo del test respeta el mismo orden que el navegador
    const idx = CORE_FILES.map(order);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  });
});

for (const cfg of CONFIGS) {
  describe(`partidas (${cfg.name})`, () => {
    const c = loadCore(cfg.opts);

    it("mismo seed + mismos intents = mismo estado en cada paso (y en otro contexto)", () => {
      for (const seed of ["d1", "d2", "d3", "d4"]) {
        const a = playFuzz(c, seed);
        const b = playFuzz(c, seed);
        assert.deepEqual(b.moves, a.moves, `intents distintos con la semilla ${seed}`);
        assert.deepEqual(b.snaps, a.snaps, `estados distintos con la semilla ${seed}`);

        // reproducción desde cero con los intents serializados, en un núcleo recién cargado
        const c2 = loadCore(cfg.opts);
        const m = newMatch(c2, seed, { ai: [false, false] });
        a.moves.forEach((mv, i) => {
          const err = c2.applyIntent(m, mv.pi, JSON.parse(JSON.stringify(mv.intent ?? null)));
          assert.equal(err, a.results[i], `resultado distinto en el intent ${i} (${JSON.stringify(mv.intent)})`);
        });
        assert.equal(snapshot(m), a.snaps[a.snaps.length - 1]);
        assert.ok(a.moves.length > 20, "la partida de prueba tiene que tener movimiento");
      }
    });

    it("la IA es determinista y otra semilla da otra partida", () => {
      const run = (seed: string) => {
        const m = newMatch(c, seed);
        playAI(c, m);
        return snapshot(m);
      };
      assert.equal(run("ia1"), run("ia1"));
      assert.notEqual(run("ia1"), run("ia2"));
    });

    it("cada jugador conserva sus 60 cartas en cada paso (intents al azar)", () => {
      for (const seed of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
        let initial: ReturnType<typeof initialUids> | undefined;
        playFuzz(c, seed, {
          check: (m, mv) => {
            initial ??= initialUids(c, m);
            assert.equal(initial[0].size, 60);
            assert.equal(initial[1].size, 60);
            assertConserved(c, m, initial, `seed ${seed}, intent ${JSON.stringify(mv.intent)}`);
          },
        });
      }
    });

    it("200 partidas IA vs IA con semillas fijas: sin excepciones, conservan las 60 cartas y terminan", () => {
      const winners = [0, 0, 0];
      let setupSteps = 0;
      for (let i = 0; i < 200; i++) {
        const seed = `ia-${cfg.name}-${i}`;
        // los primeros 20 con los mazos temáticos del juego, el resto con mazos al azar
        const m = i < 20
          ? c.createMatch(i % 2 ? [c.OVERGROWTH, c.BRUSHFIRE] : [c.BRUSHFIRE, c.OVERGROWTH], ["Ana", "Beto"], { rng: c.sfc32(seed), ai: [true, true], prizes: i % 5 === 4 ? 1 : 6 })
          : newMatch(c, seed, { prizes: i % 7 === 0 ? 3 : 6 });
        const initial = initialUids(c, m);
        let n = 0;
        try {
          playAI(c, m, () => {
            n++;
            assertConserved(c, m, initial, `paso ${n}`);
          });
        } catch (e) {
          throw new Error(`partida ${seed}: ${(e as Error).message}\n${(e as Error).stack}`);
        }
        assertConserved(c, m, initial, "final");
        assert.equal(m.b.phase, "over", seed);
        assert.ok([0, 1, 2].includes(m.b.winner), `${seed}: ganador ${m.b.winner}`);
        winners[m.b.winner]++;
        setupSteps += n;
      }
      assert.ok(setupSteps > 2000);
      // las partidas no pueden ser todas del mismo lado (si lo fueran, un seat tendría ventaja por un bug)
      assert.ok(winners[0] > 20 && winners[1] > 20, `ganadores 0/1/empate: ${winners}`);
    });

    it("el log de una partida cuenta lo que pasó y logSince entrega solo lo nuevo", () => {
      const m = newMatch(c, "log1");
      const seen: string[] = [];
      let cursor = m.b.logCount;
      seen.push(...c.logSince(m, 0));
      playAI(c, m, () => {
        seen.push(...c.logSince(m, cursor));
        cursor = m.b.logCount;
      });
      assert.equal(seen.length, m.b.logCount);
      assert.equal(c.logSince(m, m.b.logCount).length, 0);
      assert.equal(JSON.stringify(seen.slice(-m.b.log.length)), JSON.stringify(m.b.log));
      assert.ok(seen.some((l: string) => /gana la partida|Empate/.test(l)));
    });

    it("intents al azar (válidos y basura): una rechazada no cambia nada y las 60 cartas se conservan", () => {
      let accepted = 0;
      let rejected = 0;
      const types = new Set<string>();
      for (let i = 0; i < 40; i++) {
        let initial: ReturnType<typeof initialUids> | undefined;
        const run = playFuzz(c, `fz-${i}`, {
          maxMoves: 1500,
          check: (m, mv) => (initial ??= initialUids(c, m), assertConserved(c, m, initial, `fz-${i}`)),
        });
        run.results.forEach((r, k) => {
          if (r === null) {
            accepted++;
            types.add((run.moves[k].intent as { t: string }).t);
          } else rejected++;
        });
        assert.equal(run.m.b.phase, "over");
      }
      assert.ok(accepted > 1000 && rejected > 1000, `aceptadas ${accepted}, rechazadas ${rejected}`);
      // se ejercitaron todos los tipos de intención
      // (el Base Set de src/baseset.ts no trae efectos de Entrenadores ni Poderes: eso es del catálogo)
      const expected = ["setupActive", "setupBench", "setupDone", "playBasic", "evolve", "attachEnergy", "retreat", "attack", "promote", "endTurn", "surrender"];
      if (cfg.name === "catálogo") expected.push("playTrainer", "peek", "usePower");
      console.log(`    [${cfg.name}] intents aceptados por tipo:`, [...types].sort().join(" "));
      for (const t of expected) {
        assert.ok(types.has(t), `nunca se aceptó una intención ${t}`);
      }
    });
  });
}

describe("reglas de applyIntent", () => {
  const c = loadCore();
  const fresh = (seed = "r1") => newMatch(c, seed, { ai: [false, false] });
  const setupBoth = (m: any) => {
    for (const pi of [0, 1] as const) {
      while (!m.setupDone[pi]) assert.equal(c.applyIntent(m, pi, c.defaultIntent(m, pi)), null);
    }
  };

  it("la partida solo arranca cuando los dos terminan la preparación", () => {
    const m = fresh();
    assert.equal(m.b.phase, "setup");
    assert.match(c.applyIntent(m, 0, { t: "setupDone" }), /Activo/); // sin Activo no se puede terminar
    const basic = m.b.p[0].hand.find((x: any) => c.isBasic(x.c));
    assert.equal(c.applyIntent(m, 0, { t: "setupActive", card: basic.uid }), null);
    assert.equal(c.applyIntent(m, 0, { t: "setupDone" }), null);
    assert.equal(m.b.phase, "setup", "falta el otro jugador");
    assert.ok(m.b.p[0].prizes.length === 0);
    assert.match(c.applyIntent(m, 0, { t: "setupBench", card: basic.uid }), /esperá|terminaste/);
    assert.match(c.applyIntent(m, 0, { t: "endTurn" }), /armando|preparación/i);
    setupBoth(m);
    assert.equal(m.b.phase, "turn");
    assert.equal(m.b.p[0].prizes.length, 6);
    assert.equal(m.b.p[1].prizes.length, 6);
    assert.equal(m.b.turn, 1);
    assert.match(c.applyIntent(m, 0, { t: "setupDone" }), /terminó/);
  });

  it("una lista de cartas con repetidos se rechaza sin tocar el estado (no duplica cartas)", () => {
    const m = fresh("r-dup");
    setupBoth(m);
    const pi = m.b.cur;
    const p = m.b.p[pi];
    const [a, b2] = p.hand;
    const before = JSON.stringify(m.b.p);
    // Maintenance mezclaba dos veces la misma carta en el mazo; pasa lo mismo con cualquier lista
    const picks = { 0: { cards: [a.uid, b2.uid, a.uid] } };
    assert.match(c.applyIntent(m, pi, { t: "playTrainer", card: a.uid, choice: { picks } }), /inválida/);
    assert.match(c.applyIntent(m, pi, { t: "retreat", bench: 0, energies: [a.uid, a.uid] }), /inválida/);
    assert.equal(JSON.stringify(m.b.p), before);
  });

  it("cambiar de Activo en la preparación devuelve el anterior a la mano", () => {
    const m = fresh("r2");
    const p = m.b.p[0];
    const basics = p.hand.filter((x: any) => c.isBasic(x.c));
    if (basics.length < 2) return; // esta semilla no sirve para el caso
    assert.equal(c.applyIntent(m, 0, { t: "setupActive", card: basics[0].uid }), null);
    const n = p.hand.length;
    assert.equal(c.applyIntent(m, 0, { t: "setupActive", card: basics[1].uid }), null);
    assert.equal(p.hand.length, n, "la mano no cambia de tamaño");
    assert.ok(p.hand.some((x: any) => x.uid === basics[0].uid));
    assert.equal(p.active.uid, basics[1].uid);
  });

  it("solo juega quien tiene el turno; el otro no puede ni atacar ni terminar", () => {
    const m = fresh("r3");
    setupBoth(m);
    const cur = m.b.cur as 0 | 1;
    const other = (1 - cur) as 0 | 1;
    for (const intent of [{ t: "endTurn" }, { t: "attack", idx: 0 }, { t: "playBasic", card: 1 }]) {
      const before = snapshot(m);
      assert.ok(c.applyIntent(m, other, intent), JSON.stringify(intent));
      assert.equal(snapshot(m), before);
    }
    assert.equal(c.applyIntent(m, cur, { t: "endTurn" }), null);
    assert.equal(m.b.cur, other);
  });

  it("no se puede nombrar una carta del rival ni una que no existe", () => {
    const m = fresh("r4");
    setupBoth(m);
    const cur = m.b.cur as 0 | 1;
    const theirs = m.b.p[1 - cur].hand[0];
    const before = snapshot(m);
    for (const intent of [{ t: "playBasic", card: theirs.uid }, { t: "attachEnergy", card: theirs.uid, target: m.b.p[cur].active.uid }, { t: "playTrainer", card: theirs.uid }, { t: "playBasic", card: 99999 }]) {
      assert.ok(c.applyIntent(m, cur, intent), JSON.stringify(intent));
    }
    assert.equal(snapshot(m), before);
  });

  it("intenciones mal formadas se rechazan sin lanzar", () => {
    const m = fresh("r5");
    for (const bad of [null, undefined, 3, "x", [], {}, { t: 3 }, { t: "attack", idx: "0" }, { t: "playTrainer", card: 1, choice: { picks: { "-1": {} } } }, { t: "retreat", bench: 1, energies: new Array(100).fill(1) }, { t: "usePower", slot: 1, choice: { type: "Dark" } }]) {
      const before = snapshot(m);
      assert.equal(typeof c.applyIntent(m, 0, bad as never), "string");
      assert.equal(snapshot(m), before);
    }
    assert.equal(typeof c.applyIntent(m, 2 as never, { t: "endTurn" }), "string");
  });

  it("rendirse termina la partida (también en la preparación) y después no se puede jugar", () => {
    const m = fresh("r6");
    assert.equal(c.applyIntent(m, 1, { t: "surrender" }), null);
    assert.equal(m.b.phase, "over");
    assert.equal(m.b.winner, 0);
    assert.match(c.applyIntent(m, 0, { t: "endTurn" }), /terminó/);
    assert.equal(c.stepAI(m, 0), false);
  });

  it("defaultIntent resuelve preparación, promoción y turno", () => {
    for (let i = 0; i < 20; i++) {
      const m = fresh("df" + i);
      setupBoth(m);
      let guard = 0;
      while (m.b.phase !== "over" && guard++ < 3000) {
        const pi = (m.b.phase === "promote" ? m.b.promoteQueue[0] : m.b.cur) as 0 | 1;
        const it = c.defaultIntent(m, pi);
        assert.equal(c.applyIntent(m, pi, it), null, `${JSON.stringify(it)} en fase ${m.b.phase}`);
      }
      assert.equal(m.b.phase, "over", "con puro tiempo vencido la partida tiene que terminar (mazo vacío)");
    }
  });

  it("createMatch rechaza mazos sin Básicos o con cartas inexistentes (no se cuelga)", () => {
    const ok = c.BRUSHFIRE;
    const opts = { rng: c.sfc32("x") };
    assert.throws(() => c.createMatch([ok, { name: "Sin básicos", cards: [{ id: "fireEnergy", qty: 60 }] }], ["a", "b"], opts), /Básicos/);
    assert.throws(() => c.createMatch([ok, { name: "Roto", cards: [{ id: "noExiste", qty: 60 }] }], ["a", "b"], opts), /inválida/);
  });

  it("ownedCounts y deckProblems no tocan el navegador", () => {
    const owned = c.ownedCounts({ pikachu: 2 });
    assert.equal(owned.pikachu, 2);
    assert.equal(c.deckProblems(c.BRUSHFIRE, owned).length, 0);
    assert.ok(c.deckProblems(c.OVERGROWTH, owned).length > 0, "no tiene esas cartas");
  });
});
