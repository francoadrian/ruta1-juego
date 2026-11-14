// =====================================================================
//  ABM de mazos: lista, ver, crear, editar, renombrar, duplicar, borrar
//  y elegir el mazo principal. Un mazo es una configuración de cartas
//  de la colección: la misma carta puede estar en varios mazos.
// =====================================================================

type DeckPopup = null | "options" | "delete" | "rename" | "save";

const DM = {
  popup: null as DeckPopup,
  optCursor: 0,
  confirmCursor: 0,
  editing: null as Deck | null, // copia de trabajo del editor
  isNew: false,
  editCursor: 0,
  editScroll: 0,
  renameText: "",
  toast: "",
  toastUntil: 0,
};

const DECK_OPTIONS = ["VER", "EDITAR", "RENOMBRAR", "HACER PRINCIPAL", "DUPLICAR", "BORRAR", "CANCELAR"];
const SAVE_OPTIONS = ["GUARDAR", "DESCARTAR CAMBIOS", "SEGUIR EDITANDO"];
const DELETE_OPTIONS = ["NO", "SÍ, BORRAR"];
const DECK_ROWS_VISIBLE = 5;
const KIND_ORDER: Card["kind"][] = ["pokemon", "trainer", "energy"];

function currentDeck(): Deck {
  return playerDecks.decks[menu.deckCursor] ?? playerDecks.decks[0];
}

function menuToast(msg: string): void {
  DM.toast = msg;
  DM.toastUntil = game.time + 2.6;
}

const isMain = (d: Deck): boolean => d.id === playerDecks.mainId;

function sortDeckCards(cards: DeckEntry[]): void {
  cards.sort(
    (a, b) =>
      KIND_ORDER.indexOf(CARDS[a.id].kind) - KIND_ORDER.indexOf(CARDS[b.id].kind) || CARDS[a.id].number - CARDS[b.id].number,
  );
}

