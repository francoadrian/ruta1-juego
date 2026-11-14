// =====================================================================
//  Menú (ENTER): MAZO, COLECCIÓN y BUZÓN
// =====================================================================

type MenuScreen = "main" | "decks" | "deck" | "edit" | "collection" | "mail";

const menu = {
  screen: "main" as MenuScreen,
  mainCursor: 0,
  deckCursor: 0, // índice en la lista de mazos (el último es "+ NUEVO MAZO")
  deckScroll: 0,
  listCursor: 0, // índice de carta dentro del mazo
  listScroll: 0, // primera fila visible
  colCursor: 0, // bolsillo seleccionado en la carpeta
  zoom: false, // carta ampliada en Colección
  binderView: loadBinderView(),
  flipStart: -1, // game.time en que empezó a pasar la página (-1: quieta)
  flipDir: 1, // 1: hacia adelante, -1: hacia atrás
  flipFrom: 0, // doble página de la que se viene
};

const MAIN_OPTIONS = [
  { label: "MAZO", desc: "Armá, editá y elegí tu mazo principal." },
  { label: "COLECCIÓN", desc: "Mirá todas las cartas de tu colección." },
  { label: "BUZÓN", desc: "Cartas y sobres que te mandaron." },
  { label: "SALIR", desc: "Cerrar este menú." },
];

const CW = VIEW_W * SCALE; // 960
const CH = VIEW_H * SCALE; // 640
const PIXEL_FONT = '"Press Start 2P", monospace';
const font = (size: number): string => `${size}px ${PIXEL_FONT}`;

function openMenu(): void {
  game.mode = "menu";
  menu.screen = "main";
  menu.zoom = false;
  void refreshMail();
}

function closeMenu(): void {
  game.mode = "explore";
  pressed.clear(); // que el mismo ENTER no reabra el menú en este frame
  actionPressed = false;
}

function menuCoversWorld(): boolean {
  return game.mode === "menu" && menu.screen !== "main";
}

// ---------------------------------------------------------------------
//  Filas de la lista del mazo (encabezados + cartas)
// ---------------------------------------------------------------------
type DeckRow = { header: string } | { entry: DeckEntry; index: number };

function deckRows(deck: Deck): DeckRow[] {
  const rows: DeckRow[] = [];
  const groups: [Card["kind"], string][] = [
    ["pokemon", "POKÉMON"],
    ["trainer", "ENTRENADOR"],
    ["energy", "ENERGÍA"],
  ];
  let index = 0;
  for (const [kind, label] of groups) {
    rows.push({ header: `${label} (${deckCount(deck, kind)})` });
    deck.cards.forEach((entry) => {
      if (CARDS[entry.id].kind === kind) rows.push({ entry, index: index++ });
    });
  }
  return rows;
}

/** Cartas del mazo en el orden en que aparecen en la lista agrupada. */
function deckOrder(deck: Deck): DeckEntry[] {
  return deckRows(deck).flatMap((r) => ("entry" in r ? [r.entry] : []));
}

const LIST = { x: 24, y: 120, w: 452, rowH: 25, rows: 19 };

// ---------------------------------------------------------------------
//  Update
// ---------------------------------------------------------------------
function updateMenu(): void {
  const up = hit(KEYS.up);
  const down = hit(KEYS.down);
  const left = hit(KEYS.left);
  const right = hit(KEYS.right);
  const a = hit(KEYS.a);
  const b = hit(KEYS.b);

  switch (menu.screen) {
    case "main": {
      const n = MAIN_OPTIONS.length;
      if (up) menu.mainCursor = (menu.mainCursor + n - 1) % n;
      if (down) menu.mainCursor = (menu.mainCursor + 1) % n;
      if (b || hit(KEYS.start)) return closeMenu();
      if (a) {
        if (menu.mainCursor === 0) menu.screen = "decks";
        if (menu.mainCursor === 1) {
          menu.screen = "collection";
          menu.zoom = false;
        }
        if (menu.mainCursor === 2) openMailbox();
        if (menu.mainCursor === 3) closeMenu();
      }
      break;
    }
    case "decks":
      return updateDeckList();
    case "edit":
      return updateDeckEditor();
    case "deck": {
      const deck = currentDeck();
      const n = deck.cards.length;
      if (up) menu.listCursor = Math.max(0, menu.listCursor - 1);
      if (down) menu.listCursor = Math.min(n - 1, menu.listCursor + 1);
      if (b) menu.screen = "decks";
      // mantener visible la fila seleccionada
      const rows = deckRows(deck);
      const rowIdx = rows.findIndex((r) => "entry" in r && r.index === menu.listCursor);
      const top = menu.listCursor === 0 ? 0 : rowIdx; // con la 1ª carta mostrar su encabezado
      if (top < menu.listScroll) menu.listScroll = top;
      if (rowIdx >= menu.listScroll + LIST.rows) menu.listScroll = rowIdx - LIST.rows + 1;
      break;
    }
    case "collection":
      return updateBinder(left, right, up, down, a, b);
    case "mail":
      return updateMailbox(up, down, a, b);
  }
}

