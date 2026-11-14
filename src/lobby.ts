// =====================================================================
//  Menú → RIVALES: jugadores conectados, desafíos y cola (ADR 0002, 3.2).
//  La lógica de red está en net.ts; acá solo la pantalla (mismas convenciones que menu.ts) y el
//  overlay de avisos (desafíos entrantes, reloj de la partida, estado de la conexión).
//
//  Teclas: ↑↓ elegir · ←→ cantidad de premios de tus desafíos · Z acción · C rechazar/cancelar · X volver.
// =====================================================================

const LB = { cursor: 0, scroll: 0, prizes: 6 };
const LB_ROWS = 7;
const LB_LIST = { x: 24, y: 118, w: CW - 48, rowH: 60 };

type LbRow =
  | { k: "queue" }
  | { k: "inc"; c: ChallengeIn }
  | { k: "out"; o: ChallengeOut }
  | { k: "pl"; p: LobbyEntry };

/** Las filas de la pantalla, en orden: cola, desafíos que te mandaron, el que mandaste, jugadores. */
function lobbyRows(): LbRow[] {
  const now = Date.now();
  NET.incoming = NET.incoming.filter((c) => c.expires * 1000 > now);
  if (NET.outgoing && NET.outgoing.until < now) NET.outgoing = null;
  const rows: LbRow[] = [{ k: "queue" }];
  for (const c of NET.incoming) rows.push({ k: "inc", c });
  if (NET.outgoing) rows.push({ k: "out", o: NET.outgoing });
  for (const p of NET.lobby) rows.push({ k: "pl", p });
  return rows;
}

function openLobby(): void {
  menu.screen = "lobby";
  LB.cursor = 0;
  LB.scroll = 0;
  lobbySub(true);
}

function leaveLobby(): void {
  lobbySub(false);
  menu.screen = "main";
}

function updateLobby(up: boolean, down: boolean, left: boolean, right: boolean, a: boolean, b: boolean): void {
  if (b) return leaveLobby();
  if (NET.link === "open" && !NET.lobbyWanted) lobbySub(true); // volviste de una partida
  if (left || right) LB.prizes = LB.prizes === 6 ? 1 : 6;
  const rows = lobbyRows();
  const n = rows.length;
  LB.cursor = Math.min(LB.cursor, n - 1);
  if (up) LB.cursor = (LB.cursor + n - 1) % n;
  if (down) LB.cursor = (LB.cursor + 1) % n;
  if (LB.cursor < LB.scroll) LB.scroll = LB.cursor;
  if (LB.cursor >= LB.scroll + LB_ROWS) LB.scroll = LB.cursor - LB_ROWS + 1;
  const row = rows[LB.cursor];
  const decline = hit(KEYS.view);
  if (!a && !decline) return;
  if (!NET.online || NET.link !== "open") return menuToast("Sin conexión con el servidor.");
  switch (row.k) {
    case "queue":
      if (a) void toggleQueue();
      break;
    case "inc":
      if (a) void acceptChallenge(row.c);
      else declineChallenge(row.c);
      break;
    case "out":
      cancelChallenge();
      break;
    case "pl":
      if (!a) break;
      if (row.p.status !== "libre") return menuToast(`${row.p.name} está jugando.`);
      if (NET.queued) return menuToast("Estás buscando rival: cancelá la búsqueda primero.");
      if (NET.outgoing) return menuToast("Ya tenés un desafío pendiente.");
      void sendChallenge(row.p, LB.prizes);
      break;
  }
}

function lobbyHint(row: LbRow | undefined): string {
  switch (row?.k) {
    case "queue":
      return NET.queued ? "Z: CANCELAR BÚSQUEDA   X: VOLVER" : "Z: BUSCAR RIVAL   X: VOLVER";
    case "inc":
      return "Z: ACEPTAR   C: RECHAZAR   X: VOLVER";
    case "out":
      return "Z / C: CANCELAR DESAFÍO   X: VOLVER";
    case "pl":
      return "Z: DESAFIAR   ←→: PREMIOS   X: VOLVER";
    default:
      return "X: VOLVER";
  }
}

