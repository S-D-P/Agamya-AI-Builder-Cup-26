// Language layer shared by both experiences. Gemini reasons over the original language directly (no translate-then-
// reason pipeline); this module only decides WHICH language to use and tells the model how to treat wording.
// "tested" means covered by this project's evaluation (docs/EVALUATION.md), not a promise of perfect understanding.

export const LANGUAGES = {
  en: { name: "English", native: "English", script: "Latin", tested: true },
  mr: { name: "Marathi", native: "मराठी", script: "Devanagari", tested: true },
  hi: { name: "Hindi", native: "हिन्दी", script: "Devanagari", tested: false },
  kn: { name: "Kannada", native: "ಕನ್ನಡ", script: "Kannada", tested: false },
};
export const LANGUAGE_CODES = Object.keys(LANGUAGES);
export const normalizeLanguage = (code) => (LANGUAGES[String(code ?? "").toLowerCase()] ? String(code).toLowerCase() : "en");

/** Share of letters that are Devanagari (0..1). Used to check response-language consistency, not to detect language. */
export function devanagariShare(text) {
  const letters = String(text ?? "").match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[ऀ-ॿ]/.test(c)).length / letters.length;
}

/** Does this text plausibly match the expected language's script? Allows code-switching (English terms inside Marathi). */
export function matchesLanguageScript(text, code) {
  const share = devanagariShare(text);
  return LANGUAGES[code]?.script === "Devanagari" ? share >= 0.5 : share < 0.2;
}

/**
 * Instruction appended to prompts whose output a person will read or hear. Content language only: the interface
 * language is handled by the UI. Preserving terms matters: in Marathi ghee-making "बेरी" is the browned milk solids;
 * a literal translation ("berry") would destroy the meaning.
 */
export function languageInstruction(code) {
  const c = normalizeLanguage(code);
  if (c === "en") return "Write every sentence a person will read in English, unless the expert or learner wrote in another language, in which case reply in their language.";
  const l = LANGUAGES[c];
  return `Write every sentence a person will read in ${l.name} (${l.native}, ${l.script} script), the language the person is using.
Keep names, numbers, units, measurements and domain terms exactly as the person said them; if they mixed in English words (code-switching), keep those words.
Do not translate local or technical terms literally (for example, in Marathi cooking "बेरी" means the browned milk solids, not a fruit).
Quotes must stay verbatim in the original language. Never replace the person's wording with an English paraphrase.`;
}
