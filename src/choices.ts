// =====================================================================
//  Combate: selector de cartas/opciones y flujos que piden elegir
//  (Entrenadores, Poderes Pokémon, ataques con elección, retirada).
// =====================================================================

interface ChooserItem {
  card?: Card; // se muestra como carta
  label?: string; // o como fila de texto
  icon?: EType;
  sub?: string;
}

interface Chooser {
  title: string;
  items: ChooserItem[];
  min: number;
  max: number;
  ordered?: boolean; // el orden de elección importa (Pokédex)
  doneWhen?: (sel: number[]) => boolean; // confirmar solo al cumplirse (retirada)
  cursor: number;
  scroll: number;
  selected: number[];
  onDone: (sel: number[]) => void;
  onCancel?: () => void;
}

let CHOOSER: Chooser | null = null;

const CH_GRID = { x: 70, y: 128, cols: 9, w: 74, h: 104, gapX: 18, gapY: 14, rows: 3 };
const CH_ROW = { x: 110, y: 130, h: 40, rows: 9 };

function openChooser(c: Omit<Chooser, "cursor" | "scroll" | "selected">): void {
  CHOOSER = { ...c, cursor: 0, scroll: 0, selected: [] };
}

const chooserIsCards = (c: Chooser): boolean => c.items.some((i) => i.card);

function finishChooser(sel: number[]): void {
  const c = CHOOSER!;
  CHOOSER = null;
  c.onDone(sel);
}

function updateChooser(): void {
  const c = CHOOSER!;
  const n = c.items.length;
  const cards = chooserIsCards(c);
  const cols = cards ? CH_GRID.cols : 1;
  if (hit(KEYS.left) && cards) c.cursor = Math.max(0, c.cursor - 1);
  if (hit(KEYS.right) && cards) c.cursor = Math.min(n - 1, c.cursor + 1);
  if (hit(KEYS.up)) c.cursor = Math.max(0, c.cursor - cols);
  if (hit(KEYS.down)) c.cursor = Math.min(n - 1, c.cursor + cols);
  const row = Math.floor(c.cursor / cols);
  const visible = cards ? CH_GRID.rows : CH_ROW.rows;
  if (row < c.scroll) c.scroll = row;
  if (row >= c.scroll + visible) c.scroll = row - visible + 1;

  if (hit(KEYS.view) && c.items[c.cursor]?.card) {
    BT.zoom = c.items[c.cursor].card!;
    return;
  }
  if (hit(KEYS.b)) {
    if (c.selected.length) c.selected.pop();
    else if (c.onCancel) {
      CHOOSER = null;
      c.onCancel();
    }
    return;
  }
  if (hit(KEYS.a)) {
    if (c.max === 1 && !c.doneWhen) return finishChooser([c.cursor]);
    const at = c.selected.indexOf(c.cursor);
    if (at >= 0) c.selected.splice(at, 1);
    else if (c.selected.length < c.max) c.selected.push(c.cursor);
    if (c.doneWhen ? c.doneWhen(c.selected) : c.selected.length === c.max) return finishChooser([...c.selected]);
  }
  if (hit(KEYS.start) && c.selected.length >= c.min && (!c.doneWhen || c.doneWhen(c.selected))) {
    finishChooser([...c.selected]);
  }
}

