// =====================================================================
//  Mundo pixel-art estilo GBA — mapas, NPCs y el jugador que se mueve.
//  El arte (tiles y sprites) está en art.ts.
// =====================================================================

type Mode = "explore" | "dialog" | "choice" | "flash" | "menu" | "battle" | "booster" | "warp";
type MoveState = "idle" | "walk" | "jump" | "bump";

const VIEW_W = 240; // resolución nativa GBA
const VIEW_H = 160;
const SCALE = 4;

// ---------------------------------------------------------------------
//  Mundo: mapas, carteles, pasajes y NPCs (data/world.json, lo edita el
//  backoffice). Si no existe, se usa la Ruta 1 de abajo.
//  Tiles: ver TILE_INFO en art.ts.
//  Permisos de paso (perm, como en Advance Map): "." según el tile,
//  "X" bloqueado, "O" se puede pasar siempre.
// ---------------------------------------------------------------------
interface WorldSign {
  x: number;
  y: number;
  lines: string[];
}

interface WorldWarp {
  x: number;
  y: number;
  to: string; // id del mapa de destino
  tx: number;
  ty: number;
  facing?: Dir;
}

interface WorldMap {
  id: string;
  name: string;
  tiles: string[];
  perm?: string[];
  signs?: WorldSign[];
  warps?: WorldWarp[];
}

interface NpcDialog {
  intro: string[]; // al hablarle
  question?: string; // la pregunta para jugar
  decline?: string[]; // si no querés jugar
  win?: string[]; // ganaste (y te da el premio)
  winAgain?: string[]; // ganaste, pero el premio era una sola vez y ya lo tenías
  lose?: string[];
  draw?: string[];
  talk?: string[]; // NPC que no juega: solo esto
}

interface NpcDef {
  id: string;
  name: string;
  map: string;
  x: number;
  y: number;
  facing: Dir;
  look: Look;
  battle?: boolean; // false: solo charla
  deck?: { name: string; cards: DeckEntry[] };
  prizes?: number; // 0 / ausente: el jugador elige 6 o 1
  reward?: { booster: string; once?: boolean }; // booster: "" nada, "random" o id del sobre
  dialog: NpcDialog;
}

interface World {
  version: number;
  start: { map: string; x: number; y: number; facing: Dir };
  playerLook?: Look;
  maps: WorldMap[];
  npcs: NpcDef[];
}

declare const GAME_WORLD: World | null | undefined;

