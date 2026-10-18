// "Our inspiration": the story behind Agamya, public (no sign-in). Every outside fact is cited; the sources are listed at
// the end and in docs/submission/RESEARCH_LEDGER.md. The muslin "cut thumbs" story is told as a legend, not as history.
import { brand } from "./auth.js";

const REFS = [
  ["The Daily Star (2026). What Bengal made and let others claim.", "https://www.thedailystar.net/supplements-0/news/what-bengal-made-and-let-others-claim-4217271"],
  ["Wikipedia. Dhaka muslin.", "https://en.wikipedia.org/wiki/Dhaka_muslin"],
  ["Garland Magazine (2026). Kimono and lacquerware sales down up to 90 per cent as Japan's craft base narrows (data: Association for the Promotion of Traditional Craft Industries).", "https://garlandmag.com/kimono-and-lacquerware-sales-down-up-to-90-per-cent-as-japans-craft-base-narrows/"],
  ["NPR / WFAE (29 Jul 2022). Japan's traditional crafts are struggling to survive the country's population decline.", "https://www.wfae.org/2022-07-29/japans-traditional-crafts-are-struggling-to-survive-the-countrys-population-decline"],
  ["Chakravartty, A. (6 Sep 2013). Survey tracks down only speaker of Majhi in India. Down To Earth.", "https://www.downtoearth.org.in/amp/story/environment/survey-tracks-down-only-speaker-of-majhi-in-india-42123"],
  ["Wikipedia. Majhi language.", "https://en.wikipedia.org/wiki/Majhi_language"],
  ["Panopto (2018). Workplace Knowledge and Productivity Report, reported by HR Dive.", "https://www.hrdive.com/news/inefficient-knowledge-sharing-costs-large-us-businesses-47m-a-year/527892/"],
  ["Polanyi, M. (1966). The Tacit Dimension. University of Chicago Press.", "https://press.uchicago.edu/ucp/books/book/chicago/T/bo6035368.html"],
];
const cite = (...n) => n.map((i) => `<a class="ins-cite" href="#ins-ref-${i}" aria-label="Source ${i}">[${i}]</a>`).join("");

// Each chapter shows one panel of the landing artwork (six panels, left to right): decorative, so hidden from screen readers.
const CHAPTERS = [
  { id: "muslin", panel: 1, accent: "crimson", place: "Bengal", native: ["মসলিন", "bn", "muslin, in Bengali"], title: "The cloth no one can make any more",
    body: `<p>Dhaka muslin was among the finest cloths ever woven: yarn spun from a local cotton, <i>phuti karpas</i>, at thread counts reported up to about 1,200. ${cite(1, 2)}</p>
      <p>A story is often told that weavers' thumbs were cut off to end the craft. <b>We tell it as a legend</b>: it traces back to a 1772 account by the merchant William Bolts. ${cite(1)} The documented decline is plainer: tariffs on Bengal cloth in England, and cheap machine-made cotton flooding Bengal. ${cite(2)}</p>
      <p>Either way, the reasons a spinner wet the thread, or chose one morning over another, were never written down. The cotton itself is now considered lost. ${cite(1)}</p>` },
  { id: "japan", panel: 2, accent: "gold", place: "Japan", native: ["伝統的工芸品", "ja", "traditional craft products, in Japanese"], title: "Workshops without successors",
    body: `<p>Japan's registered traditional-craft workforce fell from about 288,000 in 1979 to 48,334 in fiscal 2022, according to industry-association data reported by Garland Magazine. ${cite(3)}</p>
      <p>In Kanazawa (<span lang="ja">金沢</span>), craft families have closed because no one took over, and the city now trains new craftspeople. ${cite(4)} A master can show an apprentice for years. When the years run out, so does the teaching.</p>` },
  { id: "majhi", panel: 3, accent: "indigo", place: "Sikkim", native: ["माझी", "mjz", "Majhi, in Devanagari"], title: "Fifteen words for river",
    body: `<p>In 2013 the People's Linguistic Survey of India traced the only known speaker of Majhi in India: Thak Bahadur Majhi, aged 80, in a village in Sikkim. ${cite(5)}</p>
      <p>Majhi was the language of boatmen on the Teesta, with fifteen different words for river. As roads replaced the boats, the words went one after another. ${cite(5)} Majhi is still spoken in Nepal, where Nepali is steadily replacing it. ${cite(6)}</p>
      <p>A word list survives a speaker. The knowing (which river word fits which water) does not.</p>` },
  { id: "work", panel: 4, accent: "indigo", place: "Your office", native: null, title: "The expert at the next desk",
    body: `<p>The same thing happens every month in ordinary companies. In a 2018 Panopto survey, 42% of institutional knowledge was unique to the employee in their role, so colleagues cannot do that part of the job when they are away. ${cite(7)}</p>
      <p>It is rarely the steps. It is the reason: <q>anything over fifty thousand I hold for the controller, because last year a duplicate went out.</q> The philosopher Michael Polanyi put it simply: <q>we can know more than we can tell.</q> ${cite(8)}</p>` },
  { id: "ai", panel: 0, accent: "crimson", place: "Agamya", native: ["अगम्य", "sa", "Agamya: hard to reach, in Sanskrit"], title: "A different use of AI",
    body: `<p>Most AI tries to replace the expert, or to guess. Agamya does the opposite. It <b>asks</b>. While the expert works, Moti watches, listens and asks one short question at a natural pause: why that, why now?</p>
      <ul><li>Every reason is kept <b>in the expert's own words</b>, checked word for word. Anything else is labelled AI-inferred.</li>
        <li>The expert <b>confirms</b> the map and chooses who learns from it.</li>
        <li>The next person practises with Moti as a tutor, in their own language, and is stopped before a wrong decision.</li>
        <li>AI agents ask the same map: would the expert stop here?</li></ul>
      <p>A weaver's reason and a controller's rule are the same kind of thing: judgment that lives in one person. Agamya is built to keep it, with the reason, and with their consent.</p>` },
];