function renderChooser(): void {
  const c = CHOOSER;
  if (!c) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(5,10,20,0.72)";
  ctx.fillRect(0, 0, CW, CH);
  rrect(40, 40, CW - 80, CH - 80, 16, "#f8f8f0", "#283850", 4);
  wrapText(c.title, 11, CW - 140).slice(0, 2).forEach((l, i) => text(l, 70, 62 + i * 18, 11, "#283850"));
  const cards = chooserIsCards(c);
  const pulse = 0.5 + 0.5 * Math.sin(game.time * 8);

  const badge = (x: number, y: number, i: number) => {
    const k = c.selected.indexOf(i);
    if (k < 0) return;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#e04030";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    text(c.ordered || c.max > 1 ? String(k + 1) : "✓", x, y - 5, 10, "#ffffff", { align: "center" });
  };

  if (cards) {
    const { x, y, cols, w, h, gapX, gapY, rows } = CH_GRID;
    c.items.forEach((it, i) => {
      const row = Math.floor(i / cols) - c.scroll;
      if (row < 0 || row >= rows) return;
      const r = { x: x + (i % cols) * (w + gapX), y: y + row * (h + gapY + 16), w, h };
      drawHandCard(it.card!, r);
      if (it.sub) text(fitText(it.sub, 7, w + 10), r.x + w / 2, r.y + h + 4, 7, "#606060", { align: "center" });
      if (i === c.cursor) rrect(r.x - 5, r.y - 5, r.w + 10, r.h + 10, 10, undefined, `rgba(255,${Math.round(80 + 120 * pulse)},48,1)`, 4);
      badge(r.x + r.w - 2, r.y + 2, i);
    });
    const total = Math.ceil(c.items.length / cols);
    if (c.scroll > 0) text("▲", CW / 2, 108, 10, "#e04030", { align: "center" });
    if (c.scroll + rows < total) text("▼", CW / 2, CH - 96, 10, "#e04030", { align: "center" });
  } else {
    c.items.forEach((it, i) => {
      const row = i - c.scroll;
      if (row < 0 || row >= CH_ROW.rows) return;
      const ry = CH_ROW.y + row * CH_ROW.h;
      if (i === c.cursor) {
        rrect(CH_ROW.x - 30, ry - 6, CW - 2 * CH_ROW.x + 40, CH_ROW.h - 4, 8, "#f8e088");
        cursorArrow(CH_ROW.x - 22, ry + 4, 14);
      }
      let tx = CH_ROW.x;
      if (it.icon) {
        energyIcon(it.icon, tx + 10, ry + 11, 10);
        tx += 30;
      }
      text(it.label ?? "", tx, ry + 4, 12, "#303030");
      if (it.sub) text(it.sub, CW - CH_ROW.x, ry + 6, 9, "#707070", { align: "right" });
      badge(CW - CH_ROW.x + 24, ry + 10, i);
    });
  }

  const need = c.max > 1 || c.doneWhen;
  const hintParts = [c.max === 1 && !c.doneWhen ? "Z: elegir" : "Z: marcar"];
  if (need) hintParts.push("ENTER: listo");
  hintParts.push(c.selected.length ? "X: desmarcar" : c.onCancel ? "X: volver" : "");
  if (cards) hintParts.push("C: ampliar");
  text(hintParts.filter(Boolean).join("   "), CW / 2, CH - 70, 9, "#505050", { align: "center" });
  if (need) {
    text(`Elegidas: ${c.selected.length}${c.max < 99 ? ` / ${c.max}` : ""}`, CW - 70, 62, 10, "#c03020", { align: "right" });
  }
}

// ---------------------------------------------------------------------
//  Ayudas
// ---------------------------------------------------------------------
const cardItems = (cis: CI[]): ChooserItem[] => cis.map((x) => ({ card: x.c }));
const energyItems = (s: Slot): ChooserItem[] =>
  s.energy.map((e) => ({
    label: e.asEnergy ? `Electrode (2 de ${TYPE_NAMES_ES[e.asEnergy.type]})` : e.c.name,
    icon: ciEnergyType(e),
  }));
const ENERGY_TYPES: EType[] = ["Fire", "Grass", "Water", "Lightning", "Psychic", "Fighting"];
const typeItems = (): ChooserItem[] => ENERGY_TYPES.map((t) => ({ label: TYPE_NAMES_ES[t], icon: t }));

/** Índices (en la mano) de las otras cartas que cumplen la condición. */
function handIdx(hi: number, pred: (c: Card) => boolean = () => true): number[] {
  return BT.b!.p[HUMAN].hand.map((x, i) => (i !== hi && pred(x.c) ? i : -1)).filter((i) => i >= 0);
}
/** Índices de una pila que cumplen la condición. */
const pileIdx = (pile: CI[], pred: (c: Card) => boolean): number[] =>
  pile.map((x, i) => (pred(x.c) ? i : -1)).filter((i) => i >= 0);