const DEFAULT_WORLD: World = {
  version: 1,
  start: { map: "ruta1", x: 14, y: 20, facing: "up" },
  playerLook: PLAYER_LOOK,
  maps: [
    {
      id: "ruta1",
      name: "RUTA 1",
      tiles: [
        "TTTTTTTTTTTTTPPPPTTTTTTTTTTTTT",
        "TTTTTTTTTTTTTPPPPTTTTTTTTTTTTT",
        "TT...........PPPP....ff....TTT",
        "TT...........PPPP...........TT",
        "TT..f........PPPP..RR.......TT",
        "TT...........PPPP...........TT",
        "TTFFFFFFF....PPPP.....WWWWW.TT",
        "TT...........PPPP....WWWWWWWTT",
        "TT..TT.......PPPP....WWWWWWWTT",
        "TT..TT..ff...PPPP.....WWWWW.TT",
        "TTLLLLLLLLLLLPPPPLLLLLLLLLLLTT",
        "TT...........PPPP...........TT",
        "TT...........PPPPPPPPPP.....TT",
        "TT...........PPPPPPPPPP.....TT",
        "TT........ff.PPPP...PPP.....TT",
        "TT...........PPPP...PPP.....TT",
        "TTTTT..ff....PPPP...PPP.....TT",
        "TTTTT........PPPP..SPPP..ff.TT",
        "TT...........PPPP...PPP.....TT",
        "TT..........SPPPP...PPP..RR.TT",
        "TT......ff...PPPPPPPPPP.....TT",
        "TTTTTTTTTTTTTPPPPTTTTTTTTTTTTT",
        "TTTTTTTTTTTTTPPPPTTTTTTTTTTTTT",
      ],
      signs: [
        { x: 12, y: 19, lines: ["RUTA 1", "Norte: PUEBLO BRUMA\nSur: VILLA SAUCE"] },
        {
          x: 19, y: 17,
          lines: [
            "CONSEJO PARA ENTRENADORES",
            "Mantené SHIFT o X para correr.",
            "Si ves a un entrenador, hablale con Z: ¡quizás quiera jugar a las cartas!",
          ],
        },
      ],
      warps: [],
    },
  ],
  npcs: [
    {
      id: "tomas",
      name: "TOMÁS",
      map: "ruta1",
      x: 20,
      y: 13,
      facing: "left",
      look: {
        cap: "#6a48b0", capLight: "#a088e0", hair: "#2a2a30", skin: "#f8d0a8", skinShade: "#d8a078",
        top: "#4aa0d8", topDark: "#2a6898", shirt: "#f8f8f8", pants: "#5a5040", shoes: "#383838",
      },
      battle: true,
      deck: { name: "Overgrowth", cards: [] }, // vacío: usa OVERGROWTH (cards.ts)
      reward: { booster: "random" },
      dialog: {
        intro: ["¡Eh, vos! Se nota que también juntás cartas.", "Mi mazo {mazoRival} no perdona."],
        question: "¿Jugamos una partida? ¿A cuántos Premios?",
        decline: ["¿No? Bueno, acá voy a estar cuando quieras."],
        win: ["¡No puede ser! Tu mazo {mazo} arrasó con mi {mazoRival}.", "Bueno, lo prometido es deuda: tomá este sobre. ¡Abrilo!"],
        winAgain: ["¡Otra vez me ganaste! Ya no me quedan sobres para darte."],
        lose: ["¡Ja! Las plantas siempre crecen de nuevo.", "Si querés la revancha, ya sabés dónde estoy."],
        draw: ["¿Empate? ¡Qué partida! Tenemos que jugar la revancha."],
      },
    },
  ],
};

const DIRS: Dir[] = ["up", "down", "left", "right"];

/** Valida lo que vino de world.json; si algo está mal, se usa el mundo por defecto. */
function loadWorld(): World {
  const w = typeof GAME_WORLD === "object" && GAME_WORLD ? GAME_WORLD : null;
  if (!w || !Array.isArray(w.maps) || !w.maps.length) return DEFAULT_WORLD;
  const maps = w.maps.filter((m) => m && typeof m.id === "string" && Array.isArray(m.tiles) && m.tiles.length && m.tiles[0].length);
  if (!maps.length) return DEFAULT_WORLD;
  for (const m of maps) {
    const width = Math.max(...m.tiles.map((r) => r.length));
    m.tiles = m.tiles.map((r) => r.padEnd(width, "T"));
    m.name = m.name || m.id.toUpperCase();
    m.signs = m.signs ?? [];
    m.warps = (m.warps ?? []).filter((x) => maps.some((mm) => mm.id === x.to));
  }
  const start = w.start && maps.some((m) => m.id === w.start.map) ? w.start : { map: maps[0].id, x: 1, y: 1, facing: "down" as Dir };
  const npcs = (w.npcs ?? []).filter((n) => n && n.id && maps.some((m) => m.id === n.map));
  for (const n of npcs) {
    n.facing = DIRS.includes(n.facing) ? n.facing : "down";
    n.look = { ...(DEFAULT_WORLD.npcs[0].look), ...(n.look ?? {}) };
    n.dialog = { ...(n.dialog ?? {}), intro: n.dialog?.intro ?? [] };
  }
  return { ...w, start, maps, npcs, playerLook: { ...PLAYER_LOOK, ...(w.playerLook ?? {}) } };
}

const WORLD = loadWorld();

interface NpcRt {
  def: NpcDef;
  x: number;
  y: number;
  facing: Dir;
  home: Dir;
  sprites: Record<Dir, HTMLCanvasElement[]>;
}

const NPC_SPRITE_CACHE = new Map<string, Record<Dir, HTMLCanvasElement[]>>();
function npcSprites(look: Look): Record<Dir, HTMLCanvasElement[]> {
  const key = JSON.stringify(look);
  let s = NPC_SPRITE_CACHE.get(key);
  if (!s) NPC_SPRITE_CACHE.set(key, (s = makeCharSprites(look)));
  return s;
}

