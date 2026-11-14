// Servidor de prueba del juego: puerto 8127 (admin en 8128) con base, catálogo, mundo e imágenes TEMPORALES.
// Nunca toca data/game.db ni assets/ reales. Al cortar (Ctrl+C) borra la carpeta temporal.
//
//   node tools/prueba.mjs        (es lo que corre la configuración `juego-prueba` de .claude/launch.json)
//
// Crea una invitación de 50 usos y muestra el link para entrar: http://localhost:8127/#invite=CODIGO
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruta1-prueba-"));
const dataDir = path.join(tmp, "data");
const assetsDir = path.join(tmp, "assets");
fs.mkdirSync(dataDir);
fs.mkdirSync(assetsDir);
for (const f of ["catalog.json", "world.json"]) fs.copyFileSync(path.join(root, "data", f), path.join(dataDir, f));

const PORT = process.env.PRUEBA_PORT || "8127";
const env = {
  ...process.env,
  GAME_DB: path.join(tmp, "game.db"),
  GAME_DATA_DIR: dataDir,
  GAME_ASSETS_DIR: assetsDir,
  ADMIN_PORT: process.env.PRUEBA_ADMIN_PORT || "8128",
  TCG_ADMIN_TOKEN_FILE: path.join(tmp, "admin-token"),
};
const main = path.join(root, "server", "main.ts");

const inv = spawnSync(process.execPath, ["--no-warnings", main, "invite", "new", "--uses", "50", "--days", "1", "prueba"], { env, encoding: "utf8" });
const code = /Código de invitación: (\S+)/.exec(inv.stdout ?? "")?.[1];
console.log(`[prueba] datos temporales en ${tmp}`);
if (code) console.log(`[prueba] entrá a http://localhost:${PORT}/#invite=${code}`);

const child = spawn(process.execPath, ["--no-warnings", main, PORT], { env, cwd: root, stdio: "inherit" });
const limpiar = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* en Windows puede estar abierta: queda en %TEMP% */ } };
child.on("exit", (c) => { limpiar(); process.exit(c ?? 0); });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
