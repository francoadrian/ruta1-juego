// Contenido del juego: catálogo (cartas, sobres) y mundo (mapas, NPCs) + assets (port 1:1 de juego/content.py).
//
// El servidor del juego es el único dueño de estos archivos: lectura, validación, `rev`
// (16 hex del sha256 del archivo guardado), backup (`*.backup.json`) y escritura atómica (tmp + rename).
// Hay una caché en memoria por archivo, invalidada por (mtime, tamaño).
// Todo es síncrono: dentro de un proceso las operaciones no se intercalan (reemplaza al lock de Python).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ValueError, cut, decodeUtf8, isObj, pyStr } from "./util.ts";

const UPLOAD_DIRS: Record<string, string> = { card: "cards", back: "backs", pack: "packs" };
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MAX_UPLOAD = 15 * 1024 * 1024;
// Tope de espacio total de assets (GAME_MAX_ASSETS_MB); al superarlo, 413.
const MAX_ASSETS_TOTAL = Number.parseInt(process.env.GAME_MAX_ASSETS_MB || "500", 10) * 1024 * 1024;

export class AssetQuota extends Error {}
export class ContentConflict extends Error {
  rev: string | null;
  constructor(rev: string | null) {
    super("conflict");
    this.rev = rev;
  }
}
export class ContentCorrupt extends Error {}