// Estado del mapa actual (cambia al pasar por un pasaje)
let curMap: WorldMap = WORLD.maps[0];
let MAP_W = 0;
let MAP_H = 0;
let map: string[][] = [];
let perm: string[] = [];
let mapLayers: HTMLCanvasElement[] = [];
let npcs: NpcRt[] = [];

function tileAt(x: number, y: number): string {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return "T";
  return map[y][x];
}

/** ¿Se puede pisar esta celda? (tile + permiso de paso) */
function isBlocked(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return true;
  const p = perm[y]?.[x];
  if (p === "X") return true;
  if (p === "O") return false;
  return TILE_INFO[map[y][x]]?.solid ?? false;
}

const npcAt = (x: number, y: number): NpcRt | undefined => npcs.find((n) => n.x === x && n.y === y);

function loadMap(id: string): void {
  curMap = WORLD.maps.find((m) => m.id === id) ?? WORLD.maps[0];
  MAP_H = curMap.tiles.length;
  MAP_W = curMap.tiles[0].length;
  map = curMap.tiles.map((r) => r.split(""));
  perm = curMap.perm ?? [];
  mapLayers = renderMapLayers(curMap.tiles);
  npcs = WORLD.npcs
    .filter((n) => n.map === curMap.id)
    .map((def) => ({ def, x: def.x, y: def.y, facing: def.facing, home: def.facing, sprites: npcSprites(def.look) }));
}
loadMap(WORLD.start.map);

const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

// ---------------------------------------------------------------------
//  Input
// ---------------------------------------------------------------------
const KEYMAP: Record<string, Dir> = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
};
const held = new Set<string>();
const dirStack: Dir[] = [];
let actionPressed = false;
/** Último toque de dirección: así un toque muy corto (presionar y soltar en el mismo frame) no se pierde. */
let tappedDir: Dir | undefined;

/** Teclas apretadas en este frame (incluye auto-repetición, útil para recorrer listas). */
const pressed = new Set<string>();
const KEYS = {
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  a: ["KeyZ", "Space"],
  b: ["KeyX", "Escape", "Backspace"],
  start: ["Enter", "KeyM"],
  view: ["KeyC"],
};
const hit = (codes: string[]): boolean => codes.some((c) => pressed.has(c));
/** Caracteres escritos en este frame (para renombrar mazos). */
const typed: string[] = [];

window.addEventListener("keydown", (e) => {
  const d = KEYMAP[e.code];
  if (d) {
    e.preventDefault();
    if (!dirStack.includes(d)) dirStack.push(d);
    if (!e.repeat) tappedDir = d;
  }
  if (!e.repeat && KEYS.a.includes(e.code)) actionPressed = true;
  if ([...KEYS.a, ...KEYS.b, ...KEYS.start].includes(e.code)) e.preventDefault();
  pressed.add(e.code);
  held.add(e.code);
  if (e.key.length === 1) typed.push(e.key);
});
window.addEventListener("keyup", (e) => {
  const d = KEYMAP[e.code];
  if (d) dirStack.splice(dirStack.indexOf(d), 1);
  held.delete(e.code);
});
window.addEventListener("blur", () => {
  dirStack.length = 0;
  held.clear();
});

const currentDir = (): Dir | undefined => dirStack[dirStack.length - 1];
const isRunning = (): boolean => held.has("ShiftLeft") || held.has("ShiftRight") || held.has("KeyX");

// ---------------------------------------------------------------------
//  Estado del juego
// ---------------------------------------------------------------------
const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const SPRITES = makeCharSprites(WORLD.playerLook ?? PLAYER_LOOK);

const player = {
  tx: WORLD.start.x, ty: WORLD.start.y,
  px: WORLD.start.x * TILE, py: WORLD.start.y * TILE,
  facing: WORLD.start.facing as Dir,
  state: "idle" as MoveState,
  fromX: WORLD.start.x, fromY: WORLD.start.y, toX: WORLD.start.x, toY: WORLD.start.y,
  t: 0, dur: 0,
  step: false,      // alterna pie izquierdo / derecho
  turnT: 0,         // pausa breve al girar sin moverse
  cont: false,      // venía caminando (gira sin pausa)
};

