// Validación de Host/Origin y límites de pedidos (ADR 0002, 3.2 y 5). Solo node:*.
//
// Con un túnel (Tailscale/Cloudflare) TODO llega desde loopback: nada se exime por venir de 127.0.0.1.

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const isLoopbackName = (h: string): boolean => LOOPBACK_HOSTS.includes(h);

/** Lista de una variable de entorno separada por comas (vacía/ausente = null). */
export function envList(raw: string | undefined): string[] | null {
  const items = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : null;
}

/**
 * Parsea una cabecera Host de verdad (con `new URL`): rechaza userinfo (`a@b`), espacios, barras, `?`, `#` y cualquier
 * carácter fuera de [a-z0-9.-_:[]]. Devuelve el nombre en minúsculas (sin punto final, con corchetes si es IPv6) y el
 * puerto escrito en la cabecera (null si no lo trae), o null si no es un Host válido.
 */
export function parseHost(hostHeader: string): { name: string; port: number | null } | null {
  const raw = hostHeader.trim();
  if (!raw || raw.length > 255 || !/^[a-z0-9._:[\]-]+$/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL("http://" + raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  const pm = /^(?:\[[^\]]*\]|[^:[\]]*):(\d{1,5})$/.exec(raw); // el puerto como lo escribieron (new URL descarta el :80)
  const name = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!name) return null;
  return { name, port: pm ? Number(pm[1]) : null };
}

/** Nombre de host de una cabecera Host (sin puerto; conserva los corchetes de IPv6). "" si no es válida. */
export function hostName(hostHeader: string): string {
  return parseHost(hostHeader)?.name ?? "";
}

/** `*.ts.net` acepta cualquier subdominio (no el dominio pelado); `*` acepta todo; el resto es exacto. */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.length > pattern.length - 1 && host.endsWith(pattern.slice(1));
  return host === pattern;
}

export interface AccessOpts {
  /** Puerto del juego: un Host/Origin loopback con otro puerto se rechaza. */
  gamePort?: number;
  /** El servidor escucha solo en loopback: únicamente entonces vale un Origin `localhost:<puerto del juego>`. */
  loopbackBind?: boolean;
}

export class Access {
  /** null = cualquier Host (solo si se pidió LAN o `*`). */
  hosts: string[] | null;
  /** null = se deriva de `hosts`. */
  origins: string[] | null;
  gamePort: number | undefined;
  loopbackBind: boolean;

  constructor(hosts: string[] | null, origins: string[] | null, opts: AccessOpts = {}) {
    this.hosts = hosts;
    this.origins = origins;
    this.gamePort = opts.gamePort;
    this.loopbackBind = opts.loopbackBind ?? true;
  }

  hostOk(hostHeader: string | undefined): boolean {
    if (this.hosts === null) return true; // LAN/`*`: no se filtra el nombre
    const h = hostHeader === undefined ? null : parseHost(hostHeader);
    if (!h) return false;
    if (!this.hosts.some((p) => hostMatches(h.name, p))) return false;
    // un nombre de loopback con otro puerto es otro servicio local (o un rebinding): se rechaza
    if (isLoopbackName(h.name) && h.port !== null && this.gamePort !== undefined && h.port !== this.gamePort) return false;
    return true;
  }

  /**
   * Sin cabecera Origin se acepta (curl, apps nativas, navegación directa); con Origin tiene que estar permitido.
   * Con ALLOWED_ORIGINS: esquema exacto y host (con comodín `*.`); si el patrón trae puerto, el puerto tiene que coincidir.
   * Sin ALLOWED_ORIGINS se deriva de ALLOWED_HOSTS:
   *   - host concreto (`mi-pc.tailnet.ts.net`): `https://host` (puerto 443) o `http://host:<puerto del juego>`;
   *   - comodín (`*.ts.net`) o `*`: cualquier http(s) con ese host (por eso conviene fijar ALLOWED_ORIGINS);
   *   - loopback (`localhost`, `127.0.0.1`, `[::1]`): solo si el servidor escucha en loopback y el puerto es el del juego.
   */
  originOk(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false; // "null", "" u otra cosa rara
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (this.origins !== null) {
      return this.origins.some((p) => {
        const m = /^(https?:)\/\/(.+)$/.exec(p);
        if (!m || m[1] !== u.protocol) return false;
        const hasPort = /:\d+$/.test(m[2]);
        const patHost = hasPort ? m[2].replace(/:\d+$/, "") : m[2];
        return hostMatches(host, patHost) && (!hasPort || m[2].endsWith(`:${port}`));
      });
    }
    if (this.hosts === null) return true;
    if (!this.hosts.some((p) => hostMatches(host, p))) return false;
    if (isLoopbackName(host)) {
      return this.loopbackBind && (this.gamePort === undefined || port === this.gamePort);
    }
    const concrete = this.hosts.some((p) => p === host);
    if (!concrete) return true; // coincide por comodín: como antes
    return (u.protocol === "https:" && port === 443) || (u.protocol === "http:" && (this.gamePort === undefined || port === this.gamePort));
  }
}