/** MIME real según los magic bytes (png/jpeg/webp/gif), o null. */
export function sniffImage(raw: Buffer): string | null {
  if (raw.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (raw.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  const h6 = raw.subarray(0, 6).toString("latin1");
  if (h6 === "GIF87a" || h6 === "GIF89a") return "image/gif";
  if (raw.subarray(0, 4).toString("latin1") === "RIFF" && raw.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function slug(s: string): string {
  s = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cut(s, 48) || "img";
}

export function revOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const nonEmptyStr = (i: unknown): boolean => typeof i === "string" && i !== "";
const hasUniqueIds = (items: any[]): boolean => {
  const ids = items.map((x) => x.id);
  return ids.every(nonEmptyStr) && new Set(ids).size === ids.length;
};
// `d.get(key, [])` de Python: si la clave existe (aunque sea null) se usa su valor.
const getOr = (d: Record<string, any>, k: string, dflt: unknown): any => (Object.hasOwn(d, k) ? d[k] : dflt);

export function validateCatalog(catalog: unknown): void {
  if (!isObj(catalog) || !Array.isArray(catalog.cards)) throw new ValueError("El catálogo debe tener una lista 'cards'.");
  if (catalog.cards.some((c: unknown) => !isObj(c))) throw new ValueError("Cada carta debe ser un objeto.");
  if (!hasUniqueIds(catalog.cards)) throw new ValueError("Cada carta necesita un id único.");
  const boosters = getOr(catalog, "boosters", []);
  if (!Array.isArray(boosters) || boosters.some((b: unknown) => !isObj(b))) {
    throw new ValueError("Los sobres deben ser una lista de objetos.");
  }
}

export function validateWorld(world: unknown): void {
  if (!isObj(world) || !Array.isArray(world.maps) || world.maps.length === 0) {
    throw new ValueError("El mundo necesita al menos un mapa.");
  }
  if (world.maps.some((m: unknown) => !isObj(m))) throw new ValueError("Cada mapa debe ser un objeto.");
  if (!hasUniqueIds(world.maps)) throw new ValueError("Cada mapa necesita un id único.");
  for (const mp of world.maps) {
    const rows = mp.tiles;
    const len = (r: string) => Array.from(r).length;
    if (!Array.isArray(rows) || rows.length === 0 || rows.some((r: unknown) => typeof r !== "string" || len(r) !== len(rows[0]))) {
      throw new ValueError(`Las filas del mapa ${pyStr(mp.id ?? null)} deben tener todas el mismo largo.`);
    }
  }
  const npcs = getOr(world, "npcs", []);
  if (!Array.isArray(npcs) || npcs.some((n: unknown) => !isObj(n))) throw new ValueError("Los NPCs deben ser una lista de objetos.");
  if (!hasUniqueIds(npcs)) throw new ValueError("Cada NPC necesita un id único.");
}

class Doc {
  file: string;
  backup: string;
  validate: (o: unknown) => void;
  label: string;
  private sig: string | null = null;
  private rawBuf: Buffer | null = null;
  private obj: unknown = null;

  constructor(file: string, backup: string, validate: (o: unknown) => void, label: string) {
    this.file = file;
    this.backup = backup;
    this.validate = validate;
    this.label = label;
  }

  /** [raw, obj] o [null, null] si no existe. Caché por mtime+tamaño. Lanza ContentCorrupt si no es JSON. */
  private load(): [Buffer | null, unknown] {
    const st = statSync(this.file, { bigint: true, throwIfNoEntry: false });
    if (!st) {
      this.sig = this.rawBuf = this.obj = null;
      return [null, null];
    }
    const sig = `${st.mtimeNs}:${st.size}`;
    if (sig !== this.sig) {
      const raw = readFileSync(this.file);
      let obj: unknown;
      try {
        obj = JSON.parse(decodeUtf8(raw));
      } catch (e) {
        throw new ContentCorrupt(`${path.basename(this.file)} está dañado: ${(e as Error).message}`);
      }
      this.sig = sig;
      this.rawBuf = raw;
      this.obj = obj;
    }
    return [this.rawBuf, this.obj];
  }

  raw(): Buffer | null {
    try {
      return this.load()[0];
    } catch (e) {
      if (e instanceof ContentCorrupt) return null;
      throw e;
    }
  }

  /** [rev, obj] o [null, null] si no existe. */
  get(): [string | null, unknown] {
    const [raw, obj] = this.load();
    return raw !== null ? [revOf(raw), obj] : [null, null];
  }

  objectOrNull(): any {
    try {
      return this.get()[1];
    } catch (e) {
      if (e instanceof ContentCorrupt) return null;
      throw e;
    }
  }

  /** Valida y guarda si `rev` coincide con el actual (null si no existe). Devuelve el rev nuevo. */
  put(rev: string | null, obj: unknown): string {
    this.validate(obj);
    let raw: Buffer | null;
    let corrupt = false;
    try {
      raw = this.load()[0];
    } catch (e) {
      if (!(e instanceof ContentCorrupt)) throw e;
      raw = readFileSync(this.file); // dañado: se permite pisarlo (queda en el backup)
      corrupt = true;
    }
    const current = raw !== null ? revOf(raw) : null;
    if (rev !== current && !corrupt) throw new ContentConflict(current);
    const data = Buffer.from(JSON.stringify(obj, null, 1), "utf8");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (raw !== null) writeFileSync(this.backup, raw);
    const ext = path.extname(this.file);
    const tmp = this.file.slice(0, this.file.length - ext.length) + ".tmp";
    writeFileSync(tmp, data);
    renameSync(tmp, this.file);
    this.sig = null; // fuerza el recargo con el stat real
    return revOf(data);
  }
}

export class Content {
  dataDir: string;
  assetsDir: string;
  catalog: Doc;
  world: Doc;

  constructor(dataDir: string, assetsDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.assetsDir = path.resolve(assetsDir);
    this.catalog = new Doc(path.join(this.dataDir, "catalog.json"), path.join(this.dataDir, "catalog.backup.json"), validateCatalog, "catálogo");
    this.world = new Doc(path.join(this.dataDir, "world.json"), path.join(this.dataDir, "world.backup.json"), validateWorld, "mundo");
  }

  // --- consultas para el juego ----------------------------------------------------
  boosterDef(bid: string): Record<string, any> | null {
    const cat = this.catalog.objectOrNull();
    if (!cat) return null;
    const list = getOr(cat, "boosters", []);
    return (Array.isArray(list) ? list : []).find((b: any) => b.id === bid) ?? null;
  }

  cardIds(): Set<string> | null {
    const cat = this.catalog.objectOrNull();
    return cat ? new Set<string>(cat.cards.map((c: any) => c.id)) : null;
  }

  boosterIds(): Set<unknown> | null {
    const cat = this.catalog.objectOrNull();
    return cat ? new Set<unknown>(getOr(cat, "boosters", []).map((b: any) => b.id)) : null;
  }

  // --- assets ---------------------------------------------------------------------
  assetsSize(): number {
    let total = 0;
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else {
          try { total += statSync(f).size; } catch { /* se ignora */ }
        }
      }
    };
    walk(this.assetsDir);
    return total;
  }

  /** Valida y guarda una imagen. Devuelve la ruta pública `assets/<carpeta>/<slug>-<sha1>.<ext>`. */
  saveAsset(kind: unknown, name: unknown, dataUrl: unknown): string {
    const folder = typeof kind === "string" && Object.hasOwn(UPLOAD_DIRS, kind) ? UPLOAD_DIRS[kind] : null;
    if (!folder) throw new ValueError("Tipo de imagen desconocido.");
    const m = /^data:(image\/[a-z+.-]+);base64,([\s\S]*)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
    if (!m || !Object.hasOwn(MIME_EXT, m[1])) throw new ValueError("Formato no soportado (usá PNG, JPG, WEBP o GIF).");
    const b64 = m[2];
    // b64decode(validate=True): solo el alfabeto, largo múltiplo de 4 y hasta 2 '=' al final
    const body = b64.replace(/={1,2}$/, "");
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*$/.test(body)) throw new ValueError("Imagen inválida.");
    const raw = Buffer.from(b64, "base64");
    if (raw.length > MAX_UPLOAD) throw new ValueError("La imagen supera los 15 MB.");
    if (raw.length === 0) throw new ValueError("Imagen vacía.");
    if (sniffImage(raw) !== m[1]) throw new ValueError("El contenido no coincide con el formato declarado.");
    const sha1 = createHash("sha1").update(raw).digest("hex").slice(0, 10);
    const fname = `${slug(name ? pyStr(name) : "img")}-${sha1}.${MIME_EXT[m[1]]}`;
    const target = path.join(this.assetsDir, folder, fname);
    if (!existsSync(target) && this.assetsSize() + raw.length > MAX_ASSETS_TOTAL) {
      throw new AssetQuota("Se alcanzó el tope de espacio para imágenes.");
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, raw);
    return `assets/${folder}/${fname}`;
  }
}
