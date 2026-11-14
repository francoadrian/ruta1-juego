// Tests unitarios del endurecimiento (auditoría de seguridad): Host/Origin, límites con tope, presupuesto de fallos por clave,
// nombres de jugador, HMAC de invitaciones (con migración de filas viejas), log de partidas y poda. Sin servidor: usan una DB temporal.
//
//   node --test --no-warnings tests/hardening.test.ts      (o `npm run test:hardening`)

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Access, FailureBudget, RateLimiter, accessFromEnv, parseHost } from "../server/security.ts";
import { Store, cleanName, legacyInviteHash } from "../server/store.ts";

const tmps: string[] = [];
const tmpDb = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "ruta1-hard-"));
  tmps.push(d);
  return path.join(d, "t.db");
};
after(() => { for (const t of tmps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* WAL abierto en Windows */ } } });

describe("B3: parseHost / hostOk", () => {
  it("parsea nombre y puerto; rechaza userinfo, espacios, barras y caracteres raros", () => {
    assert.deepEqual(parseHost("LocalHost:8123"), { name: "localhost", port: 8123 });
    assert.deepEqual(parseHost("[::1]:8123"), { name: "[::1]", port: 8123 });
    assert.deepEqual(parseHost("mi-pc.tail1234.ts.net"), { name: "mi-pc.tail1234.ts.net", port: null });
    assert.deepEqual(parseHost("localhost.:80"), { name: "localhost", port: 80 });
    for (const bad of ["", "a@b.com", "localhost@evil.com", "localhost evil.com", "evil.com/", "evil.com?x", "evil.com#x", "ev\\il.com", "a b", "ñandú.com", "evil.com\u0000", "localhost:abc", "[::1", "a:b:c"]) {
      assert.equal(parseHost(bad), null, JSON.stringify(bad));
    }
  });

  it("compara el puerto solo para nombres de loopback", () => {
    const a = accessFromEnv({}, "127.0.0.1", 8123).access;
    assert.ok(a.hostOk("localhost:8123"));
    assert.ok(a.hostOk("127.0.0.1")); // sin puerto: lo reenvía un proxy local
    assert.ok(!a.hostOk("localhost:9999"));
    assert.ok(!a.hostOk("localhost@evil.com"));
    assert.ok(!a.hostOk("evil.com"));
    assert.ok(!a.hostOk(undefined));
    const b = accessFromEnv({ ALLOWED_HOSTS: "mi-pc.tail1234.ts.net,localhost" }, "127.0.0.1", 8123).access;
    assert.ok(b.hostOk("mi-pc.tail1234.ts.net"));
    assert.ok(b.hostOk("mi-pc.tail1234.ts.net:443")); // el puerto de afuera no importa para nombres que no son loopback
    assert.ok(!b.hostOk("otra.tail1234.ts.net"));
  });
});

describe("B2: Origin derivado de ALLOWED_HOSTS", () => {
  it("loopback: solo con bind en loopback y el puerto del juego", () => {
    const a = accessFromEnv({}, "127.0.0.1", 8123).access;
    assert.ok(a.originOk("http://localhost:8123"));
    assert.ok(a.originOk("http://127.0.0.1:8123"));
    assert.ok(!a.originOk("http://localhost:5173"), "otro puerto de localhost es otra app");
    assert.ok(!a.originOk("http://localhost"), "puerto 80");
    assert.ok(!a.originOk("http://evil.com"));
    assert.ok(a.originOk(undefined));
    const lan = new Access(["localhost"], null, { gamePort: 8123, loopbackBind: false });
    assert.ok(!lan.originOk("http://localhost:8123"), "con bind fuera de loopback localhost no vale de Origin");
  });

  it("host concreto: se deriva https://host (443) o http://host:<puerto del juego>; el comodín deja pasar cualquier puerto", () => {
    const a = accessFromEnv({ ALLOWED_HOSTS: "mi-pc.tail1234.ts.net,localhost" }, "127.0.0.1", 8123).access;
    assert.ok(a.originOk("https://mi-pc.tail1234.ts.net"));
    assert.ok(a.originOk("http://mi-pc.tail1234.ts.net:8123"));
    assert.ok(!a.originOk("https://mi-pc.tail1234.ts.net:8443"));
    assert.ok(!a.originOk("http://mi-pc.tail1234.ts.net"));
    assert.ok(!a.originOk("https://otro.tail1234.ts.net"));
    assert.ok(a.originOk("http://localhost:8123"));
    const w = accessFromEnv({ ALLOWED_HOSTS: "*.ts.net" }, "127.0.0.1", 8123).access;
    assert.ok(w.originOk("https://cualquiera.ts.net:8443"));
  });

  it("ALLOWED_ORIGINS explícito manda sobre todo", () => {
    const a = accessFromEnv({ ALLOWED_HOSTS: "mi-pc.tail1234.ts.net,localhost", ALLOWED_ORIGINS: "https://mi-pc.tail1234.ts.net" }, "127.0.0.1", 8123).access;
    assert.ok(a.originOk("https://mi-pc.tail1234.ts.net"));
    assert.ok(!a.originOk("http://localhost:8123"));
    assert.ok(!a.originOk("https://evil.com"));
    assert.ok(!a.originOk("https://user:pw@mi-pc.tail1234.ts.net"));
  });
});

