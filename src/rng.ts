// =====================================================================
//  Aleatoriedad inyectable (ADR 0002). El motor nunca llama a Math.random:
//  recibe un Rng. El servidor usa uno criptográfico con semilla por partida;
//  el cliente offline y los tests usan sfc32 con una semilla de texto.
// =====================================================================

interface Rng {
  /** Número en [0, 1). */
  next(): number;
}

/** Mezcla un texto en 4 enteros de 32 bits (xmur3 de bryc). */
function seedWords(seed: string): [number, number, number, number] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const out: number[] = [];
  for (let k = 0; k < 4; k++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    out.push((h ^= h >>> 16) >>> 0);
  }
  return out as [number, number, number, number];
}

/** PRNG sfc32: determinista a partir de la semilla (misma semilla = misma secuencia). No apto para el servidor (no es impredecible). */
function sfc32(seed: string): Rng {
  let [a, b, c, d] = seedWords(seed);
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // descarta las primeras salidas
  return { next };
}

/**
 * Semilla aleatoria para el modo local (offline) del cliente. Es la única función del
 * núcleo que usa una fuente no determinista, y solo la llama el navegador: el servidor
 * le pasa al motor su propio Rng.
 */
function randomSeed(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return Array.from(c.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join("-");
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 4294967296).toString(16)).join("-");
}