/** Si el Pokémon tiene más de una Energía, pregunta cuál; si no, sigue directo. */
function chooseEnergy(s: Slot, title: string, done: (i: number) => void, back: () => void, max = 1): void {
  if (s.energy.length <= max) return done(-1);
  openChooser({ title, items: energyItems(s), min: 1, max, onDone: (sel) => done(sel[0]), onCancel: back });
}

function finishFlow(err: string | null): void {
  CHOOSER = null;
  afterAction(err);
}

// ---------------------------------------------------------------------
//  Entrenadores: se piden, paso a paso, las elecciones que necesitan
//  sus pasos (Pokémon, cartas de la mano, del mazo, del descarte…).
// ---------------------------------------------------------------------
/** Texto de la pregunta de un paso "Elegir Pokémon", según lo que viene después. */
function chooseSlotPrompt(steps: Step[], i: number, name: string): string {
  if (steps[i].prompt) return String(steps[i].prompt);
  const opp = steps[i].side === "opp";
  const next = steps.slice(i + 1).find((s) => s.op !== "log" && s.op !== "chooseSlot");
  switch (next?.op) {
    case "switchIn": return opp ? `${name}: ¿qué Pokémon del rival traés al frente?` : `${name}: ¿qué Pokémon pasa a ser el Activo?`;
    case "heal": return `${name}: ¿qué Pokémon curás?`;
    case "discardEnergyOf": return opp ? `${name}: ¿de qué Pokémon rival descartás Energía?` : `${name}: ¿de cuál de tus Pokémon descartás Energía?`;
    case "attachTool": return `${name}: ¿a qué Pokémon se lo unís?`;
    case "returnToHand": return `${name}: ¿qué Pokémon vuelve a tu mano?`;
    case "devolve": return `${name}: ¿qué Pokémon querés involucionar?`;
    case "cureStatus": return `${name}: ¿qué Pokémon curás de sus estados?`;
    default: return `${name}: elegí un Pokémon${opp ? " del rival" : ""}.`;
  }
}