const game = {
  mode: "explore" as Mode,
  time: 0,
  flashT: 0,
  battlePrizes: 6,
  bannerT: 0,
  opponent: null as NpcRt | null, // con quién se juega la partida
  netWait: false, // se pidió la partida al servidor y falta su match.start
  talking: null as NpcRt | null, // con quién se está hablando ("!" arriba)
  warpT: 0,
  warpTo: null as WorldWarp | null,
  dialog: { pages: [] as string[][], page: 0, chars: 0, onClose: undefined as (() => void) | undefined },
  choice: { question: "", options: [] as string[], cursor: 0, onPick: (_i: number) => {} },
};

/** Pregunta con opciones (caja de elección estilo GBA). */
function openChoice(question: string, options: string[], onPick: (i: number) => void): void {
  game.choice = { question, options, cursor: 0, onPick };
  game.mode = "choice";
}

function updateChoice(): void {
  const c = game.choice;
  const n = c.options.length;
  if (hit(KEYS.up)) c.cursor = (c.cursor + n - 1) % n;
  if (hit(KEYS.down)) c.cursor = (c.cursor + 1) % n;
  let pick = -1;
  if (hit(KEYS.a)) pick = c.cursor;
  else if (hit(KEYS.b)) pick = n - 1; // X = la última opción (cancelar)
  if (pick < 0) return;
  game.mode = "explore";
  actionPressed = false;
  pressed.clear();
  c.onPick(pick);
}

function renderChoice(): void {
  if (game.mode !== "choice") return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const s = SCALE;
  const c = game.choice;
  // la pregunta, en la caja de diálogo
  const { x, y, w, h } = BOX;
  ctx.fillStyle = "#404858";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4 * s);
  ctx.fill();
  ctx.fillStyle = "#f8f8f8";
  ctx.beginPath();
  ctx.roundRect(x + s, y + s, w - 2 * s, h - 2 * s, 3 * s);
  ctx.fill();
  ctx.font = FONT;
  ctx.textBaseline = "top";
  wrap(c.question, w - TEXT_PAD * 2 - 8 * s).slice(0, 2).forEach((line, i) => {
    const ty = y + 10 * s + i * 14 * s;
    ctx.fillStyle = "#d0d0c8";
    ctx.fillText(line, x + TEXT_PAD + 2, ty + 2);
    ctx.fillStyle = "#484848";
    ctx.fillText(line, x + TEXT_PAD, ty);
  });
  // las opciones, en una caja a la derecha
  const ow = 300;
  const rowH = 46;
  const oh = c.options.length * rowH + 30;
  const ox = CW - ow - 16;
  const oy = y - oh - 8;
  ctx.fillStyle = "#404858";
  ctx.beginPath();
  ctx.roundRect(ox, oy, ow, oh, 14);
  ctx.fill();
  ctx.fillStyle = "#f8f8f8";
  ctx.beginPath();
  ctx.roundRect(ox + 5, oy + 5, ow - 10, oh - 10, 10);
  ctx.fill();
  c.options.forEach((opt, i) => {
    const ty = oy + 22 + i * rowH;
    if (i === c.cursor) cursorArrow(ox + 22, ty + 2, 18);
    text(opt, ox + 52, ty, 18, "#484848", { shadow: "#d0d0c8" });
  });
}

function startMove(state: MoveState, toX: number, toY: number, dur: number): void {
  player.state = state;
  player.fromX = player.tx;
  player.fromY = player.ty;
  player.toX = toX;
  player.toY = toY;
  player.t = 0;
  player.dur = dur;
  player.step = !player.step;
}

function tryMove(d: Dir): void {
  const [dx, dy] = DELTA[d];
  const nx = player.tx + dx;
  const ny = player.ty + dy;
  const t = tileAt(nx, ny);
  if (t === "L" && !/[XO]/.test(perm[ny]?.[nx] ?? "")) {
    if (d === "down" && !isBlocked(nx, ny + 1) && !npcAt(nx, ny + 1)) startMove("jump", nx, ny + 1, 0.42);
    else startMove("bump", player.tx, player.ty, 0.3);
    return;
  }
  if (isBlocked(nx, ny) || npcAt(nx, ny)) {
    startMove("bump", player.tx, player.ty, 0.3);
    return;
  }
  startMove("walk", nx, ny, isRunning() ? 0.12 : 0.24);
}