// ---------------------------------------------------------------------
//  Helpers de dibujo
// ---------------------------------------------------------------------
const TYPE_STYLE: Record<EType, { main: string; light: string; bg: string; dark: string; es: string }> = {
  Fire: { main: "#e8582c", light: "#f8a878", bg: "#fbe6d4", dark: "#8a2a10", es: "Fuego" },
  Grass: { main: "#4aa048", light: "#a0d880", bg: "#e4f2d4", dark: "#25602a", es: "Planta" },
  Water: { main: "#3a80e0", light: "#90c0f8", bg: "#dceaf8", dark: "#1a4888", es: "Agua" },
  Psychic: { main: "#9858c0", light: "#d0a8e8", bg: "#efe0f6", dark: "#552a78", es: "Psíquico" },
  Lightning: { main: "#f0c020", light: "#f8e080", bg: "#fbf3d0", dark: "#806000", es: "Rayo" },
  Fighting: { main: "#c06838", light: "#e8a880", bg: "#f4e0d0", dark: "#683010", es: "Lucha" },
  Colorless: { main: "#b8b8b0", light: "#e8e8e0", bg: "#f2f2ee", dark: "#585858", es: "Incoloro" },
};
const TRAINER_STYLE = { main: "#8890a0", light: "#c8ccd8", bg: "#eef0f4", dark: "#384050" };

const RARITY_ES: Record<Rarity, string> = {
  Common: "Común",
  Uncommon: "Poco común",
  Rare: "Rara",
  "Rare Holo": "Rara holo",
};

function cardStyle(card: Card) {
  return card.kind === "trainer" ? TRAINER_STYLE : TYPE_STYLE[card.type];
}

function cardType(card: Card): EType | undefined {
  return card.kind === "trainer" ? undefined : card.type;
}

function rrect(x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string, lw = 2): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

/** Proporción real de una carta: 2,5" × 3,5" (5:7). */
const CARD_RATIO = 5 / 7;

/** El rectángulo 5:7 más grande que entra en (x, y, w, h), centrado. */
function fitCard(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  if (w / h > CARD_RATIO) {
    const nw = h * CARD_RATIO;
    return { x: x + (w - nw) / 2, y, w: nw, h };
  }
  const nh = w / CARD_RATIO;
  return { x, y: y + (h - nh) / 2, w, h: nh };
}

/** Dibuja una imagen llenando el rectángulo (recorta lo que sobra, sin deformar) con esquinas redondeadas. */
function drawImageCover(img: HTMLImageElement, x: number, y: number, w: number, h: number, r = 0): void {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / s;
  const sh = h / s;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

/** Frente de carta con imagen propia (si tiene); devuelve false si hay que dibujarla a mano. */
function drawCardImage(card: Card, x: number, y: number, w: number, h: number, r: number): boolean {
  const img = cardImage(card);
  if (!img) return false;
  drawImageCover(img, x, y, w, h, r);
  return true;
}

const rarityLabelEs = (c: Card): string => RARITY_ES[c.rarity] + (c.holo ? " holo" : "");

function text(
  str: string, x: number, y: number, size: number, color: string,
  opts: { align?: CanvasTextAlign; shadow?: string; baseline?: CanvasTextBaseline } = {},
): void {
  ctx.font = font(size);
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = opts.baseline ?? "top";
  if (opts.shadow) {
    ctx.fillStyle = opts.shadow;
    ctx.fillText(str, x + Math.max(1, size / 8), y + Math.max(1, size / 8));
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.textAlign = "left";
}

function wrapText(str: string, size: number, maxW: number): string[] {
  ctx.font = font(size);
  const lines: string[] = [];
  let line = "";
  for (const word of str.split(" ")) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Ícono de energía: círculo de color con un símbolo simple dibujado. */
function energyIcon(type: EType, cx: number, cy: number, r: number): void {
  const st = TYPE_STYLE[type];
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = type === "Colorless" ? "#f0f0ea" : st.main;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r / 6);
  ctx.strokeStyle = st.dark;
  ctx.stroke();

  const s = r * 0.62;
  ctx.fillStyle = type === "Colorless" ? "#707070" : "#fff8f0";
  ctx.beginPath();
  switch (type) {
    case "Fire": // llama
      ctx.moveTo(cx, cy - s);
      ctx.quadraticCurveTo(cx + s * 1.1, cy + s * 0.1, cx, cy + s);
      ctx.quadraticCurveTo(cx - s * 1.1, cy + s * 0.1, cx, cy - s);
      ctx.fill();
      ctx.fillStyle = st.main;
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.35, s * 0.32, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "Grass": // hoja
      ctx.ellipse(cx, cy, s * 0.5, s, Math.PI / 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = st.main;
      ctx.lineWidth = Math.max(1, r / 8);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.6, cy + s * 0.6);
      ctx.lineTo(cx + s * 0.6, cy - s * 0.6);
      ctx.stroke();
      break;
    case "Water": // gota
      ctx.moveTo(cx, cy - s);
      ctx.quadraticCurveTo(cx + s, cy + s * 0.2, cx, cy + s);
      ctx.quadraticCurveTo(cx - s, cy + s * 0.2, cx, cy - s);
      ctx.fill();
      break;
    case "Lightning": // rayo
      ctx.fillStyle = st.dark;
      ctx.moveTo(cx + s * 0.25, cy - s);
      ctx.lineTo(cx - s * 0.55, cy + s * 0.15);
      ctx.lineTo(cx - s * 0.05, cy + s * 0.15);
      ctx.lineTo(cx - s * 0.3, cy + s);
      ctx.lineTo(cx + s * 0.55, cy - s * 0.2);
      ctx.lineTo(cx + s * 0.05, cy - s * 0.2);
      ctx.closePath();
      ctx.fill();
      break;
    case "Fighting": // puño
      ctx.roundRect(cx - s * 0.7, cy - s * 0.45, s * 1.4, s * 1.1, s * 0.3);
      ctx.fill();
      ctx.strokeStyle = st.main;
      ctx.lineWidth = Math.max(1, r / 9);
      for (const k of [-0.25, 0.1, 0.45]) {
        ctx.beginPath();
        ctx.moveTo(cx + s * k, cy - s * 0.45);
        ctx.lineTo(cx + s * k, cy);
        ctx.stroke();
      }
      break;
    case "Psychic": // ojo
      ctx.ellipse(cx, cy, s, s * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = st.main;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.35, 0, Math.PI * 2);
      ctx.fill();
      break;
    default: // estrella
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? s * 0.45 : s;
        ctx.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
      }
      ctx.closePath();
      ctx.fill();
  }
}

function rarityMark(r: Rarity, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (r === "Common") ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  else if (r === "Uncommon") {
    ctx.moveTo(x, y - size / 2);
    ctx.lineTo(x + size / 2, y);
    ctx.lineTo(x, y + size / 2);
    ctx.lineTo(x - size / 2, y);
  } else {
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? size * 0.25 : size * 0.6;
      ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
    }
  }
  ctx.closePath();
  ctx.fill();
}

