# AI agents that stop where the expert would stop

A confirmed Work Map lists where an expert stops, asks or refuses. Agents can ask it before acting.

```
POST /agent/v1/check   {"action": "Post invoice INV-204 for 72,000 rupees", "context": "new supplier"}
→ {"verdict": "STOP", "stepTitle": "Handle invoices over 50,000", "guardrail": {"expertQuote": "Anything over fifty thousand rupees I never post myself"}, ...}
```

| Verdict | Meaning | The agent must |
|---|---|---|
| `STOP` | A "never" or limit guardrail would be broken | not act; quote the expert |
| `ASK` | A "stop and ask" or exception applies | hand over to a person |
| `PROCEED` | Matches a step; no guardrail triggered | go ahead |
| `NOT_COVERED` | Not in the map, or facts missing | ask a person |

**How it stays grounded:** Gemini picks the verdict and the step. The guardrail and the expert's words are copied from the confirmed map. A stop that points to no real guardrail becomes `NOT_COVERED`.

## Connect

On a confirmed Work Map, open **Use this Work Map with AI agents → Connect an agent**. The key:
- is shown once and stored only as a hash;
- can be revoked at any time;
- is rate-limited.

Every check is logged.

- **REST:** `POST /agent/v1/check` and `GET /agent/v1/map`, with `Authorization: Bearer <key>`.
- **MCP:** `POST /agent/v1/mcp`, with the tools `get_work_map` and `check_action`. It works with any MCP client.
- **Google ADK on Vertex AI Agent Engine:** see [`agents/README.md`](../agents/README.md).