function uniqueName(base: string): string {
  const names = new Set(playerDecks.decks.map((d) => d.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const n = base.slice(0, DECK_NAME_MAX - suffix.length) + suffix;
    if (!names.has(n)) return n;
  }
}

// ---------------------------------------------------------------------
//  Lista de mazos
// ---------------------------------------------------------------------
function updateDeckList(): void {
  const decks = playerDecks.decks;
  if (DM.popup === "rename") return updateRename();

  const up = hit(KEYS.up);
  const down = hit(KEYS.down);
  const a = hit(KEYS.a);
  const b = hit(KEYS.b);

  if (DM.popup === "options") {
    const n = DECK_OPTIONS.length;
    if (up) DM.optCursor = (DM.optCursor + n - 1) % n;
    if (down) DM.optCursor = (DM.optCursor + 1) % n;
    if (b) DM.popup = null;
    else if (a) runDeckOption(DECK_OPTIONS[DM.optCursor]);
    return;
  }
  if (DM.popup === "delete") {
    if (up || down) DM.confirmCursor = 1 - DM.confirmCursor;
    if (b) DM.popup = null;
    else if (a) {
      DM.popup = null;
      if (DM.confirmCursor === 1) deleteDeck();
    }
    return;
  }

  const n = decks.length + 1; // + "NUEVO MAZO"
  if (up) menu.deckCursor = (menu.deckCursor + n - 1) % n;
  if (down) menu.deckCursor = (menu.deckCursor + 1) % n;
  if (menu.deckCursor < menu.deckScroll) menu.deckScroll = menu.deckCursor;
  if (menu.deckCursor >= menu.deckScroll + DECK_ROWS_VISIBLE) menu.deckScroll = menu.deckCursor - DECK_ROWS_VISIBLE + 1;
  if (b) menu.screen = "main";
  else if (a) {
    if (menu.deckCursor === decks.length) openEditor(null);
    else {
      DM.popup = "options";
      DM.optCursor = 0;
    }
  }
}

function runDeckOption(opt: string): void {
  const deck = currentDeck();
  DM.popup = null;
  switch (opt) {
    case "VER":
      menu.screen = "deck";
      menu.listCursor = 0;
      menu.listScroll = 0;
      break;
    case "EDITAR":
      openEditor(deck);
      break;
    case "RENOMBRAR":
      DM.renameText = deck.name;
      DM.popup = "rename";
      break;
    case "HACER PRINCIPAL": {
      if (isMain(deck)) return menuToast(`${deck.name} ya es tu mazo principal.`);
      const problems = deckProblems(deck);
      if (problems.length) return menuToast(`No se puede: ${problems[0]}`);
      playerDecks.mainId = deck.id!;
      savePlayerDecks();
      menuToast(`${deck.name} ahora es tu mazo principal.`);
      break;
    }
    case "DUPLICAR": {
      const copy: Deck = {
        id: `d${playerDecks.nextId++}`,
        name: uniqueName(deck.name),
        cards: deck.cards.map((e) => ({ ...e })),
      };
      playerDecks.decks.push(copy);
      savePlayerDecks();
      menu.deckCursor = playerDecks.decks.length - 1;
      menuToast(`Se creó ${copy.name}.`);
      break;
    }
    case "BORRAR":
      if (isMain(deck)) return menuToast("No podés borrar el mazo principal. Elegí otro como principal primero.");
      DM.popup = "delete";
      DM.confirmCursor = 0;
      break;
  }
}

function deleteDeck(): void {
  const deck = currentDeck();
  playerDecks.decks.splice(playerDecks.decks.indexOf(deck), 1);
  savePlayerDecks();
  menu.deckCursor = Math.min(menu.deckCursor, playerDecks.decks.length - 1);
  menuToast(`Se borró ${deck.name}.`);
}

// ---------------------------------------------------------------------
//  Renombrar (se escribe con el teclado)
// ---------------------------------------------------------------------
function updateRename(): void {
  for (const ch of typed) {
    if (DM.renameText.length < DECK_NAME_MAX && /^[\p{L}\p{N} '!¡?¿.\-]$/u.test(ch)) DM.renameText += ch;
  }
  if (pressed.has("Backspace")) DM.renameText = DM.renameText.slice(0, -1);
  if (pressed.has("Escape")) DM.popup = null;
  else if (pressed.has("Enter")) {
    const name = DM.renameText.trim();
    if (!name) return menuToast("El nombre no puede estar vacío.");
    if (playerDecks.decks.some((d) => d !== currentDeck() && d.name.toLowerCase() === name.toLowerCase())) {
      return menuToast("Ya tenés un mazo con ese nombre.");
    }
    currentDeck().name = name;
    savePlayerDecks();
    DM.popup = null;
    menuToast(`Mazo renombrado a ${name}.`);
  }
}

// ---------------------------------------------------------------------
//  Editor
// ---------------------------------------------------------------------
type EditRow = { header: string } | { id: string; index: number };

function editRows(): EditRow[] {
  const rows: EditRow[] = [];
  const labels: Record<Card["kind"], string> = { pokemon: "POKÉMON", trainer: "ENTRENADOR", energy: "ENERGÍA" };
  let index = 0;
  for (const kind of KIND_ORDER) {
    const entries = COLLECTION.filter((e) => CARDS[e.id].kind === kind);
    if (!entries.length) continue;
    rows.push({ header: `${labels[kind]} (${deckCount(DM.editing!, kind)})` });
    for (const e of entries) rows.push({ id: e.id, index: index++ });
  }
  return rows;
}

function editIds(): string[] {
  return editRows().flatMap((r) => ("id" in r ? [r.id] : []));
}

function openEditor(deck: Deck | null): void {
  DM.isNew = !deck;
  DM.editing = deck
    ? { id: deck.id, name: deck.name, cards: deck.cards.map((e) => ({ ...e })) }
    : { id: `d${playerDecks.nextId}`, name: uniqueName("Mazo nuevo"), cards: [] };
  DM.editCursor = 0;
  DM.editScroll = 0;
  DM.popup = null;
  menu.screen = "edit";
}

function addCard(id: string): void {
  const d = DM.editing!;
  const card = CARDS[id];
  if (deckCount(d) >= DECK_SIZE) return menuToast(`El mazo ya tiene ${DECK_SIZE} cartas.`);
  if (qtyInDeck(d, id) >= ownedQty(id)) return menuToast(`Solo tenés ${ownedQty(id)} ${card.name} en tu colección.`);
  if (!isBasicEnergy(card) && copiesByName(d, card.name) >= MAX_COPIES) {
    return menuToast(`Máximo ${MAX_COPIES} copias de ${card.name} por mazo.`);
  }
  const e = d.cards.find((x) => x.id === id);
  if (e) e.qty++;
  else {
    d.cards.push({ id, qty: 1 });
    sortDeckCards(d.cards);
  }
}

function removeCard(id: string): void {
  const d = DM.editing!;
  const e = d.cards.find((x) => x.id === id);
  if (!e) return;
  e.qty--;
  if (e.qty <= 0) d.cards.splice(d.cards.indexOf(e), 1);
}

function saveEditor(): void {
  const d = DM.editing!;
  const problems = deckProblems(d);
  if (d.id === playerDecks.mainId && problems.length) {
    return menuToast(`Tu mazo principal tiene que estar completo: ${problems[0]}`);
  }
  if (DM.isNew) {
    playerDecks.decks.push(d);
    playerDecks.nextId++;
    menu.deckCursor = playerDecks.decks.length - 1;
  } else {
    const target = playerDecks.decks.find((x) => x.id === d.id)!;
    target.cards = d.cards;
  }
  savePlayerDecks();
  DM.editing = null;
  menu.screen = "decks";
  menuToast(problems.length ? `Guardado, pero incompleto: ${problems[0]}` : "Mazo guardado.");
}

function updateDeckEditor(): void {
  const up = hit(KEYS.up);
  const down = hit(KEYS.down);
  const a = hit(KEYS.a);
  const b = hit(KEYS.b);

  if (DM.popup === "save") {
    const n = SAVE_OPTIONS.length;
    if (up) DM.optCursor = (DM.optCursor + n - 1) % n;
    if (down) DM.optCursor = (DM.optCursor + 1) % n;
    if (b) DM.popup = null;
    else if (a) {
      DM.popup = null;
      const opt = SAVE_OPTIONS[DM.optCursor];
      if (opt === "GUARDAR") saveEditor();
      if (opt === "DESCARTAR CAMBIOS") {
        DM.editing = null;
        menu.screen = "decks";
      }
    }
    return;
  }

  const ids = editIds();
  if (up) DM.editCursor = Math.max(0, DM.editCursor - 1);
  if (down) DM.editCursor = Math.min(ids.length - 1, DM.editCursor + 1);
  const id = ids[DM.editCursor];
  if (hit(KEYS.right) || a) addCard(id);
  if (hit(KEYS.left)) removeCard(id);
  if (b) {
    DM.popup = "save";
    DM.optCursor = 0;
  }

  const rows = editRows();
  const rowIdx = rows.findIndex((r) => "id" in r && r.index === DM.editCursor);
  const top = DM.editCursor === 0 ? 0 : rowIdx;
  if (top < DM.editScroll) DM.editScroll = top;
  if (rowIdx >= DM.editScroll + LIST.rows) DM.editScroll = rowIdx - LIST.rows + 1;
}

// ---------------------------------------------------------------------
//  Dibujo
// ---------------------------------------------------------------------
function deckTypes(deck: Deck): EType[] {
  const count = new Map<EType, number>();
  for (const e of deck.cards) {
    const c = CARDS[e.id];
    if (c.kind === "pokemon") count.set(c.type, (count.get(c.type) ?? 0) + e.qty);
  }
  const types = [...count].sort((x, y) => y[1] - x[1]).map(([t]) => t);
  return types.length ? types : ["Colorless"];
}

function deckBoxIcon(deck: Deck, x: number, y: number, s: number): void {
  const types = deckTypes(deck);
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, TYPE_STYLE[types[0]].main);
  g.addColorStop(1, TYPE_STYLE[types[1] ?? types[0]].main);
  rrect(x, y, s, s, 8);
  ctx.fillStyle = g;
  ctx.fill();
  energyIcon(types[0], x + s * 0.36, y + s * 0.38, s * 0.2);
  if (types[1]) energyIcon(types[1], x + s * 0.64, y + s * 0.64, s * 0.2);
}

function drawPopup(title: string, options: string[], cursor: number, w = 360): void {
  const h = 60 + options.length * 34;
  const x = CW / 2 - w / 2;
  const y = CH / 2 - h / 2;
  ctx.fillStyle = "rgba(10,16,30,0.55)";
  ctx.fillRect(0, 0, CW, CH);
  rrect(x, y, w, h, 14, "#404858");
  rrect(x + 5, y + 5, w - 10, h - 10, 10, "#f8f8f8");
  text(fitText(title, 11, w - 40), x + 22, y + 20, 11, "#283850");
  options.forEach((o, i) => {
    const oy = y + 48 + i * 34;
    if (i === cursor) cursorArrow(x + 22, oy + 2, 14);
    const danger = o.startsWith("BORRAR") || o.startsWith("SÍ");
    text(o, x + 46, oy + 2, 13, danger ? "#c03020" : "#404040", { shadow: "#d8d8d0" });
  });
}

function drawMenuToast(): void {
  if (game.time > DM.toastUntil) return;
  const lines = wrapText(DM.toast, 11, 640);
  const h = 22 + lines.length * 18;
  const y = CH - 44 - h;
  rrect(CW / 2 - 350, y, 700, h, 10, "rgba(40,24,24,0.94)", "#f08060", 3);
  lines.forEach((l, i) => text(l, CW / 2, y + 13 + i * 18, 11, "#ffffff", { align: "center" }));
}

function renderDeckList(): void {
  const decks = playerDecks.decks;
  const main = mainDeck();
  screenBackground("MAZOS", `${decks.length} mazo${decks.length === 1 ? "" : "s"} · principal: ${main.name}`, "Z: ELEGIR   X: VOLVER");
  const x = 70;
  const w = CW - 140;
  const h = 84;
  const items = decks.length + 1;
  for (let k = 0; k < DECK_ROWS_VISIBLE; k++) {
    const i = menu.deckScroll + k;
    if (i >= items) break;
    const y = 84 + k * 94;
    const sel = i === menu.deckCursor;
    if (sel) cursorArrow(x - 34, y + h / 2 - 12, 24);
    if (i === decks.length) {
      rrect(x, y, w, h, 14, "rgba(248,248,240,0.55)", sel ? "#e04030" : "#f8f8f0", sel ? 5 : 2);
      text("+ NUEVO MAZO", x + w / 2, y + 32, 18, "#283850", { align: "center" });
      continue;
    }
    const deck = decks[i];
    rrect(x, y, w, h, 14, "#f8f8f0", sel ? "#e04030" : "#283850", sel ? 5 : 3);
    deckBoxIcon(deck, x + 14, y + 12, 60);
    text(deck.name.toUpperCase(), x + 92, y + 16, 18, "#303030", { shadow: "#d8d8d0" });
    if (isMain(deck)) {
      rrect(x + w - 168, y + 12, 150, 26, 8, "#f0c040", "#a88a18", 2);
      rarityMark("Rare", x + w - 150, y + 25, 14, "#4a3a08");
      text("PRINCIPAL", x + w - 86, y + 19, 10, "#4a3a08", { align: "center" });
    }
    const problems = deckProblems(deck);
    const n = deckCount(deck);
    const parts = `${n}/${DECK_SIZE} cartas · Pokémon ${deckCount(deck, "pokemon")} · Entren. ${deckCount(deck, "trainer")} · Energía ${deckCount(deck, "energy")}`;
    text(parts, x + 92, y + 44, 9, "#505050");
    text(
      problems.length ? `INCOMPLETO: ${problems[0]}` : `LISTO · ${deckInfo(deck)}`,
      x + 92, y + 62, 9, problems.length ? "#c03020" : "#2a7a3a",
    );
  }
  if (menu.deckScroll > 0) text("▲", CW / 2, 72, 10, "#f8e060", { align: "center" });
  if (menu.deckScroll + DECK_ROWS_VISIBLE < items) text("▼", CW / 2, CH - 46, 10, "#f8e060", { align: "center" });

  const deck = currentDeck();
  if (DM.popup === "options") drawPopup(deck.name.toUpperCase(), DECK_OPTIONS, DM.optCursor);
  if (DM.popup === "delete") drawPopup(`¿Borrar ${deck.name}?`, DELETE_OPTIONS, DM.confirmCursor);
  if (DM.popup === "rename") drawRename();
  drawMenuToast();
}

function drawRename(): void {
  ctx.fillStyle = "rgba(10,16,30,0.6)";
  ctx.fillRect(0, 0, CW, CH);
  const w = 560;
  const h = 210;
  const x = CW / 2 - w / 2;
  const y = CH / 2 - h / 2;
  rrect(x, y, w, h, 14, "#404858");
  rrect(x + 5, y + 5, w - 10, h - 10, 10, "#f8f8f8");
  text("NOMBRE DEL MAZO", x + 26, y + 24, 12, "#283850");
  rrect(x + 26, y + 56, w - 52, 54, 8, "#ffffff", "#78b0c8", 3);
  const caret = Math.floor(game.time * 2.5) % 2 === 0 ? "_" : " ";
  text(DM.renameText + caret, x + 44, y + 74, 18, "#303030");
  text(`${DM.renameText.length}/${DECK_NAME_MAX}`, x + w - 40, y + 120, 9, "#909090", { align: "right" });
  text("Escribí con el teclado.", x + 26, y + 146, 9, "#606060");
  text("ENTER: guardar  ESC: cancelar  RETROCESO: borrar", x + 26, y + 168, 9, "#606060");
}

function renderDeckEditor(): void {
  const d = DM.editing!;
  const n = deckCount(d);
  screenBackground(`EDITAR: ${d.name.toUpperCase()}`, `${n}/${DECK_SIZE} cartas`, "↑↓ ELEGIR  →/Z AGREGAR  ← QUITAR  X TERMINAR");
  const rows = editRows();
  const { x, y, w, rowH } = LIST;
  rrect(x - 8, y - 36, w + 16, LIST.rows * rowH + 48, 12, "#f8f8f0", "#283850", 3);
  text("MAZO  CARTA", x + 10, y - 22, 10, "#808080");
  text("TENÉS", x + w - 10, y - 22, 10, "#808080", { align: "right" });
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 8, y - 4, w + 16, LIST.rows * rowH + 8);
  ctx.clip();
  rows.slice(DM.editScroll, DM.editScroll + LIST.rows).forEach((row, i) => {
    const ry = y + i * rowH;
    if ("header" in row) {
      ctx.fillStyle = "#d8e0ec";
      ctx.fillRect(x, ry + 2, w, rowH - 4);
      text(row.header, x + 10, ry + 8, 10, "#304060");
      return;
    }
    const card = CARDS[row.id];
    const q = qtyInDeck(d, row.id);
    const sel = row.index === DM.editCursor;
    if (sel) rrect(x + 2, ry + 1, w - 4, rowH - 2, 6, "#f8e088");
    if (sel) cursorArrow(x + 6, ry + 6, 12);
    text(String(q), x + 50, ry + 7, 12, q ? "#c03020" : "#b0b0b0", { align: "right" });
    const t = cardType(card);
    if (t) energyIcon(t, x + 76, ry + rowH / 2, 9);
    else rrect(x + 68, ry + 4, 16, 17, 3, TRAINER_STYLE.light, TRAINER_STYLE.dark, 2);
    text(fitText(card.name, 12, 250), x + 96, ry + 7, 12, q ? "#303030" : "#707070");
    text(`${ownedQty(row.id)}`, x + w - 10, ry + 7, 12, "#606060", { align: "right" });
  });
  ctx.restore();
  if (DM.editScroll > 0) text("▲", x + w / 2, y - 22, 10, "#e04030", { align: "center" });
  if (DM.editScroll + LIST.rows < rows.length) text("▼", x + w / 2, y + LIST.rows * rowH - 2, 10, "#e04030", { align: "center" });

  // resumen
  const sx = 500;
  const sw = 436;
  const problems = deckProblems(d);
  rrect(sx, 78, sw, 108, 12, "#f8f8f0", "#283850", 3);
  text(`${n}/${DECK_SIZE}`, sx + 18, 92, 22, n === DECK_SIZE ? "#2a7a3a" : "#c03020");
  text(`Pokémon ${deckCount(d, "pokemon")} · Entren. ${deckCount(d, "trainer")} · Energía ${deckCount(d, "energy")}`, sx + 18, 126, 9, "#505050");
  if (d.id === playerDecks.mainId) {
    rarityMark("Rare", sx + sw - 128, 101, 14, "#a88a18");
    text("PRINCIPAL", sx + sw - 18, 96, 10, "#a88a18", { align: "right" });
  }
  const status = problems.length
    ? `FALTA: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1})` : ""}`
    : "LISTO PARA JUGAR";
  text(fitText(status, 9, sw - 36), sx + 18, 152, 9, problems.length ? "#c03020" : "#2a7a3a");

  // carta seleccionada, a escala
  const id = editIds()[DM.editCursor];
  if (id) {
    ctx.save();
    ctx.translate(sx + (sw - 320) / 2, 194);
    ctx.scale(0.8, 0.8);
    drawCardDetail(CARDS[id], 0, 0, 400, 510);
    ctx.restore();
  }

  if (DM.popup === "save") drawPopup("¿Qué hacemos con los cambios?", SAVE_OPTIONS, DM.optCursor, 420);
  drawMenuToast();
}
