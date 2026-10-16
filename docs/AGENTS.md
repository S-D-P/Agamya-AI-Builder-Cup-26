# Guardrail agents: AI agents that stop where the expert would stop

A confirmed Work Map is more than training material. It is a list of the places where an expert stops, asks or refuses. Agamya makes it usable by AI agents and automations, so they ask **"would the expert stop here?"** before they act.

```
Expert (Moti capture → Work Map → debrief → confirm)
        │
        ▼
Confirmed Work Map ──► /agent/v1/check  (REST)      ┐
                   ──► /agent/v1/mcp    (MCP tools) ├─ bearer key, scoped to ONE map, revocable, rate-limited
                   ──► /agent/v1/map    (markdown)  ┘
        ▲
        │ check_action / get_work_map (function tools)
Agamya Guardian: Google ADK agent on Vertex AI Agent Engine (agents/guardrail_agent)
```

## Verdicts

| Verdict | Meaning | What an agent must do |
|---|---|---|
| `STOP` | A "never" or limit guardrail would be broken | Do not act; quote the expert |
| `ASK` | A "stop and ask" or an exception applies | Hand over to a person |
| `PROCEED` | The action matches a step; no guardrail is triggered by the given facts | Go ahead |
| `NOT_COVERED` | The map does not cover this, or deciding facts are missing | Ask a person, do not guess |
| `UNAVAILABLE` | The check could not run | Ask a person |

**Grounding:**
- Gemini (2.5 Flash, structured output) only chooses the verdict, the step and the guardrail, by index.
- The guardrail text and the expert's verbatim quote are copied from the confirmed map, never generated.
- If the model says STOP or ASK but points at no real guardrail, the answer is downgraded to `NOT_COVERED` (tested).

## Connect an agent

On a confirmed Work Map, open **Use this Work Map with AI agents → Connect an agent**. The key is shown once; only its SHA-256 is stored. Revoking it stops it at once. Every check is recorded with its verdict and step, and the proposed action is stored redacted. Recent checks appear on the map page and in **Impact**.

- **REST:**
  ```bash
  curl -X POST $AGAMYA/agent/v1/check -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
    -d '{"action":"Post invoice INV-204 for 72,000 rupees","context":"supplier: Mehta Traders (new)"}'
  ```
- **MCP** (Claude, Gemini CLI or any MCP client; Streamable HTTP, JSON responses): `$AGAMYA/agent/v1/mcp` with the header `Authorization: Bearer $KEY`. It offers two tools, `get_work_map` and `check_action`. The server's `instructions` tell the client to check before acting.
- **Google ADK**, deployed on **Vertex AI Agent Engine**: see `agents/README.md`.

## Verified (October 16, 2026)

- **Local ADK run** (`InMemoryRunner`) against a real confirmed map:
  - "Post INV-204 for ₹72,000" → `check_action` → **STOP**. The agent refused and quoted Asha verbatim.
  - "INV-205 for ₹18,000 from a long-standing supplier" → **PROCEED**, naming the step.
- **Deployed on Vertex AI Agent Engine** (`reasoningEngines/2634610454936158208`, us-central1):
  - "Post INV-311 from Mehta Traders for ₹64,500" → the cloud agent called the Cloud Run API and got **STOP**.
  - It answered: *Asha says: "Anything over fifty thousand rupees I never post myself, I hold it for the controller"*.
- **In the app:** "Post INV-204 from a new supplier for ₹72,000" → **STOP** at the step "Confirm bank details for new supplier", with Asha's words.
- **Automated tests** (`tests/live.test.mjs`):
  - keys, revocation and isolation between spaces;
  - REST and the MCP protocol (`initialize`, `notifications/initialized` → 202, `tools/list`, `tools/call`, unknown method → −32601);
  - redaction of stored actions;
  - the grounding downgrade.