/** Recuadro de "ilustración" (sin arte oficial): degradé del tipo + símbolo grande. */
function artBox(card: Card, x: number, y: number, w: number, h: number): void {
  const st = cardStyle(card);
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, st.light);
  g.addColorStop(1, st.main);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 6;
  for (let i = -h; i < w; i += 18) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
  const type = cardType(card);
  const r = Math.min(w, h) * 0.28;
  if (type) energyIcon(type, x + w / 2, y + h / 2, r);
  else {
    // ícono de entrenador: una tarjeta con signo +
    rrect(x + w / 2 - r * 0.8, y + h / 2 - r, r * 1.6, r * 2, r * 0.2, "#f8f8f8", st.dark, Math.max(2, r / 10));
    ctx.fillStyle = st.dark;
    ctx.fillRect(x + w / 2 - r * 0.45, y + h / 2 - r * 0.12, r * 0.9, r * 0.24);
    ctx.fillRect(x + w / 2 - r * 0.12, y + h / 2 - r * 0.45, r * 0.24, r * 0.9);
  }
  ctx.strokeStyle = "#b89838";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
}

// ---------------------------------------------------------------------
//  Carta en detalle (≈ proporción real 63×88)
// ---------------------------------------------------------------------
const STAGE_ES: Record<PokemonCard["stage"], string> = { Basic: "POKÉMON BÁSICO", "Stage 1": "FASE 1", "Stage 2": "FASE 2" };

function drawCardDetail(card: Card, bx: number, by: number, bw: number, bh: number): void {
  const { x, y, w, h } = fitCard(bx, by, bw, bh);
  if (drawCardImage(card, x, y, w, h, Math.round(w * 0.04))) return;
  const st = cardStyle(card);
  // borde amarillo clásico + marco del tipo
  rrect(x, y, w, h, 16, "#f4d23c", "#a88a18", 3);
  rrect(x + 12, y + 12, w - 24, h - 24, 8, st.bg, st.dark, 2);
  const ix = x + 26;
  const iw = w - 52;
  let cy = y + 22;

  if (card.kind === "pokemon") {
    text(STAGE_ES[card.stage], ix, cy, 9, st.dark);
    if (card.evolvesFrom) text(`Evoluciona de ${card.evolvesFrom}`, ix + iw, cy, 9, st.dark, { align: "right" });
    cy += 16;
    text(card.name, ix, cy, 18, "#202020");
    text(`${card.hp} HP`, ix + iw - 28, cy + 2, 14, "#c02818", { align: "right" });
    energyIcon(card.type, ix + iw - 10, cy + 8, 11);
    cy += 30;
  } else {
    text(card.kind === "trainer" ? "ENTRENADOR" : "ENERGÍA", ix, cy, 9, st.dark);
    cy += 16;
    text(card.name, ix, cy, 18, "#202020");
    cy += 30;
  }

  const artH = card.kind === "energy" ? 230 : 140;
  artBox(card, ix, cy, iw, artH);
  cy += artH + 6;
  text(`${card.set} · ${card.number}/${SET_SIZE} · ${rarityLabelEs(card)}`, x + w / 2, cy, 8, st.dark, {
    align: "center",
  });
  cy += 20;

  if (card.kind === "pokemon") {
    if (card.power) {
      text("PODER POKéMON:", ix, cy, 9, "#c02818");
      text(card.power.name, ix + 132, cy, 11, "#c02818");
      cy += 18;
      for (const line of wrapText(card.power.text, 8, iw)) {
        text(line, ix, cy, 8, "#404040");
        cy += 12;
      }
      cy += 10;
      ctx.fillStyle = st.light;
      ctx.fillRect(ix, cy - 6, iw, 2);
    }
    card.attacks.forEach((atk, i) => {
      if (i > 0) {
        ctx.fillStyle = st.light;
        ctx.fillRect(ix, cy - 6, iw, 2);
      }
      atk.cost.forEach((t, k) => energyIcon(t, ix + 10 + k * 22, cy + 10, 10));
      const nameX = ix + Math.max(1, atk.cost.length) * 22 + 6;
      text(atk.name, nameX, cy + 4, 12, "#202020");
      if (atk.damage) text(atk.damage, ix + iw, cy + 2, 16, "#202020", { align: "right" });
      cy += 26;
      if (atk.text) {
        for (const line of wrapText(atk.text, 9, iw)) {
          text(line, ix, cy, 9, "#404040");
          cy += 14;
        }
      }
      cy += 10;
    });

    // pie: debilidad / resistencia / retiro
    const by = y + h - 76;
    ctx.fillStyle = st.dark;
    ctx.fillRect(ix, by - 8, iw, 2);
    const colW = iw / 3;
    const labels = ["DEBILIDAD", "RESISTENCIA", "RETIRO"];
    labels.forEach((l, i) => text(l, ix + colW * i + colW / 2, by, 7, st.dark, { align: "center" }));
    const iy = by + 26;
    if (card.weakness) {
      energyIcon(card.weakness, ix + colW / 2 - 12, iy, 10);
      text("×2", ix + colW / 2 + 2, iy - 5, 10, "#202020");
    } else text("—", ix + colW / 2, iy - 5, 10, "#202020", { align: "center" });
    if (card.resistance) {
      energyIcon(card.resistance, ix + colW * 1.5 - 12, iy, 10);
      text("-30", ix + colW * 1.5 + 2, iy - 5, 10, "#202020");
    } else text("—", ix + colW * 1.5, iy - 5, 10, "#202020", { align: "center" });
    if (card.retreat === 0) text("—", ix + colW * 2.5, iy - 5, 10, "#202020", { align: "center" });
    for (let k = 0; k < card.retreat; k++) {
      energyIcon("Colorless", ix + colW * 2.5 + (k - (card.retreat - 1) / 2) * 22, iy, 10);
    }
  } else if (card.kind === "trainer") {
    for (const line of wrapText(card.text, 10, iw)) {
      text(line, ix, cy, 10, "#303030");
      cy += 17;
    }
  } else {
    text("Energía básica", x + w / 2, cy + 10, 12, st.dark, { align: "center" });
  }

  rarityMark(card.rarity, x + w - 30, y + h - 26, 10, "#202020");
}

