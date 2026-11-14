// =====================================================================
//  Controles táctiles (celular / tablet): cruceta, A, B, START y VER.
//  Cada botón "aprieta" la tecla equivalente del teclado, así el resto del
//  juego no se entera de si se juega con teclado o con el dedo.
//  La disposición (vertical / horizontal) la arma index.html con CSS.
// =====================================================================

const TOUCH = {
  enabled: false,
  held: new Map<number, { code: string; repeat?: number }>(), // pointerId → tecla
  pad: null as HTMLElement | null,
};

function keyEvent(type: "keydown" | "keyup", code: string, repeat = false): void {
  // key = code (más de un carácter) para que no cuente como letra escrita
  window.dispatchEvent(new KeyboardEvent(type, { code, key: code, repeat, bubbles: true }));
}

/** En el popup de renombrar mazo, A confirma y B cancela (como ENTER / ESC). */
function remap(code: string): string {
  if (game.mode === "menu" && DM.popup === "rename") {
    if (code === "KeyZ") return "Enter";
    if (code === "KeyX") return "Escape";
  }
  return code;
}

function pressKey(pointer: number, code: string, autoRepeat: boolean): void {
  releaseKey(pointer);
  code = remap(code);
  keyEvent("keydown", code);
  const h: { code: string; repeat?: number } = { code };
  if (autoRepeat) {
    // mantener apretado: repite como el teclado (para recorrer listas)
    h.repeat = window.setTimeout(function again() {
      keyEvent("keydown", code, true);
      h.repeat = window.setTimeout(again, 90);
    }, 380);
  }
  TOUCH.held.set(pointer, h);
  navigator.vibrate?.(8);
}

function releaseKey(pointer: number): void {
  const h = TOUCH.held.get(pointer);
  if (!h) return;
  clearTimeout(h.repeat);
  keyEvent("keyup", h.code);
  TOUCH.held.delete(pointer);
}

const DPAD_CODES: Record<Dir, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

/** Cruceta: la dirección sale de dónde está el dedo respecto del centro (se puede deslizar). */
function bindDpad(el: HTMLElement): void {
  const dirAt = (e: PointerEvent): Dir | null => {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.12) return null; // zona muerta
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  };
  const show = (d: Dir | null) => el.setAttribute("data-dir", d ?? "");
  const move = (e: PointerEvent) => {
    if (!TOUCH.held.has(e.pointerId) && e.type === "pointermove") return;
    const d = dirAt(e);
    const cur = TOUCH.held.get(e.pointerId)?.code;
    if (d && cur !== DPAD_CODES[d]) pressKey(e.pointerId, DPAD_CODES[d], true);
    if (!d && cur) releaseKey(e.pointerId);
    show(d);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const d = dirAt(e);
    if (d) pressKey(e.pointerId, DPAD_CODES[d], true);
    show(d);
  });
  el.addEventListener("pointermove", move);
  const up = (e: PointerEvent) => {
    releaseKey(e.pointerId);
    show(null);
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function bindButton(el: HTMLElement): void {
  const code = el.dataset.code!;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("on");
    pressKey(e.pointerId, code, el.dataset.repeat === "1");
  });
  const up = (e: PointerEvent) => {
    el.classList.remove("on");
    releaseKey(e.pointerId);
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

/** Teclado del celular para escribir el nombre de un mazo. */
function bindTyping(btn: HTMLElement, input: HTMLInputElement): void {
  btn.addEventListener("click", () => {
    input.value = DM.renameText;
    input.focus();
  });
  input.addEventListener("input", () => {
    if (DM.popup !== "rename") return;
    DM.renameText = input.value.replace(/[^\p{L}\p{N} '!¡?¿.\-]/gu, "").slice(0, DECK_NAME_MAX);
    if (input.value !== DM.renameText) input.value = DM.renameText;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      input.blur();
      keyEvent("keydown", "Enter");
      keyEvent("keyup", "Enter");
    }
    e.stopPropagation(); // que las letras no muevan al personaje
  });
}

function enableTouch(): void {
  if (TOUCH.enabled) return;
  TOUCH.enabled = true;
  document.body.classList.add("touch");
  window.dispatchEvent(new Event("resize"));
}

function initTouch(): void {
  const pad = document.getElementById("pad");
  if (!pad) return;
  TOUCH.pad = pad;
  bindDpad(pad.querySelector(".dpad") as HTMLElement);
  pad.querySelectorAll<HTMLElement>("[data-code]").forEach(bindButton);
  const typeBtn = document.getElementById("typeBtn");
  const typeInput = document.getElementById("typeInput") as HTMLInputElement | null;
  if (typeBtn && typeInput) bindTyping(typeBtn, typeInput);
  // se activan solos en pantallas táctiles (o al primer toque)
  if (matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch")) enableTouch();
  window.addEventListener("touchstart", enableTouch, { once: true, passive: true });
  // botón de escribir: visible solo mientras se renombra un mazo
  const tick = () => {
    typeBtn?.classList.toggle("show", TOUCH.enabled && game.mode === "menu" && DM.popup === "rename");
    requestAnimationFrame(tick);
  };
  tick();
  // al perder el foco, soltar todo (que no quede una tecla trabada)
  window.addEventListener("blur", () => [...TOUCH.held.keys()].forEach(releaseKey));
}

initTouch();
