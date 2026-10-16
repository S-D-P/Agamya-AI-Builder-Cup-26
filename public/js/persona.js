// Moti, the Agamya companion: a small pearl with attentive eyes. Personality, never authority: it signals what the
// system is doing (watching, thinking, asking), never that knowledge is correct. Only people approve knowledge.
// States: idle · observing · thinking · curious · asking · learning · confirmed · teaching
import { icon } from "./icons.js";

export const CAPTIONS = {
  idle: "Ready when you are", observing: "Watching", thinking: "Thinking", curious: "Noticed something",
  asking: "May I ask?", learning: "Learning", confirmed: "Saved", teaching: "Guiding",
};

let uid = 0;
export function orb(state = "observing", size = 72, { caption = true } = {}) {
  const id = `mt${uid++}`;
  const badge = { curious: "spark", asking: "question", confirmed: "validate", teaching: "teach" }[state];
  return `<div class="orb orb-${state}" role="img" aria-label="Moti, the Agamya companion: ${CAPTIONS[state] ?? state}">
  <svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${pearl(id)}</svg>
  ${badge ? `<span class="orb-badge">${icon(badge, 12)}</span>` : ""}
  ${caption ? `<span class="orb-caption">${CAPTIONS[state] ?? ""}</span>` : ""}
</div>`;
}

/** The pearl itself (also used, still, as the brand mark). Subtly asymmetric so it reads as organic, not geometric. */
export function pearl(id = `mt${uid++}`, { still = false } = {}) {
  return `<defs>
      <radialGradient id="${id}" cx="38%" cy="32%" r="74%"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="#f6f1ea"/><stop offset=".86" stop-color="#e6ddd1"/><stop offset="1" stop-color="#d7ccbe"/></radialGradient>
      <linearGradient id="${id}i" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#dfeadf" stop-opacity=".7"/><stop offset=".55" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#f6ddd5" stop-opacity=".75"/></linearGradient>
    </defs>
    <ellipse cx="50" cy="94" rx="25" ry="3.2" fill="#1f2421" opacity=".08"/>
    <g class="${still ? "" : "body"}">
      <path d="M51 11c21 0 37 16 36.5 39.5C87 74 71 89 49.5 88.5 28 88 12.5 73 13 50.5 13.5 28 30 11 51 11z" fill="url(#${id})"/>
      <path d="M51 11c21 0 37 16 36.5 39.5C87 74 71 89 49.5 88.5 28 88 12.5 73 13 50.5 13.5 28 30 11 51 11z" fill="url(#${id}i)"/>
      <ellipse cx="35" cy="27" rx="10" ry="5.5" fill="#fff" opacity=".85" transform="rotate(-28 35 27)"/>
      <g class="eyes-open">
        <g class="lid"><ellipse cx="40.5" cy="51" rx="4.4" ry="5.8" fill="#26302b"/><circle cx="41.9" cy="49" r="1.4" fill="#fff"/></g>
        <g class="lid"><ellipse cx="60" cy="50" rx="4.4" ry="5.8" fill="#26302b"/><circle cx="61.4" cy="48" r="1.4" fill="#fff"/></g>
      </g>
      <path class="happy" d="M36 52q4.5-5 9 0M55.5 51q4.5-5 9 0" stroke="#26302b" stroke-width="2.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="33" cy="61" rx="4" ry="2" fill="#e8907a" opacity=".22"/><ellipse cx="67" cy="60" rx="4" ry="2" fill="#e8907a" opacity=".22"/>
    </g>`;
}