/** Rellena {mazo}, {mazoRival} y {nombre} en los textos de los NPC. */
function fillText(n: NpcRt, t: string): string {
  return t
    .replace(/\{mazo\}/g, mainDeck().name)
    .replace(/\{mazoRival\}/g, n.def.deck?.name || "Overgrowth")
    .replace(/\{nombre\}/g, playerName());
}

/** Textos del NPC con su nombre adelante del primero ("TOMÁS: ..."). */
function npcSay(n: NpcRt, texts: string[] | undefined, fallback = "..."): string[] {
  const list = (texts ?? []).filter((t) => t && t.trim());
  if (!list.length) list.push(fallback);
  return list.map((t, i) => {
    const f = fillText(n, t);
    return i === 0 && !f.startsWith(n.def.name) ? `${n.def.name}: ${f}` : f;
  });
}

function talkTo(n: NpcRt): void {
  n.facing = OPPOSITE[player.facing];
  game.talking = n;
  const d = n.def.dialog;
  const back = () => {
    n.facing = n.home;
    game.talking = null;
  };
  if (n.def.battle === false) {
    openDialog(npcSay(n, d.talk?.length ? d.talk : d.intro), back);
    return;
  }
  openDialog(npcSay(n, d.intro, "¡Hola!"), () => {
    const fixed = Number(n.def.prizes) || 0;
    const opts = fixed ? [`¡DALE! (${fixed} PREMIO${fixed > 1 ? "S" : ""})`, "AHORA NO"] : ["6 PREMIOS", "1 PREMIO", "CANCELAR"];
    openChoice(fillText(n, d.question || "¿Jugamos una partida?"), opts, (i) => {
      if (i === opts.length - 1) {
        openDialog(npcSay(n, d.decline, "Bueno, otra vez será."), back);
        return;
      }
      game.battlePrizes = fixed || (i === 0 ? 6 : 1);
      game.opponent = n;
      game.mode = "flash";
      game.flashT = 0;
    });
  });
}

/** Pasó el destello: con servidor, la partida contra el NPC la crea el servidor (npc.start → match.start); sin él, corre acá. */
function beginNpcBattle(): void {
  const n = game.opponent;
  if (!PLAYER || !NET.online || !n) return startBattle(game.battlePrizes);
  if (game.netWait) return;
  game.netWait = true;
  void netStartNpc(n.def.id, game.battlePrizes, (why) => {
    game.netWait = false;
    abortNpcBattle(why);
  });
}

/** No se pudo empezar la partida: se vuelve a hablar con el NPC con el motivo. */
function abortNpcBattle(why: string): void {
  const n = game.opponent;
  game.opponent = null;
  game.mode = "explore";
  if (n) {
    n.facing = OPPOSITE[player.facing];
    game.talking = n;
  }
  openDialog([why], () => {
    if (n) n.facing = n.home;
    game.talking = null;
  });
}

