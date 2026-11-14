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

Variables para exponerlo por Tailscale (en PowerShell, antes de arrancar):

```powershell
$env:ALLOWED_HOSTS = "*.ts.net"
$env:TRUST_PROXY = "1"
node --no-warnings server/main.ts
```

Qué hace cada una y **qué pasa si te equivocás**:

| Variable | Para qué sirve | Consecuencia |
|---|---|---|
| `ALLOWED_HOSTS=*.ts.net` | Lista de nombres de `Host` que el servidor acepta. Por defecto solo `localhost`/`127.0.0.1`. Con `*.ts.net` acepta cualquier nombre de tu tailnet. | Sin esto, tus amigos ven **403 "Host no permitido"**. Con `*` aceptás cualquier nombre: no lo pongas salvo que sepas por qué. |
| `ALLOWED_ORIGINS` | (Opcional) Orígenes permitidos para los pedidos y el WebSocket, p. ej. `https://mi-pc.tail1234.ts.net`. Si no la ponés, vale cualquier `http(s)` cuyo host esté en `ALLOWED_HOSTS`. | Ponerla más estricta protege contra páginas de otros sitios que intenten hablar con tu juego; si te equivocás en el nombre, el WebSocket se cierra con error 4403. |
| `TRUST_PROXY=1` | Le dice al servidor que confíe en `X-Forwarded-For` para saber la IP real del cliente. | **Pongala solo si el servidor está detrás de `tailscale serve`/túnel.** Sin ella, todos los jugadores parecen venir de `127.0.0.1` y comparten los límites de pedidos (uno que abuse bloquea a todos). Con ella y **sin** proxy delante, cualquiera podría falsear su IP y esquivar los límites. |

Otras variables útiles: `MAX_PLAYERS` (tope de jugadores, 30), `GAME_PORT`/primer argumento (puerto, 8123), `TURN_SECONDS` (tiempo por turno, 90). La lista completa está al principio de `server/main.ts`.

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
| Arrancar | `node --no-warnings server/main.ts` (con `ALLOWED_HOSTS` y `TRUST_PROXY` si hay amigos) |
| Parar | `Ctrl+C` (anula las partidas en curso) |
| Publicar en la tailnet | `tailscale serve --bg 8123` |
| Despublicar | `tailscale serve reset` |
| Invitar | `node --no-warnings server/main.ts invite new` |
| Backup | `python tools/backup_db.py` |

## 7. Alternativa: Cloudflare Tunnel + Access

Si preferís un link público tipo `https://juego.tudominio.com` (necesitás un dominio en Cloudflare), se puede con **Cloudflare Tunnel** (`cloudflared`) apuntando a `http://127.0.0.1:8123`. Es una **alternativa**, no lo recomendado:

- **Cloudflare Access es obligatorio** (política que deje entrar solo a los emails de tus amigos). Sin Access, el juego queda abierto a todo Internet y solo lo frena el código de invitación.
- Variables: `ALLOWED_HOSTS=juego.tudominio.com`, `ALLOWED_ORIGINS=https://juego.tudominio.com`, `TRUST_PROXY=1` (Cloudflare manda la IP real en `X-Forwarded-For`).
- El juego manda un ping por el WebSocket cada 25 s porque Cloudflare corta conexiones ociosas a los 100 s.
- Igual que con Tailscale: el túnel apunta **solo** al puerto 8123; el 8125 (admin) nunca.

No abras puertos en el router en ninguno de los dos casos.

## 8. Si algo falla

- **403 "Host no permitido"**: falta `ALLOWED_HOSTS=*.ts.net` (o el nombre no coincide).
- **El WebSocket no conecta (cierre 4403)**: revisá `ALLOWED_ORIGINS`; sin esa variable alcanza con `ALLOWED_HOSTS`.
- **429 "Demasiados intentos"**: límites de pedidos/altas; si todos comparten IP, te falta `TRUST_PROXY=1`.
- **"El servidor está lleno" (503)**: subí `MAX_PLAYERS`.
- **Falta `vendor/typescript.js`**: corré `npm ci` y `node tools/vendor.mjs`.
- **Tailscale no da link HTTPS**: activá MagicDNS y HTTPS Certificates en la consola de administración.
