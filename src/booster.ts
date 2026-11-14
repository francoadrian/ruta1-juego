// =====================================================================
//  Sobre de Base Set: generación (11 cartas) y animación de apertura
//  Composición: 1 Rara (≈1 de cada 3, Rara holo), 3 Poco comunes,
//  5 Comunes y 2 Energías básicas.
// =====================================================================

type BoosterPhase = "intro" | "idle" | "burst" | "reveal" | "summary";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

const BO = {
  phase: "intro" as BoosterPhase,
  t: 0,
  tear: 0, // progreso del corte (0..1)
  angle: 0, // inclinación del sobre (←→)
  angVel: 0,
  turn: 0, // giro del sobre para ver el dorso (0 = frente, π = dorso)
  turnTarget: 0,
  cards: [] as string[],
  isNew: [] as boolean[],
  revealed: 0, // cartas ya pasadas a la fila de abajo
  flipT: -1, // -1 = sin girar; 0..1 = girando la carta de arriba
  showing: false, // la carta de arriba está boca arriba
  flyT: -1, // 0..1 = carta volando a la fila
  flash: 0,
  particles: [] as Particle[],
  onDone: null as (() => void) | null,
  title: "", // arriba del sobre al llegar
  claimed: false, // las cartas ya se sumaron (envío del buzón): no volver a sumarlas
  noPack: false, // cartas sueltas del buzón: no hay sobre, se dan vuelta directo
  queue: [] as { cards: string[]; isNew: boolean[] }[], // tandas que faltan (envíos grandes)
};

/** Sobre: 2,5" × 4,75" (10:19). */
const PACK = { w: 190, h: 361, strip: 30, cx: 480, cy: 300 };
/** Cartas: 2,5" × 3,5" (5:7). */
const BIG = { w: 235, h: 329, x: 480 - 117.5, y: 92 };
const ROW = { w: 65, h: 91, gap: 6, y: 494 };
/** Tamaño de referencia con el que se dibuja la carta grande antes de escalarla. */
const DETAIL = { w: 400, h: 560 };

// ---------------------------------------------------------------------
//  Generación: ver packs.ts (generateBooster)
// ---------------------------------------------------------------------
let currentBooster: BoosterDef | null = null;

/** Sobre por id (aunque esté deshabilitado, por si llegó al buzón antes de deshabilitarlo). */
const boosterById = (id: string): BoosterDef | null =>
  BOOSTERS.find((b) => b.id === id) ?? (CATALOG?.boosters ?? []).find((b) => b.id === id && b.cards?.length) ?? null;

/** Cuáles de estas cartas son nuevas para la colección (antes de sumarlas). */
function newFlags(cards: string[]): boolean[] {
  const seen = new Set<string>();
  return cards.map((id) => {
    const isNew = ownedQty(id) === 0 && !seen.has(id);
    seen.add(id);
    return isNew;
  });
}

function resetBooster(onDone: () => void, extra: Partial<typeof BO>): void {
  game.mode = "booster";
  Object.assign(BO, {
    phase: "intro", t: 0, tear: 0, angle: 0, angVel: 0, revealed: 0,
    flipT: -1, showing: false, flyT: -1, flash: 0, particles: [], onDone, turn: 0, turnTarget: 0,
    title: "", claimed: false, noPack: false, queue: [],
    ...extra,
  });
}

/** Sobre que sorteó el servidor (buzón o premio de un NPC): las cartas ya son del jugador; acá solo se muestra la apertura. */
function openMailBooster(def: BoosterDef, cards: string[], isNew: boolean[], onDone: () => void, title = "¡Llegó un sobre a tu buzón!"): void {
  currentBooster = def;
  resetBooster(onDone, { cards, isNew, claimed: true, title });
}