/** Al terminar la partida: lo que dice el NPC y el premio (que decide el servidor y llega en match.over). */
function finishNpcBattle(result: "win" | "lose" | "draw", reward: MatchResult["reward"] = null): void {
  const n = game.opponent;
  game.opponent = null;
  const hasReward = !!reward?.cards?.length;
  // ¿es la primera vez que gana? (para el diálogo); el progreso local se actualiza con lo que dice el servidor
  const id = n?.def.id ?? "";
  const before = id ? PROGRESS.defeated[id] ?? 0 : 0;
  if (result === "win" && id) {
    PROGRESS.defeated[id] = before + 1;
    saveProgressLocal();
  }
  if (!n && !hasReward) return;
  if (n) {
    n.facing = OPPOSITE[player.facing];
    game.talking = n;
  }
  const back = () => {
    if (n) n.facing = n.home;
    game.talking = null;
  };
  const d = n?.def.dialog ?? { win: [], lose: [], draw: [], winAgain: [] };
  if (result !== "win") {
    openDialog(npcSay(n!, result === "draw" ? d.draw : d.lose, result === "draw" ? "¡Empate!" : "¡Te gané!"), back);
    return;
  }
  if (!hasReward) {
    // sin premio: ya lo ganó antes (once), no tiene o no hay conexión. Con servidor se refresca igual el progreso.
    if (NET.online) void refreshPlayer();
    openDialog(npcSay(n!, before > 0 && d.winAgain?.length ? d.winAgain : d.win, "¡Me ganaste!"), back);
    return;
  }
  // el sobre ya lo sorteó el servidor y las cartas ya son del jugador: se calcula qué es nuevo ANTES de refrescar la colección
  const cards = reward!.cards!.filter((c) => CARDS[c]);
  const isNew = newFlags(cards);
  const def = reward!.booster ? boosterById(reward!.booster) : null;
  const title = n ? `¡${n.def.name} te dio un sobre!` : "¡Ganaste un sobre!";
  const show = () => {
    if (!cards.length) return back();
    if (def) openMailBooster(def, cards, isNew, back, title);
    else revealMailCards(cards, isNew, back);
  };
  const refreshed = refreshPlayer(); // corre mientras se lee el diálogo
  if (n) openDialog(npcSay(n, d.win, "¡Me ganaste! Tomá, este sobre es para vos."), () => void refreshed.then(show));
  else void refreshed.then(show);
}

function interact(): void {
  const [dx, dy] = DELTA[player.facing];
  const fx = player.tx + dx;
  const fy = player.ty + dy;
  const n = npcAt(fx, fy);
  if (n) return talkTo(n);
  const sign = curMap.signs?.find((x) => x.x === fx && x.y === fy);
  if (sign?.lines.length) openDialog(sign.lines);
}

/** Pasaje (puerta, borde del mapa…): fundido a negro y aparece en el otro mapa. */
function checkWarp(): boolean {
  const w = curMap.warps?.find((x) => x.x === player.tx && x.y === player.ty);
  if (!w) return false;
  game.warpTo = w;
  game.warpT = 0;
  game.mode = "warp";
  return true;
}

function updateWarp(dt: number): void {
  const before = game.warpT;
  game.warpT += dt / 0.6;
  if (before < 0.5 && game.warpT >= 0.5 && game.warpTo) {
    const w = game.warpTo;
    loadMap(w.to);
    Object.assign(player, { tx: w.tx, ty: w.ty, px: w.tx * TILE, py: w.ty * TILE, toX: w.tx, toY: w.ty, state: "idle" });
    if (w.facing) player.facing = w.facing;
    game.bannerT = 0;
  }
  if (game.warpT >= 1) {
    game.warpTo = null;
    game.mode = "explore";
  }
}

function updatePlayer(dt: number): void {
  const p = player;
  if (p.state !== "idle") {
    p.t += dt / p.dur;
    if (p.t >= 1) {
      p.tx = p.toX;
      p.ty = p.toY;
      p.px = p.tx * TILE;
      p.py = p.ty * TILE;
      const walked = p.state !== "bump";
      p.state = "idle";
      p.cont = true;
      if (walked && game.mode === "explore" && checkWarp()) return;
    } else {
      p.px = (p.fromX + (p.toX - p.fromX) * p.t) * TILE;
      p.py = (p.fromY + (p.toY - p.fromY) * p.t) * TILE;
      return;
    }
  }
  if (game.mode !== "explore") return;

  if (hit(KEYS.start)) {
    openMenu();
    return;
  }
  if (actionPressed && game.time >= interactLockUntil) {
    interact();
    if (game.mode !== "explore") return;
  }

  const d = currentDir() ?? tappedDir;
  tappedDir = undefined;
  if (!d) {
    p.cont = false;
    p.turnT = 0;
    return;
  }
  if (d !== p.facing && !p.cont) {
    p.facing = d;
    p.turnT = 0.1;
    return;
  }
  p.facing = d;
  if (p.turnT > 0) {
    p.turnT -= dt;
    if (!currentDir()) p.turnT = 0; // fue solo un toque: girar sin caminar
    return;
  }
  tryMove(d);
}

// ---------------------------------------------------------------------
//  Diálogo
// ---------------------------------------------------------------------
const canvas = document.getElementById("game") as HTMLCanvasElement;
canvas.width = VIEW_W * SCALE;
canvas.height = VIEW_H * SCALE;
const ctx = canvas.getContext("2d")!;

