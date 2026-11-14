# ADR 0002 — PvP con servidor autoritativo y WebSockets (hito 2)

Estado: **aprobado** (2026-11-14) · Fecha: 2026-11-14 · Rama: `hito-2-pvp-autoritativo`
Decisiones del usuario: P1 = **A** (servidor del juego en Node/TS; el backoffice sigue en Python) · P2 = conservar las colecciones actuales · P3 = Tailscale (`tailscale serve`, nunca Funnel) · P4 = `GAME_HOST=127.0.0.1` por defecto · P5 = invitaciones solo por CLI (sin `/admin/v1/invites`) · P6 = el PvP no da premio (solo estadística).
(El ADR 0001, sobre la API de admin, vive en el repo privado del backoffice. Acá solo se asume que `/admin/v1` existe y que **su contrato no cambia**.)

## 1. Contexto
- **Colección en manos del cliente**: `PUT /api/me/save` (`server.py:207-220`) guarda lo que mande el navegador; `clean_save` solo normaliza (`juego/store.py:72-87`). El cliente arma el save en `src/net.ts:51-52` y lo empuja en `net.ts:100-131`.
- **Sobres elegidos por el cliente**: el buzón genera las cartas en el navegador (`src/mail.ts:42-44`, `src/booster.ts:70-87`) y el servidor solo valida el pool (`server.py:188-199`). El premio de un NPC lo decide el cliente (`src/game.ts:483-494`) y se suma con `addToCollection` (`src/cards.ts:643-653`, `booster.ts:218`).
- **Motor**: `src/tcg.ts` es lógica pura, pero usa `Math.random` (`tcg.ts:94-100` shuffle, `tcg.ts:136-140` monedas), un contador global de uids (`tcg.ts:90-92`) que se asigna *antes* de mezclar (`tcg.ts:187-193`), y supone un humano y una IA (`tcg.ts:197`, `src/battle.ts:28-29`, IA por timer en `battle.ts:363-394`). Depende de `cards.ts`, que al cargarse toca el DOM: `Image` (`cards.ts:506-522`) y `localStorage` (`cards.ts:621-628`). `deckProblems` usa la colección global (`cards.ts:672-684`). La colección inicial (Brushfire + `EXTRA_OWNED`) es implícita en el cliente (`cards.ts:593-597`, `cards.ts:633-639`).
- **Efectos con info oculta**: `searchDeck` (`tcg.ts:919-923`) y `arrangeTop` (`tcg.ts:947-952`) necesitan ver el mazo propio.
- **Altas sin control**: `POST /api/players` es anónimo e ilimitado y acepta un save del cliente (`server.py:173-177`, `store.py:136-150`, `index.html:144-150`).
- **Supply chain**: `typescript.js` sale de jsDelivr sin SRI (`index.html:114`); fuentes de Google (`index.html:11`).
- **Red**: el juego escucha en `0.0.0.0` (`server.py:47`); admin en `127.0.0.1:8125` (`server.py:226-234`, rutas en `juego/admin.py:121-153`). No hay tests.

## 2. Decisión
El servidor del juego pasa a ser **la única autoridad** sobre colección, mazos, sobres, RNG y combates (PvP y contra NPC), corriendo **el mismo `src/tcg.ts` + `src/ai.ts`** sin DOM, con una **interfaz de intenciones** (`src/match.ts`) y un canal **WebSocket** autenticado; se accede por **Tailscale** (recomendado) o Cloudflare Tunnel. El contrato de abajo es independiente del lenguaje del servidor; **el lenguaje (Node/TS vs Python) lo decide el usuario** (sección 7, recomendación: Node/TS).

