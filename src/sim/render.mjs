// Renderers for simulated capture sources. They produce SVG "screens" and "camera frames"; the server rasterises
// them to PNG so they travel through exactly the same vision path as real screenshots / camera frames.
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

// Fonts: system discovery is not reliable in slim Linux images (observed: no text rendered on Cloud Run even with
// fonts-dejavu-core installed). Point resvg at the font directories that exist, and name DejaVu as the fallback.
const FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts", "C:/Windows/Fonts", "/System/Library/Fonts", "/Library/Fonts"].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
const FONT = { loadSystemFonts: true, fontDirs: FONT_DIRS, defaultFontFamily: "DejaVu Sans", sansSerifFamily: "DejaVu Sans", monospaceFamily: "DejaVu Sans Mono" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function toPng(svg, width = 960) {
  // Text in simulated frames is evidence the model reads (timers, dials, console lines), so it must render on every
  // platform: Windows/macOS have Arial and Consolas; the Linux container has DejaVu (fonts-dejavu-core in the image).
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: FONT }).render().asPng();
}

/** Boot self-check: can this host render text into simulated frames? (Missing fonts silently drop text otherwise.) */
export function textRenderingOk() {
  try {
    const px = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#fff"/><text x="6" y="30" font-size="26" font-family="Arial, DejaVu Sans, sans-serif" fill="#000">12:00</text></svg>`,
      { font: FONT }).render().pixels;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 128) ink++;
    return ink > 50;
  } catch { return false; }
}

export function render(kind, state) {
  if (kind === "console") return consoleSvg(state);
  if (kind === "loom") return loomSvg(state);
  if (kind === "sheet") return sheetSvg(state);
  if (kind === "stove") return stoveSvg(state);
  return consoleSvg({ title: kind, lines: [JSON.stringify(state)] });
}

// ---------------------------------------------------------------- legacy console (green screen)
function wrap(line, n = 74) {
  const out = [];
  let s = String(line);
  while (s.length > n) { out.push(s.slice(0, n)); s = s.slice(n); }
  out.push(s);
  return out;
}

