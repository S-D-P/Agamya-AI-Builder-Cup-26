// LIVING KNOWLEDGE SAMPLE — "Amma's ghee": a mother teaching her daughter to make ghee from butter.
// Physical skill, camera + voice + a written family recipe card. The simulated kitchen camera produces rendered frames;
// NO action labels are emitted, so the engine only sees pixels and hears the teacher, as with a real camera.
// The judgment: the recipe card says "simmer 20 minutes", but she stops when the milk solids turn light golden and the
// foam clears (and a curry leaf crackles at once). The boundary: time is not the rule; the signal is. Store-bought
// butter holds more water, so at the same minute the specks are still white and stopping would be wrong.

const CARD = `FAMILY RECIPE CARD: Ghee from butter

1. Melt 500 g unsalted butter in a heavy pan on medium heat.
2. Simmer for 20 minutes, stirring now and then.
3. Turn off the heat and strain through a fine cloth into a clean, dry jar.`;

const workflow = {
  id: "wf-kitchen",
  name: "Amma's ghee",
  description: "How Lakshmi knows when ghee is ready: the signals she watches instead of the clock.",
  kind: "physical",
  modalities: { screen: false, app_events: false, microphone: true, camera: true, documents: true },
  captureSources: ["sim:kitchen-camera", "live:camera"],
  documents: [{ id: "doc-ghee-card", title: "Family recipe card: ghee", mimeType: "text/plain", text: CARD }],
  procedures: [
    { id: "CARD-GHEE", title: "Ghee from butter (recipe card)", appliesWhen: "Making ghee from butter", steps: ["Melt 500 g unsalted butter on medium heat.", "Simmer for 20 minutes, stirring now and then.", "Turn off the heat and strain into a dry jar."], defaultDecision: "Simmer for 20 minutes, then turn off the heat and strain", resolutionActions: [], docId: "doc-ghee-card" },
  ],
  experts: [{ id: "ex-lakshmi", name: "Lakshmi", role: "Teacher · has made ghee at home for 40 years" }],
  learners: [{ id: "ln-meera", name: "Meera", role: "Learner · her daughter" }],
  source: "demo",
};

// How fast the milk solids colour, by butter: minute → stage
const STAGES = ["white", "cream", "light_golden", "golden_brown", "dark_brown"];
function stageAt(speed, minute) {
  const thresholds = speed === "fast" ? [0, 8, 11, 15, 18] : [0, 13, 19, 23, 26];
  let i = 0;
  thresholds.forEach((t, k) => { if (minute >= t) i = k; });
  return STAGES[i];
}
const foamFor = (stage) => (stage === "white" ? "thick" : stage === "cream" ? "settling" : "clear");

function ghee(c) {
  const start = c.facts.startMinute;
  const residue = stageAt(c.facts.speed, start);
  return {
    ...c,
    state: { minute: start, residue, foam: foamFor(residue), flame: "medium", hand: null, leaf: null, strained: false, tilt: false },
    effect(state, action) {
      switch (action) {
        case "stir": return { set: { hand: "ladle", tilt: false } };
        case "wait": {
          if (state.flame === "off") return { set: { hand: null } };
          const minute = state.minute + 3;
          const r = stageAt(c.facts.speed, minute);
          return { set: { minute, residue: r, foam: foamFor(r), hand: null, tilt: false, leaf: null } };
        }
        case "tilt_pan": return { set: { hand: "tilt", tilt: true } };
        case "drop_leaf": return { set: { hand: "leaf", leaf: state.foam === "clear" ? "crackle" : "quiet" } };
        case "lower_flame": return { set: { hand: "knob", flame: "low" } };
        case "turn_off": return { set: { hand: "knob", flame: "off", tilt: false } };
        case "strain": return { set: { hand: "strain", strained: true, tilt: false } };
        default: return {};
      }
    },
    view(state) { return state; },
  };
}

