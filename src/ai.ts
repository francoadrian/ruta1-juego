// =====================================================================
//  IA del rival — heurísticas simples, una acción por llamada
// =====================================================================

/** Daño esperado de un ataque contra un defensor (con Debilidad/Resistencia/PlusPower). */
/**
 * Daño base esperado de los pasos de un ataque: las monedas cuentan como 50 %
 * y lo que viene después de un "el ataque no hace nada" se pondera por la
 * probabilidad de llegar hasta ahí.
 */
function expectedBase(atk: Attack, a: Slot, d: Slot): number {
  if (!atk.effect?.length) return printedDamage(atk);
  let flips = 0;
  let heads = 0;
  let total = 0;
  const probe = { a, d, atk, heads: 0 };
  const ctx = { a, d, opp: { bench: [] as Slot[] } } as unknown as AtkCtx;
  const condProb = (c: string): number => {
    if (c === "heads" || c === "tails") return flips <= 1 ? 0.5 : 1 - 0.5 ** flips;
    if (c === "allHeads" || c === "noHeads") return 0.5 ** Math.max(1, flips);
    if (c === "dealtDamage") return total > 0 ? 1 : 0;
    const f = EFFECT_CONDS[c];
    return f ? (f({ ...ctx, heads: 0, tails: 0, flips: 0, dealt: 0 }) ? 1 : 0) : 0.5;
  };
  const walk = (list: Step[], prob: number): number => {
    // devuelve la probabilidad de seguir después de esta lista
    for (const s of list) {
      if (s.op === "flip") {
        flips = Math.max(1, Number(s.count) || 1);
        heads = flips / 2;
      } else if (s.op === "damage") {
        probe.heads = heads;
        total += prob * stepDamage(probe, s);
      } else if (s.op === "stop") return 0;
      else if (s.op === "metronome") total += prob * 20;
      else if (s.op === "if") {
        const q = condProb(s.cond);
        const goT = walk(s.then ?? [], prob * q);
        const goE = walk(s.else ?? [], prob * (1 - q));
        const cont = (prob * q > 0 ? goT / prob : 0) + (prob * (1 - q) > 0 ? goE / prob : 0);
        prob *= cont;
        if (prob <= 0) return 0;
      }
    }
    return prob;
  };
  walk(atk.effect, 1);
  return Math.round(total);
}

function expectedDamage(b: Battle, a: Slot, idx: number, d: Slot): number {
  const atk = topCard(a).attacks[idx];
  const base = expectedBase(atk, a, d);
  if (base <= 0) return 0;
  if (d.stiffenTurn === b.turn) return 0;
  const def = topCard(d);
  let dmg = base;
  if (weaknessOf(d) === topCard(a).type) dmg *= 2;
  if (resistanceOf(d) === topCard(a).type) dmg = Math.max(0, dmg - 30);
  if (dmg > 0) dmg += toolBonus(a);
  return dmg;
}

function attackScore(b: Battle, pi: number, idx: number): number {
  const me = b.p[pi];
  const opp = b.p[1 - pi];
  const a = me.active!;
  const d = opp.active!;
  const atk = topCard(a).attacks[idx];
  const steps = atk.effect ?? [];
  const has = (op: string) => stepsHave(steps, op);
  const dmg = expectedDamage(b, a, idx, d);
  // ataques sin daño: según lo que hacen
  if (dmg <= 0) {
    if (has("heal")) return a.damage >= 30 ? a.damage * 0.9 : -1;
    if (has("protect")) return remainingHp(a) <= 40 ? 25 : 4;
    if (has("switchDefending")) return opp.bench.length ? 3 : -1;
  }
  let score = dmg;
  if (dmg >= remainingHp(d)) score += 1000;
  if (has("status")) score += 6;
  const disc = has("discardEnergy");
  if (disc && disc.from !== "defending") score -= 4;
  const self = steps.find((s) => s.op === "hurt" && s.target === "self");
  if (self && Number(self.amount) >= remainingHp(a)) score -= 50;
  return score;
}

function bestAttack(b: Battle, pi: number): number {
  const a = b.p[pi].active;
  if (!a || !b.p[1 - pi].active) return -1;
  let best = -1;
  let bestScore = 0;
  topCard(a).attacks.forEach((_, i) => {
    if (attackError(b, pi, i)) return;
    const s = attackScore(b, pi, i);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  });
  return best;
}

