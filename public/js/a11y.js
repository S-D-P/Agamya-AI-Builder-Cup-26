// Accessibility helpers shared by all views.
// announce(): one persistent polite live region (outside the re-rendered #app), so screen readers hear status changes
// such as "answer sent" or "transcript ready" without focus moving. Native <dialog>.showModal() already makes the page
// behind inert and handles Escape; restoreFocus() returns focus to the control that opened it, even after a re-render.
let region = null;
export function announce(message) {
  if (!region) {
    region = document.getElementById("announcer") ?? Object.assign(document.createElement("div"), { id: "announcer", className: "sr-only" });
    region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite"); region.setAttribute("aria-atomic", "true");
    if (!region.isConnected) document.body.appendChild(region);
  }
  region.textContent = "";
  setTimeout(() => { region.textContent = message; }, 30); // clear-then-set so repeated messages are re-announced
}

/** Return focus after a dialog closes. Views re-render, so the opener element may be gone: find its replacement by selector. */
export function focusSelectorFor(el) {
  if (!el || el === document.body || el.id === "main") return el?.id === "main" ? "#main" : null;
  if (el.dataset?.focus) return `[data-focus="${CSS.escape(el.dataset.focus)}"]`;
  if (el.id) return `#${CSS.escape(el.id)}`;
  // No id: identify the control by its tag and every data attribute (e.g. data-act + data-p for a toggle chip).
  const attrs = Object.entries(el.dataset ?? {}).filter(([, v]) => v !== "").map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${CSS.escape(v)}"]`).join("");
  return attrs ? `${el.tagName.toLowerCase()}${attrs}` : null;
}
export function restoreFocus(selector, fallback) {
  const el = (selector && document.querySelector(selector)) || fallback;
  el?.focus?.({ preventScroll: false });
}
