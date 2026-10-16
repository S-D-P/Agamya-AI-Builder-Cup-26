"""Deploy the Agamya Guardian (Google ADK) to Vertex AI Agent Engine.

    agents/.venv/Scripts/python agents/deploy_agent_engine.py            # create (or --update RESOURCE_NAME)

Needs: gcloud application-default credentials; PROJECT (default from GOOGLE_CLOUD_PROJECT), REGION (us-central1),
STAGING_BUCKET (gs://<project>-agamya-agents, created if missing), AGAMYA_URL and AGAMYA_AGENT_KEY. The key is stored in
Secret Manager (secret "agamya-guardian-key") and given to the agent as a secret reference, never as plain configuration.
"""
import os
import subprocess
import sys

import vertexai
from vertexai import agent_engines

# Package the agent by its RELATIVE path so it is importable as "guardrail_agent" inside Agent Engine.
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())
from guardrail_agent.agent import root_agent  # noqa: E402

PROJECT = os.environ.get("PROJECT") or os.environ.get("GOOGLE_CLOUD_PROJECT")
REGION = os.environ.get("REGION", "us-central1")
BUCKET = os.environ.get("STAGING_BUCKET") or f"gs://{PROJECT}-agamya-agents"
URL, KEY = os.environ.get("AGAMYA_URL"), os.environ.get("AGAMYA_AGENT_KEY")
SECRET = "agamya-guardian-key"
if not (PROJECT and URL and KEY):
    sys.exit("set PROJECT, AGAMYA_URL and AGAMYA_AGENT_KEY")

gc = "gcloud.cmd" if os.name == "nt" else "gcloud"
def run(*args, stdin=None, check=True):
    return subprocess.run([gc, *args, "--project", PROJECT], input=stdin, text=True, capture_output=True, check=check)

if run("storage", "buckets", "describe", BUCKET, check=False).returncode:
    run("storage", "buckets", "create", BUCKET, "--location", REGION, "--uniform-bucket-level-access")
if run("secrets", "describe", SECRET, check=False).returncode:
    run("secrets", "create", SECRET, "--data-file=-", stdin=KEY)
else:
    run("secrets", "versions", "add", SECRET, "--data-file=-", stdin=KEY)

# Agent Engine runs as the Vertex AI Reasoning Engine service agent: it may read this one secret, nothing else.
number = run("projects", "describe", PROJECT, "--format", "value(projectNumber)").stdout.strip()
for sa in (f"service-{number}@gcp-sa-aiplatform-re.iam.gserviceaccount.com", f"service-{number}@gcp-sa-aiplatform.iam.gserviceaccount.com"):
    run("secrets", "add-iam-policy-binding", SECRET, "--member", f"serviceAccount:{sa}", "--role", "roles/secretmanager.secretAccessor", check=False)

vertexai.init(project=PROJECT, location=REGION, staging_bucket=BUCKET)
app = agent_engines.AdkApp(agent=root_agent, enable_tracing=True)
config = dict(
    requirements=["google-cloud-aiplatform[agent_engines,adk]>=1.100", "google-adk>=1.0", "requests>=2.31"],
    extra_packages=["guardrail_agent"],
    display_name="Agamya Guardian",
    description="Acts on an expert's confirmed Agamya Work Map and stops where the expert would stop.",
    env_vars={"AGAMYA_URL": URL, "AGAMYA_AGENT_KEY": {"secret": SECRET, "version": "latest"}},
)
if len(sys.argv) > 2 and sys.argv[1] == "--update":
    remote = agent_engines.update(resource_name=sys.argv[2], agent_engine=app, **config)
else:
    remote = agent_engines.create(app, **config)
print("Agent Engine resource:", remote.resource_name)