// ---------------------------------------------------------------------
//  Pantallas
// ---------------------------------------------------------------------
function screenBackground(title: string, subtitle: string, hint: string): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, CH);
  g.addColorStop(0, "#78a8d0");
  g.addColorStop(1, "#4870a8");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);
  // patrón de rombos suave
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  for (let yy = 0; yy < CH; yy += 32)
    for (let xx = (yy / 32) % 2 ? 16 : 0; xx < CW; xx += 32) {
      ctx.beginPath();
      ctx.moveTo(xx, yy - 8);
      ctx.lineTo(xx + 8, yy);
      ctx.lineTo(xx, yy + 8);
      ctx.lineTo(xx - 8, yy);
      ctx.fill();
    }
  // barra superior
  ctx.fillStyle = "#283850";
  ctx.fillRect(0, 0, CW, 64);
  ctx.fillStyle = "#f0c040";
  ctx.fillRect(0, 64, CW, 4);
  text(title, 24, 18, 20, "#f8f8f8", { shadow: "#101828" });
  text(subtitle, CW - 24, 26, 10, "#c0d0e8", { align: "right" });
  // barra inferior
  ctx.fillStyle = "rgba(24,32,48,0.85)";
  ctx.fillRect(0, CH - 30, CW, 30);
  text(hint, CW - 16, CH - 21, 10, "#f8f8f8", { align: "right" });
}

function cursorArrow(x: number, y: number, size = 12, color = "#e04030"): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size * 0.8, y + size / 2);
  ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fill();
}

/** Menú principal estilo GBA: caja a la derecha + descripción abajo. */
function renderMainMenu(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const w = 290;
  const rowH = 52;
  const h = MAIN_OPTIONS.length * rowH + 28;
  const x = CW - w - 12;
  const y = 12;
  rrect(x, y, w, h, 14, "#404858");
  rrect(x + 5, y + 5, w - 10, h - 10, 10, "#f8f8f8");
  rrect(x + 11, y + 11, w - 22, h - 22, 7, undefined, "#78b0c8", 3);
  MAIN_OPTIONS.forEach((opt, i) => {
    const ty = y + 26 + i * rowH;
    if (i === menu.mainCursor) cursorArrow(x + 26, ty + 4, 20);
    text(opt.label, x + 58, ty, 22, "#484848", { shadow: "#d0d0c8" });
    if (opt.label === "BUZÓN" && NET.mail.length) {
      const bx = x + 58 + 22 * 5 + 18;
      rrect(bx, ty - 4, 44, 30, 15, "#e04030", "#ffffff", 3);
      text(String(Math.min(99, NET.mail.length)), bx + 22, ty + 3, 14, "#ffffff", { align: "center" });
    }
  });

  // caja de descripción
  const { x: bx, y: by, w: bw, h: bh } = BOX;
  rrect(bx, by, bw, bh, 16, "#404858");
  rrect(bx + 5, by + 5, bw - 10, bh - 10, 12, "#f8f8f8");
  rrect(bx + 14, by + 14, bw - 28, bh - 28, 8, undefined, "#78b0c8", 4);
  const opt = MAIN_OPTIONS[menu.mainCursor];
  const desc = opt.label === "BUZÓN"
    ? NET.online
      ? `${NET.mail.length ? `Tenés ${NET.mail.length} envío${NET.mail.length === 1 ? "" : "s"} sin abrir.` : opt.desc} ID: ${playerId()}`
      : "Sin conexión con el servidor."
    : opt.desc;
  const lines = wrapText(desc, 22, bw - 90);
  lines.forEach((l, i) => text(l, bx + 44, by + 44 + i * 44, 22, "#484848", { shadow: "#d0d0c8" }));
}

