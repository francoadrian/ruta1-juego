// Corre tests/api.contract.test.ts contra el servidor Python actual (server.py), todo temporal:
//   - DB, catálogo, mundo y assets en una carpeta temporal (nunca toca data/game.db ni assets/ reales)
//   - puertos libres para el juego y la API de admin, solo en 127.0.0.1
//   - tokens de admin creados con el CLI (`python server.py admin-token new --write`), uno de ellos revocado
//
//   node tests/run-against-python.mjs            (PYTHON=python3 si "python" no es el intérprete)
//   Los argumentos extra pasan a `node --test` (p. ej. --test-name-pattern=estáticos).

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || "python";
const QUOTA_MB = 1;

const tmp = mkdtempSync(path.join(os.tmpdir(), "ruta1-contract-"));
const dataDir = path.join(tmp, "data");
const assetsDir = path.join(tmp, "assets");
mkdirSync(dataDir);
mkdirSync(assetsDir);
for (const f of ["catalog.json", "world.json"]) copyFileSync(path.join(ROOT, "data", f), path.join(dataDir, f));

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const gamePort = await freePort();
let adminPort = await freePort();
while (adminPort === gamePort) adminPort = await freePort();

const baseEnv = {
  ...process.env,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  GAME_HOST: "127.0.0.1",
  GAME_PORT: String(gamePort),
  ADMIN_HOST: "127.0.0.1",
  ADMIN_PORT: String(adminPort),
  GAME_DB: path.join(tmp, "game.db"),
  GAME_DATA_DIR: dataDir,
  GAME_ASSETS_DIR: assetsDir,
  GAME_MAX_ASSETS_MB: String(QUOTA_MB),
};

function cli(tokenFile, ...args) {
  const r = spawnSync(PYTHON, ["server.py", "admin-token", ...args], {
    cwd: ROOT,
    env: { ...baseEnv, TCG_ADMIN_TOKEN_FILE: tokenFile },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`admin-token ${args.join(" ")} falló: ${r.stderr || r.stdout}`);
  return r.stdout;
}

let server;
let code = 1;
async function cleanup() {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((res) => { server.once("exit", res); setTimeout(res, 3000); });
  }
  for (let i = 0; i < 10; i++) {
    try { rmSync(tmp, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  console.error(`AVISO: no pude borrar ${tmp}`);
}

try {
  // Tokens: uno vigente y uno revocado.
  const okFile = path.join(tmp, "admin-token");
  const revFile = path.join(tmp, "admin-token-revocado");
  cli(okFile, "new", "contrato", "--write");
  const out = cli(revFile, "new", "revocado", "--write");
  cli(okFile, "revoke", out.match(/#(\d+)/)[1]);
  const adminToken = readFileSync(okFile, "utf8").trim();
  const revokedToken = readFileSync(revFile, "utf8").trim();

  // Servidor.
  server = spawn(PYTHON, ["server.py"], { cwd: ROOT, env: baseEnv, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d; });
  const ready = (port) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (server.exitCode !== null) return reject(new Error(`el servidor murió: ${stderr}`));
        if (Date.now() - t0 > 20000) return reject(new Error("el servidor no levantó a tiempo"));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
  await Promise.all([ready(gamePort), ready(adminPort)]);

  const env = {
    ...process.env,
    GAME_URL: `http://127.0.0.1:${gamePort}`,
    GAME_ADMIN_URL: `http://127.0.0.1:${adminPort}`,
    ADMIN_TOKEN: adminToken,
    REVOKED_ADMIN_TOKEN: revokedToken,
    ASSETS_QUOTA_MB: String(QUOTA_MB),
  };
  console.log(`Servidor Python de prueba: juego ${env.GAME_URL}, admin ${env.GAME_ADMIN_URL} (datos en ${tmp})`);
  const t = spawn(process.execPath, ["--test", ...process.argv.slice(2), path.join(ROOT, "tests", "api.contract.test.ts")], {
    cwd: ROOT, env, stdio: "inherit",
  });
  code = await new Promise((res) => t.on("exit", (c) => res(c ?? 1)));
} catch (e) {
  console.error(String(e?.message || e));
} finally {
  await cleanup();
}
process.exit(code);
