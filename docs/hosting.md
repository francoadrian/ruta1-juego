# Hostear Ruta 1 desde tu PC y jugar con amigos

Guía paso a paso, pensada para alguien que nunca expuso un servidor. La idea: tu PC corre el juego y **Tailscale** arma una red privada entre tu PC y los celulares/PC de tus amigos. No se abre ningún puerto del router y el juego no queda público en Internet.

Resumen de la arquitectura (ADR `docs/adr/0002-pvp-autoritativo-websockets.md`):

```
celular de tu amigo ──(Tailscale, HTTPS)──► tu PC: tailscale serve ──► 127.0.0.1:8123 (el juego)
                                                                      127.0.0.1:8125 (admin: NUNCA se comparte)
```

El juego escucha solo en `127.0.0.1` (esta PC). Tailscale es el único que "entra" y lo hace por loopback.

---

## 0. Qué necesitás

- Node.js 24 o más nuevo (`node -v` te lo dice).
- Este repo con las dependencias instaladas:
  ```
  npm ci
  node tools/vendor.mjs
  ```
  (`vendor.mjs` copia `typescript.js` a `vendor/`, que el navegador necesita. Si te lo olvidás, el servidor lo genera solo al arrancar.)
- Una cuenta de Tailscale (gratis para uso personal): https://tailscale.com

## 1. Instalar Tailscale

