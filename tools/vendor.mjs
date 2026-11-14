// Copia typescript.js desde node_modules a vendor/ (ADR 0002 §5: el navegador no baja nada de un CDN).
//
//   npm ci && node tools/vendor.mjs          → vendor/typescript.js (lo sirve el servidor en /vendor/typescript.js)
//   node tools/vendor.mjs <carpeta del paquete typescript>   (opcional: otra ubicación)
//
// La versión sale de package-lock.json (con su hash de integridad). vendor/ está en .gitignore:
// es un artefacto de instalación, igual que node_modules.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = path.resolve(process.argv[2] ?? path.join(root, "node_modules", "typescript"));
const src = path.join(pkg, "lib", "typescript.js");
if (!fs.existsSync(src)) {
  console.error(`No encuentro ${src}. Corré "npm ci" primero (typescript tiene que estar en devDependencies).`);
  process.exit(1);
}
const out = path.join(root, "vendor", "typescript.js");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(src, out);
const version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
console.log(`vendor/typescript.js ← typescript@${version} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
