# One image, two Cloud Run services: PROCESS_ROLE=api (HTTP) and PROCESS_ROLE=worker (job queue + scheduler).
# Gemini on Vertex AI and Cloud Storage use the service account's identity; no keys are baked into the image.
FROM node:24-slim
# Fonts for server-side rendering of simulated screens / scenario visuals (resvg).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY server.mjs ./
# Benchmark/adversarial evidence shown on the Insights screen (imported once into the database).
COPY data/benchmark.json data/adversarial.json ./data/
USER node
ENV PORT=8080 PROCESS_ROLE=api GOOGLE_CLOUD_LOCATION=us-central1 GEMINI_MODEL=gemini-2.5-flash
EXPOSE 8080
CMD ["node", "server.mjs"]
