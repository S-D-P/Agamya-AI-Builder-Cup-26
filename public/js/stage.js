// Landing stage: one continuous painted frame in which each scene of knowledge being practised melts into the next.
// Original artwork, drawn in code, in the spirit of hand-painted 90s cel animation: layered washes of sky, flat cel-shaded
// figures with a single rim light, and one small living detail per scene. Nothing is copied from any film.
// Accessibility: a visible pause control (WCAG 2.2.2), a still frame under prefers-reduced-motion, and a text description.

const W = 1600, H = 720;

// Shared painted-sky helper: a vertical wash plus a soft sun.
const sky = (id, stops, sun) => `
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>
  ${sun ? `<radialGradient id="${id}-sun" cx="${sun.x}" cy="${sun.y}" r="${sun.r}"><stop offset="0" stop-color="${sun.c}" stop-opacity=".95"/><stop offset="1" stop-color="${sun.c}" stop-opacity="0"/></radialGradient>` : ""}</defs>
  <rect x="-600" width="${W + 600}" height="${H}" fill="url(#${id})"/>${sun ? `<rect x="-600" width="${W + 600}" height="${H}" fill="url(#${id}-sun)"/>` : ""}`;

export const SCENES = [
  {
    key: "kathak", place: "Jaipur, India", craft: "Kathak · ghungroo and alta",
    svg: () => `${sky("s1", [[0, "#f6b48a"], [0.45, "#e9798a"], [1, "#6d2f5f"]], { x: 0.72, y: 0.38, r: 0.35, c: "#ffe2a8" })}
      <g fill="#b64a62" opacity=".55"><path d="M0 470 Q120 380 240 470 L240 720 L0 720Z"/><path d="M220 470 Q340 360 460 470 L460 720 L220 720Z"/><path d="M1140 470 Q1260 370 1380 470 L1380 720 L1140 720Z"/><path d="M1360 470 Q1480 380 1600 470 L1600 720 L1360 720Z"/></g>
      <g fill="#8a2f52"><rect x="-600" y="560" width="2200" height="160"/><g opacity=".7">${[80, 300, 1200, 1420].map((x) => `<rect x="${x}" y="500" width="60" height="70" rx="30"/>`).join("")}</g></g>
      <ellipse cx="800" cy="640" rx="260" ry="22" fill="#4a1736" opacity=".45"/>
      <g class="spin" style="transform-origin:800px 520px">
        <path d="M800 400 C700 470 610 560 600 640 Q800 690 1000 640 C990 560 900 470 800 400Z" fill="#f2e3c6"/>
        <path d="M800 400 C760 470 700 560 690 650 Q745 662 800 664 Z" fill="#e2c79c"/>
        <path d="M612 628 Q800 678 988 628" stroke="#c0392b" stroke-width="10" fill="none"/>
      </g>
      <path d="M770 300 Q800 285 830 300 L840 410 Q800 425 760 410Z" fill="#2c1530"/>
      <path d="M770 320 Q700 280 660 210" stroke="#2c1530" stroke-width="22" stroke-linecap="round" fill="none"/>
      <path d="M830 320 Q900 270 945 300" stroke="#2c1530" stroke-width="22" stroke-linecap="round" fill="none"/>
      <circle cx="800" cy="262" r="34" fill="#2c1530"/><path d="M782 240 Q800 220 830 236 Q842 270 820 296" stroke="#ffd9a0" stroke-width="3" fill="none" opacity=".8"/>
      <path d="M766 262 Q760 330 744 360" stroke="#2c1530" stroke-width="14" stroke-linecap="round" fill="none"/>
      <g class="jingle"><g fill="#f0c24b">${[0, 1, 2, 3, 4].map((i) => `<circle cx="${764 + i * 9}" cy="${676 + (i % 2) * 4}" r="5"/><circle cx="${822 + i * 9}" cy="${676 + ((i + 1) % 2) * 4}" r="5"/>`).join("")}</g></g>
      <path d="M758 686 q16 -6 34 0 M816 686 q16 -6 34 0" stroke="#d6213c" stroke-width="7" stroke-linecap="round" fill="none"/>`,
  },
  {
    key: "weaver", place: "Phulia, Bengal", craft: "Handloom · jamdani weaving",
    svg: () => `${sky("s2", [[0, "#cfe6da"], [0.5, "#9cc7b4"], [1, "#2f5d55"]], { x: 0.2, y: 0.25, r: 0.3, c: "#fff5d6" })}
      <path d="M-600 420 Q100 380 800 420 T1600 410 L1600 720 L-600 720Z" fill="#6ea08d" opacity=".55"/>
      <path d="M-600 470 L1600 470 L1600 520 L-600 520Z" fill="#a8d1c9" opacity=".6"/>
      <path d="M200 495 q40 -20 90 0 l-10 10 h-70z" fill="#2f5d55" opacity=".7"/><path d="M245 495 v-40 l30 30z" fill="#2f5d55" opacity=".7"/>
      <rect x="-600" y="520" width="2200" height="200" fill="#5b3a29"/>
      <g stroke="#3a2418" stroke-width="16" stroke-linecap="round"><path d="M560 300 V640 M1100 300 V640 M540 300 H1120 M540 470 H1120"/></g>
      <g stroke="#f4ead2" stroke-width="2" opacity=".9">${Array.from({ length: 36 }, (_, i) => `<path d="M${580 + i * 14} 312 V462"/>`).join("")}</g>
      <rect x="580" y="410" width="500" height="52" fill="#e9e1f0"/><g fill="#7b4a9a" opacity=".85">${Array.from({ length: 9 }, (_, i) => `<path d="M${600 + i * 54} 436 l12 -12 l12 12 l-12 12z"/>`).join("")}</g>
      <g class="shuttle"><rect x="590" y="452" width="70" height="14" rx="7" fill="#c98b3a"/></g>
      <path d="M1180 470 Q1160 420 1190 390 Q1230 370 1250 410 L1270 520 L1170 540Z" fill="#23333a"/>
      <circle cx="1216" cy="360" r="30" fill="#23333a"/><path d="M1196 344 Q1216 326 1240 340" stroke="#fff5d6" stroke-width="3" fill="none" opacity=".7"/>
      <path d="M1190 430 Q1120 440 1080 452" stroke="#23333a" stroke-width="18" stroke-linecap="round" fill="none"/>`,
  },
  {
    key: "sword", place: "Seki, Japan", craft: "Swordsmith · polishing the blade",
    svg: () => `${sky("s3", [[0, "#1b2340"], [0.6, "#3a3f6a"], [1, "#151826"]], { x: 0.8, y: 0.2, r: 0.12, c: "#f3ead0" })}
      <circle cx="1280" cy="140" r="54" fill="#f3ead0"/>
      <g fill="#f4d7a1" opacity=".9">${[0, 1, 2, 3].map((i) => `<rect x="${120 + i * 150}" y="150" width="130" height="330" rx="2"/>`).join("")}</g>
      <g stroke="#2a2216" stroke-width="5">${[0, 1, 2, 3].map((i) => `<path d="M${185 + i * 150} 150 V480 M${120 + i * 150} 260 H${250 + i * 150} M${120 + i * 150} 370 H${250 + i * 150}"/>`).join("")}</g>
      <rect x="-600" y="480" width="2200" height="240" fill="#2a2216"/><g stroke="#3a2f20" stroke-width="3">${Array.from({ length: 8 }, (_, i) => `<path d="M0 ${500 + i * 28} H1600"/>`).join("")}</g>
      <path d="M840 380 Q800 330 830 300 Q880 280 900 330 L930 470 Q880 520 800 500Z" fill="#0f1220"/>
      <circle cx="866" cy="268" r="32" fill="#0f1220"/><path d="M846 250 Q866 232 890 246" stroke="#f3ead0" stroke-width="3" fill="none" opacity=".6"/>
      <path d="M820 420 Q760 430 700 420" stroke="#0f1220" stroke-width="18" stroke-linecap="round" fill="none"/>
      <path d="M900 420 Q960 432 1000 424" stroke="#0f1220" stroke-width="18" stroke-linecap="round" fill="none"/>
      <path d="M520 418 Q800 400 1080 414 L1082 420 Q800 410 522 426Z" fill="#d9dde6"/>
      <rect x="470" y="412" width="60" height="16" rx="4" fill="#3b2a1a"/><rect x="520" y="404" width="10" height="32" fill="#a07a3a"/>
      <g class="glint"><path d="M560 410 l40 -2 l-40 14z" fill="#ffffff" opacity=".95"/></g>`,
  },
  {
    key: "kpop", place: "Seoul, Korea", craft: "Vocal coach · fixing the pitch",
    svg: () => `${sky("s4", [[0, "#22114a"], [0.55, "#5b2a8c"], [1, "#160b2b"]], { x: 0.5, y: 0.1, r: 0.4, c: "#ff7ad9" })}
      <g opacity=".35" fill="#ff7ad9">${Array.from({ length: 10 }, (_, i) => `<rect x="${i * 170}" y="80" width="6" height="400"/>`).join("")}</g>
      <rect x="-600" y="540" width="2200" height="180" fill="#120926"/>
      <path class="wave" d="M200 300 Q300 230 400 300 T600 300 T800 300 T1000 300 T1200 300 T1400 300" stroke="#7ef2ff" stroke-width="6" fill="none" stroke-linecap="round"/>
      <path d="M200 300 H1400" stroke="#ffffff" stroke-width="2" stroke-dasharray="10 12" opacity=".5"/>
      <g fill="#ffe36e">${[480, 760, 1040].map((x) => `<circle cx="${x}" cy="300" r="10"/>`).join("")}</g>
      <path d="M560 560 Q540 470 580 430 Q620 410 650 450 L670 560Z" fill="#0b0518"/><circle cx="612" cy="400" r="30" fill="#0b0518"/>
      <path d="M600 384 Q612 370 632 380" stroke="#ff7ad9" stroke-width="3" fill="none"/>
      <path d="M640 470 Q700 440 740 420" stroke="#0b0518" stroke-width="16" stroke-linecap="round" fill="none"/>
      <path d="M980 560 Q960 480 1000 450 Q1040 434 1062 470 L1080 560Z" fill="#0b0518"/><circle cx="1026" cy="420" r="28" fill="#0b0518"/>
      <rect x="1000" y="470" width="8" height="90" fill="#7ef2ff" opacity=".6"/><circle cx="1004" cy="462" r="12" fill="#cfd6ff"/>`,
  },
  {
    key: "code", place: "Bengaluru, India", craft: "Engineer · debugging at month-end",
    svg: () => `${sky("s5", [[0, "#0d1414"], [1, "#050808"]], { x: 0.5, y: 0.45, r: 0.45, c: "#1d8a7a" })}
      <rect x="430" y="140" width="740" height="420" rx="18" fill="#0a1a19" stroke="#2fd3b5" stroke-width="3"/>
      <g font-family="JetBrains Mono, monospace" font-size="22" fill="#9df5e2">
        <text x="470" y="200">if (period.isMonthEnd()) {</text><text x="500" y="240">  inspectUpstream(txn);</text>
        <text x="470" y="280">}</text><text x="470" y="330" fill="#ff8f8f" class="bug">retry(txn); // posts twice</text>
        <text x="470" y="330" fill="#8dff9e" class="fix" opacity="0">retryAfterValidation(txn);</text>
        <text x="470" y="380" fill="#4e8b80">// why? ask the person who knows</text></g>
      <rect class="caret" x="470" y="400" width="14" height="26" fill="#9df5e2"/>
      <rect x="-600" y="600" width="2200" height="120" fill="#081010"/><rect x="740" y="560" width="120" height="44" fill="#123"/>
      <path d="M760 720 Q740 640 790 610 Q840 596 860 640 L880 720Z" fill="#000"/><circle cx="820" cy="580" r="32" fill="#000"/>
      <path d="M800 566 Q820 552 844 562" stroke="#2fd3b5" stroke-width="3" fill="none" opacity=".8"/>`,
  },
  {
    key: "invest", place: "Singapore", craft: "Investor · deciding what to back",
    svg: () => `${sky("s6", [[0, "#ffd8a8"], [0.5, "#f5a27a"], [1, "#4a3a5c"]], { x: 0.65, y: 0.55, r: 0.35, c: "#fff1c4" })}
      <g fill="#6b4f7a" opacity=".75"><rect x="80" y="380" width="90" height="340"/><rect x="190" y="300" width="70" height="420"/><rect x="280" y="420" width="110" height="300"/>
        <rect x="1180" y="330" width="80" height="390"/><rect x="1280" y="250" width="60" height="470"/><rect x="1360" y="400" width="140" height="320"/><path d="M1290 250 l20 -40 l20 40z"/></g>
      <rect x="-600" y="0" width="2200" height="720" fill="none" stroke="#2b2236" stroke-width="40"/><path d="M800 0 V720" stroke="#2b2236" stroke-width="16"/>
      <path class="chart" d="M480 520 L560 490 L640 505 L720 440 L800 455 L880 380 L960 395 L1040 320" stroke="#2b2236" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="1040" cy="320" r="10" fill="#2b2236"/>
      <path d="M1060 720 Q1040 610 1080 570 Q1120 550 1150 590 L1170 720Z" fill="#2b2236"/><circle cx="1110" cy="540" r="32" fill="#2b2236"/>
      <path d="M1092 524 Q1110 510 1132 520" stroke="#fff1c4" stroke-width="3" fill="none" opacity=".8"/>
      <path d="M1090 610 Q1070 580 1100 560" stroke="#2b2236" stroke-width="16" stroke-linecap="round" fill="none"/>`,
  },
];