/** Por defecto solo loopback. Si el servidor escucha fuera de loopback y no se configuró ALLOWED_HOSTS, no se filtra el Host (y se avisa). */
export function accessFromEnv(env: NodeJS.ProcessEnv, gameHost: string, gamePort?: number): { access: Access; lanWarning: boolean } {
  let hosts = envList(env.ALLOWED_HOSTS);
  let lanWarning = false;
  const loopbackBind = ["127.0.0.1", "localhost", "::1"].includes(gameHost);
  if (hosts === null) {
    if (loopbackBind) hosts = [...LOOPBACK_HOSTS];
    else lanWarning = true;
  } else if (hosts.includes("*")) hosts = null;
  return { access: new Access(hosts, envList(env.ALLOWED_ORIGINS), { gamePort, loopbackBind }), lanWarning };
}

/**
 * Ventana deslizante por clave: `hit` devuelve false si se pasó del límite. El mapa tiene tope (`maxKeys`): al llenarse
 * se barren las claves vencidas y, si sigue lleno, se descartan las menos usadas recientemente (LRU simple).
 */
export class RateLimiter {
  private max: number;
  private windowMs: number;
  private maxKeys: number;
  private hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number, maxKeys = 5000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.hits.size;
  }

  hit(key: string, t = Date.now()): boolean {
    const prev = this.hits.get(key);
    const arr = (prev ?? []).filter((x) => x > t - this.windowMs);
    // se re-inserta al final: el orden del Map es el orden de uso (LRU)
    this.hits.delete(key);
    let ok = true;
    if (arr.length >= this.max) ok = false;
    else arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) {
      for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
      for (const k of this.hits.keys()) {
        if (this.hits.size <= this.maxKeys) break;
        this.hits.delete(k);
      }
    }
    return ok;
  }
}

/**
 * Intentos fallidos con presupuesto POR CLAVE (IP del cliente) y un tope global muy alto como último recurso.
 * `blocked(key)` es true si esa clave agotó el suyo; `globalExhausted()` avisa que se agotó el global (el que llama decide:
 * un código válido nunca se bloquea por el global).
 */
export class FailureBudget {
  private perKey: number;
  private global: number;
  private windowMs: number;
  private maxKeys: number;
  private fails = new Map<string, number[]>();
  private all: number[] = [];

  constructor(perKey: number, global: number, windowMs: number, maxKeys = 5000) {
    this.perKey = perKey;
    this.global = global;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  private live(arr: number[] | undefined, t: number): number[] {
    return (arr ?? []).filter((x) => x > t - this.windowMs);
  }

  blocked(key: string, t = Date.now()): boolean {
    const arr = this.live(this.fails.get(key), t);
    if (arr.length) this.fails.set(key, arr); else this.fails.delete(key);
    return arr.length >= this.perKey;
  }

  globalExhausted(t = Date.now()): boolean {
    this.all = this.live(this.all, t);
    return this.all.length >= this.global;
  }

  fail(key: string, t = Date.now()): void {
    const arr = this.live(this.fails.get(key), t);
    arr.push(t);
    this.fails.delete(key);
    this.fails.set(key, arr);
    this.all = this.live(this.all, t);
    this.all.push(t);
    if (this.fails.size > this.maxKeys) {
      for (const [k, v] of this.fails) if (!v.some((x) => x > t - this.windowMs)) this.fails.delete(k);
      for (const k of this.fails.keys()) {
        if (this.fails.size <= this.maxKeys) break;
        this.fails.delete(k);
      }
    }
  }
}