function trainerFlow(hi: number): void {
  const b = BT.b!;
  const p = b.p[HUMAN];
  const o = b.p[RIVAL];
  const card = p.hand[hi];
  const name = card.c.name;
  const steps = trainerSteps(card.c);
  const picks: Record<number, TPick> = {};
  const used = new Set<CI>([card]); // cartas de la mano ya elegidas en pasos anteriores
  let chosen: Slot | null = null;
  const cancel = () => {
    CHOOSER = null;
    BT.pick = null;
    actionHand();
  };
  const choose = (title: string, items: CI[], min: number, max: number, done: (sel: CI[]) => void, ordered = false) =>
    openChooser({ title, items: cardItems(items), min, max, ordered, onCancel: cancel, onDone: (sel) => done(sel.map((k) => items[k])) });
  const byNumber = (list: CI[]) => [...list].sort((a, c) => a.c.number - c.c.number);

  const next = (i: number): void => {
    if (i >= steps.length) {
      CHOOSER = null;
      return finishFlow(playTrainer(b, HUMAN, hi, { picks }));
    }
    const st = steps[i];
    const go = (pk?: TPick) => {
      if (pk) picks[i] = pk;
      next(i + 1);
    };
    const n = Math.max(1, Number(st.count) || 1);
    const tgt = st.target === "myActive" ? p.active : st.target === "oppActive" ? o.active : chosen;
    switch (st.op) {
      case "chooseSlot": {
        const cands = slotCandidates(b, HUMAN, st);
        return openPick({
          prompt: chooseSlotPrompt(steps, i, name),
          targets: slotTargets(st.side === "opp" ? RIVAL : HUMAN, cands),
          onCancel: cancel,
          onPick: (t) => {
            chosen = t.slot!;
            go({ slot: t.slot });
          },
        });
      }
      case "discardEnergyOf": {
        if (!tgt) return go();
        const ok = tgt.energy.filter((e) => !st.type || ciEnergyType(e) === st.type);
        const want = Number(st.count) > 0 ? Number(st.count) : ok.length;
        if (ok.length <= want) return go();
        const idx = ok.map((e) => tgt.energy.indexOf(e));
        return openChooser({
          title: `${name}: elegí ${want === 1 ? "la Energía" : `${want} Energías`} de ${topCard(tgt).name} para descartar.`,
          items: energyItems(tgt).filter((_, k) => idx.includes(k)), min: want, max: want, onCancel: cancel,
          onDone: (sel) => go({ energies: sel.map((k) => ok[k]) }),
        });
      }
      case "devolve": {
        if (!tgt || tgt.stack.length < 3) return go({ stage: 1 });
        return openChooser({
          title: `${name}: ¿hasta qué fase involuciona ${topCard(tgt).name}?`,
          items: [
            { label: `Quitar solo la Fase 2 (queda ${tgt.stack[1].c.name})` },
            { label: `Quitar Fase 1 y 2 (queda ${tgt.stack[0].c.name})` },
          ],
          min: 1, max: 1, onCancel: cancel,
          onDone: ([k]) => go({ stage: k === 0 ? 2 : 1 }),
        });
      }
      case "evolveSkip": {
        const s2s = breederStage2s(b, HUMAN).map((k) => p.hand[k]);
        return choose(`${name}: elegí la Fase 2 de tu mano.`, s2s, 1, 1, ([s2]) => {
          used.add(s2);
          openPick({
            prompt: `¿Sobre qué Pokémon Básico va ${s2.c.name}?`,
            targets: slotTargets(HUMAN, breederTargets(b, HUMAN, s2.c)),
            onCancel: cancel,
            onPick: (t) => go({ cards: [s2], slot: t.slot }),
          });
        });
      }
      case "discardFromHand":
      case "handToDeck": {
        if (st.op === "handToDeck" && (st.who === "opp" || st.who === "both" || !(Number(st.count) > 0))) return go();
        const items = p.hand.filter((c) => !used.has(c) && matchFilter(c.c, st.filter));
        const verb = st.op === "discardFromHand" ? "descartar" : "mezclar en tu mazo";
        return choose(`${name}: elegí ${n} ${filterEs(st.filter, n)} de tu mano para ${verb}.`, items, n, n, (sel) => {
          sel.forEach((c) => used.add(c));
          go({ cards: sel });
        });
      }
      case "searchDeck": {
        const items = byNumber(p.deck.filter((c) => !used.has(c) && matchFilter(c.c, st.filter)));
        const k = Math.min(n, items.length);
        return choose(`${name}: elegí ${k === 1 ? "la" : k} ${filterEs(st.filter, k)} que buscás en tu mazo.`, items, k, k, (sel) => go({ cards: sel }));
      }
      case "fromDiscard": {
        const q = st.side === "opp" ? o : p;
        const items = q.discard.filter((c) => matchFilter(c.c, st.filter));
        const room = st.to === "bench" ? BENCH_MAX - q.bench.length : Infinity;
        const k = Math.min(n, items.length, room);
        if (st.upTo && items.length <= 1) return go({ cards: items });
        const where = st.to === "bench" ? (st.side === "opp" ? "a la Banca del rival" : "a tu Banca") : "a tu mano";
        return choose(
          `${name}: elegí ${st.upTo ? "hasta " : ""}${k} ${filterEs(st.filter, k)} ${st.side === "opp" ? "del descarte del rival" : "de tu pila de descarte"} (van ${where}).`,
          items, st.upTo ? 1 : k, k, (sel) => go({ cards: sel }),
        );
      }
      case "arrangeTop": {
        const k = Math.min(Math.max(1, Number(st.count) || 5), p.deck.length);
        if (k <= 1) return go();
        return openChooser({
          title: `${name}: tocá las ${k} cartas en el orden en que querés que queden (la 1 queda arriba de todo).`,
          items: cardItems(p.deck.slice(0, k)), min: k, max: k, ordered: true, onCancel: cancel,
          onDone: (sel) => go({ order: sel }),
        });
      }
      default:
        return go();
    }
  };
  next(0);
}