export function inspirationView() {
  return `<div class="landing light ins">
  <header class="lp-top">${brand()}<span class="spacer"></span><a class="btn ghost sm" href="#/">Home</a><a class="btn sm" href="#/login">Sign in</a></header>
  <main id="main" class="lp-main" tabindex="-1">
    <header class="ins-hero">
      <p class="eyebrow">Our inspiration</p>
      <h1>When an expert leaves, the <em>why</em> leaves with them.</h1>
      <p class="ins-lede">It has happened for centuries: to weavers, to languages, to craft families, and to the colleague who knew why the payment was held. These are the stories that made us build Agamya.</p>
      <nav class="ins-toc" aria-label="Chapters"><ol>${CHAPTERS.map((c, i) => `<li><a href="#ins-${c.id}" data-ins="${c.id}"><span class="n">${i + 1}</span> ${c.title}</a></li>`).join("")}</ol></nav>
    </header>
    ${CHAPTERS.map((c, i) => `<section class="ins-ch ${c.accent}" id="ins-${c.id}" aria-labelledby="ins-${c.id}-h">
      <div class="ins-panel" aria-hidden="true" style="--panel:${c.panel}"></div>
      <div class="ins-text">
        <p class="eyebrow">${i + 1} · ${c.place}</p>
        <h2 id="ins-${c.id}-h" tabindex="-1">${c.title}</h2>
        ${c.native ? `<p class="ins-native"><span lang="${c.native[1]}">${c.native[0]}</span> <span class="small muted">${c.native[2]}</span></p>` : ""}
        ${c.body}
      </div>
    </section>`).join("")}
    <section class="ins-end" aria-labelledby="ins-end-h">
      <h2 id="ins-end-h">Show it once. Confirm it. Pass it on, without losing why.</h2>
      <div class="row wrap hero-cta"><a class="btn primary lg work" href="#/login">Try Agamya</a><a class="btn lg" href="#/">Back to home</a></div>
      <p class="small muted">The artwork panels are illustrations, not photographs of the people or places described.</p>
    </section>
    <section class="ins-refs" aria-labelledby="ins-refs-h"><h2 id="ins-refs-h">Sources</h2>
      <ol>${REFS.map(([t, u], i) => `<li id="ins-ref-${i + 1}">${u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : t}</li>`).join("")}</ol>
      <p class="small muted">Accessed 18 October 2026. Figures are quoted as each source reports them.</p>
    </section>
  </main>
  <footer class="ins-foot">
    <p>Developed with <span aria-hidden="true">♥</span><span class="sr-only">love</span> from Mumbai, India</p>
    <p class="small">By <a href="https://www.linkedin.com/in/sumit-jadhav-733377214/" target="_blank" rel="noopener noreferrer">Sumit Jadhav</a>
      and <a href="https://www.linkedin.com/in/siddhi-pandirkar-2ab080203/" target="_blank" rel="noopener noreferrer">Siddhi Pandirkar</a></p>
  </footer></div>`;
}

/** In-page links must not change the hash: the hash is the router. */
export function inspirationClick(e) {
  const a = e.target.closest('a[href^="#ins-"]');
  if (!a) return false;
  e.preventDefault();
  const target = document.getElementById(a.getAttribute("href").slice(1));
  if (!target) return true;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  (target.querySelector("h2") ?? target).focus({ preventScroll: true });
  return true;
}