function renderDeck(): void {
  const deck = currentDeck();
  screenBackground(
    deck.name.toUpperCase(),
    `${deckCount(deck)} cartas · ${deck.cards.length} distintas`,
    "↑↓: ELEGIR   X: VOLVER",
  );
  const order = deckOrder(deck);
  const rows = deckRows(deck);

  // panel de lista
  const { x, y, w, rowH } = LIST;
  rrect(x - 8, y - 36, w + 16, LIST.rows * rowH + 48, 12, "#f8f8f0", "#283850", 3);
  text("CANT.  CARTA", x + 10, y - 22, 10, "#808080");
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 8, y - 4, w + 16, LIST.rows * rowH + 8);
  ctx.clip();
  rows.slice(menu.listScroll, menu.listScroll + LIST.rows).forEach((row, i) => {
    const ry = y + i * rowH;
    if ("header" in row) {
      ctx.fillStyle = "#d8e0ec";
      ctx.fillRect(x, ry + 2, w, rowH - 4);
      text(row.header, x + 10, ry + 8, 10, "#304060");
      return;
    }
    const card = CARDS[row.entry.id];
    const sel = row.index === menu.listCursor;
    if (sel) rrect(x + 2, ry + 1, w - 4, rowH - 2, 6, "#f8e088");
    if (sel) cursorArrow(x + 6, ry + 6, 12);
    text(`${row.entry.qty}×`, x + 58, ry + 7, 12, "#303030", { align: "right" });
    const t = cardType(card);
    if (t) energyIcon(t, x + 82, ry + rowH / 2, 9);
    else rrect(x + 74, ry + 4, 16, 17, 3, TRAINER_STYLE.light, TRAINER_STYLE.dark, 2);
    text(card.name, x + 102, ry + 7, 12, "#303030");
    text(`${card.number}/${SET_SIZE}`, x + w - 10, ry + 9, 9, "#909090", { align: "right" });
  });
  ctx.restore();
  // indicadores de scroll
  if (menu.listScroll > 0) text("▲", x + w / 2, y - 22, 10, "#e04030", { align: "center" });
  if (menu.listScroll + LIST.rows < rows.length)
    text("▼", x + w / 2, y + LIST.rows * rowH - 2, 10, "#e04030", { align: "center" });

  if (order[menu.listCursor]) drawCardDetail(CARDS[order[menu.listCursor].id], 512, 78, 424, 526);
  else text("Este mazo está vacío.", 724, 300, 12, "#ffffff", { align: "center", shadow: "#101828" });
}

// ---------------------------------------------------------------------
//  Carta chica (resumen de sobre y carpeta)
// ---------------------------------------------------------------------
/** Frente de una carta chica, en proporción 5:7 dentro del rectángulo dado. */
function drawMiniFace(card: Card, bx: number, by: number, bw: number, bh: number): { x: number; y: number; w: number; h: number } {
  const r = fitCard(bx, by, bw, bh);
  const { x, y, w, h } = r;
  const st = cardStyle(card);
  if (!drawCardImage(card, x, y, w, h, Math.max(4, w * 0.06))) {
    rrect(x, y, w, h, Math.max(4, w * 0.07), "#f4d23c", "#a88a18", 2);
    rrect(x + w * 0.05, y + w * 0.05, w * 0.9, h - w * 0.1, 4, st.bg, st.dark, 1.5);
    const fs = w < 105 ? 7 : 9;
    wrapText(card.name, fs, w - 26)
      .slice(0, 2)
      .forEach((l, i) => text(l, x + w * 0.1, y + h * 0.08 + i * (fs + 3), fs, "#202020"));
    artBox(card, x + w * 0.1, y + h * 0.27, w * 0.8, h * 0.47);
    const ns = w < 105 ? 6 : 8;
    text(`${card.number}/${SET_SIZE}`, x + w * 0.1, y + h - h * 0.15, ns, st.dark);
    if (card.kind === "pokemon") text(`${card.hp}HP`, x + w * 0.9, y + h - h * 0.15, ns, "#c02818", { align: "right" });
  }
  return r;
}

function drawMiniCard(entry: DeckEntry, bx: number, by: number, bw: number, bh: number, sel: boolean): void {
  const { x, y, w, h } = drawMiniFace(CARDS[entry.id], bx, by, bw, bh);
  // cantidad
  ctx.beginPath();
  ctx.arc(x + w - 8, y + 8, 17, 0, Math.PI * 2);
  ctx.fillStyle = "#283850";
  ctx.fill();
  ctx.strokeStyle = "#f8f8f8";
  ctx.lineWidth = 2;
  ctx.stroke();
  text(`×${entry.qty}`, x + w - 8, y + 4, 9, "#f8f8f8", { align: "center" });

  if (sel) {
    const pulse = Math.floor(game.time * 4) % 2 === 0;
    rrect(x - 5, y - 5, w + 10, h + 10, 13, undefined, pulse ? "#ff4030" : "#ffa030", 5);
  }
}

// ---------------------------------------------------------------------
//  Colección: carpeta con folios de 9 bolsillos
// ---------------------------------------------------------------------
type BinderView = "number" | "type" | "rarity";
const BINDER_VIEWS: { id: BinderView; label: string }[] = [
  { id: "number", label: "NUMERADA" },
  { id: "type", label: "POR TIPO" },
  { id: "rarity", label: "POR RAREZA" },
];
const BINDER_VIEW_KEY = "tcglocal.binderView.v1";