describe("B1/M4: límites con tope de memoria y presupuesto de fallos por clave", () => {
  it("RateLimiter: el mapa no pasa de maxKeys (descarta las claves menos usadas) y sigue limitando", () => {
    const r = new RateLimiter(2, 60_000, 100);
    for (let i = 0; i < 1000; i++) assert.ok(r.hit(`k${i}`, 1000 + i));
    assert.ok(r.size <= 100, `size ${r.size}`);
    assert.ok(r.hit("x", 5000));
    assert.ok(r.hit("x", 5001));
    assert.ok(!r.hit("x", 5002));
    assert.ok(r.hit("x", 5000 + 61_000)); // la ventana venció
  });

  it("FailureBudget: bloquea por clave, no a las otras; el global avisa pero no bloquea por sí mismo", () => {
    const b = new FailureBudget(3, 10, 3_600_000, 50);
    for (let i = 0; i < 3; i++) b.fail("1.1.1.1", 1000 + i);
    assert.ok(b.blocked("1.1.1.1", 2000));
    assert.ok(!b.blocked("2.2.2.2", 2000));
    assert.ok(!b.globalExhausted(2000));
    for (let i = 0; i < 7; i++) b.fail(`9.9.9.${i}`, 3000);
    assert.ok(b.globalExhausted(3500));
    assert.ok(!b.blocked("2.2.2.2", 3500), "agotar el global no bloquea a una IP limpia");
    assert.ok(!b.globalExhausted(3_700_000), "vence con la ventana");
    for (let i = 0; i < 500; i++) b.fail(`a${i}`, 4_000_000);
  });
});

describe("B5: nombres de jugador", () => {
  it("cleanName saca caracteres invisibles y de dirección, normaliza espacios y recorta a 24", () => {
    assert.equal(cleanName("  A​B‮C⁦D﻿E  "), "ABCDE");
    assert.equal(cleanName("Fran   Tomi X"), "Fran Tomi X");
    assert.equal(cleanName("a\u0000b\n"), "ab");
    assert.equal(cleanName("x".repeat(40)), "x".repeat(24));
    assert.equal(cleanName("​‌"), "");
    assert.equal(cleanName(undefined), "");
  });

  it("alta: un nombre repetido (sin importar mayúsculas ni Unicode equivalente) se desambigua con un número; renombrar a uno ocupado es 400", () => {
    const st = new Store(tmpDb());
    try {
      const code = st.createInvite("t", 20, 1);
      const [a] = st.createPlayer("Tomi", code, 30);
      const [b] = st.createPlayer("TOMI", code, 30);
      const [c] = st.createPlayer("t​omi", code, 30);
      const [d] = st.createPlayer("Ｔomi", code, 30); // T de ancho completo (NFKC = "t")
      assert.equal(a.name, "Tomi");
      assert.equal(b.name, "TOMI 2");
      assert.equal(c.name, "tomi 3");
      assert.equal(d.name, "Ｔomi 4");
      assert.throws(() => st.renamePlayer(a.id, "tomi 2"), /Ya hay un jugador/);
      assert.equal(st.renamePlayer(a.id, "TOMI")?.name, "TOMI", "renombrarse a sí mismo (otra capitalización) sí se puede");
      assert.equal(st.renamePlayer("J-NOEXIS", "Tomi"), null);
      const long = "x".repeat(24);
      const [e] = st.createPlayer(long, code, 30);
      const [f] = st.createPlayer(long, code, 30);
      assert.equal(e.name, long);
      assert.equal(f.name.length, 24);
      assert.ok(f.name.endsWith(" 2"));
    } finally { st.close(); }
  });
});

