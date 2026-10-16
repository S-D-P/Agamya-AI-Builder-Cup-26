// DEMO WORKFLOW 2 — Hand-loom weaving (physical; camera + voice + documents).
// The simulated camera produces frames of a loom station. NO action labels are emitted: the engine only sees pixels
// and hears the expert, exactly as it would with a real camera. Controlled scenario with a known set of actions.

const GUIDE = `STUDIO WEAVING GUIDE — cotton warp on the 4-shaft floor loom

Setup
 1. Wind the cotton warp and set the warp tension dial to 6.
 2. Weave a header of 6 rows before starting the pattern.
Weaving
 3. Throw the shuttle and beat each row evenly.
 4. Keep tension at the setting for the yarn (cotton: 6) for the whole piece.
 5. Every 10 rows, inspect for broken warp ends and repair them before continuing.`;

const workflow = {
  id: "wf-weaving",
  name: "Hand-loom weaving",
  description: "How our senior weaver keeps cotton warps from breaking on the studio floor looms.",
  kind: "physical",
  modalities: { screen: false, app_events: false, microphone: true, camera: true, documents: true },
  captureSources: ["sim:loom-camera", "live:camera"],
  documents: [{ id: "doc-weave-guide", title: "Studio Weaving Guide", mimeType: "text/plain", text: GUIDE }],
  procedures: [
    { id: "SOP-WEAVE-TENSION", title: "Warp tension for cotton", appliesWhen: "Weaving with cotton warp", steps: ["Set the warp tension dial to 6.", "Throw the shuttle and beat each row evenly.", "Keep tension at 6 for the whole piece."], defaultDecision: "Keep the tension dial at 6", resolutionActions: [], docId: "doc-weave-guide" },
  ],
  experts: [{ id: "ex-amara", name: "Amara Okafor", role: "Master weaver, 30 years" }],
  learners: [{ id: "ln-lee", name: "Lee Chen", role: "Studio apprentice" }],
  source: "demo",
};

function loomCase(c) {
  return {
    ...c,
    state: { humidity: c.facts.humidity, threadCondition: c.facts.threadCondition, tension: 6, rows: 6, hand: null, broken: false, shuttlePos: 0 },
    effect(state, action) {
      switch (action) {
        case "feel_warp": return { set: { hand: "warp" } };
        case "check_hygrometer": return { set: { hand: "gauge" } };
        case "loosen_tension": return { set: { hand: "dial", tension: Math.max(0, state.tension - 2) } };
        case "tighten_tension": return { set: { hand: "dial", tension: Math.min(10, state.tension + 2) } };
        case "weave_row": {
          const breaks = state.threadCondition === "dry" && state.tension >= 6;
          // a row is a repetitive motion: three near-identical frames as the shuttle crosses
          return { set: { hand: "shuttle", rows: state.rows + 1, broken: state.broken || breaks, shuttlePos: 2 }, frames: [{ hand: "shuttle", shuttlePos: 0 }, { hand: "shuttle", shuttlePos: 1 }] };
        }
        case "pause": return { set: { hand: null } };
        case "finish": return { set: { hand: null } };
        default: return {};
      }
    },
    view(state) { return state; },
  };
}

const environment = {
  id: "sim:loom-camera",
  label: "Loom station camera (simulated feed)",
  render: "loom",
  emits: ["CAMERA"],
  uiText: false,
  actions: [
    { id: "feel_warp", label: "Pinch and feel the warp", kind: "physical" },
    { id: "check_hygrometer", label: "Look at the hygrometer", kind: "physical" },
    { id: "loosen_tension", label: "Turn tension dial down 2", kind: "physical" },
    { id: "tighten_tension", label: "Turn tension dial up 2", kind: "physical" },
    { id: "weave_row", label: "Weave a row", kind: "physical" },
    { id: "finish", label: "Finish session", kind: "close" },
  ],
  cases: [
    loomCase({
      id: "W1", title: "Dry winter afternoon", expertId: "ex-amara", procedureId: "SOP-WEAVE-TENSION",
      facts: { humidity: 28, threadCondition: "dry", yarn: "cotton warp" },
      script: {
        steps: [["feel_warp"], ["check_hygrometer"], ["loosen_tension"], ["weave_row"], ["weave_row"], ["weave_row"], ["finish"]],
        answers: [
          "The thread feels dry. When cotton gets that papery feel it snaps if you keep it at full tension, so I back the dial off.",
          "No, only when the thread is dry, which is basically when the room humidity drops below about 35 percent. On a normal day it stays at 6.",
          "If it feels soft and springy again I go back to 6. Too loose and the cloth comes out sleazy.",
        ],
        narration: "I'm just checking how the warp feels before I start.",
      },
      groundTruth: { judgment: true },
    }),
    loomCase({
      id: "W2", title: "Normal humidity (routine)", expertId: "ex-amara", procedureId: "SOP-WEAVE-TENSION",
      facts: { humidity: 55, threadCondition: "supple", yarn: "cotton warp" },
      script: { steps: [["feel_warp"], ["weave_row"], ["weave_row"], ["weave_row"], ["finish"]], answers: [] },
      groundTruth: { judgment: false },
    }),
  ],
};

const scenarios = [
  { id: "WV-A1", sourceCase: "W1", kind: "apply", title: "Cold morning, papery warp", render: "loom",
    state: { humidity: 31, threadCondition: "dry", tension: 6, rows: 4, hand: "warp", broken: false },
    facts: { yarn: "cotton warp", humidity: "31%", feel: "The warp feels stiff and papery between your fingers", dial: "6" },
    narrative: "You're about to start a cotton table runner. The studio heating has been on all morning. You pinch the warp: it feels stiff and papery.",
    options: ["Keep tension at 6 and weave", "Lower the tension before weaving", "Raise tension to 8 for a firmer beat"], answerKey: "Lower the tension before weaving" },
  { id: "WV-A2", sourceCase: "W1", kind: "counterfactual", title: "Humid day, supple warp", render: "loom",
    state: { humidity: 58, threadCondition: "supple", tension: 6, rows: 4, hand: "warp", broken: false },
    facts: { yarn: "cotton warp", humidity: "58%", feel: "The warp feels soft and springy", dial: "6" },
    narrative: "Same loom and cotton warp on a rainy afternoon. You pinch the warp: it feels soft and springy.",
    options: ["Keep tension at 6 and weave", "Lower the tension before weaving", "Raise tension to 8 for a firmer beat"], answerKey: "Keep tension at 6 and weave", ruleAction: "Lower the tension before weaving" },
];

export default { workflow, environment, scenarios };