## 3. Contrato
### 3.1 Motor sin DOM (archivos globales, sin `import`)
Núcleo que corre igual en navegador y servidor: `baseset → cards → rng → tcg → ai → packs → match`. Lo que toca el DOM de `cards.ts` (imágenes, `PLAYER`, `pulledCards`, mazos en `localStorage`) se mueve a `src/player.ts`. Nuevo orden de `FILES`: `baseset → cards → rng → tcg → ai → packs → match → player → net → art → game → menu → decks → battle → choices → booster → mail → touch → main`.
```ts
// rng.ts
interface Rng { next(): number }                      // [0,1)
function sfc32(seed: string): Rng                     // cliente offline y tests
// tcg.ts: Battle gana { rng: Rng; uidNext: number } (no se serializan). shuffle(a, rng). coin(b) usa b.rng.
//   newBattle(decks:[Deck,Deck], names:[string,string], opts:{rng: Rng; prizes?: number; ai?:[boolean,boolean]})
//   uids por partida y asignados DESPUÉS de mezclar.
// cards.ts: ownedCounts(pulled: Record<string,number>): Record<string,number>  (= inicial + pulled)
//           deckProblems(deck: Deck, owned: Record<string,number>): string[]
// packs.ts: generateBooster(def: BoosterDef, rng: Rng): string[]   (sale de booster.ts:54-87)
// match.ts
type Ref = number;  // uid de carta (CI) o de Pokémon en juego (Slot)
type Intent =
 | {t:"setupActive"; card:Ref} | {t:"setupBench"; card:Ref} | {t:"setupDone"}
 | {t:"playBasic"; card:Ref} | {t:"evolve"; card:Ref; target:Ref} | {t:"attachEnergy"; card:Ref; target:Ref}
 | {t:"peek"; card:Ref}                                   // Entrenador con searchDeck/arrangeTop
 | {t:"playTrainer"; card:Ref; choice?:{slot?:Ref; picks?:Record<number,{slot?:Ref; cards?:Ref[]; energies?:Ref[]; order?:number[]; stage?:number}>}}
 | {t:"usePower"; slot:Ref; choice?:{hand?:Ref; from?:Ref; target?:Ref; energy?:Ref; type?:EType}}
 | {t:"retreat"; bench:Ref; energies?:Ref[]} | {t:"attack"; idx:number; target?:Ref; choice?:AttackChoice}
 | {t:"promote"; bench:Ref} | {t:"discardDoll"; slot:Ref} | {t:"endTurn"} | {t:"surrender"};
function createMatch(decks, names, opts): Match       // Match = { b, setupDone:[bool,bool], peekLock?:{pi,card}, seq }
function applyIntent(m: Match, pi: 0|1, it: Intent): string | null   // error en español o null
function viewFor(m: Match, pi: 0|1): BattleView
function defaultIntent(m: Match, pi: 0|1): Intent     // para timeouts (aiSetup/aiPromote/endTurn)
function stepAI(m: Match, pi: 0|1): boolean           // envuelve aiSetup/aiPromote/aiStep (ai.ts:121,129,150)
```
Reglas de `applyIntent`: resuelve `Ref`→índice en el momento; exige `cur === pi` salvo en setup, `promote` (pi en `promoteQueue`) y `surrender`; `finishSetup` corre recién con los dos `setupDone`; tras `peek` el único intent aceptado de ese jugador es `playTrainer` de esa carta (si vence el tiempo, se juega con elección automática).

**`BattleView`** (el destinatario siempre en `p[0]`, así `battle.ts` conserva `HUMAN=0`):
```json
{"turn":3,"cur":0,"first":1,"phase":"turn","winner":-1,"energyPlayed":false,"retreated":false,
 "prizeCount":6,"promoteQueue":[],
 "p":[{"name":"FRAN","deckName":"Brushfire","hand":[{"uid":17,"id":"charmander"}],"deck":41,"prizes":6,
       "discard":[{"uid":9,"id":"potion"}],"active":{"uid":12,"stack":[{"uid":12,"id":"vulpix"}],"energy":[],"damage":10,"...":"resto de Slot"},
       "bench":[],"turns":2,"mulligans":0},
      {"name":"TOMI","deckName":"Overgrowth","hand":7,"deck":40,"prizes":6,"discard":[],"active":{"...":"Slot"},"bench":[],"turns":2,"mulligans":1}]}
```
Mazo y premios: siempre **cantidad** (también los propios). Mano rival: cantidad. En setup, Activo/Banca rivales van como `null`/cantidad hasta que ambos terminen. Nunca viaja `rng`, semilla ni `uidNext`. El cliente rehidrata `id→CARDS[id]` y la mano rival como dorsos.