export function consoleSvg({ title = "LGCY-PAY/OPS CONSOLE v3.2", status = "", lines = [] }) {
  const all = lines.flatMap((l) => wrap(l)).slice(-18);
  const rows = all.map((l, i) => `<text x="24" y="${78 + i * 22}">${esc(l)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="500" viewBox="0 0 960 500">
<rect width="960" height="500" fill="#0d1a12"/>
<g font-family="Consolas, DejaVu Sans Mono, 'Courier New', monospace" font-size="17" fill="#8ff0a4">
<text x="24" y="36" fill="#4f8f5e">${esc(title)}</text><text x="936" y="36" text-anchor="end" fill="#4f8f5e">${esc(status)}</text>
<line x1="24" y1="48" x2="936" y2="48" stroke="#2c5a3a" stroke-dasharray="4 4"/>${rows}</g></svg>`;
}

// ---------------------------------------------------------------- loom (camera frame of a weaving station)
export function loomSvg(s) {
  const dry = s.threadCondition === "dry";
  const warpColor = dry ? "#e8dcb5" : "#c98b4a";
  const warps = Array.from({ length: 22 }, (_, i) => {
    const x = 150 + i * 20;
    const broken = s.broken && i === 11;
    const fray = dry ? `<path d="M${x} ${200 + (i % 5) * 30} l4 -6 M${x} ${260 + (i % 4) * 25} l-4 -5" stroke="#b9a978" stroke-width="1.5"/>` : "";
    return broken
      ? `<line x1="${x}" y1="90" x2="${x}" y2="250" stroke="${warpColor}" stroke-width="4"/><line x1="${x + 6}" y1="290" x2="${x}" y2="420" stroke="${warpColor}" stroke-width="4"/><circle cx="${x + 3}" cy="270" r="9" fill="none" stroke="#d63c3c" stroke-width="3"/>`
      : `<line x1="${x}" y1="90" x2="${x}" y2="420" stroke="${warpColor}" stroke-width="4"/>${fray}`;
  }).join("");
  const wovenRows = Array.from({ length: Math.min(s.rows ?? 0, 14) }, (_, i) => `<rect x="140" y="${410 - i * 9}" width="440" height="7" fill="${i % 2 ? "#7b5ea7" : "#9c7fc8"}"/>`).join("");
  const dialAngle = -135 + ((s.tension ?? 6) / 10) * 270;
  const rad = (dialAngle * Math.PI) / 180;
  const hand = (() => {
    const pos = { warp: [370, 230], dial: [880, 250], gauge: [880, 420], shuttle: [200 + (s.shuttlePos ?? 0) * 140, 300] }[s.hand];
    if (!pos) return "";
    const [x, y] = pos;
    return `<g opacity="0.92"><ellipse cx="${x}" cy="${y + 40}" rx="34" ry="44" fill="#d9a07a"/>
      ${[-24, -8, 8, 24].map((dx, k) => `<rect x="${x + dx - 6}" y="${y - 18 + (k === 0 || k === 3 ? 8 : 0)}" width="12" height="40" rx="6" fill="#d9a07a"/>`).join("")}
      <rect x="${x + 28}" y="${y + 18}" width="12" height="30" rx="6" fill="#d9a07a" transform="rotate(-35 ${x + 34} ${y + 30})"/></g>`;
  })();
  const shuttle = s.hand === "shuttle" ? `<rect x="${170 + (s.shuttlePos ?? 0) * 140}" y="290" width="90" height="16" rx="8" fill="#5a3b1a"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<rect width="960" height="540" fill="#3a3129"/><rect x="0" y="470" width="960" height="70" fill="#2a231d"/>
<rect x="110" y="60" width="500" height="22" fill="#6b4a2b"/><rect x="110" y="425" width="500" height="22" fill="#6b4a2b"/>
<rect x="100" y="60" width="18" height="400" fill="#5a3d22"/><rect x="602" y="60" width="18" height="400" fill="#5a3d22"/>
${warps}${wovenRows}${shuttle}
<g transform="translate(770 165)"><circle r="96" fill="#1f1a15" stroke="#a88c5b" stroke-width="6"/>
<circle r="70" fill="#2d2620" stroke="#5c4a35" stroke-width="3"/>
<line x1="0" y1="0" x2="${Math.cos(rad - Math.PI / 2) * 66}" y2="${Math.sin(rad - Math.PI / 2) * 66}" stroke="#5c4a35" stroke-width="10" stroke-linecap="round"/>
<rect x="-46" y="-34" width="92" height="68" rx="8" fill="#0e0c0a" stroke="#ff5a1f" stroke-width="3"/>
<text y="22" font-size="56" font-weight="bold" fill="#ffb15c" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif">${esc(s.tension ?? 6)}</text>
<text y="124" font-size="18" fill="#e9dcc0" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif" font-weight="bold">WARP TENSION</text></g>
<g transform="translate(770 390)"><rect x="-70" y="-48" width="140" height="96" rx="10" fill="#e8e4da" stroke="#777" stroke-width="3"/>
<text y="-16" font-size="15" fill="#444" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif">HUMIDITY</text>
<text y="28" font-size="40" fill="#222" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif" font-weight="bold">${esc(s.humidity)}%</text></g>
${hand}
<text x="24" y="510" font-size="15" fill="#9a8a72" font-family="Arial, DejaVu Sans, sans-serif">CAM-1 · loom station · rows woven: ${esc(s.rows ?? 0)}</text>
</svg>`;
}

// ---------------------------------------------------------------- spreadsheet / analytics screen
export function sheetSvg({ title = "Revenue_Monthly.xlsx", tab = "", columns = [], rows = [], highlight = [], panel = [] }) {
  const cw = Math.floor(820 / Math.max(columns.length, 1));
  const head = columns.map((c, i) => `<rect x="${40 + i * cw}" y="80" width="${cw}" height="30" fill="#e9eef5" stroke="#c9d1db"/><text x="${48 + i * cw}" y="100" font-weight="bold">${esc(c)}</text>`).join("");
  const body = rows.map((r, ri) => r.map((v, ci) => {
    const hl = highlight.some(([hr, hc]) => hr === ri && (hc === undefined || hc === ci));
    return `<rect x="${40 + ci * cw}" y="${110 + ri * 28}" width="${cw}" height="28" fill="${hl ? "#ffe9a8" : "#fff"}" stroke="#dde3ea"/><text x="${48 + ci * cw}" y="${129 + ri * 28}">${esc(v)}</text>`;
  }).join("")).join("");
  const py = 130 + rows.length * 28;
  const panelSvg = panel.length
    ? `<rect x="40" y="${py}" width="820" height="${24 + panel.length * 24}" fill="#f4f7fb" stroke="#9fb3c8"/>${panel.map((p, i) => `<text x="52" y="${py + 26 + i * 24}">${esc(p)}</text>`).join("")}`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
<rect width="960" height="560" fill="#f7f9fc"/><rect width="960" height="44" fill="#1f6f43"/>
<text x="20" y="29" fill="#fff" font-size="17" font-family="Segoe UI, Arial, DejaVu Sans, sans-serif">${esc(title)}</text>
<text x="40" y="68" font-size="14" fill="#55606e" font-family="Segoe UI, Arial, DejaVu Sans, sans-serif">${esc(tab)}</text>
<g font-family="Segoe UI, Arial, DejaVu Sans, sans-serif" font-size="14" fill="#1d2733">${head}${body}${panelSvg}</g></svg>`;
}

// ---------------------------------------------------------------- stove (kitchen camera: ghee in a pan)
const SPECK = { white: "#f6f1e4", cream: "#ecdcae", light_golden: "#d7a13c", golden_brown: "#9c6226", dark_brown: "#4f2d14" };
export function stoveSvg(s) {
  const clear = s.foam === "clear", thick = s.foam === "thick";
  const liquid = clear ? "#e7b444" : thick ? "#f4e7b8" : "#efd27e";
  const speck = SPECK[s.residue] ?? SPECK.white;
  const cx = 420, cy = 285, rx = 250, ry = 150;
  // milk-solid specks resting on the bottom; larger and fully exposed when the pan is tilted
  const specks = Array.from({ length: s.tilt ? 26 : 18 }, (_, i) => {
    const a = (i * 137.5 * Math.PI) / 180, rr = 0.22 + ((i * 37) % 60) / 100;
    const x = s.tilt ? 250 + (i % 7) * 26 + ((i * 13) % 9) : cx + Math.cos(a) * rx * rr * 0.8;
    const y = s.tilt ? 300 + Math.floor(i / 7) * 22 + ((i * 7) % 8) : cy + Math.sin(a) * ry * rr * 0.75;
    const r = s.tilt ? 8 + (i % 3) * 2 : 4 + (i % 3);
    return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.8}" fill="${speck}" stroke="${s.residue === "white" ? "#d9d2c0" : "none"}" stroke-width="1" opacity="${clear || s.tilt ? 1 : 0.45}"/>`;
  }).join("");
  const foam = thick || s.foam === "settling"
    ? Array.from({ length: thick ? 30 : 10 }, (_, i) => `<circle cx="${cx - 200 + ((i * 53) % 400)}" cy="${cy - 100 + ((i * 41) % 200) * 0.9}" r="${thick ? 16 + (i % 4) * 5 : 8 + (i % 3) * 3}" fill="#fffdf6" opacity="${thick ? 0.95 : 0.8}"/>`).join("")
    : "";
  const pool = s.tilt
    ? `<ellipse cx="${cx + 70}" cy="${cy - 10}" rx="${rx * 0.62}" ry="${ry * 0.82}" fill="${liquid}" opacity="0.92"/><ellipse cx="300" cy="335" rx="125" ry="70" fill="#8d8a84" opacity="0.35"/>`
    : `<ellipse cx="${cx}" cy="${cy}" rx="${rx - 14}" ry="${ry - 10}" fill="${liquid}" opacity="${clear ? 0.9 : 1}"/>`;
  const flames = s.flame === "off" ? "" : Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * Math.PI * 2, h = s.flame === "low" ? 10 : 24;
    const x = cx + Math.cos(a) * 205, y = 470 + Math.sin(a) * 26;
    return `<path d="M${x - 7} ${y} q7 ${-h} 14 0 z" fill="#3d7bf2" opacity="0.9"/><path d="M${x - 3} ${y} q3 ${-h * 0.6} 6 0 z" fill="#ffb347"/>`;
  }).join("");
  const leaf = s.leaf
    ? `<g transform="translate(560 230) rotate(-25)"><path d="M0 0 q30 -22 62 0 q-30 22 -62 0 z" fill="#2f6b2a"/><line x1="0" y1="0" x2="62" y2="0" stroke="#b6d39a" stroke-width="2"/></g>
       ${s.leaf === "crackle" ? Array.from({ length: 9 }, (_, i) => `<line x1="${585 + Math.cos(i) * 40}" y1="${222 + Math.sin(i) * 26}" x2="${585 + Math.cos(i) * 56}" y2="${222 + Math.sin(i) * 38}" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`).join("") : ""}`
    : "";
  const hand = {
    ladle: `<g><rect x="520" y="110" width="200" height="16" rx="8" fill="#8a6a43" transform="rotate(-28 520 118)"/><ellipse cx="505" cy="270" rx="34" ry="20" fill="#9c9c9c" stroke="#666" stroke-width="3"/></g>`,
    tilt: `<g><rect x="660" y="250" width="170" height="28" rx="12" fill="#3b3b3b"/><ellipse cx="840" cy="262" rx="40" ry="46" fill="#c98f68"/></g>`,
    leaf: `<ellipse cx="640" cy="170" rx="34" ry="40" fill="#c98f68"/>`,
    knob: `<ellipse cx="790" cy="520" rx="34" ry="34" fill="#c98f68"/>`,
    strain: `<g><path d="M300 120 q120 60 240 0 l-20 60 q-100 40 -200 0 z" fill="#f3efe6" stroke="#c9c1ae" stroke-width="3"/></g>`,
  }[s.hand] ?? "";
  const jarFill = s.strained ? `<rect x="868" y="340" width="70" height="110" rx="6" fill="#e3ad3a"/>` : "";
  const mm = String(s.minute ?? 0).padStart(2, "0");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560">
