// Validación de Host/Origin y límites de pedidos (ADR 0002, 3.2 y 5). Solo node:*.
//
// Con un túnel (Tailscale/Cloudflare) TODO llega desde loopback: nada se exime por venir de 127.0.0.1.

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Lista de una variable de entorno separada por comas (vacía/ausente = null). */
export function envList(raw: string | undefined): string[] | null {
  const items = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : null;
}

/** Nombre de host de una cabecera Host (sin puerto; conserva los corchetes de IPv6). */
export function hostName(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const i = h.indexOf("]");
    return i < 0 ? "" : h.slice(0, i + 1);
  }
  return h.split(":", 1)[0];
}

/** `*.ts.net` acepta cualquier subdominio (no el dominio pelado); `*` acepta todo; el resto es exacto. */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.length > pattern.length - 1 && host.endsWith(pattern.slice(1));
  return host === pattern;
}

export class Access {
  /** null = cualquier Host (solo si se pidió LAN o `*`). */
  hosts: string[] | null;
  /** null = se deriva de `hosts` (cualquier esquema y puerto). */
  origins: string[] | null;

  constructor(hosts: string[] | null, origins: string[] | null) {
    this.hosts = hosts;
    this.origins = origins;
  }

  hostOk(hostHeader: string | undefined): boolean {
    if (this.hosts === null) return true;
    if (!hostHeader) return false;
    const h = hostName(hostHeader);
    return h !== "" && this.hosts.some((p) => hostMatches(h, p));
  }

  /**
   * Sin cabecera Origin se acepta (curl, apps nativas, navegación directa); con Origin tiene que estar permitido.
   * Con ALLOWED_ORIGINS: esquema exacto y host (con comodín `*.`); si el patrón trae puerto, el puerto tiene que coincidir.
   * Sin ALLOWED_ORIGINS: vale cualquier http(s) cuyo host esté en ALLOWED_HOSTS.
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
    const host = hostName(u.host);
    if (this.origins === null) return this.hosts === null || this.hosts.some((p) => hostMatches(host, p));
    return this.origins.some((p) => {
      const m = /^(https?:)\/\/(.+)$/.exec(p);
      if (!m || m[1] !== u.protocol) return false;
      const hasPort = /:\d+$/.test(m[2]);
      const patHost = hasPort ? m[2].replace(/:\d+$/, "") : m[2];
      return hostMatches(host, patHost) && (!hasPort || m[2].endsWith(`:${u.port || (u.protocol === "https:" ? "443" : "80")}`));
    });
  }
}

/** Por defecto solo loopback. Si el servidor escucha fuera de loopback y no se configuró ALLOWED_HOSTS, no se filtra el Host (y se avisa). */
export function accessFromEnv(env: NodeJS.ProcessEnv, gameHost: string): { access: Access; lanWarning: boolean } {
  let hosts = envList(env.ALLOWED_HOSTS);
  let lanWarning = false;
  if (hosts === null) {
    if (["127.0.0.1", "localhost", "::1"].includes(gameHost)) hosts = [...LOOPBACK_HOSTS];
    else lanWarning = true;
  } else if (hosts.includes("*")) hosts = null;
  return { access: new Access(hosts, envList(env.ALLOWED_ORIGINS)), lanWarning };
}

/** Ventana deslizante por clave: `hit` devuelve false si se pasó del límite. */
export class RateLimiter {
  private max: number;
  private windowMs: number;
  private hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  hit(key: string, t = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
    return true;
  }
}

/** Intentos fallidos con tope global (30/h por defecto): al agotarse, `blocked` es true hasta que venzan. */
export class FailureBudget {
  private max: number;
  private windowMs: number;
  private fails: number[] = [];

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private prune(t: number): void {
    this.fails = this.fails.filter((x) => x > t - this.windowMs);
  }

  blocked(t = Date.now()): boolean {
    this.prune(t);
    return this.fails.length >= this.max;
  }

  fail(t = Date.now()): void {
    this.prune(t);
    this.fails.push(t);
  }
}
