// Object storage for all media and documents. Local filesystem in development, Google Cloud Storage in production.
// Keys are always namespaced by organization: org/<orgId>/... ; callers never choose arbitrary paths.
import fs from "node:fs";
import path from "node:path";

const KEY = /^org\/[0-9a-f-]{36}\/[a-z0-9/_.-]+$/;

export function objectKey(orgId, ...parts) {
  const key = ["org", orgId, ...parts].join("/").toLowerCase();
  if (!KEY.test(key) || key.includes("..")) throw new Error("invalid object key");
  return key;
}

export async function createStorage(cfg) {
  if (cfg.driver === "gcs") return gcsStore(cfg);
  return localStore(cfg);
}

function localStore(cfg) {
  const mem = cfg.dir ? null : new Map();
  const file = (key) => {
    if (!KEY.test(key)) throw new Error("invalid object key");
    return path.join(cfg.dir, ...key.split("/"));
  };
  return {
    kind: "local",
    async put(key, buf) {
      if (mem) return void mem.set(key, Buffer.from(buf));
      const f = file(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      await fs.promises.writeFile(f, buf);
    },
    async get(key) {
      if (mem) return mem.get(key) ?? null;
      try { return await fs.promises.readFile(file(key)); } catch { return null; }
    },
    async delete(key) {
      if (mem) return void mem.delete(key);
      await fs.promises.rm(file(key), { force: true });
    },
    async signedUrl() { return null; }, // local: served through the authorised media endpoint
    async ping() { if (!mem) fs.mkdirSync(cfg.dir, { recursive: true }); return true; },
  };
}

async function gcsStore(cfg) {
  const { Storage } = await import("@google-cloud/storage");
  const bucket = new Storage().bucket(cfg.bucket);
  return {
    kind: "gcs",
    async put(key, buf, { contentType } = {}) {
      if (!KEY.test(key)) throw new Error("invalid object key");
      await bucket.file(key).save(buf, { resumable: false, contentType, metadata: { cacheControl: "private, no-store" } });
    },
    async get(key) {
      try { const [b] = await bucket.file(key).download(); return b; } catch (e) { if (e.code === 404) return null; throw e; }
    },
    async delete(key) { await bucket.file(key).delete({ ignoreNotFound: true }); },
    async signedUrl(key, ttlSec = cfg.signedUrlTtlSec) {
      const [url] = await bucket.file(key).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + ttlSec * 1000 });
      return url;
    },
    // Object-level probe: the runtime account has object access only (no bucket metadata permission).
    async ping() { await bucket.file(".readyz").exists(); return true; },
  };
}
