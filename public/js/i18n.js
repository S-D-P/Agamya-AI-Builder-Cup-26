// Language layer (client). Two separate things:
//   interface language: the words of the app itself (buttons, headings); the person's saved preference.
//   content language:   the language a person speaks or writes knowledge in; stored on each session / answer.
// Marathi interface coverage is PARTIAL (navigation and the Detective, Stress Test, Radar and Ask surfaces); untranslated
// strings fall back to English. Translations were written for this project and still need native-speaker review
// (docs/EVALUATION.md). Only languages this project has tested are offered.
import { state, esc } from "./core.js";

export const LANGS = [
  { code: "en", name: "English", native: "English" },
  { code: "mr", name: "Marathi", native: "मराठी" },
];
export const langName = (code) => LANGS.find((l) => l.code === code)?.native ?? code ?? "";
export const uiLang = () => (state.me?.user?.language === "mr" ? "mr" : "en");
/** lang attribute for text whose language differs from (or may differ from) the page. */
export const langAttr = (code) => (code ? ` lang="${esc(code)}"` : "");

const MR = {
  "Home": "मुख्यपृष्ठ", "Knowledge transfers": "ज्ञान हस्तांतरण", "Workflows": "कार्यपद्धती", "Knowledge library": "ज्ञान संग्रह",
  "Learner progress": "शिकणाऱ्यांची प्रगती", "My lessons": "माझे धडे", "Insights & AI cost": "निरीक्षणे व AI खर्च", "Administration": "प्रशासन",
  "Knowledge at risk": "धोक्यातील ज्ञान", "Capture a skill": "कौशल्य जतन करा", "My knowledge": "माझे ज्ञान", "Learning": "शिकणे",
  "Sharing & permissions": "शेअरिंग व परवानग्या", "People": "लोक", "Ask": "विचारा",
  "Language": "भाषा", "Interface language": "अ‍ॅपची भाषा", "Answer language": "उत्तराची भाषा", "Speak questions": "प्रश्न बोलून दाखवा",
  "Missing knowledge": "हरवलेले ज्ञान", "What is missing": "काय हरवले आहे", "Why it matters": "हे का महत्त्वाचे आहे", "Evidence": "पुरावा",
  "Question for the expert": "तज्ज्ञासाठी प्रश्न", "Your answer": "तुमचे उत्तर", "Send answer": "उत्तर पाठवा", "Speak your answer": "उत्तर बोलून द्या",
  "Stop recording": "रेकॉर्डिंग थांबवा", "Leave unresolved": "अनिर्णित ठेवा", "Defer": "नंतर पाहू", "Not applicable": "लागू नाही",
  "Approve change": "बदल मंजूर करा", "Reject change": "बदल नाकारा", "Reopen": "पुन्हा उघडा", "Before": "आधी", "After": "नंतर",
  "Stop and ask the expert": "थांबा आणि तज्ज्ञाला विचारा", "What you understood": "तुम्हाला काय समजले", "What you missed": "काय सुटले",
  "Ask a question": "प्रश्न विचारा", "Your question": "तुमचा प्रश्न", "Sources": "स्रोत",
  "KT missions": "ज्ञान-हस्तांतरण मोहिमा", "Missions": "मोहिमा", "Groups": "गट", "Spaces": "जागा", "Your spaces": "तुमच्या जागा",
  "Invitations": "आमंत्रणे", "Notifications": "सूचना", "Invitations and notifications": "आमंत्रणे आणि सूचना", "Create a space": "नवी जागा तयार करा",
  "Storage & AI": "साठवण आणि AI",
  "Demonstrated in simulation": "सरावात दाखवले", "Needs further practice": "आणखी सराव हवा", "Requires supervision": "देखरेखीखाली करावे",
};
/** Interface string as plain text (attributes, <option>, announcements). */
export const tp = (en) => (uiLang() === "mr" && MR[en]) || en;
/**
 * Interface string as HTML. Marathi coverage is partial, so the page stays lang="en" and each translated string carries
 * its own lang="mr" (WCAG 3.1.2): screen readers switch voice for exactly the Marathi words, not for untranslated English.
 */
export const t = (en) => { const m = uiLang() === "mr" && MR[en]; return m ? `<span lang="mr">${esc(m)}</span>` : esc(en); };

/** Accessible language select (a real <select> with a visible label). */
/** label is HTML (pass t("…") or escaped text). */
export function langSelect(id, value, label, { hint = "" } = {}) {
  return `<div class="field lang-field"><label for="${id}">${label}</label>${hint ? `<span id="${id}-hint" class="small muted" style="font-weight:400">${esc(hint)}</span>` : ""}
    <select id="${id}" data-focus="${id}"${hint ? ` aria-describedby="${id}-hint"` : ""}>${LANGS.map((l) => `<option value="${l.code}" lang="${l.code}" ${l.code === value ? "selected" : ""}>${esc(l.native)}${l.native !== l.name ? ` (${esc(l.name)})` : ""}</option>`).join("")}</select></div>`;
}

/** An original statement and (if any) its translation. A translation is labelled and never shown as a quote. */
export function originalAndTranslation({ original, originalLang, translation }) {
  return `<div class="orig"><span class="eyebrow">Original${originalLang ? ` · ${esc(langName(originalLang))}` : ""}</span><div${langAttr(originalLang)}>“${esc(original)}”</div>
    ${translation && translation !== original ? `<div class="small muted"><span class="eyebrow">AI translation (not the speaker's words)</span><span lang="en">${esc(translation)}</span></div>` : ""}</div>`;
}

/**
 * Language of a stored text when no language was recorded with it: Devanagari-majority text is marked Marathi, the only
 * Devanagari language offered (Hindi is not offered because it is untested). Used for the lang attribute only.
 */
export function scriptLang(text) {
  const letters = String(text ?? "").match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  return letters.filter((c) => /[\u0900-\u097F]/.test(c)).length / letters.length >= 0.3 ? "mr" : null;
}