### 3.2 WebSocket `GET /ws` (JSON, un mensaje = `{type, ...}`)
Handshake: `Origin` ∈ `ALLOWED_ORIGINS` y `Host` ∈ `ALLOWED_HOSTS`, si no 403 antes del upgrade. Primer mensaje obligatorio en ≤5 s:
| Dir | type | payload |
|---|---|---|
| C→S | `auth` | `{"token":"<X-Player-Token>","v":1}` |
| S→C | `hello` | `{"you":{"id":"J-ABC234","name":"Fran"},"match":{"id":"M-9F3K","seq":41}\|null}` |
| C→S | `lobby.sub` / `lobby.unsub` | `{}` |
| S→C | `lobby` | `{"online":[{"id":"J-XYZ789","name":"Tomi","status":"libre"\|"jugando"}]}` |
| C→S | `challenge.send` | `{"to":"J-XYZ789","deckId":"d1","prizes":6}` |
| S→C | `challenge.incoming` | `{"id":"C-12","from":{"id":"J-ABC234","name":"Fran"},"prizes":6,"expires":1763130000}` |
| C→S | `challenge.accept` / `.decline` / `.cancel` | `{"id":"C-12","deckId":"d2"}` (deckId solo en accept) |
| S→C | `challenge.update` | `{"id":"C-12","status":"accepted"\|"declined"\|"cancelled"\|"expired","error?":"..."}` |
| C→S | `queue.join` / `queue.leave` | `{"deckId":"d1"}` (cola FIFO; empareja de a dos) |
| C→S | `npc.start` | `{"npc":"npc-brock","deckId":"d1"}` (NPC de `world.json`) |
| S→C | `match.start` | `{"match":"M-9F3K","vs":"pvp"\|"npc","opp":{"name":"Tomi"},"seq":0,"view":BattleView,"deadline":1763130090}` |
| C→S | `match.intent` | `{"match":"M-9F3K","n":7,"intent":{"t":"attack","idx":0}}` (`n`: contador del cliente, deduplica) |
| S→C | `match.state` | `{"match":"M-9F3K","seq":42,"ack":7,"view":BattleView,"log":["Moneda: CARA","..."],"deadline":1763130180,"waiting":"you"\|"opp"}` |
| S→C | `match.error` | `{"match":"M-9F3K","n":7,"error":"No tenés Energía suficiente."}` |
| S→C | `match.peek` | `{"match":"M-9F3K","card":23,"mode":"search"\|"top","cards":[{"uid":31,"id":"charmeleon"}]}` (solo al dueño; `search` = solo las que pasan el filtro) |
| C→S | `match.resume` | `{"match":"M-9F3K","seq":40}` → responde `match.state` completo |
| S→C | `match.opp` | `{"status":"disconnected"\|"back","graceUntil":1763130120}` |
| S→C | `match.over` | `{"match":"M-9F3K","winner":"you"\|"opp"\|"draw","reason":"normal"\|"surrender"\|"timeout"\|"abandon","reward":{"booster":"baseSet","cards":["..."],"defeated":2}\|null}` |
| ambos | `ping` / `pong` | `{}` cada 25 s (Cloudflare corta conexiones ociosas a los 100 s) |

Cierres: 4400 mensaje inválido, 4401 token inválido, 4403 Origin/Host, 4408 sin `auth` a tiempo, 4409 reemplazada por otra pestaña (una conexión por jugador; la nueva gana), 4429 exceso (>20 msg/s o >16 KB).
Tiempos (env): `TURN_SECONDS=90` por decisión → al vencer se aplica `defaultIntent`; 3 vencimientos seguidos = derrota `timeout`. Desconexión: gracia `GRACE_SECONDS=90` (el reloj sigue) → derrota `abandon`. Desafío vence a los 60 s. Una partida activa por jugador. NPC: el servidor corre `stepAI` cada 0,8 s y emite `match.state` por paso. Si el servidor se reinicia, las partidas en curso se anulan sin resultado (el log de intents queda para depurar/replay).

