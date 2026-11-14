# Ruta 1 — TCG pixel-art

Juego de cartas estilo Pokémon TCG Base Set dentro de un mundo pixel-art estilo GBA, con un backoffice para editar cartas, mundo y jugadores. Todo en español (rioplatense): código comentado, textos de UI y commits.

## Cómo correrlo

Python estándar, sin dependencias ni Node. Configuraciones en `.claude/launch.json`:

- `ruta` → `python server.py` → juego en http://localhost:8123 (escucha en `0.0.0.0`, accesible en la LAN).
- El backoffice vive en **otro repositorio privado** (`ruta1-backoffice`) y se corre desde ahí: `python backoffice/server.py` → http://127.0.0.1:8124. Necesita este juego corriendo y un token de admin (ver abajo).
- `juego-prueba` → mismo juego en el puerto 8127.

No hay build, tests ni linter todavía. `tsconfig.json` sirve solo para chequear tipos (`noEmit`).

## Arquitectura

### Frontoffice (juego)
- `index.html` descarga `typescript.js` de jsDelivr y **transpila `src/*.ts` en el navegador**. Los archivos son **scripts globales, no módulos**: comparten un único scope y el **orden de carga importa** (está en la lista `FILES` de `index.html`):
  `baseset → cards → net → tcg → ai → art → game → menu → decks → battle → choices → booster → mail → touch → main`.
  Si agregás un archivo, sumalo a `FILES` en el lugar correcto. No uses `import`/`export`.
- Antes de cargar los scripts, `index.html` deja en `window`: `GAME_CATALOG` (data/catalog.json), `GAME_WORLD` (data/world.json) y `GAME_PLAYER` (resultado de `/api/me` o de `POST /api/players`).
- Canvas de 240×160 escalado ×4, tiles de 16px (`TILE` en `art.ts`; los tipos de tile están en `TILE_INFO`).

| Archivo | Rol |
|---|---|
| `baseset.ts`, `cards.ts` | Datos de las 102 cartas (formato compacto) + tipos `Card`/`Attack`/efectos; `cards.ts` usa `GAME_CATALOG` si existe |
| `tcg.ts` | **Motor de reglas, lógica pura (no dibuja)**. Los efectos son listas de pasos (`EFFECT_OPS`) |
| `ai.ts` | IA del rival (heurísticas) |
| `art.ts` | Tiles y sprites generados por código. **También lo consume el backoffice** (repo aparte) por HTTP, como recurso público |
| `game.ts` | Mundo, mapas, NPCs, movimiento, loop `frame` |
| `battle.ts`, `choices.ts` | UI del combate y selectores |
| `menu.ts`, `decks.ts`, `booster.ts`, `mail.ts` | Menú, ABM de mazos, apertura de sobres, buzón |
| `net.ts` | Guardado en el servidor con `rev` y reintento ante 409; si no hay servidor, cae a localStorage |
| `touch.ts` | Controles táctiles que simulan teclas |

### Servidores (Python, `http.server` + SQLite)
- `server.py` (juego): sirve solo lo que matchea `PUBLIC` (index, `src/*.ts`, `assets/`, `data/catalog|world.json`) y la API de jugador (`/api/players`, `/api/me`, `/api/me/save`, `/api/me/mail[...]`). Autenticación con el header `X-Player-Token` (en la DB se guarda el hash sha256).
- `juego/` (`store.py`, `content.py`, `admin.py`): el servidor del juego es **el único dueño** de catálogo, mundo, jugadores, buzón y assets. `Store` sobre `data/game.db` (las partidas tienen `rev` y el claim del buzón es transaccional); `content.py` valida, hace backup `*.backup.json` y escribe de forma atómica con `rev` (409 si está desactualizado).
- API de admin del juego: `/admin/v1/*` en un listener aparte, `127.0.0.1:8125` (variables `ADMIN_HOST`/`ADMIN_PORT`). Exige `Authorization: Bearer` (tokens hasheados y revocables en la tabla `admin_tokens`), sin CORS, rechaza `Origin`. Valida `Host` (loopback + puerto real) y se niega a arrancar fuera de loopback salvo `ADMIN_ALLOW_NONLOOPBACK=1`. Tokens: `python server.py admin-token new --write` (lo guarda con permisos 0600 en `%USERPROFILE%\.tcglocal\admin-token`, o en `TCG_ADMIN_TOKEN_FILE`, y no lo imprime; sin `--write` lo muestra una vez), `admin-token list`, `admin-token revoke <id>`. El contrato completo (endpoints, errores) está en el ADR 0001 del repo privado del backoffice.
- Backoffice (repo aparte, privado): intermediario sin estado que traduce `/api/*` a `/admin/v1/*` de este juego agregando el token. Solo usa recursos públicos del juego (`/assets/*`, `src/art.ts`, `src/baseset.ts`, `src/cards.ts`) y la API de admin; **no hay código ni datos compartidos**. Su código no está en este repo a propósito: este repo es público.

### Datos
- `data/catalog.json`: `{version, cardBack, cards[], boosters[]}`. Lo edita el backoffice.
- `data/world.json`: `{version, start, playerLook, maps[], npcs[]}`. Los `tiles` son filas de strings del mismo largo.
- `effects-baseset.json` (pasos de efectos de las cartas originales) es del backoffice y vive en su repo.
- `*.backup.json`: los genera el backoffice. No editarlos a mano.
- `data/game.db`: base de jugadores (gitignored). **No leerla, editarla ni borrarla desde herramientas.** Backup: `python tools/backup_db.py` copia a `%USERPROFILE%\tcglocal-backups` (conserva las 20 más nuevas). Para restaurar: pará los servidores y copiá un `game-*.db` sobre `data/game.db`.
- `assets/`: imágenes subidas con el nombre `slug-<sha1[:10]>.ext`.

## Limitaciones conocidas (importan para los hitos)
- **El cliente tiene la autoridad**: `PUT /api/me/save` acepta la colección que mande el cliente (solo normaliza el formato), y al abrir un sobre las cartas las elige el cliente (el servidor solo valida que estén en el pool).
- El combate corre íntegro en el cliente, con `Math.random` (`shuffle`, monedas en `tcg.ts`). No hay PvP.
- El backoffice depende de los fuentes públicos del juego (`src/art.ts`, `src/baseset.ts`, `src/cards.ts`), pero ya no de la DB ni de archivos compartidos.

## Hoja de ruta
1. ~~Separar el backoffice del frontoffice~~ (hecho en la rama del hito 1; ADR 0001 en el repo privado del backoffice). Pendiente decidir en el hito 2: migrar el servidor del juego a Node/TS.
2. Hostear desde esta PC para jugar PvP con amigos: motor autoritativo en el servidor + WebSockets; exponer con Tailscale o Cloudflare Tunnel (no abrir puertos en el router).
3. Mundo más grande, más personalización, cartas, NPCs y mapas.

Las decisiones de diseño van en ADRs cortos. Los de este repo irían en `docs/adr/`; el ADR 0001 (API de admin) vive en el repo privado del backoffice. Leelos antes de cambiar la arquitectura.

## Convenciones
- TypeScript `strict`. Comentarios y nombres de UI en español; los textos de las cartas, en inglés, tal como están impresos.
- Python solo con biblioteca estándar (hasta que un ADR diga lo contrario).
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
