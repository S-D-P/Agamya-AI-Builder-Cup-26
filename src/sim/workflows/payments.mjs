// DEMO WORKFLOW 1 — Legacy payment operations (software; app events + screen + voice + documents).
// Data only: the workflow configuration, its documentation, a simulated capture source, and curated learner tests.
// No expert reasoning appears here except in `script.answers`, which is what a person playing the expert says.

const RUNBOOK = `PAYMENT EXCEPTIONS RUNBOOK (Ops, rev.4)

SOP-PAY-217  E217 POSTING REJECTED - DOWNSTREAM SEQUENCE CONFLICT
 1. View the error detail.
 2. Retry the transaction.
 3. If the retry fails 3 times, escalate to Ops Tier 2.

SOP-PAY-104  E104 HOST TIMEOUT - NO RESPONSE FROM CORE LEDGER
 1. View the error detail.
 2. Retry the transaction.
 3. If the retry fails 3 times, escalate to Ops Tier 2.

SOP-PAY-509  E509 ACCOUNT FROZEN - POSTING NOT PERMITTED
 1. View the error detail.
 2. Do not retry. Escalate to Ops Tier 2 with the account number.`;

const workflow = {
  id: "wf-payments",
  name: "Legacy payment operations",
  description: "How the operations team resolves failed postings on the mainframe payment system.",
  kind: "software",
  modalities: { screen: true, app_events: true, microphone: true, camera: false, documents: true },
  captureSources: ["sim:payments-console", "live:screen"],
  documents: [{ id: "doc-pay-runbook", title: "Payment Exceptions Runbook rev.4", mimeType: "text/plain", text: RUNBOOK }],
  procedures: [
    { id: "SOP-PAY-217", title: "E217 downstream sequence conflict", appliesWhen: "Error E217", steps: ["View the error detail.", "Retry the transaction.", "If the retry fails 3 times, escalate to Ops Tier 2."], defaultDecision: "Retry the transaction", resolutionActions: ["retry"], docId: "doc-pay-runbook" },
    { id: "SOP-PAY-104", title: "E104 host timeout", appliesWhen: "Error E104", steps: ["View the error detail.", "Retry the transaction.", "If the retry fails 3 times, escalate to Ops Tier 2."], defaultDecision: "Retry the transaction", resolutionActions: ["retry"], docId: "doc-pay-runbook" },
    { id: "SOP-PAY-509", title: "E509 account frozen", appliesWhen: "Error E509", steps: ["View the error detail.", "Do not retry. Escalate to Ops Tier 2 with the account number."], defaultDecision: "Escalate to Ops Tier 2", resolutionActions: ["escalate"], docId: "doc-pay-runbook" },
  ],
  experts: [
    { id: "ex-dana", name: "Dana Reyes", role: "Senior payments operator, 22 years" },
    { id: "ex-sam", name: "Sam Ito", role: "Payments operations lead" },
  ],
  learners: [{ id: "ln-jordan", name: "Jordan Park", role: "New operator, week 2" }],
  source: "demo",
};

const ACTIONS = [
  { id: "open_txn", label: "Open transaction", kind: "navigate" },
  { id: "view_error", label: "View error", kind: "navigate" },
  { id: "view_audit", label: "View audit log", kind: "navigate" },
  { id: "open_upstream", label: "Open upstream record", kind: "navigate" },
  { id: "inspect_field", label: "Inspect field", kind: "inspect", param: "field" },
  { id: "open_notes", label: "Open account notes", kind: "navigate" },
  { id: "correct_upstream", label: "Correct upstream date", kind: "resolve" },
  { id: "retry", label: "Retry transaction", kind: "resolve" },
  { id: "schedule_retry", label: "Schedule retry after nightly batch", kind: "resolve" },
  { id: "escalate", label: "Escalate to Ops Tier 2", kind: "resolve" },
  { id: "close_case", label: "Close case", kind: "close" },
];

const SOP_TITLES = { E217: "POSTING REJECTED - DOWNSTREAM SEQUENCE CONFLICT", E104: "HOST TIMEOUT - NO RESPONSE FROM CORE LEDGER", E509: "ACCOUNT FROZEN - POSTING NOT PERMITTED" };

