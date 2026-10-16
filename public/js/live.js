// Live Moti client: microphone (16 kHz PCM) + screen or camera frames (only when they change, at most 1/s) → our server
// over a same-origin WebSocket → Gemini Live; Moti's voice (24 kHz PCM) is played back and stops instantly when interrupted.
// Nothing here holds credentials. Every callback reports state so the UI can announce it.

// Small chunks: spreading tens of thousands of arguments can overflow the call stack in some browsers.
const b64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x1000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x1000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

export class LiveMoti {
  /** @param o {mode, sessionId, language, video:'screen'|'camera'|null, onMoti, onYou, onStatus, onMoment, onError, onState} */
  constructor(o) { Object.assign(this, o); this.state = "idle"; this.sent = { frames: 0, skipped: 0 }; }

  async start(videoEl) {
    try { await this.open(videoEl); } catch (e) { this.stopMedia(); try { this.ws?.close(); } catch { /* not open */ } throw e; }
  }

  async open(videoEl) {
    this.setState("starting");
    // 1. Media first, so a refused permission never leaves a half-open session.
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (this.video === "screen") this.vstream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    else if (this.video === "camera") this.vstream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "environment" }, audio: false });
    if (this.vstream) this.attachVideo(videoEl ?? document.getElementById("now-video"));
    this.vstream?.getVideoTracks()[0]?.addEventListener("ended", () => this.onError?.("Screen sharing stopped. Share again or end the session."));
    // 2. Socket.
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live?mode=${this.mode}&${this.sessionId ? `session=${this.sessionId}&` : ""}language=${this.language ?? "en"}`;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    this.ws.onclose = () => { this.stopMedia(); if (this.state !== "ended" && this.state !== "closed") this.setState("closed"); };
    this.ws.onerror = () => this.onError?.("Connection to Moti failed.");
    await new Promise((res, rej) => { this.ws.onopen = res; setTimeout(() => rej(new Error("Moti did not answer. Try again.")), 15000); });
    // 3. Microphone → 16 kHz PCM chunks.
    this.inCtx = new AudioContext({ sampleRate: 16000 });
    await this.inCtx.audioWorklet.addModule("/js/pcm-worklet.js");
    const src = this.inCtx.createMediaStreamSource(this.mic);
    this.node = new AudioWorkletNode(this.inCtx, "pcm-capture");
    this.node.port.onmessage = (e) => { if (this.ws?.readyState === 1 && !this.muted) this.ws.send(JSON.stringify({ t: "audio", d: b64(e.data) })); };
    src.connect(this.node);
    // 4. Playback context for Moti's voice.
    this.outCtx = new AudioContext({ sampleRate: 24000 }); this.playAt = 0; this.sources = new Set();
    // 5. Frames.
    if (this.vstream) { this.canvas = document.createElement("canvas"); this.thumb = document.createElement("canvas"); this.thumb.width = 32; this.thumb.height = 18; this.timer = setInterval(() => this.tickFrame(), 1000); }
  }

  onMessage(m) {
    if (m.t === "ready") this.setState("live");
    else if (m.t === "audio") this.play(m.d);
    else if (m.t === "interrupted") this.stopPlayback();
    else if (m.t === "moti") this.onMoti?.(m.text);
    else if (m.t === "you") this.onYou?.(m.text);
    else if (m.t === "moment") this.onMoment?.(m);
    else if (m.t === "status") this.onStatus?.(m);
    else if (m.t === "error") this.onError?.(m.message);
    else if (m.t === "closed") this.setState("closed");
  }

  play(d) {
    const pcm = new Int16Array(unb64(d)), f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
    const buf = this.outCtx.createBuffer(1, f.length, 24000); buf.copyToChannel(f, 0);
    const s = this.outCtx.createBufferSource(); s.buffer = buf; s.connect(this.outCtx.destination);
    const at = Math.max(this.outCtx.currentTime + 0.02, this.playAt);
    s.start(at); this.playAt = at + buf.duration; this.sources.add(s); s.onended = () => this.sources.delete(s);
    this.setState("speaking"); clearTimeout(this.speakT); this.speakT = setTimeout(() => this.state === "speaking" && this.setState("live"), (this.playAt - this.outCtx.currentTime) * 1000 + 200);
  }
  stopPlayback() { for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } } this.sources.clear(); this.playAt = 0; if (this.state === "speaking") this.setState("live"); }

  tickFrame() {
    if (this.offRecord || !this.videoEl?.videoWidth || this.ws?.readyState !== 1) return;
    const v = this.videoEl, tc = this.thumb.getContext("2d", { willReadFrequently: true });
    tc.drawImage(v, 0, 0, 32, 18);
    const px = tc.getImageData(0, 0, 32, 18).data;
    let diff = 0;
    if (this.prev) for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - this.prev[i]) + Math.abs(px[i + 1] - this.prev[i + 1]) + Math.abs(px[i + 2] - this.prev[i + 2]);
    const changed = !this.prev || diff / (32 * 18 * 3 * 255) > 0.012;
    const stale = Date.now() - (this.lastSent ?? 0) > 6000;
    if (!changed && !stale) { this.sent.skipped++; return; }
    this.prev = px;
    const scale = Math.min(1, 1024 / v.videoWidth);
    this.canvas.width = Math.round(v.videoWidth * scale); this.canvas.height = Math.round(v.videoHeight * scale);
    this.canvas.getContext("2d").drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
    this.canvas.toBlob(async (blob) => {
      if (!blob || this.ws?.readyState !== 1) return;
      this.ws.send(JSON.stringify({ t: "frame", d: b64(await blob.arrayBuffer()), mod: this.video === "camera" ? "CAMERA" : "SCREEN", at: Date.now() }));
      this.sent.frames++; this.lastSent = Date.now();
    }, "image/jpeg", 0.7);
  }

  say(text) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "text", text })); }
  setOffRecord(on) { this.offRecord = on; this.muted = on; if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "offrecord", on })); }
  finish() { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "done" })); this.setState("ending"); }
  // Idempotent: called on "I'm done", on socket close and on leaving the page. AudioContext.close() rejects (it does not
  // throw) when the context is already closed, so each context is closed once and any rejection is absorbed.
  stopMedia() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer); clearTimeout(this.speakT);
    try { this.node?.port && (this.node.port.onmessage = null); this.node?.disconnect(); } catch { /* already disconnected */ }
    this.mic?.getTracks().forEach((t) => t.stop()); this.vstream?.getTracks().forEach((t) => t.stop());
    for (const ctx of [this.inCtx, this.outCtx]) if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
  }
  close() { if (this.state !== "ended") this.setState("ended"); try { this.ws?.close(); } catch { /* closed */ } this.stopMedia(); }
  /** The page re-renders; give the live stream to the new <video> element so the person keeps seeing themselves. */
  attachVideo(el) {
    if (!el || !this.vstream) return;
    if (el.srcObject !== this.vstream) { el.srcObject = this.vstream; el.muted = true; el.playsInline = true; el.play().catch(() => {}); }
    this.videoEl = el;
  }
  setState(s) { this.state = s; this.onState?.(s); }
}

export const liveSupport = () => ({
  mic: Boolean(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode),
  screen: Boolean(navigator.mediaDevices?.getDisplayMedia),
  camera: Boolean(navigator.mediaDevices?.getUserMedia),
});