describe("B11: invitaciones con HMAC y migración de filas viejas", () => {
  it("el hash ya no es sha256 del código y depende de la clave guardada en la base; las filas viejas se aceptan y migran", () => {
    const file = tmpDb();
    const st = new Store(file);
    const code = st.createInvite("nueva", 1, 1);
    const plain = code.replace("-", "");
    const sha = createHash("sha256").update(plain).digest("hex");
    const db = new DatabaseSync(file);
    const rows = db.prepare("SELECT code_hash FROM invites").all().map((r: any) => r.code_hash);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0], sha, "el hash no puede ser el sha256 pelado");
    // una invitación "vieja" (sha256 sin clave), como las que ya existen en data/game.db
    const old = "ABCDEFGH";
    db.prepare("INSERT INTO invites (code_hash, label, uses_left, expires, created) VALUES (?,?,?,?,?)").run(legacyInviteHash(old), "vieja", 2, Date.now() / 1000 + 3600, 1);
    db.close();
    const [p1] = st.createPlayer("A", "ABCD-EFGH", 30);
    assert.ok(p1.id);
    const db2 = new DatabaseSync(file);
    const migrated = db2.prepare("SELECT code_hash, uses_left FROM invites WHERE label='vieja'").get() as any;
    assert.notEqual(migrated.code_hash, legacyInviteHash(old), "la fila se migró al hash nuevo");
    assert.equal(migrated.uses_left, 1);
    db2.close();
    st.createPlayer("B", "abcdefgh", 30); // segunda vez, ya con el hash nuevo
    assert.throws(() => st.createPlayer("C", "ABCD-EFGH", 30), /inválido o usado/);
    st.close();
    // la clave persiste: reabrir la base sigue reconociendo las invitaciones nuevas
    const st2 = new Store(file);
    const [p3] = st2.createPlayer("D", code, 30);
    assert.ok(p3.id);
    // y revocar acepta código viejo o nuevo
    st2.close();
  });

  it("revocar una invitación vieja (hash sha256) por su código", () => {
    const file = tmpDb();
    const st = new Store(file);
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO invites (code_hash, label, uses_left, expires, created) VALUES (?,?,?,?,?)").run(legacyInviteHash("ZZZZ2222"), "v", 1, null, 1);
    db.close();
    assert.ok(st.revokeInvite("ZZZZ-2222"));
    assert.ok(!st.revokeInvite("ZZZZ-2222"));
    st.close();
  });
});

describe("M3: log de intents incremental y poda de partidas", () => {
  const mk = (st: Store, id: string): void => st.matchStart({ id, kind: "npc", p0: "J-A", p1: "npc:x", seed: "s", catalogRev: null, decks: [] });
  const intents = (file: string, id: string): any => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return JSON.parse((db.prepare("SELECT intents FROM matches WHERE id=?").get(id) as any).intents); } finally { db.close(); }
  };

  it("matchIntents y matchEnd agregan al final sin reescribir; el resultado siempre es un arreglo JSON válido", () => {
    const file = tmpDb();
    const st = new Store(file);
    mk(st, "M-1");
    st.matchIntents("M-1", []); // nada
    st.matchIntents("M-1", [{ a: 1 }, { a: 2 }]);
    st.matchIntents("M-1", [{ a: 3 }]);
    assert.deepEqual(intents(file, "M-1"), [{ a: 1 }, { a: 2 }, { a: 3 }]);
    st.matchEnd("M-1", 0, "normal", { x: 1 }, [{ a: 4 }, { b: "con \"comillas\", comas y ]" }]);
    assert.deepEqual(intents(file, "M-1"), [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { b: "con \"comillas\", comas y ]" }]);
    mk(st, "M-2");
    st.matchEnd("M-2", null, "void", null, []);
    assert.deepEqual(intents(file, "M-2"), []);
    mk(st, "M-3");
    st.matchEnd("M-3", null, "void", null, [{ z: 1 }]);
    assert.deepEqual(intents(file, "M-3"), [{ z: 1 }]);
    st.close();
  });

  it("pruneMatches borra solo las terminadas hace más de N días", () => {
    const file = tmpDb();
    const st = new Store(file);
    for (const id of ["M-OLD", "M-NEW", "M-OPEN"]) mk(st, id);
    st.matchEnd("M-OLD", 0, "normal", null, []);
    st.matchEnd("M-NEW", 0, "normal", null, []);
    const db = new DatabaseSync(file);
    db.prepare("UPDATE matches SET ended=? WHERE id='M-OLD'").run(Date.now() / 1000 - 40 * 86400);
    db.prepare("UPDATE matches SET started=? WHERE id='M-OPEN'").run(Date.now() / 1000 - 90 * 86400);
    db.close();
    assert.equal(st.pruneMatches(30), 1);
    const db2 = new DatabaseSync(file, { readOnly: true });
    const left = (db2.prepare("SELECT id FROM matches ORDER BY id").all() as any[]).map((r) => r.id);
    db2.close();
    assert.deepEqual(left, ["M-NEW", "M-OPEN"]);
    st.close();
  });
});
