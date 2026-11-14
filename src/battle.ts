// =====================================================================
//  Pantalla de combate de cartas (jugador vs NPC)
// =====================================================================

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Target {
  rect: Rect;
  owner: number;
  slot?: Slot;
  hand?: number;
}

interface Pick {
  prompt: string;
  targets: Target[];
  cursor: number;
  onPick: (t: Target) => void;
  onCancel?: () => void;
  tag?: string;
}

const HUMAN = 0;
const RIVAL = 1;

const BT = {
  b: null as Battle | null,
  mode: "menu" as "menu" | "attack" | "pick" | "idle",
  menuCursor: 0,
  attackCursor: 0,
  pick: null as Pick | null,
  zoom: null as Card | null,
  aiTimer: 0,
  banner: "",
  bannerT: 0,
  toast: "",
  toastT: 0,
  lastTurn: -1,
};

const BATTLE_MENU = ["MANO", "ATACAR", "PODERES", "RETIRARSE", "VER MESA", "FIN DEL TURNO", "RENDIRSE"];

// ---------------------------------------------------------------------
//  Layout (canvas de 960×640)
// ---------------------------------------------------------------------
const FIELD = { cx: 420, left: 150, right: 690 };
const PANEL = { x: 700, w: 252 };

function benchRect(owner: number, i: number): Rect {
  return { x: 213 + i * 86, y: owner === HUMAN ? 410 : 10, w: 70, h: 98 };
}
function activeRect(owner: number): Rect {
  return { x: FIELD.cx - 47, y: owner === HUMAN ? 265 : 122, w: 95, h: 133 };
}
function handRect(i: number, n: number): Rect {
  const w = 65;
  const span = FIELD.right - FIELD.left - w;
  const step = n > 1 ? Math.min(72, span / (n - 1)) : 0;
  const total = step * (n - 1) + w;
  const x0 = FIELD.left + (FIELD.right - FIELD.left - total) / 2;
  return { x: x0 + i * step, y: 524, w, h: 91 };
}
function slotRect(owner: number, s: Slot): Rect {
  const p = BT.b!.p[owner];
  return p.active === s ? activeRect(owner) : benchRect(owner, p.bench.indexOf(s));
}

const slotTargets = (owner: number, slots: Slot[]): Target[] =>
  slots.map((slot) => ({ rect: slotRect(owner, slot), owner, slot }));
const handTargets = (idx: number[]): Target[] => {
  const n = BT.b!.p[HUMAN].hand.length;
  return idx.map((hand) => ({ rect: handRect(hand, n), owner: HUMAN, hand }));
};

// ---------------------------------------------------------------------
//  Inicio / fin
// ---------------------------------------------------------------------
/** Mazo del NPC (sus cartas habilitadas); si no tiene, el Overgrowth de siempre. */
function npcDeck(n: NpcRt | null): Deck {
  const cards = (n?.def.deck?.cards ?? []).filter((e) => isPlayable(e.id) && e.qty > 0);
  if (!cards.length || !cards.some((e) => isBasicCard(CARDS[e.id]))) return OVERGROWTH;
  return { name: n!.def.deck!.name || "Mazo", cards };
}

const rivalName = (): string => BT.b?.p[RIVAL].name ?? game.opponent?.def.name ?? "RIVAL";

function startBattle(prizes = PRIZES): void {
  game.mode = "battle";
  const opp = game.opponent;
  BT.b = newBattle([mainDeck(), npcDeck(opp)], [playerName(), opp?.def.name ?? "RIVAL"], {
    rng: sfc32(randomSeed()), // modo local: semilla propia del cliente
    prizes,
    ai: [false, true],
  });
  BT.mode = "idle";
  BT.pick = null;
  BT.zoom = null;
  BT.lastTurn = -1;
  aiSetup(BT.b, RIVAL);
  showBanner(`¡${rivalName()} te desafía!`);
  pickSetupActive();
}

function exitBattle(): void {
  const b = BT.b!;
  BT.b = null;
  game.mode = "explore";
  finishNpcBattle(b.winner === HUMAN ? "win" : b.winner === 2 ? "draw" : "lose");
}

function showBanner(text: string): void {
  BT.banner = text;
  BT.bannerT = 1.3;
}

function toast(msg: string | null): boolean {
  if (!msg) return false;
  BT.toast = msg;
  BT.toastT = 2.2;
  return true;
}