/** Cartas sueltas del buzón: se dan vuelta de a una (en tandas de hasta 12). */
function revealMailCards(cards: string[], isNew: boolean[], onDone: () => void): void {
  const queue: { cards: string[]; isNew: boolean[] }[] = [];
  for (let i = 0; i < cards.length; i += 12) queue.push({ cards: cards.slice(i, i + 12), isNew: isNew.slice(i, i + 12) });
  const first = queue.shift()!;
  currentBooster = null;
  resetBooster(onDone, { cards: first.cards, isNew: first.isNew, claimed: true, noPack: true, queue, phase: "reveal" });
}

// ---------------------------------------------------------------------
//  Partículas
// ---------------------------------------------------------------------
function burstParticles(x: number, y: number, n: number, colors: string[], speed = 260): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random());
    BO.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60,
      life: 0, max: 0.6 + Math.random() * 0.8,
      color: colors[i % colors.length], size: 2 + Math.random() * 4,
    });
  }
}

function updateParticles(dt: number): void {
  for (const p of BO.particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 380 * dt;
    p.vx *= 1 - 1.5 * dt;
  }
  BO.particles = BO.particles.filter((p) => p.life < p.max);
}

function drawSparkle(x: number, y: number, s: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - s * 2);
  ctx.lineTo(x + s * 0.5, y - s * 0.5);
  ctx.lineTo(x + s * 2, y);
  ctx.lineTo(x + s * 0.5, y + s * 0.5);
  ctx.lineTo(x, y + s * 2);
  ctx.lineTo(x - s * 0.5, y + s * 0.5);
  ctx.lineTo(x - s * 2, y);
  ctx.lineTo(x - s * 0.5, y - s * 0.5);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------
//  Update
// ---------------------------------------------------------------------
const isHeld = (codes: string[]): boolean => codes.some((c) => held.has(c));

function updateBooster(dt: number): void {
  BO.t += dt;
  BO.flash = Math.max(0, BO.flash - dt * 2.5);
  updateParticles(dt);

  // inclinar el sobre con ←→ (resorte amortiguado)
  const target = isHeld(KEYS.left) ? -0.6 : isHeld(KEYS.right) ? 0.6 : 0;
  BO.angVel += (target - BO.angle) * 40 * dt;
  BO.angVel *= 1 - 7 * dt;
  BO.angle += BO.angVel * dt;
  // dar vuelta el sobre (↑↓) para ver el dorso
  BO.turn += (BO.turnTarget - BO.turn) * Math.min(1, dt * 9);

  switch (BO.phase) {
    case "intro":
      if (BO.t > 0.9) {
        BO.phase = "idle";
        BO.t = 0;
      }
      break;
    case "idle":
      if (BO.tear === 0 && (hit(KEYS.up) || hit(KEYS.down))) BO.turnTarget = BO.turnTarget ? 0 : Math.PI;
      if (isHeld(KEYS.a) && BO.turnTarget) BO.turnTarget = 0; // para abrirlo, se ve el frente
      else if (isHeld(KEYS.a) && Math.cos(BO.turn) > 0.9) {
        BO.tear = Math.min(1, BO.tear + dt * 0.6);
        if (Math.random() < 0.6) {
          const x = PACK.cx - PACK.w / 2 + BO.tear * PACK.w;
          burstParticles(x, PACK.cy - PACK.h / 2 + PACK.strip, 1, ["#e8e8f8", "#b8c8f8", "#f8e080"], 120);
        }
      }
      if (BO.tear >= 1) {
        BO.phase = "burst";
        BO.t = 0;
        BO.flash = 1;
        burstParticles(PACK.cx, PACK.cy - PACK.h / 2 + PACK.strip, 40, ["#ffffff", "#f8e080", "#a8c8ff", "#f8a8e8"], 380);
      }
      break;
    case "burst":
      if (BO.t > 1.5) {
        BO.phase = "reveal";
        BO.t = 0;
      }
      break;
    case "reveal":
      if (hit(KEYS.b)) {
        BO.revealed = BO.cards.length;
        BO.phase = "summary";
        BO.t = 0;
        break;
      }
      if (BO.flipT >= 0) {
        BO.flipT += dt / 0.45;
        if (BO.flipT >= 1) {
          BO.flipT = -1;
          BO.showing = true;
          const card = CARDS[BO.cards[BO.revealed]];
          if (card.holo) {
            burstParticles(480, 250, 60, ["#ffffff", "#f8e060", "#80e8ff", "#ff90e0", "#a0ff90"], 420);
            BO.flash = 0.7;
          } else if (card.rarity === "Rare") burstParticles(480, 250, 25, ["#f8e060", "#ffffff"], 300);
        }
      } else if (BO.flyT >= 0) {
        BO.flyT += dt / 0.3;
        if (BO.flyT >= 1) {
          BO.flyT = -1;
          BO.revealed++;
          if (BO.revealed >= BO.cards.length) {
            BO.phase = "summary";
            BO.t = 0;
          }
        }
      } else if (hit(KEYS.a)) {
        if (BO.showing) {
          BO.showing = false;
          BO.flyT = 0;
        } else BO.flipT = 0;
      }
      break;
    case "summary":
      if (BO.t > 0.5 && hit(KEYS.a) && BO.queue.length) {
        const next = BO.queue.shift()!;
        Object.assign(BO, { cards: next.cards, isNew: next.isNew, phase: "reveal", t: 0, revealed: 0, flipT: -1, showing: false, flyT: -1 });
        break;
      }
      if (BO.t > 0.5 && hit(KEYS.a)) {
        game.mode = "explore";
        const cb = BO.onDone;
        BO.onDone = null;
        cb?.();
      }
      break;
  }
}