// ---------------------------------------------------------------------
//  Poderes Pokémon (y descartar Entrenadores en juego como Pokémon)
// ---------------------------------------------------------------------
function actionPowers(): void {
  const b = BT.b!;
  const p = b.p[HUMAN];
  const powers = powerSlots(b, HUMAN);
  const dolls = inPlay(p).filter(isDoll);
  const items: ChooserItem[] = [
    ...powers.map((s) => ({ label: `${topCard(s).power!.name} — ${topCard(s).name}`, icon: topCard(s).type })),
    ...dolls.map((d) => ({ label: `Descartar ${d.stack[0].c.name}`, icon: "Colorless" as EType })),
  ];
  if (!items.length) {
    const blocked = inPlay(p).find((s) => isActivePowerCard(topCard(s)));
    return void toast(blocked ? (powerError(b, HUMAN, blocked) ?? "No podés usar Poderes ahora.") : "No tenés Poderes Pokémon para usar.");
  }
  const back = () => {
    CHOOSER = null;
    closePick();
  };
  openChooser({
    title: "PODERES: elegí qué querés usar (se pueden usar las veces que quieras antes de atacar).",
    items, min: 1, max: 1, onCancel: back,
    onDone: ([k]) => (k < powers.length ? powerFlow(powers[k]) : finishFlow(discardDoll(b, HUMAN, dolls[k - powers.length]))),
  });
}

/** Pide, paso a paso, lo que necesita cada paso del Poder y después lo usa. */
function powerFlow(s: Slot): void {
  const b = BT.b!;
  const p = b.p[HUMAN];
  const pw = topCard(s).power!.name;
  const steps = powerSteps(s);
  const cancel = () => {
    CHOOSER = null;
    closePick();
  };
  const next = (i: number, ch: PowerChoice): void => {
    if (i >= steps.length) return finishFlow(usePower(b, HUMAN, s, ch));
    const st = steps[i];
    const mine = inPlay(p);
    const go = (extra: PowerChoice) => next(i + 1, { ...ch, ...extra });
    switch (st.op) {
      case "attachFromHand": {
        const fits = mine.filter((x) => !st.toType || topCard(x).type === st.toType);
        const what = st.energy ? `una Energía ${TYPE_NAMES_ES[st.energy as EType]}` : "una Energía";
        return openPick({
          prompt: `${pw}: ¿a qué Pokémon le unís ${what} de tu mano?`,
          targets: slotTargets(HUMAN, fits),
          onCancel: cancel,
          onPick: (t) => go({ target: t.slot }),
        });
      }
      case "moveEnergy":
        return openPick({
          prompt: `${pw}: ¿de qué Pokémon sacás la Energía?`,
          targets: slotTargets(HUMAN, mine.filter((x) => x.energy.some((e) => isBasicEnergyOf(e, st.type)))),
          onCancel: cancel,
          onPick: (from) =>
            openPick({
              prompt: "¿A qué Pokémon la movés?",
              targets: slotTargets(HUMAN, mine.filter((x) => x !== from.slot)),
              onCancel: cancel,
              onPick: (to) => go({ from: from.slot, target: to.slot }),
            }),
        });
      case "moveDamage": {
        const n = 10 * (Number(st.counters) || 1);
        return openPick({
          prompt: `${pw}: ¿de qué Pokémon sacás el daño?`,
          targets: slotTargets(HUMAN, mine.filter((x) => x.damage > 0)),
          onCancel: cancel,
          onPick: (from) => {
            const dests = mine.filter((x) => x !== from.slot && remainingHp(x) > n);
            if (!dests.length) return void toast("Ningún otro Pokémon puede recibirlo sin quedar Fuera de Combate.");
            openPick({
              prompt: "¿A qué Pokémon se lo pasás? (no puede quedar Fuera de Combate)",
              targets: slotTargets(HUMAN, dests),
              onCancel: cancel,
              onPick: (to) => go({ from: from.slot, target: to.slot }),
            });
          },
        });
      }
      case "becomeEnergy": {
        const ko = steps.some((x) => x.op === "knockOutSelf");
        return openPick({
          prompt: `${pw}: ${ko ? `${topCard(s).name} queda Fuera de Combate (el rival toma un Premio). ` : ""}¿A qué Pokémon se une como Energía?`,
          targets: slotTargets(HUMAN, mine.filter((x) => x !== s)),
          onCancel: cancel,
          onPick: (t) =>
            openChooser({
              title: `¿Qué tipo de Energía va a proveer ${topCard(s).name}? (${Number(st.provides) || 2} de ese tipo)`,
              items: typeItems(), min: 1, max: 1,
              onCancel: cancel,
              onDone: ([k]) => {
                CHOOSER = null;
                go({ target: t.slot, type: ENERGY_TYPES[k] });
              },
            }),
        });
      }
      default:
        return next(i + 1, ch);
    }
  };
  next(0, {});
}

