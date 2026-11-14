// =====================================================================
//  Arte del mundo: tiles del mapa y sprites de personajes, todo generado
//  por código. Lo usan el juego (game.ts) y el editor de mapas del backoffice.
//  No depende de nada más del juego.
// =====================================================================

type Dir = "up" | "down" | "left" | "right";
const TILE = 16;

// ---------------------------------------------------------------------
//  Utilidades de dibujo
// ---------------------------------------------------------------------
function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  return [c, g];
}

/** Hash determinista para texturas "aleatorias" estables. */
function hash(x: number, y: number, s = 0): number {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function px(g: CanvasRenderingContext2D, x: number, y: number, color: string, w = 1, h = 1): void {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

const COL = {
  grass: "#88d070",
  grassDark: "#60b048",
  grassLight: "#b0e898",
  shoreDark: "#20702c",
  path: "#e8d8a0",
  pathDark: "#d0b878",
  pathLight: "#f8f0c8",
  treeO: "#183818",
  tree1: "#2a6a30",
  tree2: "#3a8c40",
  tree3: "#58b050",
  tree4: "#90d878",
  trunk: "#7a4a28",
  trunkD: "#4a2a14",
  water: "#5898f0",
  waterD: "#3870d0",
  waterL: "#c8e8ff",
  wood: "#c89050",
  woodL: "#e0b070",
  woodD: "#8a5a2a",
  woodO: "#4a2a14",
};

// ---------------------------------------------------------------------
//  Tiles
// ---------------------------------------------------------------------
function drawGrass(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  px(g, ox, oy, COL.grass, TILE, TILE);
  for (let k = 0; k < 3; k++) {
    if (hash(x, y, k) > 0.65) continue;
    const bx = ox + 1 + Math.floor(hash(x, y, k + 10) * 12);
    const by = oy + 2 + Math.floor(hash(x, y, k + 20) * 11);
    // pequeño mechón "ıı"
    px(g, bx, by, COL.grassDark, 1, 2);
    px(g, bx + 2, by, COL.grassDark, 1, 2);
    px(g, bx + 1, by + 1, COL.grassDark);
    px(g, bx + 1, by - 1, COL.grassLight);
  }
}

function drawPath(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  px(g, ox, oy, COL.path, TILE, TILE);
  for (let k = 0; k < 5; k++) {
    const sx = ox + Math.floor(hash(x, y, k + 40) * 15);
    const sy = oy + Math.floor(hash(x, y, k + 50) * 15);
    px(g, sx, sy, k % 2 ? COL.pathDark : COL.pathLight, k % 3 === 0 ? 2 : 1, 1);
  }
  // bordes irregulares con el pasto
  const sides: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  sides.forEach(([dx, dy], side) => {
    if (ART_AT(x + dx, y + dy) === "P") return;
    for (let i = 0; i < TILE; i++) {
      const r = hash(x * 3 + i, y * 7 + side, 99);
      const depth = r < 0.45 ? 1 : r < 0.85 ? 2 : 3;
      for (let d = 0; d < depth + 1; d++) {
        const color = d < depth ? COL.grass : COL.pathDark;
        if (dy === -1) px(g, ox + i, oy + d, color);
        if (dy === 1) px(g, ox + i, oy + TILE - 1 - d, color);
        if (dx === -1) px(g, ox + d, oy + i, color);
        if (dx === 1) px(g, ox + TILE - 1 - d, oy + i, color);
      }
    }
  });
}

function drawTree(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  px(g, ox, oy, COL.grassDark, TILE, TILE);
  // tronco
  px(g, ox + 6, oy + 12, COL.trunkD, 4, 4);
  px(g, ox + 7, oy + 12, COL.trunk, 2, 3);
  // copa
  for (let yy = 0; yy < 14; yy++) {
    for (let xx = 0; xx < 16; xx++) {
      const dx = (xx - 7.5) / 7.8;
      const dy = (yy - 6.5) / 7;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      let c: string;
      if (d > 0.87) c = COL.treeO;
      else {
        const l = (xx - 5) ** 2 + (yy - 4) ** 2 + hash(xx + x * 16, yy + y * 16, 7) * 14;
        c = l < 10 ? COL.tree4 : l < 32 ? COL.tree3 : l < 70 ? COL.tree2 : COL.tree1;
        // textura de hojas
        if ((xx + yy * 3 + x) % 5 === 0 && l > 10) c = COL.tree1;
      }
      px(g, ox + xx, oy + yy, c);
    }
  }
}

function drawWater(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number, f: number): void {
  px(g, ox, oy, COL.water, TILE, TILE);
  for (let i = 0; i < 2; i++) {
    const wx = Math.floor(hash(x, y, i + 60) * 16) + f * 2;
    const wy = 3 + i * 7 + Math.floor(hash(x, y, i + 70) * 3);
    const pts: [number, number][] = [[0, 1], [1, 0], [2, 0], [3, 1]];
    pts.forEach(([a, b]) => px(g, ox + ((wx + a) % 16), oy + wy + b, COL.waterL));
    px(g, ox + ((wx + 1) % 16), oy + wy + 2, COL.waterD, 2, 1);
  }
  // orillas
  const n = ART_AT(x, y - 1) !== "W";
  const s = ART_AT(x, y + 1) !== "W";
  const w = ART_AT(x - 1, y) !== "W";
  const e = ART_AT(x + 1, y) !== "W";
  if (n) { px(g, ox, oy, COL.shoreDark, 16, 1); px(g, ox, oy + 1, COL.waterL, 16, 1); px(g, ox, oy + 2, COL.waterD, 16, 1); }
  if (s) { px(g, ox, oy + 15, COL.shoreDark, 16, 1); px(g, ox, oy + 14, COL.waterD, 16, 1); }
  if (w) { px(g, ox, oy, COL.shoreDark, 1, 16); px(g, ox + 1, oy, COL.waterL, 1, 16); }
  if (e) { px(g, ox + 15, oy, COL.shoreDark, 1, 16); px(g, ox + 14, oy, COL.waterD, 1, 16); }
}

function drawFlowers(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number, f: number): void {
  drawGrass(g, ox, oy, x, y);
  const petal = (x + y) % 2 ? "#f86060" : "#f8f8f8";
  const spots: [number, number][] = [[4, 4], [11, 11]];
  spots.forEach(([cx, cy], i) => {
    const sway = (f + i) % 2;
    const fx = ox + cx + sway;
    const fy = oy + cy;
    px(g, ox + cx, fy + 2, "#409030", 1, 2);
    px(g, fx - 1, fy, petal);
    px(g, fx + 1, fy, petal);
    px(g, fx, fy - 1, petal);
    px(g, fx, fy + 1, petal);
    px(g, fx, fy, "#f8d030");
  });
}

function drawLedge(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  drawGrass(g, ox, oy, x, y);
  const lEnd = ART_AT(x - 1, y) !== "L";
  const rEnd = ART_AT(x + 1, y) !== "L";
  const x0 = ox + (lEnd ? 2 : 0);
  const x1 = ox + TILE - (rEnd ? 2 : 0);
  const w = x1 - x0;
  px(g, x0, oy + 9, COL.grassLight, w, 1);
  px(g, x0, oy + 10, "#58a040", w, 2);
  px(g, x0, oy + 12, "#3c7830", w, 1);
  px(g, x0, oy + 13, "#2a5a22", w, 1);
  if (lEnd) px(g, x0, oy + 10, "#2a5a22", 1, 3);
  if (rEnd) px(g, x1 - 1, oy + 10, "#2a5a22", 1, 3);
}

function drawRock(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  drawGrass(g, ox, oy, x, y);
  px(g, ox + 3, oy + 13, COL.grassDark, 11, 2); // sombra
  for (let yy = 0; yy < 16; yy++)
    for (let xx = 0; xx < 16; xx++) {
      const dx = (xx - 7.5) / 6.5;
      const dy = (yy - 8.5) / 5.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      let c = d > 0.82 ? "#383838" : "#a8a8b0";
      if (d <= 0.82 && xx + yy > 18) c = "#808088";
      if (d <= 0.82 && (xx - 5) ** 2 + (yy - 6) ** 2 < 5) c = "#e0e0e8";
      px(g, ox + xx, oy + yy, c);
    }
}

function drawSign(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  drawGrass(g, ox, oy, x, y);
  px(g, ox + 6, oy + 9, COL.woodO, 4, 7);
  px(g, ox + 7, oy + 9, COL.woodD, 2, 6);
  px(g, ox + 1, oy + 2, COL.woodO, 14, 9);
  px(g, ox + 2, oy + 3, COL.wood, 12, 7);
  px(g, ox + 2, oy + 3, COL.woodL, 12, 1);
  px(g, ox + 4, oy + 5, COL.woodD, 8, 1);
  px(g, ox + 4, oy + 7, COL.woodD, 6, 1);
}

function drawFence(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  drawGrass(g, ox, oy, x, y);
  const lx = ART_AT(x - 1, y) === "F" ? 0 : 6;
  const rx = ART_AT(x + 1, y) === "F" ? 16 : 10;
  for (const ry of [4, 9]) {
    px(g, ox + lx, oy + ry - 1, COL.woodO, rx - lx, 4);
    px(g, ox + lx, oy + ry, COL.woodL, rx - lx, 1);
    px(g, ox + lx, oy + ry + 1, COL.woodD, rx - lx, 1);
  }
  px(g, ox + 5, oy + 1, COL.woodO, 6, 14);
  px(g, ox + 6, oy + 2, COL.wood, 4, 12);
  px(g, ox + 6, oy + 2, COL.woodL, 4, 1);
  px(g, ox + 9, oy + 3, COL.woodD, 1, 11);
  px(g, ox + 4, oy + 14, COL.grassDark, 8, 1);
}


function drawTallGrass(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number, f: number): void {
  px(g, ox, oy, COL.grassDark, TILE, TILE);
  for (let k = 0; k < 4; k++) {
    const bx = ox + 1 + (k % 2) * 8;
    const by = oy + 1 + Math.floor(k / 2) * 8;
    const sway = (f + k + x) % 2;
    px(g, bx + sway, by, COL.grassLight, 1, 3);
    px(g, bx + 2, by + 1, COL.grass, 1, 5);
    px(g, bx + 4 - sway, by, COL.grassLight, 1, 3);
    px(g, bx + 1, by + 3, COL.shoreDark, 5, 1);
    px(g, bx + 3, by + 2, COL.grass, 1, 4);
  }
}

function drawSand(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  px(g, ox, oy, "#f0e0a8", TILE, TILE);
  for (let k = 0; k < 6; k++) {
    const sx = ox + Math.floor(hash(x, y, k + 80) * 15);
    const sy = oy + Math.floor(hash(x, y, k + 90) * 15);
    px(g, sx, sy, k % 2 ? "#d8c080" : "#fff4d0");
  }
}

function drawBush(g: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number): void {
  drawGrass(g, ox, oy, x, y);
  px(g, ox + 2, oy + 13, COL.grassDark, 12, 2);
  for (let yy = 2; yy < 15; yy++)
    for (let xx = 1; xx < 15; xx++) {
      const dx = (xx - 7.5) / 6.6;
      const dy = (yy - 8.5) / 6.2;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      let c = d > 0.85 ? COL.treeO : COL.tree2;
      if (d <= 0.85 && (xx - 5) ** 2 + (yy - 6) ** 2 < 8) c = COL.tree3;
      if (d <= 0.85 && (xx * 3 + yy + x) % 7 === 0) c = COL.tree1;
      px(g, ox + xx, oy + yy, c);
    }
}

// ---------------------------------------------------------------------
//  Catálogo de tiles: lo que ve el editor y lo que define si se puede pasar
// ---------------------------------------------------------------------
interface TileInfo {
  name: string;
  solid: boolean;
}

const TILE_INFO: Record<string, TileInfo> = {
  ".": { name: "Pasto", solid: false },
  P: { name: "Camino", solid: false },
  f: { name: "Flores", solid: false },
  t: { name: "Pasto alto", solid: false },
  s: { name: "Arena", solid: false },
  L: { name: "Saliente (se salta hacia abajo)", solid: false },
  T: { name: "Árbol", solid: true },
  H: { name: "Arbusto", solid: true },
  W: { name: "Agua", solid: true },
  R: { name: "Roca", solid: true },
  F: { name: "Cerca", solid: true },
  S: { name: "Cartel", solid: true },
};

/** Vecinos del tile que se está dibujando (bordes del camino, orillas, cercas). */
let ART_AT: (x: number, y: number) => string = () => ".";

/** Dibuja un tile en (x, y) de la grilla; `at` devuelve el tile de cualquier celda. */
function drawTileArt(g: CanvasRenderingContext2D, ch: string, x: number, y: number, f: number, at: (x: number, y: number) => string): void {
  ART_AT = at;
  const ox = x * TILE;
  const oy = y * TILE;
  switch (ch) {
    case "T": drawTree(g, ox, oy, x, y); break;
    case "P": drawPath(g, ox, oy, x, y); break;
    case "W": drawWater(g, ox, oy, x, y, f); break;
    case "f": drawFlowers(g, ox, oy, x, y, f); break;
    case "L": drawLedge(g, ox, oy, x, y); break;
    case "S": drawSign(g, ox, oy, x, y); break;
    case "F": drawFence(g, ox, oy, x, y); break;
    case "R": drawRock(g, ox, oy, x, y); break;
    case "t": drawTallGrass(g, ox, oy, x, y, f); break;
    case "s": drawSand(g, ox, oy, x, y); break;
    case "H": drawBush(g, ox, oy, x, y); break;
    default: drawGrass(g, ox, oy, x, y);
  }
}

const ANIM_FRAMES = 4;

/** Pre-renderiza el mapa entero, un lienzo por cada frame de animación (agua / flores). */
function renderMapLayers(rows: string[]): HTMLCanvasElement[] {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const at = (x: number, y: number): string => (x < 0 || y < 0 || x >= w || y >= h ? "T" : rows[y][x]);
  const out: HTMLCanvasElement[] = [];
  for (let f = 0; f < ANIM_FRAMES; f++) {
    const [c, g] = makeCanvas(w * TILE, h * TILE);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) drawTileArt(g, rows[y][x], x, y, f, at);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------
//  Sprite del jugador (16x16, 4 direcciones, 3 frames)
// ---------------------------------------------------------------------
const PAL: Record<string, string> = {
  o: "#303030", h: "#3a9a52", H: "#78d088", k: "#704828",
  s: "#f8d0a8", S: "#d8a078", j: "#f08838", J: "#c05818",
  w: "#f8f8f8", p: "#4a5a90", b: "#383838",
};

const HEAD_TOP = [
  "......oooo......",
  "....ooHHHHoo....",
  "...oHHHHHHHHo...",
  "...ohhhhhhhho...",
  "..oohhhhhhhhoo..",
];

const BODY: Record<"down" | "up" | "left", string[]> = {
  down: [
    ...HEAD_TOP,
    "..okksssssskko..",
    "...osossssoso...",
    "...oSssssssSo...",
    "..ojoSSSSSSojo..",
    ".ojjjjwwwwjjjjo.",
    ".ojJjjwwwwjjJjo.",
    ".osJjjjjjjjjJso.",
    "..ooJJjjjjJJoo..",
  ],
  up: [
    ...HEAD_TOP,
    "..okkkkkkkkkko..",
    "...okkkkkkkko...",
    "...okkkkkkkko...",
    "..ojokkkkkkojo..",
    ".ojjjjjjjjjjjjo.",
    ".ojJjjjjjjjjJjo.",
    ".osJjjjjjjjjJso.",
    "..ooJJjjjjJJoo..",
  ],
  left: [
    "......oooo......",
    "....ooHHHHoo....",
    "...oHHHHHHHHo...",
    ".oohhhhhhhhho...",
    ".ohhhhhhhhhkko..",
    "..ossssskkkko...",
    "..ososssskkko...",
    "..oSsssssSko....",
    "...oSSSSSSo.....",
    "...ojjjjjjjo....",
    "...ojjsjjjJo....",
    "...ojjsjjJJo....",
    "....oJJJJJo.....",
  ],
};

const LEGS_FRONT = [
  ["...oppppppppo...", "...opppoopppo...", "....obbo.obbo..."],
  ["...oppppppppo...", "...opppoopppo...", "...obbo...oo...."],
  ["...oppppppppo...", "...opppoopppo...", "....oo...obbo..."],
];
const LEGS_SIDE = [
  ["....opppppo.....", "....oppopppo....", "....obbo.obo...."],
  ["....opppppo.....", "...opppo..oppo..", "..obbo....obbo.."],
  ["....opppppo.....", "....oppppo......", "....obbbo......."],
];

function spriteFrom(rows: string[], flip: boolean, pal: Record<string, string> = PAL): HTMLCanvasElement {
  const [c, g] = makeCanvas(16, 16);
  rows.forEach((row, y) => {
    const r = row.padEnd(16, ".").slice(0, 16);
    for (let x = 0; x < 16; x++) {
      const col = pal[r[x]];
      if (col) px(g, flip ? 15 - x : x, y, col);
    }
  });
  return c;
}


// ---------------------------------------------------------------------
//  Aspecto de un personaje (jugador o NPC): colores del sprite
// ---------------------------------------------------------------------
interface Look {
  cap: string; // gorra / pelo de arriba
  hair: string; // pelo de los costados
  skin: string;
  top: string; // campera
  shirt: string; // remera
  pants: string;
  shoes: string;
  capLight?: string; // tonos opcionales (si faltan se calculan)
  skinShade?: string;
  topDark?: string;
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function lookPalette(l: Look): Record<string, string> {
  return {
    o: "#303030",
    h: l.cap, H: l.capLight || shade(l.cap, 0.4), k: l.hair,
    s: l.skin, S: l.skinShade || shade(l.skin, -0.14),
    j: l.top, J: l.topDark || shade(l.top, -0.25),
    w: l.shirt, p: l.pants, b: l.shoes,
  };
}

/** Los 4 sentidos × 3 cuadros (quieto, paso izquierdo, paso derecho). */
function makeCharSprites(l: Look): Record<Dir, HTMLCanvasElement[]> {
  const pal = lookPalette(l);
  return {
    down: LEGS_FRONT.map((x) => spriteFrom([...BODY.down, ...x], false, pal)),
    up: LEGS_FRONT.map((x) => spriteFrom([...BODY.up, ...x], false, pal)),
    left: LEGS_SIDE.map((x) => spriteFrom([...BODY.left, ...x], false, pal)),
    right: LEGS_SIDE.map((x) => spriteFrom([...BODY.left, ...x], true, pal)),
  };
}

const PLAYER_LOOK: Look = {
  cap: "#3a9a52", capLight: "#78d088", hair: "#704828", skin: "#f8d0a8", skinShade: "#d8a078",
  top: "#f08838", topDark: "#c05818", shirt: "#f8f8f8", pants: "#4a5a90", shoes: "#383838",
};