// ---------------------------------------------------------------------
//  Preparación (elegir Activo y Banca)
// ---------------------------------------------------------------------
function basicsInHand(): number[] {
  return BT.b!.p[HUMAN].hand.map((c, i) => (isBasic(c.c) ? i : -1)).filter((i) => i >= 0);
}

function pickSetupActive(): void {
  openPick({
    prompt: "Elegí tu Pokémon Activo.",
    targets: handTargets(basicsInHand()),
    onPick: (t) => {
      setupActive(BT.b!, HUMAN, t.hand!);
      pickSetupBench();
    },
  });
}

function pickSetupBench(): void {
  const b = BT.b!;
  const basics = basicsInHand();
  if (!basics.length || b.p[HUMAN].bench.length >= BENCH_MAX) return finishHumanSetup();
  openPick({
    prompt: "Elegí Pokémon para tu Banca. X: listo.",
    targets: handTargets(basics),
    onPick: (t) => {
      setupBench(b, HUMAN, t.hand!);
      pickSetupBench();
    },
    onCancel: finishHumanSetup,
  });
}

function finishHumanSetup(): void {
  BT.pick = null;
  BT.mode = "idle";
  finishSetup(BT.b!);
}

// ---------------------------------------------------------------------
//  Selección genérica de objetivos
// ---------------------------------------------------------------------
function openPick(p: Omit<Pick, "cursor">): void {
  BT.pick = { ...p, cursor: 0 };
  BT.mode = "pick";
}

function closePick(): void {
  BT.pick = null;
  BT.mode = "menu";
}