// ---------------------------------------------------------------------
//  Dibujo del sobre (diseño propio, sin logos oficiales)
// ---------------------------------------------------------------------
/** Pinta el pedazo (x, y, w, h) del sobre con la parte que le toca de la textura. */
function packTexture(img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  drawImageCover(img, -PACK.w / 2, -PACK.h / 2, PACK.w, PACK.h);
  ctx.restore();
}

function crimp(x: number, y: number, w: number, h: number, base: string, edgeTop: boolean, tex?: HTMLImageElement | null): void {
  if (tex) packTexture(tex, x, y, w, h);
  else {
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  for (let i = x + 4; i < x + w; i += 5) {
    ctx.beginPath();
    ctx.moveTo(i, y + 3);
    ctx.lineTo(i, y + h - 3);
    ctx.stroke();
  }
  // borde dentado
  ctx.fillStyle = "#0a0f20";
  const ey = edgeTop ? y : y + h;
  const dir = edgeTop ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x, ey);
  for (let i = 0; i <= w; i += 8) ctx.lineTo(x + i + 4, ey + dir * 4), ctx.lineTo(x + i + 8, ey);
  ctx.lineTo(x + w, ey - dir * 2);
  ctx.lineTo(x, ey - dir * 2);
  ctx.closePath();
  ctx.fill();
}