// Behaviour of the simulated mainframe for one case.
function consoleCase(c) {
  return {
    ...c,
    state: { screen: [`PAYMENT EXCEPTION QUEUE`, `${c.facts.txn}  ${c.facts.error}  FAILED  ${c.facts.businessDate} ${c.facts.time}`, "", "Select an action."], fixed: false },
    effect(state, action, param) {
      const f = c.facts;
      const show = (lines) => ({ text: lines.join(" | "), set: { screen: lines } });
      switch (action) {
        case "open_txn": return show([`TXN ${f.txn}  AMT ${f.amount}  ACCT ${f.account}`, `CHANNEL ${f.channel}`, `BUS-DATE ${f.businessDate}  CAL ${f.calendarFlag}`, ...(f.valueDate ? [`VALUE-DATE REQUESTED ${f.valueDate}`] : []), "STATUS: FAILED"]);
        case "view_error": return show([`ERROR ${f.error}: ${SOP_TITLES[f.error]}`]);
        case "view_audit": return show(c.audit);
        case "open_upstream": return show([`UPSTREAM ${c.upstream.id}  FEED ${c.upstream.feed}`, ...Object.entries(c.upstream.fields).map(([k, v]) => `${k.padEnd(11)} ${v}`)]);
        case "inspect_field": return show([`${param} = ${c.upstream.fields[param] ?? "not present"}`]);
        case "open_notes": return show([`ACCOUNT NOTES ${f.account}`, ...c.notes]);
        case "correct_upstream": return { ...show([c.outcomes.correct_upstream ?? "No change needed."]), set: { screen: [c.outcomes.correct_upstream ?? "No change needed."], fixed: true } };
        case "retry": return show([state.fixed ? c.outcomes.retry_after_fix : c.outcomes.retry_before_fix]);
        case "schedule_retry": return show([c.outcomes.schedule_retry ?? "Retry scheduled for 02:15."]);
        case "escalate": return show([c.outcomes.escalate]);
        case "close_case": return show(["CASE CLOSED."]);
        default: return show(["?"]);
      }
    },
    paramOptions: { inspect_field: Object.keys(c.upstream.fields) },
    view(state) { return { title: "LGCY-PAY/OPS CONSOLE v3.2", status: `${c.facts.businessDate} ${c.facts.time} · ${c.facts.calendarFlag}`, lines: state.screen }; },
  };
}

