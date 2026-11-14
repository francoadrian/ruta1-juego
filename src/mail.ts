// =====================================================================
//  Menú → BUZÓN: lo que el operador del backoffice le mandó al jugador
//  (cartas sueltas o sobres). Al abrir un envío, las cartas se suman a la
//  colección en el servidor y se muestran con la animación de los sobres.
// =====================================================================

const MB = { cursor: 0, scroll: 0, busy: false };
const MAIL_ROWS = 6;
const MAIL_LIST = { x: 24, y: 92, w: 470, rowH: 76 };

function mailTitle(m: MailItem): string {
  if (m.kind === "booster") return `Sobre ${boosterById(m.payload.booster ?? "")?.name ?? m.payload.booster ?? ""}`;
  const n = m.payload.cards?.length ?? 0;
  return n === 1 ? `Carta: ${CARDS[m.payload.cards![0]]?.name ?? "?"}` : `${n} cartas`;
}

function mailDate(t: number): string {
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openMailbox(): void {
  menu.screen = "mail";
  MB.cursor = Math.min(MB.cursor, Math.max(0, NET.mail.length - 1));
  void refreshMail();
}

function backToMailbox(): void {
  game.mode = "menu";
  menu.screen = "mail";
  MB.cursor = Math.min(MB.cursor, Math.max(0, NET.mail.length - 1));
}

async function openMailItem(m: MailItem): Promise<void> {
  if (MB.busy) return;
  MB.busy = true;
  try {
    if (m.kind === "booster") {
      const def = boosterById(m.payload.booster ?? "");
      if (!def) return menuToast("Ese sobre ya no existe en el catálogo. Pedile al operador que te mande otro.");
      const cards = generateBooster(def);
      const isNew = newFlags(cards);
      const err = await claimMail(m, cards);
      if (err) return menuToast(err);
      openMailBooster(def, cards, isNew, backToMailbox);
    } else {
      const cards = (m.payload.cards ?? []).filter((id) => CARDS[id]);
      const isNew = newFlags(cards);
      const err = await claimMail(m);
      if (err) return menuToast(err);
      if (!cards.length) return menuToast("El envío no tenía cartas que existan en el juego.");
      revealMailCards(cards, isNew, backToMailbox);
    }
  } finally {
    MB.busy = false;
  }
}

function updateMailbox(up: boolean, down: boolean, a: boolean, b: boolean): void {
  if (MB.busy) return;
  const n = NET.mail.length;
  if (b) {
    menu.screen = "main";
    return;
  }
  if (!n) return;
  if (up) MB.cursor = (MB.cursor + n - 1) % n;
  if (down) MB.cursor = (MB.cursor + 1) % n;
  if (MB.cursor < MB.scroll) MB.scroll = MB.cursor;
  if (MB.cursor >= MB.scroll + MAIL_ROWS) MB.scroll = MB.cursor - MAIL_ROWS + 1;
  if (a) void openMailItem(NET.mail[MB.cursor]);
}

/** Íconito del envío: un sobre o un abanico de cartas. */
function drawMailIcon(m: MailItem, x: number, y: number, h: number): void {
  if (m.kind === "booster") {
    const def = boosterById(m.payload.booster ?? "");
    const w = Math.round(h * (10 / 19));
    const img = loadedImage(def?.front);
    if (img) drawImageCover(img, x, y, w, h, 4);
    else {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, "#c8d0e8");
      g.addColorStop(0.5, "#f8f8ff");
      g.addColorStop(1, "#9098c0");
      rrect(x, y, w, h, 4, g as unknown as string, "#505878", 2);
      ctx.fillStyle = "#e05050";
      ctx.fillRect(x + 3, y + h * 0.42, w - 6, h * 0.14);
    }
    return;
  }
  const w = Math.round(h * CARD_RATIO * 0.86);
  const ch = Math.round(w / CARD_RATIO);
  for (let i = 2; i >= 0; i--) {
    ctx.save();
    ctx.translate(x + w / 2 + i * 6, y + ch / 2 + (h - ch) / 2);
    ctx.rotate((i - 1) * 0.12);
    const id = m.payload.cards?.[i];
    if (i === 0 && id && CARDS[id]) drawMiniFace(CARDS[id], -w / 2, -ch / 2, w, ch);
    else drawCardBack(-w / 2, -ch / 2, w, ch);
    ctx.restore();
  }
}