function packFoil(x: number, y: number, w: number, h: number, shine: number): void {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#1d2b6a");
  g.addColorStop(0.35, "#3a62d8");
  g.addColorStop(0.65, "#7a3ad0");
  g.addColorStop(1, "#1a2458");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // brillo diagonal que se mueve al inclinar
  const sx = x + w * (0.5 + shine);
  const sg = ctx.createLinearGradient(sx - 80, y, sx + 80, y + h * 0.4);
  sg.addColorStop(0, "rgba(255,255,255,0)");
  sg.addColorStop(0.5, "rgba(255,255,255,0.35)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  ctx.fillRect(x, y, w, h);
}

/** Brillo diagonal sobre una textura cargada (para que se note el plástico). */
function packGloss(x: number, y: number, w: number, h: number, shine: number): void {
  const sx = x + w * (0.5 + shine);
  const sg = ctx.createLinearGradient(sx - 80, y, sx + 80, y + h * 0.4);
  sg.addColorStop(0, "rgba(255,255,255,0)");
  sg.addColorStop(0.5, "rgba(255,255,255,0.28)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  ctx.fillRect(x, y, w, h);
}

const packFront = (): HTMLImageElement | null => loadedImage(currentBooster?.front);
const packBack = (): HTMLImageElement | null => loadedImage(currentBooster?.back);

function drawPackBody(w: number, h: number, shine: number): void {
  const top = -h / 2 + PACK.strip;
  const bodyH = h - PACK.strip - 22;
  const tex = packFront();
  crimp(-w / 2, h / 2 - 22, w, 22, "#26306a", false, tex);
  if (tex) {
    packTexture(tex, -w / 2, top, w, bodyH);
    packGloss(-w / 2, top, w, bodyH, shine);
    return;
  }
  packFoil(-w / 2, top, w, bodyH, shine);

  // emblema central
  const cy = top + bodyH * 0.42;
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.arc(0, cy, 72, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,230,140,0.85)";
  ctx.lineWidth = 3;
  ctx.stroke();
  const types: EType[] = ["Fire", "Water", "Grass", "Lightning", "Psychic", "Fighting"];
  types.forEach((t, i) => {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / types.length + game.time * 0.4;
    energyIcon(t, Math.cos(a) * 50, cy + Math.sin(a) * 50, 13);
  });
  energyIcon("Colorless", 0, cy, 20);

  const raw = (currentBooster?.name ?? "").toUpperCase();
  ctx.font = font(22);
  const ns = Math.max(12, Math.min(22, Math.floor((22 * (w - 20)) / Math.max(1, ctx.measureText(raw).width))));
  const name = fitText(raw, ns, w - 20);
  text(name, 2, top + bodyH * 0.74 + 2, ns, "#1a1030", { align: "center" });
  text(name, 0, top + bodyH * 0.74, ns, "#ffe070", { align: "center" });
  text("TRADING CARD GAME", 0, top + bodyH * 0.74 + 34, 8, "#d8e0ff", { align: "center" });
  text(`${BO.cards.length} CARTAS`, 0, top + bodyH - 22, 9, "#ffffff", { align: "center" });
}

/** Dorso del sobre: textura cargada o un diseño simple por defecto. */
function drawPackBackFace(w: number, h: number, shine: number): void {
  const tex = packBack();
  const top = -h / 2 + PACK.strip;
  const bodyH = h - PACK.strip - 22;
  crimp(-w / 2, -h / 2, w, PACK.strip, "#26306a", true, tex);
  crimp(-w / 2, h / 2 - 22, w, 22, "#26306a", false, tex);
  if (tex) {
    packTexture(tex, -w / 2, top, w, bodyH);
    packGloss(-w / 2, top, w, bodyH, -shine);
    return;
  }
  packFoil(-w / 2, top, w, bodyH, -shine);
  rrect(-w / 2 + 18, top + 20, w - 36, bodyH - 40, 8, "rgba(255,255,255,0.12)", "rgba(255,230,140,0.6)", 2);
  text("CONTIENE", 0, top + 44, 10, "#ffe070", { align: "center" });
  text(`${BO.cards.length} CARTAS`, 0, top + 66, 14, "#ffffff", { align: "center" });
  const lines = wrapText("Cartas al azar de la colección. Cada sobre trae al menos una carta Rara.", 8, w - 64);
  lines.forEach((l, i) => text(l, 0, top + 104 + i * 14, 8, "#d8e0ff", { align: "center" }));
  // código de barras
  for (let i = 0; i < 34; i++) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-56 + i * 3.3, top + bodyH - 74, i % 3 === 0 ? 2 : 1, 40);
  }
}