function loadBinderView(): BinderView {
  try {
    // (literal: se llama al crear `menu`, antes de que exista BINDER_VIEW_KEY)
    const v = localStorage.getItem("tcglocal.binderView.v1");
    if (v === "number" || v === "type" || v === "rarity") return v;
  } catch {}
  return "number";
}

/** Un bolsillo de la carpeta: qty 0 = la carta todavía no se consiguió (bolsillo vacío). */
type BinderSlot = { id: string; qty: number };

const TYPE_ORDER: EType[] = ["Grass", "Fire", "Water", "Lightning", "Psychic", "Fighting", "Colorless"];
const kindRank = (c: Card): number => (c.kind === "pokemon" ? 0 : c.kind === "trainer" ? 1 : 2);
const rarityRank = (c: Card): number =>
  isBasicEnergy(c) ? 4 : c.holo ? 0 : c.rarity === "Rare" || c.rarity === "Rare Holo" ? 1 : c.rarity === "Uncommon" ? 2 : 3;
const byCardNumber = (a: Card, b: Card): number => a.number - b.number || a.name.localeCompare(b.name);

/** Bolsillos de la carpeta según la vista elegida. */
function binderSlots(): BinderSlot[] {
  const owned = new Map(COLLECTION.map((e) => [e.id, e.qty]));
  if (menu.binderView === "number") {
    // un bolsillo por cada carta del juego, en orden de número: los que faltan quedan vacíos
    return Object.values(CARDS)
      .filter((c) => isPlayable(c.id))
      .sort(byCardNumber)
      .map((c) => ({ id: c.id, qty: owned.get(c.id) ?? 0 }));
  }
  const cmp =
    menu.binderView === "type"
      ? (a: Card, b: Card) =>
          kindRank(a) - kindRank(b) ||
          (a.kind === "trainer" || b.kind === "trainer" ? 0 : TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) ||
          byCardNumber(a, b)
      : (a: Card, b: Card) => rarityRank(a) - rarityRank(b) || byCardNumber(a, b);
  return COLLECTION.map((e) => ({ id: e.id, qty: e.qty })).sort((a, b) => cmp(CARDS[a.id], CARDS[b.id]));
}

/** Medidas de la carpeta abierta (dos folios de 3×3). */
const BINDER = (() => {
  const card = { w: 100, h: 140 };
  const pocket = { w: card.w + 12, h: card.h + 12, gap: 6 };
  const pad = 12;
  const page = { w: pocket.w * 3 + pocket.gap * 2 + pad * 2, h: pocket.h * 3 + pocket.gap * 2 + pad * 2 };
  const spine = 18;
  const cover = 10;
  const w = cover * 2 + page.w * 2 + spine;
  const h = cover * 2 + page.h;
  const x = Math.round((CW - w) / 2);
  const y = 68 + Math.round((CH - 30 - 68 - h) / 2);
  return { card, pocket, pad, page, spine, cover, w, h, x, y, leftX: x + cover, rightX: x + cover + page.w + spine, pageY: y + cover };
})();
const PER_PAGE = 9;
const PER_SPREAD = PER_PAGE * 2;
const FLIP_TIME = 0.5;

const spreadOf = (i: number): number => Math.floor(i / PER_SPREAD);

/** Columna (0..5, contando los dos folios) y fila (0..2) de un bolsillo dentro de su doble página. */
function binderPos(i: number): { spread: number; col: number; row: number } {
  const local = i % PER_SPREAD;
  const page = Math.floor(local / PER_PAGE);
  const k = local % PER_PAGE;
  return { spread: spreadOf(i), col: page * 3 + (k % 3), row: Math.floor(k / 3) };
}
const binderIndex = (spread: number, col: number, row: number): number =>
  spread * PER_SPREAD + Math.floor(col / 3) * PER_PAGE + row * 3 + (col % 3);

function startFlip(from: number, to: number): void {
  if (from === to) return;
  menu.flipFrom = from;
  menu.flipDir = to > from ? 1 : -1;
  menu.flipStart = game.time;
}

function moveBinderCursor(to: number, n: number): void {
  const from = menu.colCursor;
  menu.colCursor = Math.max(0, Math.min(n - 1, to));
  startFlip(spreadOf(from), spreadOf(menu.colCursor));
}