/** Qué tan listo está un Pokémon para pelear (para promoverlo o cambiarlo). */
function readiness(s: Slot): number {
  const atks = topCard(s).attacks;
  const ready = atks.some((a) => canPay(s, a.cost)) ? 50 : 0;
  const closeness = Math.max(...atks.map((a) => 10 - missingEnergy(energyTypes(s), a.cost) * 3));
  return ready + closeness + remainingHp(s) / 10;
}

function bestBenchIndex(p: PlayerSt): number {
  let best = 0;
  p.bench.forEach((s, i) => {
    if (readiness(s) > readiness(p.bench[best])) best = i;
  });
  return best;
}

function aiSetup(b: Battle, pi: number): void {
  const p = b.p[pi];
  const basics = () => p.hand.map((c, i) => [c, i] as const).filter(([c]) => isBasic(c.c));
  const [, first] = basics().sort(([x], [y]) => (y.c as PokemonCard).hp - (x.c as PokemonCard).hp)[0];
  setupActive(b, pi, first);
  for (let next = basics()[0]; next && p.bench.length < BENCH_MAX; next = basics()[0]) setupBench(b, pi, next[1]);
}

function aiPromote(b: Battle, pi: number): void {
  promote(b, pi, bestBenchIndex(b.p[pi]));
}

const handIndex = (p: PlayerSt, pred: (c: Card) => boolean): number => p.hand.findIndex((x) => pred(x.c));

/** Para qué sirve un Entrenador, según sus pasos (la IA no mira ids ni textos). */
function trainerRole(c: Card): string {
  const s = trainerSteps(c);
  const has = (op: string) => s.find((x) => x.op === op);
  const pick = has("chooseSlot");
  if (s.length && s.every((x) => x.op === "draw" && x.who !== "opp")) return "draw";
  if (pick && has("switchIn")) return pick.side === "opp" ? "gust" : "switch";
  if (pick && pick.side !== "opp" && has("heal")) return has("discardEnergyOf") ? "bigHeal" : "heal";
  if (has("attachTool")?.mode === "plus") return "plus";
  if (pick?.side === "opp" && has("discardEnergyOf") && s.filter((x) => x.op === "chooseSlot").length === 1) return "removal";
  return "";
}
const healAmount = (c: Card): number => Number(trainerSteps(c).find((x) => x.op === "heal")?.amount) || 999;