1. En la **PC** donde corre el juego: bajá Tailscale de https://tailscale.com/download, instalalo e iniciá sesión.
2. En tu **celular** (y en el de cada amigo): instalá la app de Tailscale (Play Store / App Store) e iniciá sesión.
3. En la consola de administración (https://login.tailscale.com/admin) activá **MagicDNS** y **HTTPS Certificates** (sección DNS). Sin eso `tailscale serve` no puede darte un link `https://...`.
4. Anotá el nombre de tu PC en la tailnet: algo como `mi-pc.tail1234.ts.net` (lo ves en la app o con `tailscale status`).

## 2. Arrancar el juego

```
node --no-warnings server/main.ts
```

(o `npm start`). Tiene que decir `Juego en http://localhost:8123/`. Probalo en tu navegador: http://localhost:8123.

Para pararlo: `Ctrl+C` en esa terminal. Se cierran las conexiones y se **anulan las partidas en curso** (sin ganador); las colecciones quedan guardadas.

Variables para exponerlo por Tailscale (en PowerShell, antes de arrancar). Reemplazá `mi-pc.tail1234.ts.net` por el nombre de TU PC en la tailnet (paso 1.4):

```powershell
$env:ALLOWED_HOSTS   = "mi-pc.tail1234.ts.net,localhost,127.0.0.1"
$env:ALLOWED_ORIGINS = "https://mi-pc.tail1234.ts.net,http://localhost:8123"
$env:TRUST_PROXY     = "1"     # ver la advertencia de abajo: todavía hay que verificarlo con tu Tailscale
node --no-warnings server/main.ts
```

Qué hace cada una y **qué pasa si te equivocás**:

| Variable | Para qué sirve | Consecuencia |
|---|---|---|
| `ALLOWED_HOSTS` | Lista **exacta** de nombres de `Host` que el servidor acepta (el nombre de tu PC en la tailnet **y** `localhost`/`127.0.0.1` para que vos puedas jugar y usar el backoffice desde esta misma PC). Por defecto solo `localhost`/`127.0.0.1`/`[::1]`. Un nombre de loopback solo vale con el **puerto del juego** (`localhost:8123`). | Sin tu nombre, tus amigos ven **403 "Host no permitido"**. **No uses `*.ts.net` ni `*`**: aceptarían cualquier máquina de cualquier tailnet que apunte a tu PC. Con `*` el servidor deja de filtrar el Host. |
| `ALLOWED_ORIGINS` | **Exigida** para exponerlo: los orígenes desde los que un navegador puede hablar con tu juego (pedidos y WebSocket), p. ej. `https://mi-pc.tail1234.ts.net` **más** `http://localhost:8123` para vos (cuando la definís, manda sobre todo lo derivado: lo que no está en la lista se rechaza, también `localhost`). Es lo que frena a una página de otro sitio que intente usar tu juego con la sesión de un amigo. | Si no la ponés, el servidor deriva el Origin de `ALLOWED_HOSTS`: para un host concreto acepta `https://host` (puerto 443) o `http://host:8123`, y para `localhost`, solo `http://localhost:8123` (y solo si el juego escucha en loopback). Con un comodín en `ALLOWED_HOSTS` acepta cualquier puerto: por eso conviene fijarla. Si te equivocás en el nombre, el navegador no puede conectar el WebSocket: el servidor responde **HTTP 403 antes del upgrade** (no hay un código de cierre 4403) y en la consola del navegador solo se ve que falló la conexión. |
| `TRUST_PROXY=1` | Le dice al servidor que la IP real del cliente es la **última** entrada de `X-Forwarded-For`. | Ver abajo. |

> **TRUST_PROXY: pendiente de verificar con `tailscale serve` real.** Esta guía se escribió **sin** poder probarlo contra un Tailscale de verdad (no estaba instalado donde se desarrolló). El código está probado con cabeceras simuladas, no con el proxy real. Lo que hay que comprobar: que `tailscale serve` agregue la IP del cliente al final de `X-Forwarded-For`. Cómo verificarlo:
> 1. Arrancá con `DEBUG_HEADERS=1` (además del resto):
>    ```powershell
>    $env:DEBUG_HEADERS = "1"
>    node --no-warnings server/main.ts
>    ```
> 2. Abrí el juego **desde otro dispositivo** de tu tailnet (el celular) y mirá la terminal. Cada pedido imprime una línea como
>    `[debug-ip] socket=127.0.0.1 x-forwarded-for=[100.101.102.103] usada=100.101.102.103 trust_proxy=1`.
>    Imprime **solo** la cadena de IP (nunca otras cabeceras, cookies ni tokens) y se calla después de 200 líneas.
> 3. Si `x-forwarded-for` está vacío o `usada` es `127.0.0.1`, tu `tailscale serve` no manda la IP: **sacá `TRUST_PROXY`**. Sin la variable todos los jugadores comparten la IP de loopback y los límites por IP (altas, pedidos, intentos fallidos) valen para todos juntos (uno que abuse frena a los demás), pero nadie puede falsear su IP.
> 4. Si `usada` muestra la IP de tu amigo (`100.x.y.z`), está bien. Después apagá `DEBUG_HEADERS`.
>
> **No pongas `TRUST_PROXY=1` si no hay un proxy delante** (por ejemplo, si abrís el juego directo en la LAN): cualquiera podría falsear su IP con la cabecera y esquivar los límites por IP.

Otras variables útiles: `MAX_PLAYERS` (tope de jugadores, 30), `GAME_PORT`/primer argumento (puerto, 8123), `TURN_SECONDS` (tiempo por turno, 90), `MATCH_RETENTION_DAYS` (días que se guardan las partidas terminadas, 30), `MATCH_STARTS_PER_MIN`/`MATCH_STARTS_PER_HOUR` (partidas que puede empezar un jugador, 6 y 60), `MAX_CONNECTIONS` (512), `SIGNUP_FAILS_PER_HOUR` (intentos de alta fallidos por IP, 10). La lista completa está al principio de `server/main.ts` y `server/ws.ts`.

**Qué se registra:** el servidor escribe a la salida de error (una línea por evento, con la hora y la IP del cliente cuando se conoce): altas, rechazos 403/429, invitaciones inválidas o agotadas, autenticaciones fallidas del WebSocket, cierres por límites (4429) y partidas anuladas. **Nunca** escribe tokens ni códigos de invitación. Si lo corrés como servicio, redirigí la salida de error a un archivo.

**Cabeceras de seguridad:** todas las respuestas llevan `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` y `X-Content-Type-Options: nosniff`; `index.html` además lleva una CSP: `default-src 'self'`, `connect-src 'self' ws: wss:`, `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`, `form-action 'self'`. `script-src` incluye **`'unsafe-inline'`** porque el juego transpila `src/*.ts` en el navegador y los ejecuta como `<script>` en línea creados desde JavaScript (sin nonces posibles); **no** incluye `'unsafe-eval'` (se probó en Chrome: el juego anda sin él). Si algún día se precompila el TypeScript en un paso de build, se puede sacar también `'unsafe-inline'`.

> No cambies `GAME_HOST` a `0.0.0.0` para esto: eso abre el juego a toda tu red local (LAN). Con Tailscale no hace falta.

## 3. Publicarlo en tu tailnet

En otra terminal:

```
tailscale serve --bg 8123
```

Eso crea un link HTTPS **privado** (solo gente de tu tailnet) hacia el puerto 8123 de tu PC. `tailscale serve status` te muestra la URL, por ejemplo `https://mi-pc.tail1234.ts.net/`. Para sacarlo: `tailscale serve reset`.

### NO uses Funnel

`tailscale funnel` publica el servicio en **Internet abierta**. No lo uses: este juego está pensado para una tailnet privada (invitaciones, límites y filtros están dimensionados para eso). Y **nunca** compartas el puerto 8125 (admin): es solo para el backoffice, en esta PC.

## 4. Invitar amigos

### 4.1 Compartir tu PC en Tailscale

Tus amigos tienen que poder ver tu PC en la tailnet. Dos formas:

- **Invitarlos a tu tailnet** (admin → *Users* → *Invite users*): entran con su propia cuenta. Más simple, pero ven todos tus dispositivos si no configurás ACLs.
- **Compartir solo esta PC** (admin → *Machines* → los tres puntos de tu PC → *Share…*): le mandás un link y el amigo, con su propia tailnet, ve **solo** esa máquina. Recomendado.

Tu amigo instala Tailscale, acepta el link y ya puede abrir `https://mi-pc.tail1234.ts.net/` en el celular.

### 4.2 Crear la invitación al juego

Para dar de alta un jugador hace falta un código de invitación (de uso limitado). Con el servidor parado o corriendo, en el repo:

```
node --no-warnings server/main.ts invite new                       # 1 uso, vence en 7 días
node --no-warnings server/main.ts invite new --uses 5 --days 3 "amigos del viernes"
node --no-warnings server/main.ts invite list
node --no-warnings server/main.ts invite revoke <código o id>
```

El código aparece **una sola vez** (en la base queda solo su hash). Copialo en el momento.

### 4.3 Armar el link

Pegá el código al final de la URL, después de `#invite=`:

```
https://mi-pc.tail1234.ts.net/#invite=K7Q2-9XMB
```

Mandáselo a tu amigo: al abrirlo, el código ya viene cargado y solo tiene que escribir su nombre. (Va después del `#` a propósito: el fragmento no se manda al servidor ni queda en los logs.) Si el código vence o se agota, el alta falla con "Código de invitación inválido o usado".

## 5. Backup de la base de datos

Las colecciones, mazos y buzones están en `data/game.db`. No la toques a mano. Para copiarla:

```
python tools/backup_db.py
```

Copia a `%USERPROFILE%\tcglocal-backups` (conserva las 20 más nuevas) usando la API de backup de SQLite, así que es **seguro con el juego corriendo**. Opciones: `--keep 30`, `--dest D:\bk`, `--db otra.db`. Es un script de Python (solo biblioteca estándar) que lee el mismo archivo SQLite que usa el servidor Node: sigue valiendo. Podés programarlo con el Programador de tareas de Windows.

Para restaurar: **pará el juego** y copiá un `game-AAAAMMDD-HHMMSS.db` sobre `data/game.db`.

## 6. Resumen de comandos del día a día

| Querés… | Comando |
|---|---|
| Arrancar | `node --no-warnings server/main.ts` (con `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` y, si lo verificaste, `TRUST_PROXY` cuando hay amigos) |
| Parar | `Ctrl+C` (anula las partidas en curso) |
| Publicar en la tailnet | `tailscale serve --bg 8123` |
| Despublicar | `tailscale serve reset` |
| Invitar | `node --no-warnings server/main.ts invite new` |
| Backup | `python tools/backup_db.py` |

## 7. Alternativa: Cloudflare Tunnel + Access

Si preferís un link público tipo `https://juego.tudominio.com` (necesitás un dominio en Cloudflare), se puede con **Cloudflare Tunnel** (`cloudflared`) apuntando a `http://127.0.0.1:8123`. Es una **alternativa**, no lo recomendado:

- **Cloudflare Access es obligatorio** (política que deje entrar solo a los emails de tus amigos). Sin Access, el juego queda abierto a todo Internet y solo lo frena el código de invitación.
- Variables: `ALLOWED_HOSTS=juego.tudominio.com,localhost,127.0.0.1`, `ALLOWED_ORIGINS=https://juego.tudominio.com`, `TRUST_PROXY=1` (Cloudflare manda la IP real en `X-Forwarded-For`; verificalo igual con `DEBUG_HEADERS=1`, ver arriba).
- El juego manda un ping por el WebSocket cada 25 s porque Cloudflare corta conexiones ociosas a los 100 s.
- Igual que con Tailscale: el túnel apunta **solo** al puerto 8123; el 8125 (admin) nunca.

No abras puertos en el router en ninguno de los dos casos.

## 8. Si algo falla

- **403 "Host no permitido"**: el nombre que usa el navegador no está en `ALLOWED_HOSTS` (tiene que ser exacto, y `localhost:<puerto>` solo vale con el puerto del juego). Mirá la línea `403 Host no permitido` en la terminal.
- **El WebSocket no conecta** (en el navegador solo se ve que falló; el servidor contesta **HTTP 403 antes del upgrade**, no hay cierre 4403): revisá `ALLOWED_ORIGINS` (esquema, nombre y puerto exactos) y `ALLOWED_HOSTS`. En la terminal aparece `upgrade rechazado 403 (Host/Origin)`.
- **429 "Demasiados intentos"**: límites de pedidos/altas; si todos comparten IP, falta `TRUST_PROXY=1` (verificalo con `DEBUG_HEADERS=1`).
- **"El servidor está lleno" (503)**: subí `MAX_PLAYERS`.
- **Falta `vendor/typescript.js`**: corré `npm ci` y `node tools/vendor.mjs`.
- **Tailscale no da link HTTPS**: activá MagicDNS y HTTPS Certificates en la consola de administración.