function renderMailbox(): void {
  const n = NET.mail.length;
  screenBackground("BUZÓN", `ID DE JUGADOR: ${playerId()}`, n ? "Z: ABRIR   X: VOLVER" : "X: VOLVER");
  if (!NET.online) {
    rrect(80, 200, CW - 160, 150, 14, "#f8f8f8", "#404858", 4);
    text("SIN CONEXIÓN", CW / 2, 230, 16, "#c04030", { align: "center" });
    wrapText("El buzón necesita el servidor del juego (python server.py). Así como está, el juego guarda solo en este navegador.", 10, CW - 220)
      .forEach((l, i) => text(l, CW / 2, 270 + i * 18, 10, "#404858", { align: "center" }));
    return;
  }
  if (!n) {
    rrect(80, 200, CW - 160, 150, 14, "#f8f8f8", "#404858", 4);
    text("No hay nada nuevo.", CW / 2, 240, 16, "#404858", { align: "center" });
    text("Acá llegan las cartas y los sobres que te manden.", CW / 2, 282, 10, "#607088", { align: "center" });
    text("Se revisa solo cada 20 segundos.", CW / 2, 304, 9, "#8090a8", { align: "center" });
    return;
  }

  // lista
  const L = MAIL_LIST;
  for (let r = 0; r < MAIL_ROWS; r++) {
    const i = MB.scroll + r;
    const m = NET.mail[i];
    if (!m) break;
    const y = L.y + r * L.rowH;
    const sel = i === MB.cursor;
    rrect(L.x, y, L.w, L.rowH - 8, 10, sel ? "#fff8d8" : "#f8f8f8", sel ? "#e09030" : "#404858", sel ? 4 : 2);
    drawMailIcon(m, L.x + 12, y + 6, L.rowH - 20);
    text(fitText(mailTitle(m), 12, L.w - 120), L.x + 84, y + 14, 12, "#283850");
    text(fitText(`De: ${m.sender || "Backoffice"} · ${mailDate(m.created)}`, 8, L.w - 120), L.x + 84, y + 40, 8, "#607088");
    if (sel) cursorArrow(L.x - 16, y + 24, 14);
  }
  if (MB.scroll > 0) text("▲", L.x + L.w / 2, L.y - 16, 10, "#283850", { align: "center" });
  if (MB.scroll + MAIL_ROWS < n) text("▼", L.x + L.w / 2, L.y + MAIL_ROWS * L.rowH - 4, 10, "#283850", { align: "center" });

  // detalle del seleccionado
  const m = NET.mail[MB.cursor];
  const px0 = 520;
  const pw = CW - px0 - 24;
  rrect(px0, 92, pw, 500, 14, "#f8f8f8", "#404858", 4);
  drawMailIcon(m, px0 + pw / 2 - (m.kind === "booster" ? 55 : 70), 112, 210);
  text(fitText(mailTitle(m).toUpperCase(), 13, pw - 32), px0 + pw / 2, 342, 13, "#283850", { align: "center" });
  text(`${n} envío${n === 1 ? "" : "s"} sin abrir`, px0 + pw / 2, 366, 8, "#8090a8", { align: "center" });
  const msg = m.message?.trim() ? `“${m.message.trim()}”` : m.kind === "booster" ? "¡Abrilo para ver qué cartas trae!" : "Dalas vuelta para ver qué cartas son.";
  wrapText(msg, 10, pw - 40).slice(0, 7).forEach((l, i) => text(l, px0 + 20, 398 + i * 20, 10, "#404858"));
  if (MB.busy) {
    rrect(px0 + 40, 530, pw - 80, 40, 10, "#283850");
    text("ABRIENDO…", px0 + pw / 2, 543, 12, "#ffffff", { align: "center" });
  } else {
    rrect(px0 + 40, 530, pw - 80, 40, 10, "#e05040", "#802010", 3);
    text(m.kind === "booster" ? "Z: ABRIR EL SOBRE" : "Z: VER LAS CARTAS", px0 + pw / 2, 543, 11, "#ffffff", { align: "center" });
  }
}