const FONT = `${7 * SCALE}px "Press Start 2P", monospace`;
const BOX = { x: 4 * SCALE, y: (VIEW_H - 46) * SCALE, w: (VIEW_W - 8) * SCALE, h: 42 * SCALE };
const TEXT_PAD = 10 * SCALE;

function wrap(text: string, maxW: number): string[] {
  ctx.font = FONT;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function openDialog(texts: string[], onClose?: () => void): void {
  const pages: string[][] = [];
  for (const t of texts) {
    const lines = wrap(t, BOX.w - TEXT_PAD * 2 - 8 * SCALE);
    for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2));
  }
  game.dialog = { pages, page: 0, chars: 0, onClose };
  game.mode = "dialog";
}

function updateDialog(dt: number): void {
  const d = game.dialog;
  const len = d.pages[d.page].join("").length;
  d.chars = Math.min(len, d.chars + dt * 45);
  if (!actionPressed) return;
  actionPressed = false; // consumir: que no reabra el cartel en el mismo frame
  if (d.chars < len) d.chars = len;
  else if (++d.page >= d.pages.length) {
    game.mode = "explore";
    const cb = d.onClose;
    d.onClose = undefined;
    cb?.();
  } else d.chars = 0;
}

// ---------------------------------------------------------------------
//  Render
// ---------------------------------------------------------------------
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function playerFrame(): number {
  const p = player;
  if (p.state === "idle") return 0;
  if (p.state === "jump") return p.t < 0.6 ? (p.step ? 1 : 2) : 0;
  return p.t < 0.5 ? (p.step ? 1 : 2) : 0;
}

function renderWorld(): void {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // cámara (si el mapa es más chico que la pantalla, queda centrado)
  const mw = MAP_W * TILE;
  const mh = MAP_H * TILE;
  const camX = Math.round(mw <= VIEW_W ? (mw - VIEW_W) / 2 : clamp(player.px + 8 - VIEW_W / 2, 0, mw - VIEW_W));
  const camY = Math.round(mh <= VIEW_H ? (mh - VIEW_H) / 2 : clamp(player.py + 8 - VIEW_H / 2, 0, mh - VIEW_H));

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const f = Math.floor(game.time * 3) % ANIM_FRAMES;
  ctx.drawImage(mapLayers[f], -camX, -camY);

  const sx = Math.round(player.px) - camX;
  const sy = Math.round(player.py) - camY;
  let hop = 0;
  if (player.state === "jump") {
    hop = -Math.round(Math.sin(Math.PI * player.t) * 10);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(sx + 8, sy + 14, 6, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // personajes de atrás hacia adelante
  const actors: { y: number; draw: () => void }[] = npcs.map((n) => ({
    y: n.y * TILE,
    draw: () => ctx.drawImage(n.sprites[n.facing][0], n.x * TILE - camX, n.y * TILE - camY - 4),
  }));
  actors.push({ y: player.py + 0.5, draw: () => ctx.drawImage(SPRITES[player.facing][playerFrame()], sx, sy - 4 + hop) });
  actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());

  // "!" sobre el NPC mientras te habla
  const n = game.talking;
  if (n && (game.mode === "dialog" || game.mode === "choice")) {
    const ex = n.x * TILE - camX + 5;
    const ey = n.y * TILE - camY - 16;
    ctx.fillStyle = "#303030";
    ctx.fillRect(ex, ey, 6, 9);
    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(ex + 1, ey + 1, 4, 7);
    ctx.fillStyle = "#e03030";
    ctx.fillRect(ex + 2, ey + 2, 2, 3);
    ctx.fillRect(ex + 2, ey + 6, 2, 1);
  }
}

function renderBanner(): void {
  const t = game.bannerT;
  if (t > 3) return;
  const slide = t < 0.3 ? t / 0.3 : t > 2.7 ? (3 - t) / 0.3 : 1;
  const w = 90 * SCALE;
  const h = 22 * SCALE;
  const x = 4 * SCALE;
  const y = Math.round(-h + (h + 4 * SCALE) * slide);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COL.woodO;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = COL.wood;
  ctx.fillRect(x + SCALE * 2, y + SCALE * 2, w - SCALE * 4, h - SCALE * 4);
  ctx.fillStyle = COL.woodL;
  ctx.fillRect(x + SCALE * 2, y + SCALE * 2, w - SCALE * 4, SCALE);
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = COL.woodD;
  let name = curMap.name;
  while (name.length > 1 && ctx.measureText(name).width > w - 8 * SCALE) name = name.slice(0, -1);
  ctx.fillText(name, x + w / 2 + 3, y + h / 2 + 3);
  ctx.fillStyle = "#fff8e8";
  ctx.fillText(name, x + w / 2, y + h / 2);
  ctx.textAlign = "left";
}

function renderDialog(): void {
  if (game.mode !== "dialog") return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const { x, y, w, h } = BOX;
  const s = SCALE;
  ctx.fillStyle = "#404858";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4 * s);
  ctx.fill();
  ctx.fillStyle = "#f8f8f8";
  ctx.beginPath();
  ctx.roundRect(x + s, y + s, w - 2 * s, h - 2 * s, 3 * s);
  ctx.fill();
  ctx.strokeStyle = "#78b0c8";
  ctx.lineWidth = s;
  ctx.beginPath();
  ctx.roundRect(x + 3.5 * s, y + 3.5 * s, w - 7 * s, h - 7 * s, 2 * s);
  ctx.stroke();

  const d = game.dialog;
  const lines = d.pages[d.page];
  let remaining = Math.floor(d.chars);
  ctx.font = FONT;
  ctx.textBaseline = "top";
  lines.forEach((line, i) => {
    const shown = line.slice(0, Math.max(0, remaining));
    remaining -= line.length;
    const ty = y + 10 * s + i * 14 * s;
    ctx.fillStyle = "#d0d0c8";
    ctx.fillText(shown, x + TEXT_PAD + 2, ty + 2);
    ctx.fillStyle = "#484848";
    ctx.fillText(shown, x + TEXT_PAD, ty);
  });

  const full = d.chars >= lines.join("").length;
  if (full && Math.floor(game.time * 3) % 2 === 0) {
    const ax = x + w - 16 * s;
    const ay = y + h - 13 * s;
    ctx.fillStyle = "#e05040";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + 6 * s, ay);
    ctx.lineTo(ax + 3 * s, ay + 4 * s);
    ctx.closePath();
    ctx.fill();
  }
}