const environment = {
  id: "sim:payments-console",
  label: "Mainframe payments console (simulated)",
  render: "console",
  emits: ["APP_EVENT", "SCREEN"],
  uiText: true, // the console exposes its screen text, so pixels are rarely needed
  actions: ACTIONS,
  cases: [
    consoleCase({
      id: "C1", title: "TXN-4471 · E217 at month-end", expertId: "ex-dana", procedureId: "SOP-PAY-217",
      facts: { txn: "TXN-4471", error: "E217", businessDate: "2026-09-30", calendarFlag: "MONTH-END CLOSE", time: "21:12", amount: "18,250.00 USD", account: "40-118-2209", channel: "GL batch posting" },
      upstream: { id: "UPS-99812", feed: "GL-FEED-03", fields: { "SOURCE-REF": "GLF3-0930-11873", "VALUE-DATE": "20260931", AMOUNT: "0000001825000", CCY: "USD", "BATCH-SEQ": "000417" } },
      notes: ["No account restrictions."], audit: ["21:12:04 POSTING ATTEMPT 1 -> E217", "21:12:04 DOWNSTREAM SEQ 000417 ALREADY OPEN"],
      outcomes: { retry_before_fix: "POSTED. WARNING: downstream ledger created 2 entries for SEQ 000417 (DSP-55120, DSP-55121).", retry_after_fix: "POSTED. 1 downstream entry (DSP-55120).", correct_upstream: "VALUE-DATE corrected 20260931 -> 20260930. Upstream record re-validated.", escalate: "Ticket T2-8812 opened." },
      script: {
        steps: [["open_txn"], ["view_error"], ["open_upstream"], ["inspect_field", "VALUE-DATE"], ["correct_upstream"], ["retry"], ["close_case"]],
        answers: [
          "During month-end processing, malformed upstream dates can cause duplicate downstream transactions. I always validate the upstream record before retrying. A value date like the 31st of September gets rolled by the ledger and the retry posts twice.",
          "Only at month-end close. The rest of the month the feeds are clean, so I just retry like the SOP says.",
          "If the upstream record has already been validated, retrying is fine even at month-end.",
        ],
      },
      groundTruth: { judgment: true },
    }),
    consoleCase({
      id: "C2", title: "TXN-4502 · E104 timeout (routine)", expertId: "ex-dana", procedureId: "SOP-PAY-104",
      facts: { txn: "TXN-4502", error: "E104", businessDate: "2026-09-16", calendarFlag: "NORMAL", time: "10:03", amount: "640.00 USD", account: "22-019-7731", channel: "Card settlement" },
      upstream: { id: "UPS-10233", feed: "CARD-SETTLE-01", fields: { "SOURCE-REF": "CS1-0916-00412", "VALUE-DATE": "20260916" } },
      notes: ["No account restrictions."], audit: ["10:03:11 POSTING ATTEMPT 1 -> E104 (no response 30s)"],
      outcomes: { retry_before_fix: "POSTED. 1 downstream entry.", retry_after_fix: "POSTED. 1 downstream entry.", escalate: "Ticket T2-8830 opened." },
      script: { steps: [["open_txn"], ["view_error"], ["view_audit"], ["retry"], ["close_case"]], answers: [] },
      groundTruth: { judgment: false },
    }),
    consoleCase({
      id: "C3", title: "TXN-4519 · E509 frozen account", expertId: "ex-dana", procedureId: "SOP-PAY-509",
      facts: { txn: "TXN-4519", error: "E509", businessDate: "2026-09-22", calendarFlag: "NORMAL", time: "16:40", amount: "3,975.20 USD", account: "77-301-4482", channel: "Supplier payment", valueDate: "NEXT BUSINESS DAY" },
      upstream: { id: "UPS-10471", feed: "AP-FEED-02", fields: { "SOURCE-REF": "AP2-0922-00981", "VALUE-DATE": "20260922" } },
      notes: ["FREEZE CODE: FZ-MIG", "Set by: CORE-MIGRATION WAVE 4", "Release: NIGHTLY BATCH 02:00"], audit: ["16:40:02 POSTING ATTEMPT 1 -> E509 ACCOUNT FROZEN"],
      outcomes: { retry_before_fix: "REJECTED again: E509 ACCOUNT FROZEN.", retry_after_fix: "REJECTED again: E509 ACCOUNT FROZEN.", schedule_retry: "Retry scheduled for 02:15 after nightly batch.", escalate: "Ticket T2-8851 opened. (Tier 2 queue depth: 63)" },
      script: {
        steps: [["open_txn"], ["view_error"], ["open_notes"], ["schedule_retry"], ["close_case"]],
        answers: [
          "Those FZ-MIG freezes come from the core migration and they release themselves in the nightly batch. If you escalate, Tier 2 just bounces the ticket back the next morning and the supplier gets paid a day late.",
          "No. Only FZ-MIG. Any other freeze code, especially FZ-LGL (legal) or FZ-FRD (fraud), goes straight to Tier 2 and you never retry those.",
          "Yes, as long as it's FZ-MIG and the payment can wait until tomorrow morning.",
        ],
      },
      groundTruth: { judgment: true },
    }),
    consoleCase({
      id: "C4", title: "TXN-4603 · E509, same-day value (Expert B)", expertId: "ex-sam", procedureId: "SOP-PAY-509",
      facts: { txn: "TXN-4603", error: "E509", businessDate: "2026-09-24", calendarFlag: "NORMAL", time: "15:05", amount: "250,000.00 USD", account: "51-660-0921", channel: "Supplier payment", valueDate: "SAME DAY (TODAY)" },
      upstream: { id: "UPS-10533", feed: "AP-FEED-02", fields: { "SOURCE-REF": "AP2-0924-01177", "VALUE-DATE": "20260924" } },
      notes: ["FREEZE CODE: FZ-MIG", "Set by: CORE-MIGRATION WAVE 4", "Release: NIGHTLY BATCH 02:00"], audit: ["15:05:40 POSTING ATTEMPT 1 -> E509 ACCOUNT FROZEN"],
      outcomes: { retry_before_fix: "REJECTED again: E509 ACCOUNT FROZEN.", retry_after_fix: "REJECTED again: E509 ACCOUNT FROZEN.", schedule_retry: "Retry scheduled for 02:15 after nightly batch.", escalate: "Ticket T2-8874 opened, marked SAME-DAY. Tier 2 force-released freeze 15:31. Posted." },
      script: {
        steps: [["open_txn"], ["view_error"], ["open_notes"], ["escalate"], ["close_case"]],
        answers: [
          "It's a same-day value payment. If it waits for the nightly batch it posts tomorrow, the supplier misses the value date and we pay penalty interest. Tier 2 can force-release a migration freeze, so for same-day payments I escalate even when it's FZ-MIG.",
          "If the value date is tomorrow or later, the nightly batch is fine and I'd just schedule the retry.",
        ],
      },
      groundTruth: { judgment: true },
    }),
  ],
};

