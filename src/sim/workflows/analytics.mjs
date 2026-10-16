// DEMO WORKFLOW 3 — Monthly revenue reporting (modern software; screen pixels only + voice + documents).
// Unlike the mainframe console, this capture source exposes NO UI text or app events: the engine must read the
// screen through Gemini vision, as it would with a real screen recording of a spreadsheet.

const PLAYBOOK = `ANALYTICS PLAYBOOK — Monthly revenue trend report

 1. Refresh Revenue_Monthly.xlsx from the finance export.
 2. Run the outlier check (z-score by region).
 3. Remove any month/region value beyond 3 standard deviations before computing the trend.
 4. Publish the trend chart to the leadership dashboard.`;

const workflow = {
  id: "wf-analytics",
  name: "Monthly revenue reporting",
  description: "How analysts prepare the monthly revenue trend for leadership.",
  kind: "software",
  modalities: { screen: true, app_events: false, microphone: true, camera: false, documents: true },
  captureSources: ["sim:revenue-sheet", "live:screen"],
  documents: [{ id: "doc-analytics-playbook", title: "Analytics Playbook", mimeType: "text/plain", text: PLAYBOOK }],
  procedures: [
    { id: "SOP-AN-OUTLIER", title: "Outlier handling in the monthly trend", appliesWhen: "A month/region value is beyond 3 standard deviations", steps: ["Run the outlier check.", "Remove values beyond 3 standard deviations.", "Publish the trend."], defaultDecision: "Remove the outlier before computing the trend", resolutionActions: [], docId: "doc-analytics-playbook" },
  ],
  experts: [{ id: "ex-priya", name: "Priya Nair", role: "Lead revenue analyst" }],
  learners: [{ id: "ln-max", name: "Max Romero", role: "Junior analyst" }],
  source: "demo",
};

const MONTHS = ["Jun", "Jul", "Aug", "Sep"];
function sheetCase(c) {
  const base = { tab: "Sheet: Monthly by region (USD k)", columns: ["Region", ...MONTHS], rows: c.table };
  return {
    ...c,
    state: { ...base, highlight: [], panel: [] },
    effect(state, action) {
      const v = c.views;
      switch (action) {
        case "run_outlier_check": return { set: { tab: "Outlier check (z-score by region)", highlight: c.outlierCells, panel: v.outlier } };
        case "open_crm_log": return { set: { tab: "CRM deal log (linked)", columns: ["Date", "Account", "Deal", "Amount"], rows: v.crm, highlight: v.crmHighlight ?? [], panel: [] } };
        case "check_duplicates": return { set: { tab: "Invoice duplicate check", columns: ["Invoice", "Region", "Month", "Amount", "Count"], rows: v.invoices, highlight: v.dupHighlight ?? [], panel: v.dupPanel } };
        case "remove_outlier": return { set: { ...base, tab: "Monthly by region (outlier removed)", rows: c.table.map((r, i) => (c.outlierCells.some(([ri]) => ri === i) ? r.map((x, j) => (j === c.outlierCells[0][1] ? "—" : x)) : r)), highlight: [], panel: ["Outlier removed. Trend recomputed."] } };
        case "keep_annotate": return { set: { ...base, tab: "Monthly by region (annotated)", highlight: c.outlierCells, panel: [c.annotation] } };
        case "publish": return { set: { ...state, panel: [...(state.panel ?? []), "Published to leadership dashboard."] } };
        default: return {};
      }
    },
    view(state) { return { title: "Revenue_Monthly.xlsx", ...state }; },
  };
}

