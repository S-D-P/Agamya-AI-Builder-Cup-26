// Voice behind a provider interface, so speech can move to another vendor without touching product code.
// Today: Google only. Speech-to-text is part of Gemini's multimodal understanding (ops/perception.mjs → transcribe);
// text-to-speech uses Gemini TTS on Vertex AI. To add a provider (for example ElevenLabs), implement `synthesize`
// returning a WAV Buffer (or null when unavailable) and register it below; select it with VOICE_PROVIDER.
// Text is always a complete alternative: every spoken question is also shown, and every answer can be typed.
import { tts as geminiTts } from "./gemini.mjs";

const PROVIDERS = {
  google: { id: "google", label: "Gemini text-to-speech on Vertex AI", synthesize: (text) => geminiTts(text) },
};

export function voiceProvider(id = "google") {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown voice provider "${id}"; available: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}