function renderLobby(): void {
  const rows = lobbyRows();
  const online = NET.online && NET.link === "open";
  screenBackground("RIVALES", online ? `EN LÍNEA: ${NET.lobby.length + 1}` : "SIN CONEXIÓN", lobbyHint(rows[Math.min(LB.cursor, rows.length - 1)]));
  if (!NET.online || NET.link !== "open") {
    rrect(80, 190, CW - 160, 190, 14, "#f8f8f8", "#404858", 4);
    const title = !NET.online ? "SIN SERVIDOR" : NET.link === "fatal" ? "DESCONECTADO" : "CONECTANDO...";
    text(title, CW / 2, 220, 16, !NET.online || NET.link === "fatal" ? "#c04030" : "#404858", { align: "center" });
    const msg = !NET.online
      ? "Jugar contra otras personas necesita el servidor del juego."
      : NET.link === "fatal"
        ? NET.linkMsg
        : "Se vuelve a intentar solo. Mientras tanto podés seguir jugando contra los NPC.";
    wrapText(msg, 10, CW - 220).forEach((l, i) => text(l, CW / 2, 262 + i * 18, 10, "#404858", { align: "center" }));
    return;
  }

  text(`PREMIOS EN TUS DESAFÍOS:  ◀ ${LB.prizes} ▶`, 24, 82, 10, "#f8f8f8", { shadow: "#101828" });

  const L = LB_LIST;
  for (let r = 0; r < LB_ROWS; r++) {
    const i = LB.scroll + r;
    if (i >= rows.length) break;
    const row = rows[i];
    const y = L.y + r * L.rowH;
    const sel = i === LB.cursor;
    const incoming = row.k === "inc";
    rrect(L.x, y, L.w, L.rowH - 8, 10, sel ? "#fff8d8" : "#f8f8f8", sel ? "#e04030" : incoming ? "#e0a030" : "#404858", sel ? 4 : 3);
    if (sel) cursorArrow(L.x + 14, y + 16, 18);
    const tx = L.x + 46;
    switch (row.k) {
      case "queue": {
        const dots = ".".repeat(1 + (Math.floor(game.time * 3) % 3));
        text(NET.queued ? `BUSCANDO RIVAL${dots}` : "BUSCAR RIVAL AL AZAR", tx, y + 12, 16, "#484848");
        text(NET.queued ? "Te emparejan con el próximo que busque." : "Te empareja con otro jugador que también esté buscando.", tx, y + 34, 8, "#607088");
        break;
      }
      case "inc": {
        const left = Math.max(0, Math.round(row.c.expires - Date.now() / 1000));
        text(`¡${row.c.from.name.toUpperCase()} TE DESAFÍA!`, tx, y + 12, 16, "#a04010");
        text(`${row.c.prizes} premio${row.c.prizes === 1 ? "" : "s"} · vence en ${left} s`, tx, y + 34, 8, "#607088");
        text("Z: ACEPTAR   C: RECHAZAR", L.x + L.w - 16, y + 18, 10, "#404858", { align: "right" });
        break;
      }
      case "out": {
        const dots = ".".repeat(1 + (Math.floor(game.time * 3) % 3));
        text(`ESPERANDO A ${row.o.toName.toUpperCase()}${dots}`, tx, y + 12, 16, "#484848");
        text(`Desafío de ${row.o.prizes} premio${row.o.prizes === 1 ? "" : "s"}. Z / C: cancelar.`, tx, y + 34, 8, "#607088");
        break;
      }
      case "pl": {
        const free = row.p.status === "libre";
        text(row.p.name.toUpperCase(), tx, y + 18, 16, "#484848");
        rrect(L.x + L.w - 150, y + 8, 128, 30, 15, free ? "#58b058" : "#e0a030", "#404858", 3);
        text(free ? "LIBRE" : "JUGANDO", L.x + L.w - 86, y + 17, 10, "#ffffff", { align: "center" });
        break;
      }
    }
  }
  if (rows.length === 1) {
    text("No hay nadie más conectado.", CW / 2, L.y + L.rowH + 40, 12, "#f8f8f8", { align: "center", shadow: "#101828" });
    text("Mandale el link de invitación a un amigo.", CW / 2, L.y + L.rowH + 66, 9, "#c0d0e8", { align: "center" });
  }
  if (rows.length > LB_ROWS) {
    const h = LB_ROWS * L.rowH - 8;
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(CW - 14, L.y, 6, h);
    ctx.fillStyle = "#f0c040";
    ctx.fillRect(CW - 14, L.y + (LB.scroll / rows.length) * h, 6, (LB_ROWS / rows.length) * h);
  }
}

// ---------------------------------------------------------------------
//  Overlay (se dibuja encima de cualquier modo; lo llama el loop de game.ts)
// ---------------------------------------------------------------------
function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function overlayBox(txt: string, x: number, y: number, size: number, bg: string, border: string): void {
  ctx.font = font(size);
  const w = ctx.measureText(txt).width + 20;
  rrect(x, y, w, size + 16, 8, bg, border, 3);
  text(txt, x + 10, y + 8, size, "#ffffff");
}

function drawNetOverlay(): void {
  if (!NET.online) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const inBattle = game.mode === "battle";
  const inLobby = game.mode === "menu" && menu.screen === "lobby";
  // desafíos entrantes (en el mapa, el menú o los diálogos)
  if (!inBattle && !inLobby && game.mode !== "booster" && game.mode !== "flash" && game.mode !== "warp") {
    const now = Date.now() / 1000;
    const c = NET.incoming.find((x) => x.expires > now);
    if (c) overlayBox(`¡${c.from.name.toUpperCase()} TE DESAFÍA! MENÚ > RIVALES`, 10, 10, 10, "rgba(160,64,16,0.95)", "#f8d060");
  }
  if (inBattle && NET.driver && BT.b) {
    if (BT.b.phase !== "over" && NET.deadline) {
      const left = NET.deadline - Date.now() / 1000;
      const mine = NET.waiting !== "opp";
      overlayBox(`${mine ? "TU TIEMPO" : "TIEMPO RIVAL"} ${mmss(left)}`, 236, 232, 8, left < 15 ? "rgba(176,40,32,0.95)" : "rgba(24,32,48,0.9)", "#f0c040");
    }
    if (NET.link !== "open") overlayBox("RECONECTANDO...", CW / 2 - 110, 6, 10, "rgba(176,40,32,0.95)", "#f8d060");
    else if (NET.opp.status === "disconnected" && BT.b.phase !== "over") {
      const left = NET.opp.graceUntil ? mmss(NET.opp.graceUntil - Date.now() / 1000) : "";
      overlayBox(`RIVAL DESCONECTADO ${left}`, CW / 2 - 150, 6, 10, "rgba(176,40,32,0.95)", "#f8d060");
    }
  }
}