// Curated learner tests. Answer keys are written by the test designer and used only for scoring.
const facts = (o) => o;
const scenarios = [
  { id: "PAY-A1", sourceCase: "C1", kind: "apply", title: "Month-end posting rejection", render: "console",
    facts: facts({ txn: "TXN-8472", error: "E217", businessDate: "2026-10-31", calendarFlag: "MONTH-END CLOSE", time: "22:47", amount: "92,400.00 USD", channel: "ACH batch posting", upstream: "ACH-FEEDER-07 (not yet validated)" }),
    narrative: "It's month-end close. Transaction 8472 from the ACH feeder was rejected with E217 (downstream sequence conflict). The runbook says to retry.",
    options: ["Retry", "Inspect upstream record", "Escalate"], answerKey: "Inspect upstream record",
    criteria: ["Connects month-end close with the risk of a malformed upstream date", "Checks the upstream record before retrying, so the retry cannot post twice"] },
  { id: "PAY-A2", sourceCase: "C1", kind: "counterfactual", title: "Mid-month posting rejection", render: "console",
    facts: facts({ txn: "TXN-8510", error: "E217", businessDate: "2026-10-14", calendarFlag: "NORMAL", time: "11:20", amount: "2,150.00 USD", channel: "Card settlement", upstream: "CARD-SETTLE-01 (validated)" }),
    narrative: "A mid-month card settlement, transaction 8510, was rejected with E217 (downstream sequence conflict). No other alerts are open.",
    options: ["Retry", "Inspect upstream record", "Escalate"], answerKey: "Retry", ruleAction: "Inspect upstream record",
    criteria: ["Sees it is mid-month on a validated feed, so the runbook retry is safe", "Does not carry the month-end check over to a normal day"] },
  // Boundary, from Dana's own words: "If the upstream record has already been validated, retrying is fine even at month-end."
  { id: "PAY-A3", sourceCase: "C1", kind: "boundary", title: "Month-end rejection, upstream already validated", render: "console",
    facts: facts({ txn: "TXN-8488", error: "E217", businessDate: "2026-10-31", calendarFlag: "MONTH-END CLOSE", time: "23:05", amount: "7,300.00 USD", channel: "GL batch posting", upstream: "GL-FEED-03 (validated 22:40, VALUE-DATE 20261031)" }),
    narrative: "Still month-end close. Transaction 8488 was rejected with E217. This time the upstream record was already validated forty minutes ago and its value date is a real date.",
    options: ["Retry", "Inspect upstream record", "Escalate"], answerKey: "Retry", ruleAction: "Inspect upstream record",
    criteria: ["Notices the upstream record is already validated", "Knows that month-end alone does not require another inspection once the record is validated"] },
  // Insufficient evidence: the deciding fact (is the upstream record sound?) cannot be checked, so the careful move is to stop and ask.
  { id: "PAY-A4", sourceCase: "C1", kind: "insufficient", title: "Month-end rejection with no upstream reference", render: "console",
    facts: facts({ txn: "TXN-8493", error: "E217", businessDate: "2026-10-31", calendarFlag: "MONTH-END CLOSE", time: "23:20", amount: "64,900.00 USD", channel: "GL batch posting", upstream: "not shown: the rejection carries no feeder reference" }),
    narrative: "Month-end close. Transaction 8493 was rejected with E217, but the rejection message carries no feeder reference, so you cannot tell which upstream record it came from or whether it was validated.",
    options: ["Retry", "Inspect upstream record"], answerKey: "__ask_expert__",
    criteria: ["Recognises that the upstream record cannot be identified or checked", "Does not retry at month-end without a validated upstream record"] },
  { id: "PAY-B1", sourceCase: "C3", kind: "apply", title: "Frozen account, next-day payroll", render: "console",
    facts: facts({ txn: "TXN-8533", error: "E509", businessDate: "2026-10-08", calendarFlag: "NORMAL", time: "17:55", amount: "12,880.00 USD", channel: "Payroll disbursement", valueDate: "NEXT BUSINESS DAY", notes: "FREEZE CODE FZ-MIG, set by CORE-MIGRATION WAVE 5" }),
    narrative: "A payroll disbursement due tomorrow failed with E509 ACCOUNT FROZEN. The account notes show freeze code FZ-MIG.",
    options: ["Escalate to Ops Tier 2", "Schedule retry after nightly batch", "Retry now"], answerKey: "Schedule retry after nightly batch" },
  { id: "PAY-B2", sourceCase: "C3", kind: "counterfactual", title: "Frozen account, different freeze code", render: "console",
    facts: facts({ txn: "TXN-8561", error: "E509", businessDate: "2026-10-09", calendarFlag: "NORMAL", time: "09:12", amount: "48,000.00 USD", channel: "Supplier payment", valueDate: "NEXT BUSINESS DAY", notes: "FREEZE CODE FZ-LGL" }),
    narrative: "A supplier payment failed with E509 ACCOUNT FROZEN. The account notes show freeze code FZ-LGL.",
    options: ["Escalate to Ops Tier 2", "Schedule retry after nightly batch", "Retry now"], answerKey: "Escalate to Ops Tier 2", ruleAction: "Schedule retry after nightly batch" },
  { id: "PAY-C1", sourceCase: "C4", kind: "apply", title: "Frozen account, same-day value", render: "console",
    facts: facts({ txn: "TXN-8590", error: "E509", businessDate: "2026-10-12", calendarFlag: "NORMAL", time: "14:20", amount: "180,000.00 USD", channel: "Supplier payment", valueDate: "SAME DAY (TODAY)", notes: "FREEZE CODE FZ-MIG" }),
    narrative: "A large supplier payment that must settle today failed with E509 ACCOUNT FROZEN. Freeze code FZ-MIG.",
    options: ["Escalate to Ops Tier 2", "Schedule retry after nightly batch", "Retry now"], answerKey: "Escalate to Ops Tier 2" },
  { id: "PAY-C2", sourceCase: "C4", kind: "counterfactual", title: "Frozen account, value date tomorrow", render: "console",
    facts: facts({ txn: "TXN-8597", error: "E509", businessDate: "2026-10-12", calendarFlag: "NORMAL", time: "16:10", amount: "210,000.00 USD", channel: "Supplier payment", valueDate: "NEXT BUSINESS DAY", notes: "FREEZE CODE FZ-MIG" }),
    narrative: "A large supplier payment with value date tomorrow failed with E509 ACCOUNT FROZEN. Freeze code FZ-MIG.",
    options: ["Escalate to Ops Tier 2", "Schedule retry after nightly batch", "Retry now"], answerKey: "Schedule retry after nightly batch", ruleAction: "Escalate to Ops Tier 2" },
];

export default { workflow, environment, scenarios };