function updateBinder(left: boolean, right: boolean, up: boolean, down: boolean, a: boolean, b: boolean): void {
  const slots = binderSlots();
  const n = slots.length;
  if (menu.zoom) {
    // izquierda/derecha recorre solo las cartas que se tienen
    const step = left ? -1 : right ? 1 : 0;
    if (step) {
      for (let k = 1; k <= n; k++) {
        const i = (((menu.colCursor + step * k) % n) + n) % n;
        if (slots[i].qty > 0) {
          moveBinderCursor(i, n);
          break;
        }
      }
    }
    if (a || b) menu.zoom = false;
    return;
  }
  if (b) {
    menu.screen = "main";
    return;
  }
  if (hit(KEYS.view)) {
    // cambiar de vista, tratando de quedarse en la misma carta
    const cur = slots[menu.colCursor]?.id;
    const idx = BINDER_VIEWS.findIndex((v) => v.id === menu.binderView);
    menu.binderView = BINDER_VIEWS[(idx + 1) % BINDER_VIEWS.length].id;
    try {
      localStorage.setItem(BINDER_VIEW_KEY, menu.binderView);
    } catch {}
    const next = binderSlots();
    menu.colCursor = Math.max(0, next.findIndex((s) => s.id === cur && s.qty > 0));
    menu.flipStart = -1;
    return;
  }
  if (!n) return;
  const { spread, col, row } = binderPos(menu.colCursor);
  const spreads = Math.ceil(n / PER_SPREAD);
  if (hit(["KeyQ", "PageUp"]) && spread > 0) return moveBinderCursor(binderIndex(spread - 1, col, row), n);
  if (hit(["KeyE", "PageDown"]) && spread < spreads - 1) return moveBinderCursor(binderIndex(spread + 1, col, row), n);
  if (left) {
    if (col > 0) moveBinderCursor(binderIndex(spread, col - 1, row), n);
    else if (spread > 0) moveBinderCursor(binderIndex(spread - 1, 5, row), n);
  }
  if (right) {
    if (col < 5 && binderIndex(spread, col + 1, row) < n) moveBinderCursor(binderIndex(spread, col + 1, row), n);
    else if (spread < spreads - 1) moveBinderCursor(binderIndex(spread + 1, 0, row), n);
  }
  if (up && row > 0) moveBinderCursor(binderIndex(spread, col, row - 1), n);
  if (down && row < 2 && binderIndex(spread, col, row + 1) < n) moveBinderCursor(binderIndex(spread, col, row + 1), n);
  if (a && slots[menu.colCursor]?.qty > 0) menu.zoom = true;
}

/** Brillo del plástico del folio sobre un bolsillo (filtro muy suave). */
function sleeveGloss(x: number, y: number, w: number, h: number, seed: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // velo apenas lechoso
  ctx.fillStyle = "rgba(236,242,250,0.07)";
  ctx.fillRect(x, y, w, h);
  // reflejo diagonal ancho y suave + uno fino
  const off = ((seed * 37) % 23) / 23;
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.18 + off * 0.2, "rgba(255,255,255,0.10)");
  g.addColorStop(0.32 + off * 0.2, "rgba(255,255,255,0)");
  g.addColorStop(0.6, "rgba(255,255,255,0)");
  g.addColorStop(0.64, "rgba(255,255,255,0.07)");
  g.addColorStop(0.67, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  // boca del bolsillo (arriba) y bordes soldados
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(x + 3, y + 4, w - 6, 1.5);
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** Un folio (página) de la carpeta: fondo de plástico, bolsillos y cartas. */
function drawBinderPage(slots: BinderSlot[], spread: number, page: number, px: number, highlight: number): void {
  const { pocket, pad, card } = BINDER;
  const py = BINDER.pageY;
  const pw = BINDER.page.w;
  const ph = BINDER.page.h;
  // hoja de plástico gris translúcido
  const g = ctx.createLinearGradient(px, py, px + pw, py + ph);
  g.addColorStop(0, "#d9dce2");
  g.addColorStop(1, "#c3c7ce");
  rrect(px, py, pw, ph, 6, undefined);
  ctx.fillStyle = g;
  ctx.fill();
  // sombra hacia el lomo
  const sx = page === 0 ? px + pw : px;
  const sg = ctx.createLinearGradient(sx, 0, page === 0 ? sx - 40 : sx + 40, 0);
  sg.addColorStop(0, "rgba(0,0,0,0.28)");
  sg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = sg;
  ctx.fillRect(page === 0 ? px + pw - 40 : px, py, 40, ph);
  // agujeros de los anillos del lado del lomo
  for (const fy of [0.18, 0.5, 0.82]) {
    ctx.beginPath();
    ctx.arc(page === 0 ? px + pw - 6 : px + 6, py + ph * fy, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#3a3d44";
    ctx.fill();
  }

  for (let k = 0; k < PER_PAGE; k++) {
    const i = spread * PER_SPREAD + page * PER_PAGE + k;
    const x = px + pad + (k % 3) * (pocket.w + pocket.gap);
    const y = py + pad + Math.floor(k / 3) * (pocket.h + pocket.gap);
    // bolsillo
    ctx.fillStyle = "rgba(150,156,166,0.35)";
    ctx.fillRect(x, y, pocket.w, pocket.h);
    const slot = slots[i];
    const cx = x + (pocket.w - card.w) / 2;
    const cy = y + pocket.h - card.h - 4;
    if (slot && slot.qty > 0) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.25)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      rrect(cx, cy, card.w, card.h, 6, "#1a1a1a");
      ctx.restore();
      drawMiniFace(CARDS[slot.id], cx, cy, card.w, card.h);
      if (slot.qty > 1) {
        rrect(cx + card.w - 30, cy + card.h - 20, 28, 16, 5, "rgba(24,32,56,0.88)", "#f8f8f8", 1.5);
        text(`×${slot.qty}`, cx + card.w - 16, cy + card.h - 16, 7, "#f8f8f8", { align: "center" });
      }
    } else if (slot) {
      // lugar reservado para una carta que todavía no se consiguió
      rrect(cx, cy, card.w, card.h, 6, "rgba(255,255,255,0.10)", "rgba(110,116,128,0.45)", 1.5);
      text(`Nº ${CARDS[slot.id].number}`, cx + card.w / 2, cy + card.h / 2 - 6, 9, "rgba(90,96,108,0.75)", { align: "center" });
    }
    if (slot) sleeveGloss(x, y, pocket.w, pocket.h, i);
    if (i === highlight) {
      const pulse = 0.5 + 0.5 * Math.sin(game.time * 7);
      rrect(x - 3, y - 3, pocket.w + 6, pocket.h + 6, 6, undefined, `rgba(255,${Math.round(70 + 110 * pulse)},40,1)`, 4);
    }
  }
}

