// Minimal authenticated API client for scripts (cookie session + CSRF header), mirroring what the browser does.
export function client(base) {
  let cookie = "";
  let csrf = "";
  async function req(method, path, body, { raw = false, headers = {} } = {}) {
    const isBuf = Buffer.isBuffer(body);
    const send = () => fetch(base + path, {
      method,
      headers: { ...(body && !isBuf ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}), origin: base, ...headers },
      body: body ? (isBuf ? body : JSON.stringify(body)) : undefined,
      redirect: "manual",
    });
    // GETs are idempotent: retry a stale keep-alive socket (ECONNRESET) instead of failing the whole run.
    const r = await send().catch((e) => (method === "GET" ? new Promise((ok) => setTimeout(ok, 500)).then(send) : Promise.reject(e)));
    const set = r.headers.getSetCookie?.() ?? [];
    for (const c of set) { const kv = c.split(";")[0]; if (kv.startsWith("kd_session=")) cookie = kv; }
    if (raw) { if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${data.error ?? ""}`), { status: r.status, data });
    if (data?.csrfToken) csrf = data.csrfToken;
    return data;
  }
  return {
    req,
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b ?? {}),
    del: (p) => req("DELETE", p),
    async login(email, password) {
      await req("POST", "/api/auth/login", { email, password });
      const me = await req("GET", "/api/auth/me");
      if (me.policies?.pending?.length) await req("POST", "/api/policies/accept", { ids: me.policies.pending });
      return req("GET", "/api/auth/me");
    },
    async poll(path, until, { timeoutMs = 180000, everyMs = 1000 } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const d = await req("GET", path);
        if (until(d)) return d;
        if (Date.now() > end) throw new Error(`timeout waiting on ${path}`);
        await new Promise((r) => setTimeout(r, everyMs));
      }
    },
  };
}