/** Hace UNA acción. Devuelve false cuando el turno terminó (atacó o pasó). */
function aiStep(b: Battle, pi: number): boolean {
  const me = b.p[pi];
  const opp = b.p[1 - pi];
  const ok = (r: string | null) => r === null;

  // 1. Bill
  let hi = handIndex(me, (c) => trainerRole(c) === "draw");
  if (hi >= 0 && me.deck.length > 2 && ok(playTrainer(b, pi, hi))) return true;

  // 2. Pokémon Básicos a la Banca
  hi = handIndex(me, isBasic);
  if (hi >= 0 && me.bench.length < BENCH_MAX && ok(playBasic(b, pi, hi))) return true;

  // 3. Evolucionar (el Activo primero)
  for (let i = 0; i < me.hand.length; i++) {
    const targets = evolveTargets(b, pi, i);
    if (targets.length) {
      const t = targets.includes(me.active!) ? me.active! : targets[0];
      if (ok(evolve(b, pi, i, t))) return true;
    }
  }

  const a = me.active!;
  const canAttackNow = bestAttack(b, pi) >= 0;

  // 4. Switch si el Activo no puede pelear
  hi = handIndex(me, (c) => trainerRole(c) === "switch");
  if (hi >= 0 && me.bench.length) {
    const stuck = a.status === "asleep" || a.status === "paralyzed";
    const bi = bestBenchIndex(me);
    if ((stuck || (!canAttackNow && readiness(me.bench[bi]) >= 50)) && ok(playTrainer(b, pi, hi, { slot: me.bench[bi] }))) {
      return true;
    }
  }

  // 5. Curar
  hi = handIndex(me, (c) => trainerRole(c) === "bigHeal");
  if (hi >= 0) {
    const amt = healAmount(me.hand[hi].c);
    const t = inPlay(me).find((s) => s.damage >= Math.min(amt, 40) && s.energy.length > 1 && remainingHp(s) <= 30);
    if (t && ok(playTrainer(b, pi, hi, { slot: t }))) return true;
  }
  hi = handIndex(me, (c) => trainerRole(c) === "heal");
  if (hi >= 0) {
    const amt = healAmount(me.hand[hi].c);
    const t = inPlay(me).find((s) => s.damage >= Math.min(amt, 20) && remainingHp(s) <= 40);
    if (t && ok(playTrainer(b, pi, hi, { slot: t }))) return true;
  }

  // 6. Unir Energía donde más ayude
  if (!b.energyPlayed) {
    let best: { hi: number; s: Slot; gain: number } | null = null;
    me.hand.forEach((c, i) => {
      if (c.c.kind !== "energy") return;
      const t = (c.c as EnergyCard).type;
      inPlay(me).forEach((s) => {
        const atks = topCard(s).attacks;
        if (!atks.length) return; // Clefairy Doll no ataca
        const t2 = (c.c as EnergyCard).provides ?? 1;
        if (t2 > 1 && atks.every((x) => !x.cost.includes("Colorless"))) return;
        const before = Math.min(...atks.map((x) => missingEnergy(energyTypes(s), x.cost)));
        const added = Array<EType>(t2).fill(t);
        const after = Math.min(...atks.map((x) => missingEnergy([...energyTypes(s), ...added], x.cost)));
        const strongest = atks[atks.length - 1];
        const strongGain =
          missingEnergy(energyTypes(s), strongest.cost) - missingEnergy([...energyTypes(s), ...added], strongest.cost);
        let gain = (before - after) * 10 + strongGain * 6;
        if (s === me.active) gain += 3;
        if (gain > 0 && (!best || gain > best.gain)) best = { hi: i, s, gain };
      });
    });
    const pick = best as { hi: number; s: Slot; gain: number } | null;
    if (pick && ok(attachEnergy(b, pi, pick.hi, pick.s))) return true;
  }

  // 7. Gust of Wind: traer un Pokémon de la Banca rival que podamos noquear
  hi = handIndex(me, (c) => trainerRole(c) === "gust");
  const ai = bestAttack(b, pi);
  if (hi >= 0 && ai >= 0 && opp.bench.length && opp.active) {
    const koActive = expectedDamage(b, a, ai, opp.active) >= remainingHp(opp.active);
    const victim = opp.bench.find((s) => expectedDamage(b, a, ai, s) >= remainingHp(s));
    if (!koActive && victim && ok(playTrainer(b, pi, hi, { slot: victim }))) return true;
  }

  // 8. PlusPower si alcanza para noquear
  hi = handIndex(me, (c) => trainerRole(c) === "plus");
  if (hi >= 0 && ai >= 0 && opp.active) {
    const dmg = expectedDamage(b, a, ai, opp.active);
    const plus = Number(trainerSteps(me.hand[hi].c).find((x) => x.op === "attachTool")?.amount) || 10;
    if (dmg > 0 && dmg < remainingHp(opp.active) && dmg + plus >= remainingHp(opp.active)) {
      if (ok(playTrainer(b, pi, hi, { slot: a }))) return true;
    }
  }

  // 9. Energy Removal al Activo rival
  hi = handIndex(me, (c) => trainerRole(c) === "removal");
  if (hi >= 0 && opp.active?.energy.length && ok(playTrainer(b, pi, hi, { slot: opp.active }))) return true;

  // 10. Retirarse si el Activo no puede atacar y hay alguien listo
  if (!canAttackNow && !b.retreated && me.bench.length && !retreatError(b, pi)) {
    const bi = bestBenchIndex(me);
    if (readiness(me.bench[bi]) >= 50 && ok(retreat(b, pi, bi))) return true;
  }

  // 11. Atacar o pasar
  const atk = bestAttack(b, pi);
  if (atk >= 0) {
    const target = opp.bench.length ? [...opp.bench].sort((x, y) => remainingHp(x) - remainingHp(y))[0] : undefined;
    attack(b, pi, atk, target);
  } else {
    log(b, `${me.name} termina su turno.`);
    endTurn(b);
  }
  return false;
}