/** Mueve el cursor al objetivo más cercano en la dirección pedida. */
function navigate(pick: Pick, dx: number, dy: number): void {
  const cur = pick.targets[pick.cursor].rect;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let best = -1;
  let bestScore = Infinity;
  pick.targets.forEach((t, i) => {
    if (i === pick.cursor) return;
    const tx = t.rect.x + t.rect.w / 2 - cx;
    const ty = t.rect.y + t.rect.h / 2 - cy;
    const along = tx * dx + ty * dy;
    if (along <= 0) return;
    const across = Math.abs(tx * dy - ty * dx);
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best >= 0) pick.cursor = best;
}

function updatePick(): void {
  const pick = BT.pick!;
  if (!pick.targets.length) {
    pick.onCancel ? pick.onCancel() : closePick();
    return;
  }
  if (hit(KEYS.left)) navigate(pick, -1, 0);
  if (hit(KEYS.right)) navigate(pick, 1, 0);
  if (hit(KEYS.up)) navigate(pick, 0, -1);
  if (hit(KEYS.down)) navigate(pick, 0, 1);
  if (hit(KEYS.a)) pick.onPick(pick.targets[pick.cursor]);
  else if (hit(KEYS.b) && pick.onCancel) pick.onCancel();
}

function hoveredCard(): Card | null {
  const b = BT.b!;
  if (BT.mode === "pick" && BT.pick?.targets.length) {
    const t = BT.pick.targets[BT.pick.cursor];
    if (t.slot) return topCard(t.slot);
    if (t.hand !== undefined) return b.p[HUMAN].hand[t.hand]?.c ?? null;
  }
  return b.p[HUMAN].active ? topCard(b.p[HUMAN].active) : null;
}

function hoveredSlot(): Slot | null {
  if (BT.mode === "pick" && BT.pick?.targets.length) return BT.pick.targets[BT.pick.cursor].slot ?? null;
  return BT.b!.p[HUMAN].active;
}

// ---------------------------------------------------------------------
//  Acciones del jugador
// ---------------------------------------------------------------------
function actionHand(): void {
  const b = BT.b!;
  const hand = b.p[HUMAN].hand;
  if (!hand.length) return void toast("No tenés cartas en la mano.");
  openPick({
    prompt: "Elegí una carta de tu mano.",
    targets: handTargets(hand.map((_, i) => i)),
    onPick: (t) => playFromHand(t.hand!),
    onCancel: closePick,
  });
}

function afterAction(err: string | null): void {
  if (toast(err)) return;
  closePick();
}

function playFromHand(hi: number): void {
  const b = BT.b!;
  const p = b.p[HUMAN];
  const card = p.hand[hi].c;
  if (card.kind === "pokemon" && card.stage === "Basic") {
    return afterAction(playBasic(b, HUMAN, hi));
  }
  if (card.kind === "pokemon") {
    const slots = evolveTargets(b, HUMAN, hi);
    if (!slots.length) {
      const why = inPlay(p).map((s) => evolveError(b, HUMAN, card, s)).find((e) => e && !e.startsWith(card.name));
      return void toast(why ?? `Necesitás a ${card.evolvesFrom} en juego.`);
    }
    return openPick({
      prompt: `¿A cuál evoluciona ${card.name}?`,
      targets: slotTargets(HUMAN, slots),
      onPick: (t) => afterAction(evolve(b, HUMAN, hi, t.slot!)),
      onCancel: actionHand,
    });
  }
  if (card.kind === "energy") {
    if (b.energyPlayed) return void toast("Ya uniste una Energía este turno.");
    return openPick({
      prompt: `¿A qué Pokémon unís ${card.name}?`,
      targets: slotTargets(HUMAN, inPlay(p)),
      onPick: (t) => afterAction(attachEnergy(b, HUMAN, hi, t.slot!)),
      onCancel: actionHand,
    });
  }
  // Entrenador: sus pasos dicen qué hay que elegir
  if (toast(trainerError(b, HUMAN, hi))) return;
  trainerFlow(hi);
}

function actionRetreat(): void {
  const b = BT.b!;
  if (toast(retreatError(b, HUMAN))) return;
  const cost = topCard(b.p[HUMAN].active!).retreat;
  openPick({
    prompt: `¿Quién entra? (descarta ${cost} Energía${cost === 1 ? "" : "s"})`,
    targets: slotTargets(HUMAN, b.p[HUMAN].bench),
    onPick: (t) => retreatFlow(b.p[HUMAN].bench.indexOf(t.slot!)),
    onCancel: closePick,
  });
}

function actionView(): void {
  const b = BT.b!;
  const targets = [
    ...slotTargets(RIVAL, inPlay(b.p[RIVAL])),
    ...slotTargets(HUMAN, inPlay(b.p[HUMAN])),
    ...handTargets(b.p[HUMAN].hand.map((_, i) => i)),
  ];
  openPick({
    prompt: "Mirá cualquier carta. Z: ampliar.",
    targets,
    onPick: (t) => {
      BT.zoom = t.slot ? topCard(t.slot) : b.p[HUMAN].hand[t.hand!].c;
    },
    onCancel: closePick,
  });
}

function doAttack(idx: number): void {
  const b = BT.b!;
  if (toast(attackError(b, HUMAN, idx))) return;
  const atk = topCard(b.p[HUMAN].active!).attacks[idx];
  if (attackNeedsOppBench(atk) && b.p[RIVAL].bench.length) {
    return openPick({
      prompt: "¿Qué Pokémon rival atraés?",
      targets: slotTargets(RIVAL, b.p[RIVAL].bench),
      onPick: (t) => attackFlow(idx, t.slot),
      onCancel: () => {
        BT.pick = null;
        BT.mode = "attack";
      },
    });
  }
  attackFlow(idx);
}

// ---------------------------------------------------------------------
//  Update
// ---------------------------------------------------------------------
function updateBattle(dt: number): void {
  const b = BT.b;
  if (!b) return;
  BT.bannerT = Math.max(0, BT.bannerT - dt);
  BT.toastT = Math.max(0, BT.toastT - dt);

  if (BT.zoom) {
    if (hit(KEYS.a) || hit(KEYS.b) || hit(KEYS.view)) BT.zoom = null;
    return;
  }
  if (CHOOSER) return updateChooser();
  if (hit(KEYS.view)) {
    const c = hoveredCard();
    if (c) BT.zoom = c;
    return;
  }

  if (b.phase === "over") {
    if (BT.bannerT <= 0 && hit(KEYS.a)) exitBattle();
    return;
  }

  if (b.phase === "turn" && b.turn !== BT.lastTurn) {
    BT.lastTurn = b.turn;
    showBanner(b.cur === HUMAN ? "TU TURNO" : `TURNO DE ${rivalName()}`);
    BT.mode = b.cur === HUMAN ? "menu" : "idle";
    BT.menuCursor = 0;
    BT.aiTimer = 0;
  }
  if (BT.bannerT > 0) return;

  if (b.phase === "promote") {
    const pi = b.promoteQueue[0];
    if (pi === RIVAL) {
      BT.aiTimer += dt;
      if (BT.aiTimer > 0.7) {
        BT.aiTimer = 0;
        aiPromote(b, RIVAL);
      }
    } else if (BT.pick?.tag !== "promote") {
      openPick({
        prompt: "Necesitás un nuevo Pokémon Activo. Elegí uno de tu Banca.",
        targets: slotTargets(HUMAN, b.p[HUMAN].bench),
        onPick: (t) => {
          BT.pick = null;
          BT.mode = "idle";
          promote(b, HUMAN, b.p[HUMAN].bench.indexOf(t.slot!));
        },
        tag: "promote",
      });
    }
    if (BT.mode === "pick") updatePick();
    return;
  }

  if (BT.mode === "pick") return updatePick();
  if (b.phase !== "turn") return;

  if (b.cur === RIVAL) {
    BT.aiTimer += dt;
    if (BT.aiTimer > 0.9) {
      BT.aiTimer = 0;
      aiStep(b, RIVAL);
    }
    return;
  }

  if (BT.mode === "idle") BT.mode = "menu";
  if (BT.mode === "attack") {
    const atks = b.p[HUMAN].active ? topCard(b.p[HUMAN].active).attacks : [];
    if (hit(KEYS.up)) BT.attackCursor = Math.max(0, BT.attackCursor - 1);
    if (hit(KEYS.down)) BT.attackCursor = Math.min(atks.length - 1, BT.attackCursor + 1);
    if (hit(KEYS.b)) BT.mode = "menu";
    else if (hit(KEYS.a)) doAttack(BT.attackCursor);
    return;
  }

  // menú principal del turno
  const n = BATTLE_MENU.length;
  if (hit(KEYS.up)) BT.menuCursor = (BT.menuCursor + n - 1) % n;
  if (hit(KEYS.down)) BT.menuCursor = (BT.menuCursor + 1) % n;
  if (!hit(KEYS.a)) return;
  switch (BATTLE_MENU[BT.menuCursor]) {
    case "MANO": return actionHand();
    case "ATACAR": {
      const err = b.p[HUMAN].active ? null : "No tenés Pokémon Activo.";
      if (toast(err)) return;
      BT.attackCursor = 0;
      BT.mode = "attack";
      return;
    }
    case "PODERES": return actionPowers();
    case "RETIRARSE": return actionRetreat();
    case "VER MESA": return actionView();
    case "FIN DEL TURNO":
      BT.mode = "idle";
      log(b, `${b.p[HUMAN].name} termina su turno.`);
      return endTurn(b);
    case "RENDIRSE":
      return surrender(b, HUMAN);
  }
}

// ---------------------------------------------------------------------
//  Dibujo
// ---------------------------------------------------------------------
const STATUS_BADGE: Record<string, [string, string]> = {
  asleep: ["DOR", "#5070d0"],
  paralyzed: ["PAR", "#d0a020"],
  confused: ["CNF", "#d050a0"],
  poison: ["VEN", "#8040b0"],
};

function drawCardBack(x: number, y: number, w: number, h: number): void {
  const img = loadedImage(CARD_BACK_IMAGE);
  if (img) {
    drawImageCover(img, x, y, w, h, Math.min(8, w / 8));
    return;
  }
  rrect(x, y, w, h, Math.min(8, w / 8), "#2850a8", "#18306a", 2);
  rrect(x + 3, y + 3, w - 6, h - 6, Math.min(6, w / 10), undefined, "#5a80d0", 1.5);
  ctx.fillStyle = "#e8b830";
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w * 0.28, h * 0.16, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d84030";
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w * 0.16, h * 0.08, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

function fitText(str: string, size: number, maxW: number): string {
  ctx.font = font(size);
  if (ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function drawFieldSlot(s: Slot, r: Rect): void {
  const card = topCard(s);
  const st = TYPE_STYLE[card.type];
  const big = r.w > 80;
  const hpY = r.y + (big ? 84 : 63);
  if (drawCardImage(card, r.x, r.y, r.w, r.h, 8)) {
    // franja oscura para que se lean los PS y las energías sobre la imagen
    ctx.fillStyle = "rgba(10,14,24,0.72)";
    ctx.fillRect(r.x + 3, hpY - 4, r.w - 6, r.y + r.h - hpY + 1);
  } else {
    rrect(r.x, r.y, r.w, r.h, 8, "#f4d23c", "#a88a18", 2);
    rrect(r.x + 5, r.y + 5, r.w - 10, r.h - 10, 5, st.bg, st.dark, 1.5);
    const fs = big ? 9 : 7;
    text(fitText(card.name, fs, r.w - 18), r.x + 9, r.y + 10, fs, "#202020");
    const artH = big ? 54 : 38;
    artBox(card, r.x + 9, r.y + (big ? 24 : 21), r.w - 18, artH);
  }
  const onImage = !!cardImage(card);

  // PS restantes
  const rem = remainingHp(s);
  const ratio = rem / card.hp;
  ctx.fillStyle = "#303030";
  ctx.fillRect(r.x + 9, hpY, r.w - 18, 5);
  ctx.fillStyle = ratio > 0.5 ? "#40c040" : ratio > 0.25 ? "#e8c020" : "#e04030";
  ctx.fillRect(r.x + 10, hpY + 1, Math.max(0, (r.w - 20) * ratio), 3);
  text(`${rem}/${card.hp}`, r.x + r.w - 9, hpY + 8, big ? 9 : 7, rem < card.hp ? "#ff6050" : onImage ? "#ffffff" : "#303030", {
    align: "right",
  });

  // energías unidas
  const er = big ? 6 : 5;
  const ey = r.y + r.h - (big ? 14 : 11);
  const maxIcons = Math.floor((r.w - 16) / (er * 2 + 2));
  s.energy.slice(0, maxIcons).forEach((e, i) => energyIcon(ciEnergyType(e), r.x + 9 + er + i * (er * 2 + 2), ey, er));
  if (s.energy.length > maxIcons) text(`+${s.energy.length - maxIcons}`, r.x + r.w - 9, ey - 4, 7, "#202020", { align: "right" });

  // estados
  const badges: [string, string][] = [];
  if (s.status) badges.push(STATUS_BADGE[s.status]);
  if (s.poisoned) badges.push(STATUS_BADGE.poison);
  if (s.tools.length) badges.push([`+${toolBonus(s)}`, "#e05030"]);
  if (s.defenders.length) badges.push([`-${defenderBonus(s)}`, "#3080c0"]);
  if (s.stiffenTurn >= BT.b!.turn) badges.push(["DUR", "#808890"]);
  badges.forEach(([label, color], i) => {
    rrect(r.x + r.w - 34, r.y - 8 + i * 16, 38, 15, 4, color, "#ffffff", 1.5);
    text(label, r.x + r.w - 15, r.y - 4 + i * 16, 7, "#ffffff", { align: "center" });
  });
  if (s.stack.length > 1) {
    rrect(r.x - 6, r.y - 6, 22, 15, 4, "#283850", "#ffffff", 1.5);
    text(`F${s.stack.length - 1}`, r.x + 5, r.y - 2, 7, "#ffffff", { align: "center" });
  }
}

function drawHandCard(card: Card, r: Rect): void {
  const st = cardStyle(card);
  if (drawCardImage(card, r.x, r.y, r.w, r.h, 7)) return;
  rrect(r.x, r.y, r.w, r.h, 7, "#f4d23c", "#a88a18", 2);
  rrect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 4, st.bg, st.dark, 1.5);
  wrapText(card.name, 7, r.w - 14)
    .slice(0, 2)
    .forEach((l, i) => text(l, r.x + 7, r.y + 8 + i * 10, 7, "#202020"));
  artBox(card, r.x + 7, r.y + 30, r.w - 14, 38);
  const tag = card.kind === "pokemon" ? (card.stage === "Basic" ? `${card.hp} HP` : `F${card.stage === "Stage 1" ? 1 : 2}·${card.hp}`) : card.kind === "trainer" ? "ENTREN." : "ENERGÍA";
  text(tag, r.x + r.w / 2, r.y + r.h - 18, 7, st.dark, { align: "center" });
}

function emptySlot(r: Rect): void {
  rrect(r.x, r.y, r.w, r.h, 8, "rgba(255,255,255,0.06)", "rgba(255,255,255,0.25)", 1.5);
}

function drawPlayerInfo(pi: number): void {
  const b = BT.b!;
  const p = b.p[pi];
  const top = pi === RIVAL;
  const y0 = top ? 10 : 404;
  rrect(8, y0, 134, 226, 10, "rgba(10,30,20,0.55)", "rgba(255,255,255,0.25)", 1.5);
  text(fitText(p.name, 11, 118), 18, y0 + 10, 11, b.cur === pi && b.phase === "turn" ? "#f8e060" : "#ffffff");
  text("PREMIOS", 18, y0 + 32, 7, "#b8d8c0");
  for (let i = 0; i < b.prizeCount; i++) {
    const px = 18 + (i % 3) * 38;
    const py = y0 + 44 + Math.floor(i / 3) * 46;
    if (i < p.prizes.length) drawCardBack(px + 1, py, 30, 42);
    else rrect(px + 1, py, 30, 42, 4, undefined, "rgba(255,255,255,0.2)", 1);
  }
  const rows = [
    ["Mazo", p.deck.length],
    ["Mano", p.hand.length],
    ["Descarte", p.discard.length],
  ] as const;
  rows.forEach(([l, v], i) => {
    text(l, 18, y0 + 146 + i * 22, 8, "#d0e8d8");
    text(String(v), 132, y0 + 146 + i * 22, 8, "#ffffff", { align: "right" });
  });
  if (b.cur === pi && b.phase === "turn" && pi === HUMAN) {
    text(b.energyPlayed ? "Energía: usada" : "Energía: disponible", 18, y0 + 212, 7, b.energyPlayed ? "#a0a0a0" : "#80f080");
  }
}

function drawField(): void {
  const b = BT.b!;
  for (const pi of [RIVAL, HUMAN]) {
    const p = b.p[pi];
    // en la preparación, los Pokémon del rival están boca abajo
    const hidden = b.phase === "setup" && pi === RIVAL;
    const put = (s: Slot | undefined | null, r: Rect) =>
      s ? (hidden ? drawCardBack(r.x, r.y, r.w, r.h) : drawFieldSlot(s, r)) : emptySlot(r);
    for (let i = 0; i < BENCH_MAX; i++) put(p.bench[i], benchRect(pi, i));
    put(p.active, activeRect(pi));
  }
  // mano del rival (dorsos chicos) y mano propia
  const opp = b.p[RIVAL];
  for (let i = 0; i < Math.min(opp.hand.length, 10); i++) drawCardBack(FIELD.left + 4 + i * 10, 124, 25, 35);
  text(`${opp.hand.length}`, FIELD.left + 18, 164, 8, "#ffffff", { align: "center" });
  const hand = b.p[HUMAN].hand;
  hand.forEach((c, i) => drawHandCard(c.c, handRect(i, hand.length)));
}

function drawPickHighlights(): void {
  if (BT.mode !== "pick" || !BT.pick) return;
  const pulse = 0.5 + 0.5 * Math.sin(game.time * 8);
  BT.pick.targets.forEach((t, i) => {
    const r = t.rect;
    if (i === BT.pick!.cursor) {
      rrect(r.x - 5, r.y - 5, r.w + 10, r.h + 10, 11, undefined, `rgba(255,${Math.round(80 + 120 * pulse)},48,1)`, 4);
      cursorArrow(r.x + r.w / 2 - 8, r.y - 22, 16, "#ff5030");
      ctx.save();
      ctx.translate(r.x + r.w / 2 + 8, r.y - 22);
      ctx.restore();
    } else rrect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 9, undefined, "rgba(255,255,160,0.55)", 2);
  });
}

function drawInfoPanel(): void {
  const x = PANEL.x;
  const w = PANEL.w;
  rrect(x, 8, w, 300, 10, "#f8f8f0", "#283850", 3);
  const card = hoveredCard();
  if (!card) return;
  const slot = hoveredSlot();
  if (cardImage(card)) return drawInfoImage(card, slot, x, w);
  const st = cardStyle(card);
  ctx.fillStyle = st.main;
  ctx.fillRect(x + 3, 11, w - 6, 30);
  text(fitText(card.name, 11, w - 70), x + 12, 20, 11, "#ffffff", { shadow: st.dark });
  let y = 50;
  const ix = x + 12;
  const iw = w - 24;
  if (card.kind === "pokemon") {
    const hp = slot ? `${remainingHp(slot)}/${card.hp}` : `${card.hp}`;
    text(`${hp} HP`, x + w - 12, 21, 9, "#ffffff", { align: "right" });
    const stage = card.stage === "Basic" ? "Básico" : `${card.stage === "Stage 1" ? "Fase 1" : "Fase 2"} (de ${card.evolvesFrom})`;
    text(stage, ix, y, 7, st.dark);
    y += 14;
    if (slot) {
      const conds = [slot.status ? STATUS_ES[slot.status] : "", slot.poisoned ? "Envenenado" : ""].filter(Boolean).join(", ");
      if (conds) {
        text(conds, ix, y, 7, "#c02818");
        y += 12;
      }
      if (slot.energy.length) {
        slot.energy.forEach((e, i) => energyIcon(ciEnergyType(e), ix + 7 + i * 16, y + 6, 7));
        y += 18;
      }
    }
    if (card.power) {
      text(`Poder: ${card.power.name}`, ix, y + 2, 8, "#c02818");
      y += 14;
      const how = isActivePowerCard(card)
        ? "(usalo desde PODERES)"
        : cardPowerHas(card, "energyBurn") ? "(se activa solo al atacar)" : "(automático)";
      text(how, ix, y, 7, "#808080");
      y += 12;
    }
    for (const atk of card.attacks) {
      y += 4;
      atk.cost.forEach((t, k) => energyIcon(t, ix + 7 + k * 16, y + 6, 7));
      const nx = ix + atk.cost.length * 16 + 4;
      text(fitText(atk.name, 8, iw - (nx - ix) - 30), nx, y + 2, 8, "#202020");
      if (atk.damage) text(atk.damage, x + w - 12, y + 1, 10, "#202020", { align: "right" });
      y += 17;
      if (atk.text) {
        for (const l of wrapText(atk.text, 7, iw)) {
          text(l, ix, y, 7, "#505050");
          y += 10;
        }
      }
    }
    const wr = `Deb: ${card.weakness ? TYPE_STYLE[card.weakness].es : "—"}  Res: ${card.resistance ? TYPE_STYLE[card.resistance].es : "—"}  Ret: ${card.retreat}`;
    text(fitText(wr, 7, iw), ix, 290, 7, st.dark);
  } else if (card.kind === "trainer") {
    text("ENTRENADOR", ix, y, 7, st.dark);
    y += 16;
    for (const l of wrapText(card.text, 8, iw)) {
      text(l, ix, y, 8, "#303030");
      y += 13;
    }
  } else {
    text("Energía básica", ix, y, 8, st.dark);
    energyIcon(card.type, x + w / 2, 170, 40);
  }
  text("C: ampliar", x + w - 12, 278, 7, "#909090", { align: "right" });
}

/** Panel de la carta seleccionada cuando tiene imagen propia: se muestra la carta entera (5:7). */
function drawInfoImage(card: Card, slot: Slot | null | undefined, x: number, w: number): void {
  const r = fitCard(x + 8, 14, w - 16, 288);
  drawCardImage(card, r.x, r.y, r.w, r.h, 8);
  if (!slot || card.kind !== "pokemon") return;
  // estado actual del Pokémon en juego, sobre una franja al pie de la carta
  const conds = [slot.status ? STATUS_ES[slot.status] : "", slot.poisoned ? "Envenenado" : ""].filter(Boolean).join(", ");
  const bandH = conds ? 40 : 26;
  ctx.fillStyle = "rgba(10,14,24,0.8)";
  ctx.fillRect(r.x, r.y + r.h - bandH, r.w, bandH);
  const rem = remainingHp(slot);
  text(`${rem}/${card.hp} PS`, r.x + r.w - 8, r.y + r.h - bandH + 8, 9, rem < card.hp ? "#ff6050" : "#ffffff", { align: "right" });
  slot.energy.slice(0, 6).forEach((e, i) => energyIcon(ciEnergyType(e), r.x + 12 + i * 14, r.y + r.h - bandH + 12, 6));
  if (conds) text(fitText(conds, 7, r.w - 16), r.x + 8, r.y + r.h - 14, 7, "#ffb0a0");
}

function drawActionPanel(): void {
  const b = BT.b!;
  const x = PANEL.x;
  const w = PANEL.w;
  const y = 316;
  rrect(x, y, w, 162, 10, "#f8f8f0", "#283850", 3);
  if (BT.mode === "pick" && BT.pick) {
    wrapText(BT.pick.prompt, 9, w - 24).forEach((l, i) => text(l, x + 12, y + 14 + i * 15, 9, "#283850"));
    text("Flechas: mover", x + 12, y + 112, 7, "#707070");
    text(`Z: elegir${BT.pick.onCancel ? "   X: volver" : ""}`, x + 12, y + 128, 7, "#707070");
    return;
  }
  if (b.phase === "over") {
    text("Partida terminada.", x + 12, y + 16, 9, "#283850");
    text("Z: salir", x + 12, y + 40, 9, "#707070");
    return;
  }
  if (b.cur !== HUMAN || b.phase !== "turn") {
    text(b.phase === "promote" ? "Esperando..." : `${rivalName()} está jugando...`, x + 12, y + 16, 9, "#283850");
    const dots = ".".repeat(1 + (Math.floor(game.time * 3) % 3));
    text(dots, x + 12, y + 40, 12, "#283850");
    return;
  }
  if (BT.mode === "attack") {
    const a = b.p[HUMAN].active!;
    text("ATACAR (X: volver)", x + 12, y + 10, 8, "#808080");
    topCard(a).attacks.forEach((atk, i) => {
      const ry = y + 30 + i * 44;
      const usable = !attackError(b, HUMAN, i);
      if (i === BT.attackCursor) {
        rrect(x + 6, ry - 4, w - 12, 40, 6, "#f8e088");
        cursorArrow(x + 10, ry + 4, 10);
      }
      atk.cost.forEach((t, k) => energyIcon(t, x + 30 + k * 15, ry + 6, 6));
      text(fitText(atk.name, 9, w - 90), x + 26, ry + 18, 9, usable ? "#202020" : "#a0a0a0");
      if (atk.damage) text(atk.damage, x + w - 14, ry + 10, 11, usable ? "#202020" : "#a0a0a0", { align: "right" });
    });
    return;
  }
  BATTLE_MENU.forEach((label, i) => {
    const ry = y + 9 + i * 21;
    if (i === BT.menuCursor) cursorArrow(x + 14, ry, 12);
    text(label, x + 34, ry + 1, 10, "#383838", { shadow: "#d8d8d0" });
  });
}

function drawLog(): void {
  const b = BT.b!;
  const x = PANEL.x;
  const w = PANEL.w;
  const y = 486;
  const h = 146;
  rrect(x, y, w, h, 10, "rgba(10,20,30,0.82)", "#283850", 3);
  const lines: string[] = [];
  for (const msg of b.log.slice(-14)) lines.push(...wrapText(msg, 7, w - 22));
  const shown = lines.slice(-12);
  shown.forEach((l, i) => {
    const isLast = i >= shown.length - 2;
    text(l, x + 11, y + 10 + i * 11, 7, l.startsWith("—") ? "#f8e060" : isLast ? "#ffffff" : "#a8b8c8");
  });
}

function renderBattle(): void {
  const b = BT.b;
  if (!b) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(FIELD.cx, 320, 60, FIELD.cx, 320, 620);
  g.addColorStop(0, "#3a8a58");
  g.addColorStop(1, "#1a4a30");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(FIELD.left, 260);
  ctx.lineTo(FIELD.right, 260);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(FIELD.cx, 260, 40, 0, Math.PI * 2);
  ctx.stroke();

  drawPlayerInfo(RIVAL);
  drawPlayerInfo(HUMAN);
  drawField();
  drawPickHighlights();
  drawInfoPanel();
  drawActionPanel();
  drawLog();

  if (BT.toastT > 0) {
    const lines = wrapText(BT.toast, 10, 440);
    const h = 26 + lines.length * 16;
    rrect(FIELD.cx - 240, 230 - h / 2 + 30, 480, h, 10, "rgba(40,20,20,0.92)", "#f08060", 3);
    lines.forEach((l, i) => text(l, FIELD.cx, 230 - h / 2 + 44 + i * 16, 10, "#ffffff", { align: "center" }));
  }

  if (BT.bannerT > 0 || b.phase === "over") {
    const t = BT.bannerT;
    const label =
      b.phase === "over" && t <= 0 ? (b.winner === HUMAN ? "¡GANASTE!" : b.winner === 2 ? "EMPATE" : "PERDISTE") : BT.banner;
    ctx.fillStyle = "rgba(10,20,40,0.78)";
    ctx.fillRect(0, 230, CW, 64);
    ctx.fillStyle = "#f0c040";
    ctx.fillRect(0, 230, CW, 3);
    ctx.fillRect(0, 291, CW, 3);
    text(label, CW / 2, 250, 22, "#ffffff", { align: "center", shadow: "#000000" });
    if (b.phase === "over" && t <= 0) text("Z: volver al mapa", CW / 2, 300, 9, "#ffffff", { align: "center", shadow: "#000000" });
  }

  renderChooser();

  if (BT.zoom) {
    ctx.fillStyle = "rgba(5,10,20,0.78)";
    ctx.fillRect(0, 0, CW, CH);
    drawCardDetail(BT.zoom, CW / 2 - 200, 50, 400, 540);
    text("Z / X / C: cerrar", CW / 2, 604, 9, "#ffffff", { align: "center" });
  }
}