### 3.3 HTTP de jugador (cambia) — `/admin/v1` no se toca
- `POST /api/players` `{"invite":"K7Q2-9XMB","name":"Tomi"}` → 201 `{"id":"J-XYZ789","name":"Tomi","rev":1,"save":{"collection":{}},"token":"…","mail":[]}`. Errores: 403 `{"error":"Código de invitación inválido o usado."}`, 429 `{"error":"Demasiados intentos. Probá en un rato."}`, 503 si se llegó a `MAX_PLAYERS` (def. 30). **Ignora `save`**: arranca con la colección inicial. El link para invitar es `https://<host>/#invite=K7Q2-9XMB` (fragmento: no queda en logs).
- `PUT /api/me/decks` `{"rev":5,"decks":{"decks":[{"id":"d1","name":"Fuego","cards":[{"id":"charmander","qty":4}]}],"mainId":"d1","nextId":2}}` → 200 `{"rev":6}` · 409 `{"error":"conflict","player":{…}}` · 400 si una carta no existe, `qty` > copias propias, >20 mazos, >60 entradas o nombre >14. Mazos incompletos se pueden guardar; la legalidad completa (`deckProblems`) se exige al empezar partida.
- `PUT /api/me/save` → 410 `{"error":"Ahora el servidor guarda la colección; actualizá la página."}`.
- `POST /api/me/mail/<id>/claim` body `{}` (se ignora `cards`) → 200 `{"mail":{…},"player":{…},"cards":["grassEnergy","…","charizard"]}`: el sobre lo genera el servidor con `packs.ts` y RNG propio.
- `GET /api/me`, `GET /api/me/mail`: sin cambios. El save en DB mantiene la forma `{collection, decks, defeated}` para que `/admin/v1/players/<id>` siga igual.
- Estáticos nuevos en `PUBLIC`: `/vendor/typescript.js` y `/assets/fonts/*.woff2`.

### 3.4 Datos (SQLite, se agregan)
```sql
CREATE TABLE invites (code_hash TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', uses_left INTEGER NOT NULL,
  expires REAL, created REAL NOT NULL);
CREATE TABLE matches (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('pvp','npc')),
  p0 TEXT NOT NULL, p1 TEXT NOT NULL,           -- id de jugador o 'npc:<id>'
  seed TEXT NOT NULL, catalog_rev TEXT, decks TEXT NOT NULL, intents TEXT NOT NULL DEFAULT '[]',
  started REAL NOT NULL, ended REAL, winner INTEGER, reason TEXT, reward TEXT);
```
CLI: `invite new [--uses 1] [--days 7] [etiqueta]` (muestra el código una vez), `invite list`, `invite revoke <código>`. RNG del servidor: semilla `crypto` de 128 bits por partida/sobre y `next()` = HMAC-SHA256(semilla, contador) → reproducible para replays e impredecible para el rival. `sfc32` solo offline y en tests.

## 4. Plan por pasos (opción A; ver 7 para B y C)
1. **motor-tcg** — `src/rng.ts`, `src/tcg.ts`, `src/cards.ts`→`src/player.ts`, `src/packs.ts` (sale de `booster.ts`), `index.html` (`FILES`). RNG inyectado, uids por partida, `deckProblems(deck, owned)`. *Independiente del lenguaje: arranca ya.*
2. **motor-tcg** — `src/match.ts` (intents, `viewFor`, `peek`, setup de dos lados, `defaultIntent`, `stepAI`). Depende de 1.
3. **motor-tcg** — `tests/engine.test.ts`, `tests/view.test.ts`, `tests/packs.test.ts`, `package.json` (`npm test` = `node --test`). Depende de 1–2. Mínimo: determinismo (misma semilla + mismos intents = mismo estado), conservación de 60 cartas por jugador en cada paso, 200 partidas IA vs IA con semillas fijas sin excepciones y que terminan, `viewFor` serializado sin ids/uids ocultos del rival ni semilla, sobres que respetan slots y pool.
4. **backend-api** — `tests/api.contract.test.ts`: tests de caja negra contra `GAME_URL` (API de jugador y `/admin/v1` con token por env) **corridos contra el Python actual**. *Independiente de 1–3.*
5. **backend-api** — port 1:1 a Node: `server/main.ts`, `server/store.ts` (`node:sqlite`, mismo esquema), `server/content.ts`, `server/admin.ts` (mismo `/admin/v1` y CLI `admin-token`), `server/engine.ts` (carga el núcleo de 3.1 en `node:vm` transpilado con `typescript` fijado en `package-lock`). Listo cuando el test del paso 4 pasa igual contra Node. Depende de 4.
6. **backend-api** — autoridad: invites, `PUT /api/me/decks`, claim server-side, 410 en save, tablas nuevas, `ALLOWED_HOSTS/ORIGINS`. Depende de 1 y 5.
7. **backend-api** — `server/ws.ts` (lobby, desafíos, cola, NPC, partidas, tiempos, `matches`) con `ws`. Depende de 2 y 6.
8. **motor-tcg** — `src/battle.ts`, `src/choices.ts`: un "driver" local (offline, `sfc32`) o remoto (manda intents, dibuja `BattleView`, usa `match.peek` para búsquedas). Depende de 2; en paralelo con 5–7.
9. **backend-api** — `src/net.ts` (cliente WS, reconexión con `match.resume`, `PUT /api/me/decks`), `src/lobby.ts` (pantalla de rivales/desafíos), `src/mail.ts`/`src/booster.ts`/`src/game.ts` (sobres y premios llegan del servidor), `index.html` (código de invitación, `/vendor/typescript.js`, fuente local). Depende de 7; distinto de los archivos de 8.
10. **contenido** — revisar `reward` de NPCs en `data/world.json` (`once` donde corresponda, para que no se farmeen sobres) y que sus mazos pasen `deckProblems`. Independiente.
11. **backend-api** — `.claude/launch.json`, `CLAUDE.md`, `docs/hosting.md` (Tailscale/Cloudflare). Al final.

