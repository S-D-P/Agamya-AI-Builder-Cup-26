# Agamya Guardian (Google ADK, Vertex AI Agent Engine)

An ADK agent that helps with one business process using an expert's **confirmed** Agamya Work Map. Before it recommends or performs any action, it calls `check_action`, and it never proceeds on STOP, ASK or NOT_COVERED. See [../docs/AGENTS.md](../docs/AGENTS.md).

## Set up

```bash
python -m venv agents/.venv
agents/.venv/Scripts/python -m pip install -r agents/requirements.txt   # macOS/Linux: agents/.venv/bin/python
```

You need a confirmed Work Map and an agent key, both from the Work Map page (**Use this Work Map with AI agents → Connect an agent**).

## Run locally

```bash
export AGAMYA_URL=https://<your-agamya-host> AGAMYA_AGENT_KEY=agk_... GOOGLE_CLOUD_PROJECT=<project> GOOGLE_GENAI_USE_VERTEXAI=true GOOGLE_CLOUD_LOCATION=us-central1
cd agents && ../agents/.venv/Scripts/adk web        # ADK dev UI; choose guardrail_agent
```

## Deploy to Vertex AI Agent Engine

```bash
PROJECT=<project> AGAMYA_URL=https://<your-agamya-host> AGAMYA_AGENT_KEY=agk_... agents/.venv/Scripts/python agents/deploy_agent_engine.py
```

The script:
1. creates a staging bucket;
2. stores the key in Secret Manager (`agamya-guardian-key`);
3. grants only the Vertex AI service agents access to that secret;
4. deploys with `AdkApp` (tracing on).

To update an existing deployment, use `--update <resource name>`.
