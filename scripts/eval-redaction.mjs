// Public-data evaluation of the transcript redactor (src/platform/redact.mjs) on ai4privacy pii-masking-200k (English,
// 43k labelled sentences). The dataset is not redistributed: download it to data/public/ first (see docs/EVALUATION.md).
//   node scripts/eval-redaction.mjs [path] [limit]
// Recall per targeted type: the labelled value no longer appears in the redacted text.
// Over-masking: labelled values that SHOULD stay readable for work (amounts, dates, times, building numbers, zip codes)
// but were changed by the redactor.
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { redactText } from "../src/platform/redact.mjs";

const file = process.argv[2] ?? path.join("data", "public", "ai4privacy-english.jsonl");
const limit = Number(process.argv[3] ?? Infinity);
const TARGET = { EMAIL: "email", PHONENUMBER: "phone", CREDITCARDNUMBER: "card", IBAN: "iban", SSN: "ssn" };
const KEEP = ["AMOUNT", "DATE", "TIME", "BUILDINGNUMBER", "ZIPCODE", "AGE"];
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };

const rec = Object.fromEntries(Object.keys(TARGET).map((k) => [k, { n: 0, hit: 0, misses: [] }]));
const cardLuhn = { n: 0, hit: 0 };
const keep = Object.fromEntries(KEEP.map((k) => [k, { n: 0, changed: 0, examples: [] }]));
let rows = 0;
const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  if (rows >= limit) break;
  const r = JSON.parse(line); rows++;
  const out = redactText(r.source_text).text;
  for (const m of r.privacy_mask) {
    if (rec[m.label]) {
      const gone = !out.includes(m.value);
      rec[m.label].n++; if (gone) rec[m.label].hit++; else if (rec[m.label].misses.length < 6) rec[m.label].misses.push(m.value);
      if (m.label === "CREDITCARDNUMBER") { const d = m.value.replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) { cardLuhn.n++; if (gone) cardLuhn.hit++; } }
    } else if (keep[m.label] && /\d/.test(m.value)) {
      keep[m.label].n++;
      if (!out.includes(m.value)) { keep[m.label].changed++; if (keep[m.label].examples.length < 4) keep[m.label].examples.push(m.value); }
    }
  }
}
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const result = {
  dataset: "ai4privacy/pii-masking-200k (english_pii_43k.jsonl)", rows, ranAt: new Date().toISOString(),
  recall: Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { labelled: v.n, masked: v.hit, recallPct: pct(v.hit, v.n), exampleMisses: v.misses }])),
  cardRecallLuhnValidOnly: { labelled: cardLuhn.n, masked: cardLuhn.hit, recallPct: pct(cardLuhn.hit, cardLuhn.n) },
  overMasking: Object.fromEntries(Object.entries(keep).map(([k, v]) => [k, { labelled: v.n, changed: v.changed, changedPct: pct(v.changed, v.n), examples: v.examples }])),
};
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(path.join("data", "eval-redaction.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