## 5. Seguridad
- No se confía en el cliente: colección, `defeated`, cartas de sobres, premios, resultado de partidas, orden del mazo, monedas. El cliente solo manda `Intent`s y mazos (validados contra `ownedCounts` al guardar y con `deckProblems` al empezar).
- `viewFor` es la única salida del estado de una partida; el test 3 lo vigila. Revisar textos de `log` que revelen cartas ocultas.
- WS: auth por primer mensaje (el token no va en la URL), Origin/Host en el upgrade (evita CSWSH), límites de tamaño/frecuencia, `n` deduplicado, partida y turno verificados en cada intent.
- Altas: código de invitación hasheado, de uso limitado, más tope global de intentos fallidos (30/h) y `MAX_PLAYERS`. **Nada se exime por venir de 127.0.0.1**: con túnel, todo llega desde loopback.
- Red: `GAME_HOST=127.0.0.1` por defecto (el túnel entra por loopback); `0.0.0.0` solo si se pide LAN. El túnel/serve apunta **solo** al puerto del juego, nunca al de admin. Tailscale: `tailscale serve --bg 8123` (HTTPS, solo tu tailnet; **no** usar Funnel). Cloudflare: `cloudflared` + Cloudflare Access obligatorio.
- `typescript.js` y la fuente se sirven desde el propio servidor (versión fijada por `package-lock` con hash de integridad). En B/C: atributo `integrity` + `crossorigin` en `index.html:114`.

## 6. Alternativas descartadas
- Cliente autoritativo con validación a posteriori: imposible validar RNG y info oculta.
- Lockstep P2P (cada cliente corre el motor): ambos conocen la semilla y todo el estado oculto.
- Long-polling HTTP en vez de WS: más simple de hostear, pero peor latencia y más código de sesión; WS pasa bien por Tailscale y Cloudflare.
- Convertir `src/` a módulos ES con build: rompe la carga en el navegador y el consumo del backoffice; se deja para después.
- Persistir y reanudar partidas tras reinicio: el log de intents lo permite más adelante; hoy no vale el costo.

## 7. Riesgos y preguntas abiertas
**P1 — ¿Migrar el servidor del juego de Python a Node/TS?** (decisión del usuario; recomendación: **A**)
La idea clave: el motor de reglas ya existe en TypeScript (`tcg.ts` + `ai.ts`, ~1.870 líneas con todos los efectos). El servidor tiene que correr *exactamente las mismas reglas* que ve el jugador. Hay tres caminos:
- **A. Servidor del juego en Node/TS** (Node ≥ 24 LTS, que ejecuta `.ts` sin build; deps: `ws`, `typescript`; base con `node:sqlite`). El backoffice sigue en Python y no se entera: habla por `/admin/v1`.
  - Pro: **un solo motor** para cliente, servidor y tests → cero divergencia. WebSockets con una librería madura en vez de escribir el protocolo a mano. Un solo lenguaje para aprender. Los tests del motor (`node --test`) salen gratis.
  - Contra: hay que portar ~1.080 líneas de Python (`server.py`, `juego/*.py`) y el contrato de `/admin/v1` debe quedar **idéntico** byte a byte en lo que importa (rutas, códigos, JSON, chequeos de Host/Origin/Bearer); si algo cambia, el backoffice se rompe. `node:sqlite` todavía es "experimental" (estable en la práctica; se puede cambiar por `better-sqlite3` si molesta). Aparecen `npm` y `node_modules`.
  - Cómo se baja el riesgo (tu terreno de QA): el paso 4 escribe **tests de caracterización** contra el servidor Python *antes* de tocarlo; el port está terminado cuando la misma suite pasa contra Node. Es la red de seguridad del cambio.