const environment = {
  id: "sim:kitchen-camera",
  label: "Kitchen camera (simulated feed)",
  render: "stove",
  emits: ["CAMERA"],
  uiText: false,
  actions: [
    { id: "stir", label: "Stir gently", kind: "physical" },
    { id: "wait", label: "Let it simmer (3 min)", kind: "physical" },
    { id: "tilt_pan", label: "Tilt the pan and look at the bottom", kind: "physical" },
    { id: "drop_leaf", label: "Drop in a curry leaf", kind: "physical" },
    { id: "lower_flame", label: "Lower the flame", kind: "physical" },
    { id: "turn_off", label: "Turn off the flame", kind: "physical" },
    { id: "strain", label: "Strain into the jar", kind: "close" },
  ],
  cases: [
    ghee({
      id: "K1", title: "Homemade butter, small batch", expertId: "ex-lakshmi", procedureId: "CARD-GHEE",
      facts: { butter: "homemade, 500 g", speed: "fast", startMinute: 6 },
      script: {
        steps: [["stir"], ["wait"], ["stir"], ["wait"], ["tilt_pan"], ["drop_leaf"], ["turn_off"], ["strain"]],
        answers: [
          "Look at the bits at the bottom. When they turn light golden like this and the foam clears so you can see through, the ghee is done. The clock doesn't matter. If I wait the full twenty minutes those bits go brown and the ghee smells burnt.",
          "No, it's not about twelve minutes. Store-bought butter has more water, so it takes longer. I wait for the colour every time. If the bits are still white and it's still crackling loudly, the water hasn't cooked off and the ghee will spoil in the jar, so I keep going even past twenty minutes.",
          "The curry leaf is my check. If it crackles straight away the water is gone. If it just sits there, keep cooking.",
        ],
        narration: "I keep stirring so the milk solids don't stick to the bottom.",
        craftContext: {
          materials: "Unsalted butter. Homemade butter from cream cooks faster than store-bought.",
          tools: "A heavy-bottomed pan, a flat ladle, a fine cotton cloth for straining, a dry glass jar.",
          conditions: "Medium flame. The jar must be completely dry or the ghee spoils.",
          sensoryCues: "Specks at the bottom turn light golden; the foam clears; the loud crackle quietens; a nutty smell; a curry leaf crackles at once.",
          timing: "Varies with the butter: about 10–12 minutes for this homemade batch, longer for store-bought.",
        },
      },
      groundTruth: { judgment: true },
    }),
    ghee({
      id: "K2", title: "Store-bought butter (follows the card)", expertId: "ex-lakshmi", procedureId: "CARD-GHEE",
      facts: { butter: "store-bought, 500 g", speed: "slow", startMinute: 8 },
      script: { steps: [["stir"], ["wait"], ["wait"], ["wait"], ["wait"], ["tilt_pan"], ["turn_off"], ["strain"]], answers: [] },
      groundTruth: { judgment: false },
    }),
  ],
};

const OPTIONS = ["Turn off the heat now and strain", "Keep simmering and keep watching the specks", "Turn the flame up to finish faster"];
const scenarios = [
  { id: "KT-A1", sourceCase: "K1", kind: "apply", title: "Minute 11, the specks have turned", render: "stove",
    state: { minute: 11, residue: "light_golden", foam: "clear", flame: "medium", hand: "tilt", tilt: true, leaf: "crackle", strained: false },
    facts: { butter: "homemade, 500 g", timer: "11 minutes (the card says 20)", specks: "light golden", foam: "cleared; you can see the bottom", curryLeaf: "crackles straight away" },
    narrative: "You are making ghee from a batch of homemade butter. The recipe card says to simmer for 20 minutes. At 11 minutes you tilt the pan: the specks at the bottom are light golden and the foam has cleared.",
    options: OPTIONS, answerKey: "Turn off the heat now and strain",
    criteria: ["Decides by the colour of the specks, not by the time on the recipe card", "Notices the foam has cleared or the curry leaf crackles"] },
  { id: "KT-A2", sourceCase: "K1", kind: "counterfactual", title: "Minute 12, store-bought butter", render: "stove",
    state: { minute: 12, residue: "white", foam: "thick", flame: "medium", hand: "tilt", tilt: true, leaf: "quiet", strained: false },
    facts: { butter: "store-bought, 500 g", timer: "12 minutes", specks: "still milky white", foam: "thick, crackling loudly", curryLeaf: "sits quietly, no crackle" },
    narrative: "This time the butter is store-bought. At 12 minutes, about when Amma turned off the heat last time, you tilt the pan: the specks are still milky white and the foam is thick and loud.",
    options: OPTIONS, answerKey: "Keep simmering and keep watching the specks", ruleAction: "Turn off the heat now and strain",
    criteria: ["Sees that the specks are still white, so the water has not cooked off yet", "Does not copy the 12-minute stop from a different batch"] },
  // Boundary: the signal has gone past the point that matters.
  { id: "KT-A3", sourceCase: "K1", kind: "boundary", title: "Minute 14, the specks are turning brown", render: "stove",
    state: { minute: 14, residue: "golden_brown", foam: "clear", flame: "medium", hand: "tilt", tilt: true, leaf: null, strained: false },
    facts: { butter: "homemade, 500 g", timer: "14 minutes (the card says 20)", specks: "deep golden, edges turning brown", foam: "clear", smell: "nutty, starting to get sharp" },
    narrative: "You got distracted for a few minutes. At 14 minutes the specks are past golden and their edges are turning brown. The card still says 6 more minutes.",
    options: OPTIONS, answerKey: "Turn off the heat now and strain",
    criteria: ["Recognises the specks are past golden and starting to brown", "Knows that waiting for the card's time would burn the ghee"] },
  // Insufficient evidence: the deciding signal cannot be observed; the careful answer is to check or ask before acting.
  { id: "KT-A4", sourceCase: "K1", kind: "insufficient", title: "Minute 12, you can't see the bottom", render: "stove",
    state: { minute: 12, residue: "cream", foam: "thick", flame: "medium", hand: null, tilt: false, leaf: null, strained: false },
    facts: { butter: "a mix of homemade and store-bought", timer: "12 minutes", specks: "hidden under thick foam", curryLeaf: "none in the house today" },
    narrative: "A thick layer of foam hides the bottom of the pan, you have no curry leaves today, and this batch mixes two kinds of butter. Amma is in the next room.",
    options: OPTIONS, answerKey: "__ask_expert__",
    criteria: ["Recognises that the deciding signal, the colour of the specks, cannot be seen", "Does not decide by the clock alone"] },
];

export default { workflow, environment, scenarios, experience: "living" };
