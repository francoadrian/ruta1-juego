# Ruta 1 — TCG pixel-art

Juego de cartas estilo Pokémon TCG Base Set dentro de un mundo pixel-art estilo GBA, con un backoffice para editar cartas, mundo y jugadores. Todo en español (rioplatense): código comentado, textos de UI y commits.

## Cómo correrlo

Requiere **Node ≥ 24** (el servidor es TypeScript que Node ejecuta quitando tipos; usa `node:sqlite`). Una sola vez:

```
npm ci
node tools/vendor.mjs     # copia typescript.js a vendor/ (el navegador lo pide al servidor; si falta, el servidor lo genera al arrancar)
```

Configuraciones en `.claude/launch.json`:

- `ruta` → `node --no-warnings server/main.ts` (o `npm start`) → juego en http://localhost:8123. Escucha solo en `127.0.0.1` por defecto (`GAME_HOST=0.0.0.0` para LAN). Para jugar con amigos, ver `docs/hosting.md` (Tailscale).
- `juego-prueba` → `node tools/prueba.mjs` → mismo juego en el puerto 8127 (admin en 8128) con base, catálogo, mundo e imágenes **temporales** (no toca `data/game.db`); imprime un link con invitación.
- El backoffice vive en **otro repositorio privado** (`ruta1-backoffice`) y se corre desde ahí (http://127.0.0.1:8124). Necesita este juego corriendo y un token de admin (ver abajo).

### Tests

| Comando | Qué corre |
|---|---|
| `npm test` | Motor y núcleo sin red: `engine`, `view`, `packs`, `driver` (`tests/*.test.ts`) |
| `npm run test:api` | `tests/api.contract.test.ts` contra un servidor Node temporal (DB, datos y puertos propios; crea invitaciones y tokens por CLI) |
| `npm run test:server` | `tests/server.config.test.ts`: Host/Origin, límites, `MAX_PLAYERS`, `GAME_HOST`, CLI de invitaciones |
| `npm run test:ws` | `tests/ws.test.ts`: WebSocket (lobby, desafíos, cola, partidas PvP/NPC, tiempos, límites, reinicio) y endurecimiento (error de DB en auth, log de partidas, tope de partidas, borrado por admin) |
| `npm run test:hardening` | `tests/hardening.test.ts`: Host/Origin, límites con tope, presupuesto de fallos, nombres, HMAC de invitaciones, log incremental y poda (sin servidor) |
| `npm run typecheck` | `tsc` sobre `src/` (`tsconfig.json`) y sobre `server/` (`tsconfig.server.json`, con `@types/node`) |

Todos usan datos temporales: nunca la DB real. No hay linter; `tsconfig.json` y `tsconfig.server.json` sirven solo para chequear tipos (`noEmit`).

## Arquitectura

### Frontoffice (juego)
- `index.html` carga `/vendor/typescript.js` (servido por el propio servidor, versión fijada en `package-lock.json`) y **transpila `src/*.ts` en el navegador**. Los archivos son **scripts globales, no módulos**: comparten un único scope y el **orden de carga importa** (está en la lista `FILES` de `index.html`):
  `baseset → cards → rng → tcg → ai → packs → match → player → driver → net → art → game → menu → decks → lobby → battle → choices → booster → mail → touch → main`.
  Los primeros siete (`baseset`…`match`) son el **núcleo sin DOM**: el servidor los carga también (en `node:vm`, `server/engine.ts`). Si agregás un archivo, sumalo a `FILES` en el lugar correcto. No uses `import`/`export` en `src/`.
- Antes de cargar los scripts, `index.html` deja en `window`: `GAME_CATALOG` (data/catalog.json), `GAME_WORLD` (data/world.json) y `GAME_PLAYER` (resultado de `/api/me` o de `POST /api/players`). El alta pide un **código de invitación**: sale del fragmento `#invite=CODIGO` del link o se escribe en la pantalla de alta.
- Canvas de 240×160 escalado ×4, tiles de 16px (`TILE` en `art.ts`; los tipos de tile están en `TILE_INFO`). La fuente Press Start 2P es local (`assets/fonts/`, licencia OFL).

| Archivo | Rol |
|---|---|
| `baseset.ts`, `cards.ts` | Datos de las 102 cartas (formato compacto) + tipos `Card`/`Attack`/efectos; `cards.ts` usa `GAME_CATALOG` si existe |
| `rng.ts` | Aleatoriedad inyectable (`Rng`): el motor nunca llama a `Math.random`. `sfc32` con semilla de texto (offline y tests); el servidor usa uno criptográfico |
| `tcg.ts` | **Motor de reglas, lógica pura (no dibuja)**. Los efectos son listas de pasos (`EFFECT_OPS`) |
| `ai.ts` | IA del rival (heurísticas) |
| `packs.ts` | Generación de sobres (slots y pool), pura |
| `match.ts` | Partida como **intenciones** (`Intent`) y `viewFor` (la ÚNICA salida del estado hacia un cliente, sin información oculta del rival), `defaultIntent`, `stepAI` |
| `player.ts` | Lado navegador: imágenes de cartas, colección y mazos guardados (DOM/localStorage; no se carga en el servidor) |
| `driver.ts` | `BattleDriver`: local (offline, `sfc32`) o remoto (manda intents por WebSocket); la UI de combate no sabe cuál usa |
| `net.ts` | Cliente de red: alta, `PUT /api/me/decks` con `rev` y reintento ante 409, WebSocket `/ws` con reconexión (`match.resume`); si no hay servidor, cae a localStorage (modo offline) |
| `art.ts` | Tiles y sprites generados por código. **También lo consume el backoffice** (repo aparte) por HTTP, como recurso público |
| `game.ts` | Mundo, mapas, NPCs, movimiento, loop `frame` |
| `menu.ts`, `decks.ts`, `booster.ts`, `mail.ts` | Menú, ABM de mazos, apertura de sobres (los sortea el servidor), buzón |
| `lobby.ts` | Pantalla RIVALES: jugadores conectados, desafíos y cola; avisos de desafíos entrantes |
| `battle.ts`, `choices.ts` | UI del combate (dibuja `BattleView`) y selectores |
| `touch.ts` | Controles táctiles que simulan teclas |

### Servidor (Node/TS, `node:http` + `ws` + `node:sqlite`)
Un solo proceso, en `server/`. La migración desde Python (hito 2, ADR 0002) ya está hecha: `server.py` y `juego/` se borraron.

| Archivo | Rol |
|---|---|
| `main.ts` | Listener público (HTTP + estáticos + API de jugador) y CLI: `admin-token …`, `invite …` |
| `ws.ts` | WebSocket `/ws`: lobby, desafíos, cola, partidas PvP y contra NPC, tiempos (turno, gracia, desafío), límites |
| `engine.ts` | Carga el núcleo (`src/*.ts` sin DOM) en `node:vm`; RNG criptográfico por partida/sobre; `ownedCounts`, sobres |
| `decks.ts` | Validación de mazos contra la colección |
| `store.ts` | SQLite (`data/game.db`): jugadores (con `rev`), buzón (claim transaccional), invitaciones, partidas, tokens de admin |
| `content.ts` | Catálogo, mundo y assets: valida, hace backup `*.backup.json` y escribe de forma atómica con `rev` (409 si está desactualizado) |
| `admin.ts` | API `/admin/v1` y CLI de tokens |
| `security.ts`, `util.ts` | Host/Origin, rate limiting, utilidades |

- **Estáticos**: solo lo que matchea la lista blanca `PUBLIC` de `main.ts`: `index.html`, `src/*.ts`, `/vendor/typescript.js`, `/assets/fonts/*.woff2`, imágenes de `/assets/` (solo png/jpg/webp/gif) y `data/catalog|world.json` (salen del contenido del juego). Nunca la DB.
- **API de jugador** (header `X-Player-Token`; en la DB solo el hash sha256):
  - `POST /api/players` `{invite, name}` → alta con **código de invitación** (hasheado, de uso limitado; tope global de intentos fallidos y `MAX_PLAYERS`). Ignora cualquier `save` del cliente.
  - `GET /api/me`, `GET /api/me/mail`.
  - `PUT /api/me/decks` `{rev, decks}` → valida los mazos contra la colección; 409 `{error:"conflict", player}` si `rev` está viejo.
  - `PUT /api/me/save` → **410**: el servidor guarda la colección (el cliente viejo tiene que recargar).
  - `POST /api/me/mail/<id>/claim` → el servidor sortea el sobre (el cuerpo se ignora) y responde `{mail, player, cards}`.
- **WebSocket** `GET /ws` (contrato en el ADR 0002, 3.2): primer mensaje `auth` con el token (no va en la URL); `lobby`, `challenge.*`, `queue.*`, `npc.start`, `match.intent`/`match.state`/`match.resume`/`match.over`. El servidor es el único que corre las partidas; el cliente solo manda intents y recibe su `BattleView`. Una partida activa por jugador; si el servidor se reinicia, las partidas en curso se anulan.
- **Host/Origin y límites** (variables de entorno, lista completa en la cabecera de `server/main.ts`): `ALLOWED_HOSTS` (por defecto loopback; admite `*.ts.net`), `ALLOWED_ORIGINS`, `TRUST_PROXY=1` (IP del cliente desde `X-Forwarded-For`, solo detrás de un túnel), `MAX_PLAYERS`, `RATE_API_PER_MIN`, `RATE_SIGNUP_PER_MIN`, `TURN_SECONDS`, `GRACE_SECONDS`…
- **Invitaciones**: `node server/main.ts invite new [--uses N] [--days N] [etiqueta]` (muestra el código una vez), `invite list`, `invite revoke <código|id>`. Link: `https://<host>/#invite=CODIGO`.
- **API de admin** `/admin/v1/*` en un listener aparte, `127.0.0.1:8125` (`ADMIN_HOST`/`ADMIN_PORT`). Exige `Authorization: Bearer` (tokens hasheados y revocables en la tabla `admin_tokens`), sin CORS, rechaza `Origin`. Valida `Host` (loopback + puerto real) y se niega a arrancar fuera de loopback salvo `ADMIN_ALLOW_NONLOOPBACK=1`. Tokens: `node server/main.ts admin-token new --write` (lo guarda con permisos 0600 en `%USERPROFILE%\.tcglocal\admin-token`, o en `TCG_ADMIN_TOKEN_FILE`, y no lo imprime; sin `--write` lo muestra una vez), `admin-token list`, `admin-token revoke <id>`. El contrato completo está en el ADR 0001 del repo privado del backoffice. **Nunca** se expone por el túnel.
- Backoffice (repo aparte, privado): intermediario sin estado que traduce `/api/*` a `/admin/v1/*` de este juego agregando el token. Solo usa recursos públicos del juego (`/assets/*`, `src/art.ts`, `src/baseset.ts`, `src/cards.ts`) y la API de admin; **no hay código ni datos compartidos**. Su código no está en este repo a propósito: este repo es público.

### Datos
- `data/catalog.json`: `{version, cardBack, cards[], boosters[]}`. Lo edita el backoffice.
- `data/world.json`: `{version, start, playerLook, maps[], npcs[]}`. Los `tiles` son filas de strings del mismo largo.
- `effects-baseset.json` (pasos de efectos de las cartas originales) es del backoffice y vive en su repo.
- `*.backup.json`: los genera el backoffice. No editarlos a mano.
- `data/game.db`: base de jugadores (gitignored). **No leerla, editarla ni borrarla desde herramientas.** `collection` guarda solo lo ganado (sobres y envíos); lo que tiene el jugador es la colección inicial + eso. Backup: `python tools/backup_db.py` copia a `%USERPROFILE%\tcglocal-backups` (conserva las 20 más nuevas; seguro con el juego corriendo). Para restaurar: pará el servidor y copiá un `game-*.db` sobre `data/game.db`.
- `assets/`: imágenes subidas con el nombre `slug-<sha1[:10]>.ext`; `assets/fonts/` tiene la fuente local (y su licencia).
- `vendor/` (gitignored): `typescript.js`, artefacto de instalación (`node tools/vendor.mjs`).

## Limitaciones conocidas (importan para los hitos)
- **La autoridad ya está en el servidor** (hito 2): colección, sobres, premios y partidas las decide el servidor; el cliente solo manda mazos (validados) e intents. Lo único que sigue en el cliente es el **modo offline** (sin servidor: combate local con `sfc32` y localStorage), que no cuenta para nada.
- Las partidas en curso no sobreviven a un reinicio del servidor (se anulan sin ganador; el log de intents queda en `matches`). No hay ranking ni historial.
- Un solo proceso y una sola PC: sin escalado horizontal. Sin cuentas ni recuperación de token: perder el token es perder el jugador (se re-invita).
- Las invitaciones se crean solo por CLI (no hay `/admin/v1/invites`; sería un cambio de contrato en el repo del backoffice).
- El backoffice depende de los fuentes públicos del juego (`src/art.ts`, `src/baseset.ts`, `src/cards.ts`), pero no de la DB ni de archivos compartidos. Sus instrucciones para crear tokens de admin ahora son `node server/main.ts admin-token …` (antes `python server.py`).

## Hoja de ruta
1. ~~Separar el backoffice del frontoffice~~ (hecho; ADR 0001 en el repo privado del backoffice).
2. ~~PvP autoritativo en el servidor + WebSockets, servidor migrado a Node/TS, hosting por Tailscale~~ (hecho en la rama del hito 2; ADR 0002 y `docs/hosting.md`). Pendiente de cierre: auditoría de seguridad y merge a `main`.
3. Mundo más grande, más personalización, cartas, NPCs y mapas. Ideas que quedaron del hito 2: invitaciones desde el backoffice, reanudar partidas tras un reinicio (replay del log de intents), ranking/historial.

Las decisiones de diseño van en ADRs cortos. Los de este repo están en `docs/adr/` (ADR 0002); el ADR 0001 (API de admin) vive en el repo privado del backoffice. Leelos antes de cambiar la arquitectura.

## Convenciones
- TypeScript `strict`. Comentarios y nombres de UI en español; los textos de las cartas, en inglés, tal como están impresos.
- El servidor (`server/`) y los tests son TypeScript "borrable" (solo sintaxis que Node puede ejecutar quitando tipos: sin `enum` ni `namespace`). `src/` son scripts globales.
- Python solo con biblioteca estándar, y solo en `tools/` (p. ej. `backup_db.py`) y en el backoffice (repo aparte). El juego no usa Python.
- Cambios chicos y enfocados. No reformatear archivos enteros.

## Flujo de trabajo: qué agente usar

La sesión principal decide qué agentes intervienen (los subagentes no pueden lanzar otros). Agentes en `.claude/agents/`.

| Si la tarea… | Agente | Cuándo |
|---|---|---|
| es chica: 1–2 archivos, sin cambiar contratos | ninguno, se hace en la sesión principal | — |
| define o cambia un contrato (API, WebSocket, esquema de datos), toca más de un componente o es un hito | `arquitecto` | **antes** de implementar; genera un ADR en `docs/adr/` |
| cambia reglas, efectos, combate, IA o RNG | `motor-tcg` | implementación |
| cambia servidores, endpoints, DB, WebSockets, `net.ts` o hosting | `backend-api` | implementación |
| agrega o edita cartas, sobres, mapas o NPCs en `data/` | `contenido` | implementación |
| cualquier cambio de código o datos | `verificador` | **al final**, antes de commitear |
| toca la API, la autenticación, subidas, red o hosting, o es el cierre de un hito | `auditor-seguridad` | después del verificador, antes de mergear |

Reglas:
- Los agentes que tocan archivos distintos (por ejemplo `motor-tcg` y `backend-api` siguiendo el mismo ADR) pueden correr en paralelo. Si dos tocarían los mismos archivos, van en secuencia.
- Pasale a cada agente la ruta del ADR y su paso concreto. No le reexpliques el proyecto: ya lee este archivo.
- Si el `verificador` falla, el arreglo lo hace el mismo agente que implementó, y después se verifica de nuevo.
- Para un hito completo, usá el skill `/hito`.