<rect width="960" height="560" fill="#d9ccb4"/><rect width="960" height="90" fill="#efe6d6"/>
<rect x="150" y="390" width="540" height="150" rx="16" fill="#2c2c2e"/>
<circle cx="790" cy="520" r="22" fill="#555" stroke="#888" stroke-width="3"/><line x1="790" y1="520" x2="${s.flame === "off" ? 790 : s.flame === "low" ? 772 : 806}" y2="${s.flame === "off" ? 500 : 506}" stroke="#ddd" stroke-width="4"/>
${flames}
<ellipse cx="${cx}" cy="${cy + 8}" rx="${rx + 14}" ry="${ry + 12}" fill="#5f6062"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#9a9b9d"/>
${pool}${specks}${foam}${leaf}${hand}
<g transform="translate(860 120)"><rect x="-80" y="-48" width="160" height="104" rx="12" fill="#1c1c1c" stroke="#ff7a1a" stroke-width="3"/>
<text y="22" font-size="52" font-weight="bold" fill="#ffb15c" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif">${esc(mm)}:00</text>
<text y="-26" font-size="15" fill="#e9dcc0" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif" font-weight="bold">ELAPSED (min)</text></g>
<rect x="860" y="300" width="86" height="160" rx="10" fill="#f4f7f8" opacity="0.55" stroke="#9fb3b8" stroke-width="3"/>${jarFill}
<text x="24" y="548" font-size="15" fill="#5f5340" font-family="Arial, DejaVu Sans, sans-serif">KITCHEN CAM · stove · flame ${esc(s.flame)}</text>
</svg>`;
}
