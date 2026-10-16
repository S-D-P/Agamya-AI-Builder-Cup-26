"""Agamya Guardian: a Google ADK agent that acts on a confirmed Agamya Work Map.

Before it recommends or takes any action in the process, it asks Agamya "would the expert stop here?" and follows the
answer: STOP and ASK mean hand over to a person, NOT_COVERED means ask a person, PROCEED means go ahead. It quotes the
expert's own words, which come from the confirmed Work Map (never from the model).

Configuration (environment):
  AGAMYA_URL         e.g. https://agamya-82538920788.us-central1.run.app
  AGAMYA_AGENT_KEY   a key created on the Work Map page ("Use this Work Map with AI agents"); scoped to one map
  GUARDIAN_MODEL     optional, default gemini-2.5-flash
"""
import os

import requests
from google.adk.agents import Agent

TIMEOUT = 30


def _call(method: str, path: str, payload: dict | None = None) -> dict:
    url = os.environ.get("AGAMYA_URL", "").rstrip("/")
    key = os.environ.get("AGAMYA_AGENT_KEY", "")
    if not url or not key:
        return {"error": "AGAMYA_URL and AGAMYA_AGENT_KEY must be set"}
    try:
        r = requests.request(method, f"{url}{path}", json=payload, timeout=TIMEOUT,
                             headers={"Authorization": f"Bearer {key}", "content-type": "application/json"})
        data = r.json() if r.content else {}
        return data if r.ok else {"error": data.get("error", f"HTTP {r.status_code}")}
    except requests.RequestException as e:  # network trouble is reported, never treated as permission to proceed
        return {"error": f"could not reach Agamya: {e.__class__.__name__}"}


def get_work_map() -> dict:
    """Read the confirmed Work Map: every step, the decision, the reason and the guardrails in the expert's words.

    Returns:
        dict with title, expert, version and markdown (the full process).
    """
    m = _call("GET", "/agent/v1/map")
    return {k: m.get(k) for k in ("title", "expert", "version", "markdown", "error") if k in m}


def check_action(action: str, context: str = "") -> dict:
    """Ask whether the expert would stop this action, before doing or recommending it.

    Args:
        action: what is about to happen, in one sentence (e.g. "Post invoice INV-204 for 72,000 rupees").
        context: relevant facts such as the amount, the supplier, whether the supplier is new, dates.

    Returns:
        dict with verdict (STOP, ASK, PROCEED, NOT_COVERED or UNAVAILABLE), the step, the guardrail, the expert's own
        words (expertQuote) and a short explanation.
    """
    r = _call("POST", "/agent/v1/check", {"action": action, "context": context})
    if "error" in r:
        return {"verdict": "UNAVAILABLE", "explanation": r["error"]}
    g = r.get("guardrail") or {}
    return {"verdict": r.get("verdict"), "step": r.get("stepTitle"), "guardrail": g.get("text"), "expertQuote": g.get("expertQuote"),
            "expert": r.get("expert"), "explanation": r.get("explanation"), "workMap": (r.get("workMap") or {}).get("title")}


root_agent = Agent(
    name="agamya_guardian",
    model=os.environ.get("GUARDIAN_MODEL", "gemini-2.5-flash"),
    description="Helps with a business process using an expert's confirmed Agamya Work Map, and stops where the expert would stop.",
    instruction="""You help people and systems carry out one business process, the way its expert does it.
The process and its guardrails come from Agamya, from a Work Map the expert confirmed. Read it with get_work_map when you need the steps.

Before you recommend, approve or perform ANY action in this process, call check_action with the action and the facts you know.
- STOP: do not do it. Say what the expert's guardrail is, quote the expert's words exactly (expertQuote) and name the expert.
- ASK: do not do it yourself. Say a person must decide and why, quoting the expert.
- NOT_COVERED or UNAVAILABLE: the confirmed map does not cover it (or the check could not run). Do not guess: ask a person.
- PROCEED: go ahead, and mention the step.
Never invent rules or quotes. If facts that decide the verdict are missing (for example the amount or whether the supplier is new), ask for them first.
Answer in the language the person writes in.""",
    tools=[get_work_map, check_action],
)