// ---------------------------------------------------------------------
//  Ataques que piden elegir
// ---------------------------------------------------------------------
/** Pide lo que haga falta para el ataque y después ataca. */
function attackFlow(idx: number, target?: Slot): void {
  const b = BT.b!;
  const a = b.p[HUMAN].active!;
  const d = b.p[RIVAL].active!;
  const atk = topCard(a).attacks[idx];
  const has = (op: string) => stepsHave(atk.effect, op);
  const go = (choice: AttackChoice = {}) => {
    CHOOSER = null;
    BT.pick = null;
    BT.mode = "idle";
    attack(b, HUMAN, idx, target, choice);
  };
  const back = () => {
    CHOOSER = null;
    BT.pick = null;
    BT.mode = "attack";
  };
  const attackItems = (ids: number[]) =>
    ids.map((j) => {
      const x = topCard(d).attacks[j];
      return { label: x.name, sub: x.damage ? `${x.damage} de daño` : "" };
    });

  if (has("metronome")) {
    const opts = metronomeOptions(d);
    if (opts.length > 1) {
      return openChooser({
        title: `Metronome: ¿qué ataque de ${topCard(d).name} copiás?`,
        items: attackItems(opts), min: 1, max: 1, onCancel: back,
        onDone: ([k]) => go({ attackIdx: opts[k] }),
      });
    }
    return go({ attackIdx: opts[0] });
  }
  if (has("amnesia") && topCard(d).attacks.length > 1) {
    const ids = topCard(d).attacks.map((_, j) => j);
    return openChooser({
      title: `${atk.name}: ¿qué ataque de ${topCard(d).name} no va a poder usar?`,
      items: attackItems(ids), min: 1, max: 1, onCancel: back,
      onDone: ([k]) => go({ attackIdx: k }),
    });
  }
  if ((has("changeWeakness") && weaknessOf(d)) || has("changeResistance")) {
    const conv1 = !!has("changeWeakness") && !!weaknessOf(d);
    return openChooser({
      title: conv1
        ? `${atk.name}: ¿a qué tipo cambia la Debilidad de ${topCard(d).name}?`
        : `${atk.name}: ¿a qué tipo cambia la Resistencia de ${topCard(a).name}?`,
      items: typeItems(), min: 1, max: 1, onCancel: back,
      onDone: ([k]) => go({ type: ENERGY_TYPES[k] }),
    });
  }
  if (has("discardEnergy")?.from === "defending" && d.energy.length > 1) {
    return openChooser({
      title: `¿Qué Energía de ${topCard(d).name} se descarta?`,
      items: energyItems(d), min: 1, max: 1, onCancel: back,
      onDone: ([k]) => go({ energy: k }),
    });
  }
  go();
}

// ---------------------------------------------------------------------
//  Retirada: elegir qué Energías descartar
// ---------------------------------------------------------------------
function retreatFlow(benchIdx: number): void {
  const b = BT.b!;
  const a = b.p[HUMAN].active!;
  const cost = topCard(a).retreat;
  const units = (sel: number[]) => sel.reduce((n, i) => n + ciEnergyUnits(a.energy[i]), 0);
  const allSame = new Set(a.energy.map((e) => `${ciEnergyType(e)}:${ciEnergyUnits(e)}`)).size <= 1;
  if (cost === 0 || allSame || units(a.energy.map((_, i) => i)) === cost) {
    return finishFlow(retreat(b, HUMAN, benchIdx));
  }
  openChooser({
    title: `Retirada: elegí qué Energías descartar (costo ${cost}).`,
    items: energyItems(a), min: 1, max: a.energy.length,
    doneWhen: (sel) => units(sel) >= cost,
    onCancel: () => {
      CHOOSER = null;
      closePick();
    },
    onDone: (sel) => finishFlow(retreat(b, HUMAN, benchIdx, sel)),
  });
}