const environment = {
  id: "sim:revenue-sheet",
  label: "Spreadsheet screen recording (simulated)",
  render: "sheet",
  emits: ["SCREEN"],
  uiText: false,
  actions: [
    { id: "run_outlier_check", label: "Run outlier check", kind: "navigate" },
    { id: "open_crm_log", label: "Open CRM deal log", kind: "navigate" },
    { id: "check_duplicates", label: "Check duplicate invoices", kind: "navigate" },
    { id: "remove_outlier", label: "Remove outlier", kind: "resolve" },
    { id: "keep_annotate", label: "Keep value, annotate as one-off", kind: "resolve" },
    { id: "publish", label: "Publish report", kind: "close" },
  ],
  cases: [
    sheetCase({
      id: "D1", title: "September EMEA spike", expertId: "ex-priya", procedureId: "SOP-AN-OUTLIER",
      table: [["NA", "1,210", "1,185", "1,240", "1,228"], ["EMEA", "860", "842", "871", "2,064"], ["APAC", "512", "530", "524", "541"]],
      outlierCells: [[1, 4]],
      annotation: "Note: EMEA Sep includes Contoso 3-year prepayment (1,200k). Underlying trend shown separately.",
      views: {
        outlier: ["EMEA · Sep · 2,064 · z = 3.4  → FLAGGED (> 3σ)", "All other cells within 3σ"],
        crm: [["2026-09-29", "Contoso", "3-year prepayment", "1,200k"], ["2026-09-12", "Fabrikam", "Renewal", "38k"]], crmHighlight: [[0]],
        invoices: [["INV-55120", "EMEA", "Sep", "1,200k", "1"], ["INV-55131", "EMEA", "Sep", "38k", "1"]], dupPanel: ["No duplicate invoice IDs found."],
      },
      script: {
        steps: [["run_outlier_check"], ["open_crm_log"], ["check_duplicates"], ["keep_annotate"], ["publish"]],
        answers: [
          "That spike is real money, it's the Contoso three-year prepayment. If you delete it the board sees revenue understated by 1.2 million, so I keep it and annotate it as a one-off and show the underlying trend separately.",
          "No. If the spike is a duplicate invoice import, it's not real revenue and I remove it like the playbook says. I only keep it when a real booked deal explains it.",
          "If neither the CRM nor the invoices explain it, I hold the report and ask finance before publishing.",
        ],
      },
      groundTruth: { judgment: true },
    }),
    sheetCase({
      id: "D2", title: "August APAC spike (routine)", expertId: "ex-priya", procedureId: "SOP-AN-OUTLIER",
      table: [["NA", "1,210", "1,185", "1,240", "1,228"], ["EMEA", "860", "842", "871", "880"], ["APAC", "512", "530", "1,498", "541"]],
      outlierCells: [[2, 3]],
      annotation: "",
      views: {
        outlier: ["APAC · Aug · 1,498 · z = 3.2  → FLAGGED (> 3σ)", "All other cells within 3σ"],
        crm: [["2026-08-14", "Northwind", "Renewal", "22k"]],
        invoices: [["INV-77812", "APAC", "Aug", "968k", "2"], ["INV-77840", "APAC", "Aug", "41k", "1"]], dupHighlight: [[0]], dupPanel: ["INV-77812 imported twice (duplicate)."],
      },
      script: { steps: [["run_outlier_check"], ["remove_outlier"], ["publish"]], answers: [] },
      groundTruth: { judgment: false },
    }),
  ],
};

const scenarios = [
  { id: "AN-A1", sourceCase: "D1", kind: "apply", title: "Q3 NA spike with a booked deal", render: "sheet",
    view: { title: "Revenue_Monthly.xlsx", tab: "Outlier check", columns: ["Region", "Jul", "Aug", "Sep"], rows: [["NA", "1,185", "1,240", "2,610"], ["EMEA", "842", "871", "880"]], highlight: [[0, 3]], panel: ["NA · Sep · z = 3.6 FLAGGED", "CRM: Globex 2-year prepayment 1,350k booked 2026-09-26", "Duplicate check: none"] },
    facts: { flagged: "NA September, z = 3.6", crm: "Globex 2-year prepayment, 1,350k", duplicates: "none found" },
    narrative: "The outlier check flags North America in September. The playbook says to remove values beyond 3σ.",
    options: ["Remove the outlier per playbook", "Keep it and annotate as a one-off", "Publish without changes"], answerKey: "Keep it and annotate as a one-off" },
  { id: "AN-A2", sourceCase: "D1", kind: "counterfactual", title: "Q3 EMEA spike from a double import", render: "sheet",
    view: { title: "Revenue_Monthly.xlsx", tab: "Outlier check", columns: ["Region", "Jul", "Aug", "Sep"], rows: [["NA", "1,185", "1,240", "1,228"], ["EMEA", "842", "871", "1,910"]], highlight: [[1, 3]], panel: ["EMEA · Sep · z = 3.3 FLAGGED", "CRM: no deals above 50k in September", "Duplicate check: INV-60411 (1,030k) imported twice"] },
    facts: { flagged: "EMEA September, z = 3.3", crm: "no large deals", duplicates: "INV-60411 imported twice" },
    narrative: "The outlier check flags EMEA in September. The playbook says to remove values beyond 3σ.",
    options: ["Remove the outlier per playbook", "Keep it and annotate as a one-off", "Publish without changes"], answerKey: "Remove the outlier per playbook", ruleAction: "Keep it and annotate as a one-off" },
];

export default { workflow, environment, scenarios };
