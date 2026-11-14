// Utilidades compartidas del servidor (solo node:*, sintaxis TypeScript "borrable").

import type { IncomingMessage } from "node:http";

/** Error de validación (equivale al ValueError del servidor Python). */
export class ValueError extends Error {}

export function isObj(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Recorta por puntos de código (como `s[:n]` de Python), no por unidades UTF-16. */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

/** `str(v)` de Python para los valores que puede traer un JSON. */
export function pyStr(v: unknown): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** `int(v)` de Python: número → trunca; texto numérico → entero; bool → 0/1; el resto → null (era TypeError/ValueError). */
export function pyInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

/** Asigna una propiedad propia aunque la clave sea "__proto__". */
export function setOwn(o: Record<string, any>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Lee exactamente `n` bytes del cuerpo del pedido. */
export function readBytes(req: IncomingMessage, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    req.on("data", (c: Buffer) => {
      got += c.length;
      if (got > n) return; // más de lo declarado: se ignora el resto
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("close", () => { if (!req.complete) reject(new Error("Conexión cortada.")); });
  });
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodifica UTF-8 estricto (con BOM = error, como `bytes.decode("utf-8")` + json.loads) y parsea el JSON. */
export function parseJson(buf: Buffer | Uint8Array): unknown {
  return JSON.parse(UTF8.decode(buf));
}

export function decodeUtf8(buf: Buffer | Uint8Array): string {
  return UTF8.decode(buf);
}