/** Dibuja un folio comprimido horizontalmente contra el lomo (la hoja que gira). */
function drawTurningPage(slots: BinderSlot[], spread: number, page: number, scale: number): void {
  const spineX = BINDER.leftX + BINDER.page.w + BINDER.spine / 2;
  const px = page === 0 ? BINDER.leftX : BINDER.rightX;
  ctx.save();
  ctx.translate(spineX, 0);
  ctx.scale(Math.max(0.01, scale), 1);
  ctx.translate(-spineX, 0);
  drawBinderPage(slots, spread, page, px, -1);
  // se oscurece a medida que queda de canto
  ctx.fillStyle = `rgba(0,0,0,${0.35 * (1 - scale)})`;
  ctx.fillRect(px, BINDER.pageY, BINDER.page.w, BINDER.page.h);
  ctx.restore();
}

function renderCollection(): void {
  const slots = binderSlots();
  const n = slots.length;
  menu.colCursor = Math.max(0, Math.min(n - 1, menu.colCursor));
  const spreads = Math.max(1, Math.ceil(n / PER_SPREAD));
  const spread = spreadOf(menu.colCursor);
  const total = COLLECTION.reduce((k, e) => k + e.qty, 0);
  const view = BINDER_VIEWS.find((v) => v.id === menu.binderView)!;
  const owned = slots.filter((s) => s.qty > 0).length;
  screenBackground(
    "COLECCIÓN",
    menu.binderView === "number" ? `${owned}/${n} cartas · ${total} en total` : `${COLLECTION.length} distintas · ${total} cartas`,
    menu.zoom ? "IZQ/DER: OTRA CARTA   X: CERRAR" : "FLECHAS: MOVER  Q/E: PÁGINA  Z: VER  C: VISTA  X: VOLVER",
  );
  text(`VISTA: ${view.label}`, 16, CH - 21, 10, "#f8e060");

  // tapa de la carpeta
  const B = BINDER;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  rrect(B.x, B.y, B.w, B.h, 14, "#1b1c21");
  ctx.restore();
  rrect(B.x + 3, B.y + 3, B.w - 6, B.h - 6, 12, undefined, "#2c2e35", 2);
  // lomo
  const spineX = B.leftX + B.page.w;
  const sg = ctx.createLinearGradient(spineX, 0, spineX + B.spine, 0);
  sg.addColorStop(0, "#0b0c0f");
  sg.addColorStop(0.5, "#24262c");
  sg.addColorStop(1, "#0b0c0f");
  ctx.fillStyle = sg;
  ctx.fillRect(spineX, B.y + 4, B.spine, B.h - 8);

  if (!n) {
    drawBinderPage(slots, 0, 0, B.leftX, -1);
    drawBinderPage(slots, 0, 1, B.rightX, -1);
    text("Todavía no tenés cartas.", CW / 2, B.y + B.h / 2, 12, "#303030", { align: "center" });
    return;
  }

  const t = menu.flipStart < 0 ? 1 : (game.time - menu.flipStart) / FLIP_TIME;
  const sel = menu.zoom ? -1 : menu.colCursor;
  if (t >= 1) {
    menu.flipStart = -1;
    drawBinderPage(slots, spread, 0, B.leftX, sel);
    drawBinderPage(slots, spread, 1, B.rightX, sel);
  } else {
    // pasar página: la hoja gira sobre el lomo
    const from = menu.flipFrom;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const fwd = menu.flipDir > 0;
    // debajo, lo que queda quieto de cada lado
    drawBinderPage(slots, fwd ? from : spread, 0, B.leftX, -1);
    drawBinderPage(slots, fwd ? spread : from, 1, B.rightX, -1);
    if (fwd) {
      if (e < 0.5) drawTurningPage(slots, from, 1, 1 - e * 2);
      else drawTurningPage(slots, spread, 0, e * 2 - 1);
    } else if (e < 0.5) drawTurningPage(slots, from, 0, 1 - e * 2);
    else drawTurningPage(slots, spread, 1, e * 2 - 1);
  }

  text(`PÁGS. ${spread * 2 + 1}-${spread * 2 + 2} DE ${spreads * 2}`, CW - 16, 46, 8, "#c0d0e8", { align: "right" });

  if (menu.zoom) {
    ctx.fillStyle = "rgba(10,16,30,0.78)";
    ctx.fillRect(0, 68, CW, CH - 98);
    const slot = slots[menu.colCursor];
    const c = CARDS[slot.id];
    drawCardDetail(c, CW / 2 - 200, 78, 400, 526);
    text(`Tenés ×${slot.qty}`, CW / 2 + 210, 300, 14, "#f8f8f8", { shadow: "#000000" });
    text(`Nº ${c.number}/${SET_SIZE}`, CW / 2 + 210, 330, 10, "#c0d0e8");
  }
}

function renderMenu(): void {
  switch (menu.screen) {
    case "main": return renderMainMenu();
    case "decks": return renderDeckList();
    case "deck": return renderDeck();
    case "edit": return renderDeckEditor();
    case "collection": return renderCollection();
    case "mail":
      renderMailbox();
      return drawMenuToast();
  }
}
