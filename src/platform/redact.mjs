// Personal-data masking for stored transcripts (applied before anything is saved). Deterministic patterns only:
// emails, phone numbers, payment card numbers (Luhn-checked), IBANs, Indian Aadhaar/PAN, US SSNs. It reduces exposure; it is
// not a guarantee (names and free-text identifiers are not detected). Frames are protected by consent, "off the record",
// pausing and per-moment deletion; on-screen redaction of images is not implemented.

const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = Number(digits[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
};

const RULES = [
  ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ["iban", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g], // shortest national IBANs (e.g. Norway) are 15 characters
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  // National ids written with dashes, dots or spaces (US SSN 123-45-6789, and 3-2/4-4 variants such as 756.1234.5678).
  ["ssn", /(?<!\d)\d{3}[-. ]\d{2,4}[-. ]\d{4}(?:[-. ]\d{2})?(?!\d)/g], // also when glued to a label ("SSN132-65-3444")
  ["ahv", /(?<!\d)756\.?\d{4}\.?\d{4}(?:\.?\d{2})?(?!\d)/g], // Swiss AHV/AVS social insurance number
  ["aadhaar", /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g],
];

export function redactText(text) {
  let s = String(text ?? "");
  const found = {};
  // Card numbers: 13–19 digits with optional spaces/dashes, Luhn-valid.
  s = s.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => { const d = m.replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) { found.card = (found.card ?? 0) + 1; return "[card number]"; } return m; });
  for (const [kind, re] of RULES) s = s.replace(re, () => { found[kind] = (found[kind] ?? 0) + 1; return `[${kind}]`; });
  // Phone numbers last (avoid eating other numbers): +country or 10+ digits with separators.
  s = s.replace(/(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,5}\)?[ .-]?){1,4}\d{3,5}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    // An unbroken digit run is usually a business number (PO, transaction id) unless it is +international or an
    // Indian mobile number; written with separators it is a phone number. Measured: docs/EVALUATION.md.
    const plain = /^\d+$/.test(m);
    if (d.length >= 10 && d.length <= 13 && (!plain || /^[6-9]\d{9}$/.test(d))) { found.phone = (found.phone ?? 0) + 1; return "[phone]"; } return m; });
  return { text: s, found };
}