function renderWarpFade(): void {
  if (game.mode !== "warp") return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 1 - Math.abs(game.warpT - 0.5) * 2.2)})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function renderFlash(): void {
  if (game.mode !== "flash") return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (Math.floor(game.flashT * 10) % 2 === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------
//  Loop principal
// ---------------------------------------------------------------------
let last = performance.now();
/** Al volver al mapa desde otra pantalla, Z no habla con nadie por un instante
 *  (evita reabrir el diálogo del NPC al saltear cuadros apretando Z seguido). */
const INTERACT_LOCK = 0.45;
let interactLockUntil = 0;

function frame(now: number): void {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  game.time += dt;
  game.bannerT += dt;

  const modeBefore = game.mode;
  if (game.mode === "dialog") updateDialog(dt);
  else if (game.mode === "choice") updateChoice();
  else if (game.mode === "menu") updateMenu();
  else if (game.mode === "battle") updateBattle(dt);
  else if (game.mode === "booster") updateBooster(dt);
  else if (game.mode === "warp") updateWarp(dt);
  else if (game.mode === "flash") {
    game.flashT += dt;
    if (game.flashT > 0.8) beginNpcBattle();
  }
  if (modeBefore !== "explore" && game.mode === "explore") interactLockUntil = game.time + INTERACT_LOCK;
  updatePlayer(dt);
  actionPressed = false;
  pressed.clear();
  typed.length = 0;

  if (game.mode === "battle") renderBattle();
  else if (game.mode === "booster") renderBooster();
  else if (!menuCoversWorld()) {
    renderWorld();
    renderBanner();
    renderFlash();
    renderWarpFade();
    renderDialog();
    renderChoice();
  }
  if (game.mode === "menu") renderMenu();
  drawNetOverlay(); // avisos de red (desafíos, reloj de la partida, conexión)
  requestAnimationFrame(frame);
}