const HOLD = 5200, MELT = 1700;

/** Markup for the stage. Every scene is in the DOM; the controller fades and melts between them. */
export function stageMarkup() {
  return `<figure class="stage" aria-labelledby="stage-cap">
    <svg viewBox="-520 0 ${W + 520} ${H}" preserveAspectRatio="xMaxYMid slice" role="img" aria-labelledby="stage-title stage-desc" focusable="false">
      <title id="stage-title">People passing on what they know</title>
      <desc id="stage-desc">A painted animation that melts from a Kathak dancer's ghungroo and alta in Jaipur, to a weaver at a Bengal handloom, a swordsmith polishing a blade in Japan, a K-pop vocal coach fixing pitch in Seoul, an engineer debugging, and an investor deciding at dawn.</desc>
      <defs>${SCENES.map((_, i) => `<filter id="melt${i}" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.008 0.022" numOctaves="2" seed="${i * 7 + 3}"/><feDisplacementMap in="SourceGraphic" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter>`).join("")}</defs>
      ${SCENES.map((s, i) => `<g class="scene" data-i="${i}" filter="url(#melt${i})" opacity="${i === 0 ? 1 : 0}">${s.svg()}</g>`).join("")}
    </svg>
    <figcaption id="stage-cap" class="stage-cap" aria-live="off"><span class="stage-place">${SCENES[0].place}</span><span class="stage-craft">${SCENES[0].craft}</span></figcaption>
    <button class="stage-toggle" type="button" data-act="stage-toggle" aria-pressed="false">Pause animation</button>
  </figure>`;
}

let timer = null, raf = null, current = 0, paused = false;

/** Start (or resume) the melt sequence on the rendered stage. Safe to call after every render. */
export function startStage() {
  const root = document.querySelector(".stage svg");
  if (!root || root.dataset.running) return;
  root.dataset.running = "1";
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { setPaused(true, true); return; }
  schedule();
}
function schedule() { clearTimeout(timer); if (!paused) timer = setTimeout(next, HOLD); }

function next() {
  const scenes = [...document.querySelectorAll(".stage .scene")];
  if (!scenes.length) return;
  const from = scenes[current], to = scenes[(current + 1) % scenes.length];
  const dFrom = document.querySelector(`#melt${from.dataset.i} feDisplacementMap`), dTo = document.querySelector(`#melt${to.dataset.i} feDisplacementMap`);
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / MELT), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    from.setAttribute("opacity", String(1 - e)); to.setAttribute("opacity", String(e));
    dFrom?.setAttribute("scale", String(90 * e)); dTo?.setAttribute("scale", String(90 * (1 - e)));
    if (k < 1) raf = requestAnimationFrame(step);
    else {
      current = (current + 1) % scenes.length;
      const s = SCENES[current], cap = document.querySelector(".stage-cap");
      if (cap) cap.innerHTML = `<span class="stage-place">${s.place}</span><span class="stage-craft">${s.craft}</span>`;
      schedule();
    }
  };
  raf = requestAnimationFrame(step);
}

function setPaused(p, reduced = false) {
  paused = p;
  document.querySelector(".stage")?.classList.toggle("paused", p);
  const b = document.querySelector(".stage-toggle");
  if (b) { b.setAttribute("aria-pressed", String(p)); b.textContent = p ? (reduced ? "Play animation" : "Play animation") : "Pause animation"; }
  if (p) { clearTimeout(timer); cancelAnimationFrame(raf); } else schedule();
}

document.addEventListener("click", (e) => { if (e.target.closest('[data-act="stage-toggle"]')) setPaused(!paused); });