function drawPack(cx: number, cy: number, opts: { tear: number; stripOff?: number; alpha?: number }): void {
  const w = PACK.w;
  const h = PACK.h;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.translate(cx, cy);
  ctx.rotate(BO.angle * 0.25);
  ctx.scale(1 - Math.abs(BO.angle) * 0.35, 1);
  // sombra
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(0, h / 2 + 30, w * 0.45, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // giro vertical (↑↓): de frente a dorso
  const turn = Math.cos(BO.turn);
  ctx.scale(Math.max(0.02, Math.abs(turn)), 1);
  if (turn < 0) {
    drawPackBackFace(w, h, BO.angle * 0.6);
    ctx.restore();
    return;
  }

  drawPackBody(w, h, BO.angle * 0.6);

  // tira superior (la que se corta)
  const top = -h / 2;
  const cut = -w / 2 + opts.tear * w;
  const off = opts.stripOff ?? 0;
  if (off < 1) {
    ctx.save();
    if (off > 0) {
      ctx.translate(0, -off * 420);
      ctx.rotate(-off * 2.4);
      ctx.globalAlpha *= 1 - off;
    }
    // parte ya cortada: se levanta un poco
    ctx.save();
    ctx.beginPath();
    ctx.rect(-w / 2 - 2, top - 10, cut + w / 2 + 2, PACK.strip + 12);
    ctx.clip();
    if (off === 0) {
      ctx.translate(-w / 2, top + PACK.strip);
      ctx.rotate(-0.07 * opts.tear);
      ctx.translate(w / 2, -(top + PACK.strip) - 5 * opts.tear);
    }
    crimp(-w / 2, top, w, PACK.strip, "#26306a", true, packFront());
    ctx.restore();
    // parte sin cortar
    ctx.save();
    ctx.beginPath();
    ctx.rect(cut, top - 4, w / 2 - cut + 2, PACK.strip + 6);
    ctx.clip();
    crimp(-w / 2, top, w, PACK.strip, "#26306a", true, packFront());
    ctx.restore();
    ctx.restore();
  }
  // línea del corte (dentada, blanca)
  if (opts.tear > 0 && off < 1) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-w / 2, top + PACK.strip);
    for (let x = -w / 2; x < cut; x += 6) ctx.lineTo(x + 3, top + PACK.strip + (x % 12 === 0 ? -2 : 2));
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------
//  Cartas grandes
// ---------------------------------------------------------------------
function drawBigCardBack(x: number, y: number): void {
  drawCardBack(x, y, BIG.w, BIG.h);
}

function drawBigCardFace(id: string, x: number, y: number, isNew: boolean): void {
  const card = CARDS[id];
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(BIG.w / DETAIL.w, BIG.h / DETAIL.h);
  drawCardDetail(card, 0, 0, DETAIL.w, DETAIL.h);
  if (card.holo) {
    // brillo holográfico animado
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, DETAIL.w, DETAIL.h, 16);
    ctx.clip();
    ctx.globalCompositeOperation = "screen";
    const off = ((game.time * 220) % 900) - 300;
    const g = ctx.createLinearGradient(off, 0, off + DETAIL.w, DETAIL.h);
    const hues = ["rgba(255,0,0,0)", "rgba(255,120,200,0.35)", "rgba(120,220,255,0.4)", "rgba(160,255,140,0.35)", "rgba(255,240,120,0.35)", "rgba(255,0,0,0)"];
    hues.forEach((c, i) => g.addColorStop(i / (hues.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DETAIL.w, DETAIL.h);
    ctx.restore();
  }
  ctx.restore();
  if (isNew) {
    rrect(x + BIG.w - 70, y - 12, 82, 26, 8, "#e83838", "#ffffff", 2);
    text("NUEVA", x + BIG.w - 29, y - 4, 10, "#ffffff", { align: "center" });
  }
}

const RARITY_LABEL: Record<Rarity, [string, string]> = {
  "Rare Holo": ["¡RARA HOLO!", "#ffe060"],
  Rare: ["¡RARA!", "#f8d040"],
  Uncommon: ["POCO COMÚN", "#c8e0ff"],
  Common: ["COMÚN", "#e0e0e0"],
};

function rarityLabel(c: Card): [string, string] {
  if (isBasicEnergy(c)) return ["ENERGÍA", "#e0e0e0"];
  if (c.holo) return c.rarity === "Rare" ? RARITY_LABEL["Rare Holo"] : [`${RARITY_LABEL[c.rarity][0]} HOLO`, "#ffe060"];
  return RARITY_LABEL[c.rarity];
}

function rowRect(i: number): Rect {
  const n = BO.cards.length;
  const total = n * ROW.w + (n - 1) * ROW.gap;
  return { x: (CW - total) / 2 + i * (ROW.w + ROW.gap), y: ROW.y, w: ROW.w, h: ROW.h };
}

// ---------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------
function renderBoosterBackground(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createRadialGradient(480, 300, 40, 480, 300, 640);
  g.addColorStop(0, "#3a2a6a");
  g.addColorStop(1, "#0c0a1c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);
  // rayos de luz girando
  ctx.save();
  ctx.translate(480, 300);
  ctx.rotate(game.time * 0.15);
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  for (let i = 0; i < 12; i++) {
    ctx.rotate((Math.PI * 2) / 12);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(700, -60);
    ctx.lineTo(700, 60);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function hint(str: string): void {
  text(str, CW / 2, CH - 34, 10, "#ffffff", { align: "center", shadow: "#000000" });
}

function renderBooster(): void {
  renderBoosterBackground();
  const bob = Math.sin(game.time * 2.2) * 6;

  switch (BO.phase) {
    case "intro": {
      const k = Math.min(1, BO.t / 0.9);
      const e = 1 - Math.pow(1 - k, 3);
      drawPack(PACK.cx, PACK.cy + (1 - e) * 500, { tear: 0 });
      text(BO.title, CW / 2, 40, 14, "#ffe070", { align: "center", shadow: "#000000" });
      break;
    }
    case "idle":
      drawPack(PACK.cx, PACK.cy + bob, { tear: BO.tear });
      text(`SOBRE ${(currentBooster?.name ?? "").toUpperCase()}`, CW / 2, 40, 14, "#ffe070", { align: "center", shadow: "#000000" });
      if (BO.tear > 0) {
        rrect(CW / 2 - 120, CH - 70, 240, 12, 6, "rgba(255,255,255,0.15)");
        rrect(CW / 2 - 120, CH - 70, 240 * BO.tear, 12, 6, "#ffe070");
      }
      hint(BO.tear > 0 ? "¡Seguí apretando Z para abrirlo!" : "Mantené Z para abrir  ·  Izq/Der: inclinar  ·  Arriba/Abajo: dar vuelta");
      break;
    case "burst": {
      const t = BO.t;
      const packDrop = Math.max(0, t - 0.6) / 0.9;
      // cartas saliendo
      const rise = Math.min(1, t / 0.9);
      const e = 1 - Math.pow(1 - rise, 3);
      for (let i = 4; i >= 0; i--) {
        const y = PACK.cy - 40 - e * 180 + i * 3 + packDrop * 30;
        drawBigCardBack(480 - BIG.w / 2 + i * 2, y - BIG.h / 2 + 40);
      }
      drawPack(PACK.cx, PACK.cy + packDrop * packDrop * 600, {
        tear: 1, stripOff: Math.min(1, t / 0.8), alpha: 1 - Math.min(1, packDrop),
      });
      break;
    }
    case "reveal": {
      const remaining = BO.cards.length - BO.revealed;
      // pila boca abajo
      const stack = remaining - (BO.showing || BO.flipT >= 0 || BO.flyT >= 0 ? 1 : 0);
      for (let i = Math.min(stack, 6) - 1; i >= 0; i--) drawBigCardBack(BIG.x + i * 2, BIG.y + i * 2);
      const id = BO.cards[BO.revealed];
      const isNew = BO.isNew[BO.revealed];
      if (BO.flipT >= 0) {
        const sx = Math.abs(Math.cos(Math.PI * BO.flipT));
        ctx.save();
        ctx.translate(BIG.x + BIG.w / 2, BIG.y - Math.sin(Math.PI * BO.flipT) * 30);
        ctx.scale(Math.max(0.02, sx), 1);
        if (BO.flipT < 0.5) drawBigCardBack(-BIG.w / 2, 0);
        else drawBigCardFace(id, -BIG.w / 2, 0, false);
        ctx.restore();
      } else if (BO.showing) {
        drawBigCardFace(id, BIG.x, BIG.y, isNew);
        const [label, color] = rarityLabel(CARDS[id]);
        text(label, CW / 2, 50, 18, color, { align: "center", shadow: "#000000" });
      } else if (BO.flyT >= 0) {
        const r = rowRect(BO.revealed);
        const k = BO.flyT * BO.flyT;
        const x = BIG.x + (r.x - BIG.x) * k;
        const y = BIG.y + (r.y - BIG.y) * k;
        const s = 1 + (r.w / BIG.w - 1) * k;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s, s);
        drawBigCardFace(id, 0, 0, false);
        ctx.restore();
      }
      // fila de cartas ya reveladas
      for (let i = 0; i < BO.cards.length; i++) {
        const r = rowRect(i);
        if (i < BO.revealed) {
          drawHandCard(CARDS[BO.cards[i]], r);
          if (CARDS[BO.cards[i]].holo) {
            drawSparkle(r.x + r.w - 6, r.y + 8 + Math.sin(game.time * 5) * 2, 3, "#fff6c0");
          }
        } else rrect(r.x, r.y, r.w, r.h, 7, "rgba(255,255,255,0.05)", "rgba(255,255,255,0.18)", 1.5);
      }
      text(`CARTA ${Math.min(BO.revealed + 1, BO.cards.length)} DE ${BO.cards.length}`, 24, 24, 10, "#c8c0f0");
      hint(BO.showing ? "Z: siguiente carta   X: revelar todas" : "Z: dar vuelta la carta   X: revelar todas");
      break;
    }
    case "summary": {
      text(BO.noPack ? "¡CARTAS RECIBIDAS!" : "¡SOBRE ABIERTO!", CW / 2, 26, 18, "#ffe070", { align: "center", shadow: "#000000" });
      const cols = 6;
      const w = 112;
      const h = 157;
      const gap = 12;
      BO.cards.forEach((id, i) => {
        const row = Math.floor(i / cols);
        const inRow = row === 0 ? cols : BO.cards.length - cols;
        const x0 = (CW - (inRow * w + (inRow - 1) * gap)) / 2;
        const x = x0 + (i % cols) * (w + gap);
        const y = 76 + row * (h + 22);
        drawMiniCard({ id, qty: ownedQty(id) }, x, y, w, h, false);
        if (BO.isNew[i]) {
          rrect(x + 4, y + h - 8, 64, 20, 6, "#e83838", "#ffffff", 2);
          text("NUEVA", x + 36, y + h - 3, 8, "#ffffff", { align: "center" });
        }
      });
      const nNew = BO.isNew.filter(Boolean).length;
      text(
        `Se agregaron ${BO.cards.length} cartas a tu colección${nNew ? ` (${nNew} nueva${nNew === 1 ? "" : "s"})` : ""}.`,
        CW / 2, 470, 11, "#ffffff", { align: "center", shadow: "#000000" },
      );
      text("El número en cada carta es cuántas copias tenés ahora.", CW / 2, 494, 8, "#c8c0f0", { align: "center" });
      hint(BO.queue.length ? `Z: ver las siguientes (quedan ${BO.queue.reduce((n, q) => n + q.cards.length, 0)})` : "Z: continuar");
      break;
    }
  }

  // partículas y destello
  for (const p of BO.particles) {
    const a = 1 - p.life / p.max;
    ctx.globalAlpha = a;
    drawSparkle(p.x, p.y, p.size * 0.6, p.color);
  }
  ctx.globalAlpha = 1;
  if (BO.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${BO.flash * 0.8})`;
    ctx.fillRect(0, 0, CW, CH);
  }
}