- **B. Quedarse en Python** (solo stdlib).
  - Pro: nada nuevo que instalar ni aprender; el contrato de admin no se toca.
  - Contra: hay que **reescribir el motor en Python** (y cada efecto nuevo, dos veces) o el cliente pierde el motor y queda como pantalla "tonta" (sin juego offline ni avisos de jugada inválida antes de mandarla). Dos motores = divergencias sutiles (redondeos, orden de iteración, RNG) que solo se detectan con tests cruzados… que igual requieren Node para correr el lado TS. WebSockets en stdlib = implementar RFC 6455 a mano (handshake, máscaras, fragmentos, ping/close) sobre `http.server` con un hilo por conexión: funciona para pocos amigos, pero es código de red delicado y propio. O se admite la dependencia `websockets` y se rompe "solo stdlib" igual.
  - Plan: pasos 4–5 desaparecen; aparecen "portar `tcg.ts`/`ai.ts`/`packs.ts` a `juego/motor/`" (motor-tcg, el paso más grande del hito), "`juego/ws.py` RFC 6455" y "tests de conformidad TS↔Python con el mismo log de intents".
- **C. Híbrido**: Python sigue con HTTP y `/admin/v1`; un proceso Node aparte (`partidas/`, `127.0.0.1:8126`) solo para `/ws` y el motor. Tailscale/Cloudflare enrutan `/ws` a 8126 por ruta (`tailscale serve --set-path /ws http://127.0.0.1:8126`).
  - Pro: no se porta nada de Python; el motor es uno solo.
  - Contra: dos runtimes y dos procesos para levantar; Node necesita leer mazos/colección y escribir resultados y premios → hace falta **otra API interna autenticada** entre ambos (más contrato, más superficie) o compartir la DB (lo que el proyecto evita). Los sobres de NPC/buzón quedan repartidos entre dos lenguajes.
  - Plan: paso 5 se reemplaza por "`juego/internal.py` (`/internal/v1` en loopback con secreto)" y "`partidas/` en Node"; launch.json con dos procesos.

Recomiendo **A**: el costo es un port acotado y verificable con tests; B duplica justo lo más difícil (las reglas) y C agrega una API interna permanente. Si elegís A, hay que actualizar `CLAUDE.md`: "Python solo stdlib" pasa a aplicar solo al backoffice; "sin Node" pasa a "Node ≥ 24 + `npm ci`"; `launch.json` `ruta` → `node server/main.ts` (puertos y variables iguales).

**Otras preguntas**
- P2: ¿Se conservan las colecciones actuales (hechas cuando mandaba el cliente) o se resetean? Recomiendo conservarlas (son amigos).
- P3: ¿Tailscale (recomendado: privado, sin dominio) o Cloudflare Tunnel (link público + Access)?
- P4: ¿Default `GAME_HOST=127.0.0.1` (recomendado) aunque se pierda el acceso LAN directo sin Tailscale?
- P5: ¿Hace falta crear invitaciones desde el backoffice? Implicaría agregar `/admin/v1/invites` (cambio de contrato en el otro repo); por ahora solo CLI.
- P6: ¿Las partidas PvP dan premio? Propuesta: no (evita farmeo entre cuentas); solo `defeated`/estadística.
- Riesgos: la UI de combate (`battle.ts`, `choices.ts`, ~1.300 líneas) lee el `Battle` directo y es el cambio más grande del cliente; textos de `log` podrían filtrar cartas ocultas; los NPCs se pueden desafiar sin estar al lado (el movimiento es del cliente): se acepta, limitado por `reward.once`.
