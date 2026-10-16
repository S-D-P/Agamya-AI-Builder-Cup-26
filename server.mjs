// Entry point. PROCESS_ROLE: all (default, local) | api (Cloud Run service) | worker (Cloud Run worker service).
import { loadDotEnv, getConfig } from "./src/config.mjs";
loadDotEnv();
const cfg = getConfig();
const { buildServices, buildServer, startScheduler } = await import("./src/app.mjs");

const services = await buildServices(cfg);
const { log } = services;
{
  const { textRenderingOk } = await import("./src/sim/render.mjs");
  if (textRenderingOk()) log.info("simulated frames: text rendering ok");
  else log.warn("simulated frames: text rendering UNAVAILABLE (fonts missing); simulated sources will lose on-screen text");
}
let app = null, scheduler = null;

if (cfg.processRole !== "worker") {
  app = await buildServer(services);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  log.info({ port: cfg.port, db: services.db.kind, storage: services.storage.kind, origin: cfg.publicOrigin }, "api listening");
}
if (cfg.processRole !== "api") {
  services.jobs.start();
  scheduler = startScheduler(services);
  if (cfg.processRole === "worker") {
    // Cloud Run requires the container to listen; the worker exposes health only.
    const http = await import("node:http");
    http.createServer((_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"ok":true,"role":"worker"}'); }).listen(cfg.port);
  }
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  clearInterval(scheduler);
  await app?.close().catch(() => {});
  await services.jobs.stop().catch(() => {});
  await services.db.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
