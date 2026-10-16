// Real browser capture → chunked, timestamped uploads → asynchronous server processing.
//   Screen  getDisplayMedia   adaptive keyframes (thumbnail diff every second; stable frames never leave the browser)
//   Camera  getUserMedia      same sampler; optional short WebM evidence chunks (MediaRecorder)
//   Mic     getUserMedia      voice-activity segmentation: only speech segments (≤20 s) are uploaded, as 16 kHz WAV
// Every upload carries capture time (client clock; the server applies the session's clock offset), is idempotent
// server-side (sha256), and is retried with backoff. Permission denial degrades gracefully per modality.
import { state } from "./core.js";

async function upload(sessionId, blob, meta, attempt = 0) {
  try {
    const r = await fetch(`/api/sessions/${sessionId}/media`, {
      method: "POST", credentials: "same-origin", body: blob,
      headers: { "content-type": blob.type || "application/octet-stream", "x-csrf-token": state.csrf, "x-modality": meta.modality, "x-kind": meta.kind,
        "x-captured-at": String(meta.capturedAt), ...(meta.durationMs ? { "x-duration-ms": String(Math.round(meta.durationMs)) } : {}),
        ...(meta.diffScore !== undefined ? { "x-diff-score": String(meta.diffScore), "x-cycle-diff": String(meta.cycleDiff) } : {}), "x-purpose": meta.purpose ?? "narration" },
    });
    if (r.status >= 500 && attempt < 3) throw new Error(`server ${r.status}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `upload failed (${r.status})`), { final: true, status: r.status });
    return data;
  } catch (e) {
    if (e.final || attempt >= 3) throw e;
    await new Promise((res) => setTimeout(res, 600 * 2 ** attempt));
    return upload(sessionId, blob, meta, attempt + 1);
  }
}

const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / (a.length * 255); };

// ---------------------------------------------------------------- screen / camera
export class VisualCapture {
  constructor({ sessionId, modality, onStats, onError, recordVideo = false }) {
    Object.assign(this, { sessionId, modality, onStats, onError, recordVideo });
    this.stats = { looked: 0, sent: 0, stable: 0, failed: 0 };
    this.recent = []; this.prev = null; this.sinceSent = 0; this.paused = false;
  }
  async start(video) {
    this.stream = this.modality === "SCREEN"
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    this.video = video;
    video.srcObject = this.stream; video.muted = true; video.playsInline = true;
    await video.play();
    this.thumb = Object.assign(document.createElement("canvas"), { width: 32, height: 18 });
    this.full = document.createElement("canvas");
    this.timer = setInterval(() => this.tick(), 1000);
    this.stream.getVideoTracks()[0].addEventListener("ended", () => this.stop());
    if (this.recordVideo && window.MediaRecorder) this.startVideoChunks();
  }
  startVideoChunks() {
    const type = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(this.stream, { mimeType: type, videoBitsPerSecond: 600_000 });
    let started = Date.now();
    rec.ondataavailable = (e) => {
      if (!e.data.size || this.paused) { started = Date.now(); return; }
      const capturedAt = started; started = Date.now();
      upload(this.sessionId, new Blob([e.data], { type: "video/webm" }), { modality: this.modality, kind: "video_chunk", capturedAt, durationMs: Date.now() - capturedAt }).catch((err) => this.onError?.(err));
    };
    rec.start(10_000); // 10 s evidence chunks (each a self-contained upload)
    this.rec = rec;
  }
  stop() { clearInterval(this.timer); try { this.rec?.stop(); } catch {} this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }
  get running() { return Boolean(this.stream); }
  gray() {
    const c = this.thumb.getContext("2d", { willReadFrequently: true });
    c.drawImage(this.video, 0, 0, 32, 18);
    const d = c.getImageData(0, 0, 32, 18).data, g = new Uint8Array(576);
    for (let i = 0; i < 576; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    return g;
  }
  async tick(force = false) {
    if (!this.video || this.paused || this.busy || !this.video.videoWidth) return;
    this.stats.looked++;
    const g = this.gray();
    const diff = this.prev ? meanDiff(this.prev, g) : 1;
    const cycleDiff = this.recent.length ? Math.min(...this.recent.map((r) => meanDiff(r, g))) : 1;
    this.prev = g; this.recent = [...this.recent, g].slice(-8); this.sinceSent++;
    if (!force && diff < 0.004 && this.sinceSent < 20) { this.stats.stable++; this.onStats?.(this.stats); return; } // heartbeat every ~20 s
    this.sinceSent = 0;
    const w = Math.min(1280, this.video.videoWidth);
    this.full.width = w; this.full.height = Math.round((this.video.videoHeight / this.video.videoWidth) * w);
    this.full.getContext("2d").drawImage(this.video, 0, 0, this.full.width, this.full.height);
    const blob = await new Promise((r) => this.full.toBlob(r, "image/jpeg", 0.82));
    this.busy = true;
    try { await upload(this.sessionId, blob, { modality: this.modality, kind: "frame", capturedAt: Date.now(), diffScore: force ? 1 : diff, cycleDiff: force ? 1 : cycleDiff }); this.stats.sent++; }
    catch (e) { this.stats.failed++; this.onError?.(e); }
    finally { this.busy = false; this.onStats?.(this.stats); }
  }
}

// ---------------------------------------------------------------- microphone (VAD-segmented narration)
export class VoiceCapture {
  constructor({ sessionId, onSegment, onError, onLevel }) { Object.assign(this, { sessionId, onSegment, onError, onLevel }); this.paused = false; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.silentFor = 0; this.timer = setInterval(() => this.tick(), 100);
  }
  level() { this.analyser.getFloatTimeDomainData(this.buf); let s = 0; for (const v of this.buf) s += v * v; return Math.sqrt(s / this.buf.length); }
  tick() {
    const lv = this.level();
    this.onLevel?.(lv);
    const speaking = lv > 0.02;
    if (this.paused) { if (this.seg) this.endSegment(); return; }
    if (speaking && !this.seg) this.beginSegment();
    if (this.seg) {
      this.silentFor = speaking ? 0 : this.silentFor + 100;
      if (this.silentFor >= 1200 || Date.now() - this.seg.started > 20000) this.endSegment();
    }
  }
  beginSegment() {
    const rec = new MediaRecorder(this.stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    this.seg = { rec, chunks, started: Date.now() };
    rec.start();
  }
  endSegment() {
    const seg = this.seg; this.seg = null; this.silentFor = 0;
    seg.rec.onstop = async () => {
      try {
        const wav = await toWav16k(new Blob(seg.chunks, { type: seg.rec.mimeType }));
        if (wav.durationSec < 0.6) return; // a click, not speech
        await upload(this.sessionId, wav.blob, { modality: "MICROPHONE", kind: "audio_chunk", capturedAt: seg.started, durationMs: wav.durationSec * 1000 });
        this.onSegment?.(wav.durationSec);
      } catch (e) { this.onError?.(e); }
    };
    seg.rec.stop();
  }
  stop() { clearInterval(this.timer); if (this.seg) this.endSegment(); this.stream?.getTracks().forEach((t) => t.stop()); this.ctx?.close(); this.stream = null; }
  get running() { return Boolean(this.stream); }
}

// ---------------------------------------------------------------- push-to-talk answers
export class AnswerRecorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = []; this.rec = new MediaRecorder(this.stream); this.started = Date.now();
    this.rec.ondataavailable = (e) => this.chunks.push(e.data);
    this.rec.start();
  }
  async stopAndUpload(sessionId) {
    const done = new Promise((r) => (this.rec.onstop = r));
    this.rec.stop(); await done;
    this.stream.getTracks().forEach((t) => t.stop());
    const wav = await toWav16k(new Blob(this.chunks, { type: this.rec.mimeType }));
    return upload(sessionId, wav.blob, { modality: "MICROPHONE", kind: "audio_chunk", capturedAt: this.started, durationMs: wav.durationSec * 1000, purpose: "answer" });
  }
}

/** Speak → editable draft text (nothing is stored server-side). The person always reviews the words before submitting. */
export class DraftRecorder {
  async start() { this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); this.chunks = []; this.rec = new MediaRecorder(this.stream); this.rec.ondataavailable = (e) => this.chunks.push(e.data); this.rec.start(); }
  async stop(language) {
    const done = new Promise((r) => (this.rec.onstop = r));
    this.rec.stop(); await done;
    this.stream.getTracks().forEach((t) => t.stop());
    const wav = await toWav16k(new Blob(this.chunks, { type: this.rec.mimeType }));
    const r = await fetch("/api/voice/transcribe", { method: "POST", credentials: "same-origin", headers: { "content-type": "audio/wav", "x-csrf-token": state.csrf, ...(language ? { "x-language": language } : {}) }, body: wav.blob });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "transcription failed");
    return data;
  }
}

async function toWav16k(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return { blob: new Blob([buf], { type: "audio/wav" }), durationSec: decoded.duration };
}

// ---------------------------------------------------------------- speech out (Gemini TTS via server; browser voice fallback)
let current = null;
export async function speak(text) {
  if (!state.speak || !text) return;
  try {
    current?.pause();
    const blob = await fetch("/api/voice/tts", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": state.csrf }, body: JSON.stringify({ text }) }).then((r) => { if (!r.ok) throw new Error("tts"); return r.blob(); });
    current = new Audio(URL.createObjectURL(blob));
    await current.play();
  } catch {
    if ("speechSynthesis" in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
  }
}
