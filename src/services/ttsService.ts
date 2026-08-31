import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env.ts";

export const PANELIST_VOICES: Record<string, string> = {
  Marcus: "en-US-DavisNeural",
  Sarah: "en-US-AriaNeural",
  Chen: "en-US-JasonNeural",
  Riley: "en-US-JennyNeural",
  Elena: "en-US-AriaNeural",
  David: "en-US-DavisNeural",
  James: "en-US-JasonNeural",
  Taylor: "en-US-JennyNeural",
};

export function resolveVoiceName(speaker: string): string {
  const normalized = speaker?.trim() || "Marcus";
  const key = Object.keys(PANELIST_VOICES).find(
    (name) => name.toLowerCase() === normalized.toLowerCase(),
  );
  return key ? PANELIST_VOICES[key] : PANELIST_VOICES.Marcus;
}

const SYNTHESIS_TIMEOUT_MS = 25_000;

let cachedSpeechConfig: sdk.SpeechConfig | null = null;

function getSpeechConfig(): sdk.SpeechConfig {
  if (cachedSpeechConfig) return cachedSpeechConfig;
  if (!config.azureSpeechKey || !config.azureSpeechRegion) {
    throw new Error("Azure Speech Key or Region is missing. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeechKey,
    config.azureSpeechRegion,
  );
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  cachedSpeechConfig = speechConfig;
  return speechConfig;
}

// ── Synthesizer pool ────────────────────────────────────────────────────────
//
// LATENCY. The streaming pipeline splits each AI turn at sentence boundaries and
// synthesizes one sentence at a time, so a single panel answer can call this
// service five or six times. Constructing `new sdk.SpeechSynthesizer(...)` per
// call opened a NEW websocket to Azure each time — DNS, TCP, TLS and the service
// handshake — and the very first sentence of every turn paid that cost on the
// critical path to first audio, which is exactly the delay the founder hears as
// "the panel is slow to answer".
//
// A synthesizer can serve many sequential requests over one connection, so idle
// instances are pooled per voice and leased for the duration of a single
// synthesis. Leasing (rather than sharing one global instance) is what keeps
// concurrent sessions from interleaving requests on the same synthesizer, which
// the SDK does not allow.
//
// The pool is deliberately small and self-healing: an instance that errors is
// closed rather than reused, idle instances are evicted after a TTL so a dead
// keep-alive is never handed to a live turn, and any lease failure falls back to
// creating a fresh synthesizer — i.e. the behaviour before pooling.

/** Idle instances kept per voice. Two covers a turn overlapping the next. */
const MAX_IDLE_PER_VOICE = 2;

/**
 * How long an unused synthesizer may sit in the pool. Azure closes idle
 * synthesis connections on its own side; the SDK reconnects transparently, but
 * that reconnect would land on the critical path of whichever turn happened to
 * lease it. Evicting first keeps the pool honest — a leased instance is either
 * genuinely warm or brand new.
 */
const IDLE_TTL_MS = 120_000;

interface PooledSynth {
  synth: sdk.SpeechSynthesizer;
  voice: string;
  idleSince: number;
  /** True when this instance came from the pool rather than being just created. */
  reused: boolean;
}

const idlePool = new Map<string, PooledSynth[]>();

/** Per-voice config so the PLAIN-TEXT fallback speaks in the right voice too. */
const voiceConfigs = new Map<string, sdk.SpeechConfig>();

function getVoiceConfig(voice: string): sdk.SpeechConfig {
  const existing = voiceConfigs.get(voice);
  if (existing) return existing;

  // Ensures credentials exist and fails identically to before when they don't.
  getSpeechConfig();
  const cfg = sdk.SpeechConfig.fromSubscription(
    config.azureSpeechKey!,
    config.azureSpeechRegion!,
  );
  cfg.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  // Previously the voice was set only inside the SSML, so when SSML synthesis
  // failed and the plain-text retry ran, Azure used the subscription's DEFAULT
  // voice — every panelist fell back to the same voice. Pinning it here means
  // the retry keeps the panelist's identity.
  cfg.speechSynthesisVoiceName = voice;
  voiceConfigs.set(voice, cfg);
  return cfg;
}

function closeQuietly(synth: sdk.SpeechSynthesizer): void {
  try {
    synth.close();
  } catch {
    /* already closed — nothing to do */
  }
}

function createSynth(voice: string): PooledSynth {
  const synth = new sdk.SpeechSynthesizer(getVoiceConfig(voice));
  // Open the websocket now instead of on the first synthesis request, so the
  // handshake overlaps whatever the caller does next rather than delaying audio.
  try {
    sdk.Connection.fromSynthesizer(synth).openConnection();
  } catch {
    /* prewarm is best-effort; the SDK connects on demand anyway */
  }
  return { synth, voice, idleSince: 0, reused: false };
}

function acquireSynth(voice: string, forceFresh = false): PooledSynth {
  if (!forceFresh) {
    const bucket = idlePool.get(voice);
    while (bucket && bucket.length > 0) {
      const candidate = bucket.pop()!;
      if (Date.now() - candidate.idleSince <= IDLE_TTL_MS) {
        candidate.reused = true;
        return candidate;
      }
      closeQuietly(candidate.synth); // expired — don't hand out a stale socket
    }
  }
  return createSynth(voice);
}

function releaseSynth(lease: PooledSynth): void {
  const bucket = idlePool.get(lease.voice) || [];
  if (bucket.length >= MAX_IDLE_PER_VOICE) {
    closeQuietly(lease.synth);
    return;
  }
  lease.idleSince = Date.now();
  lease.reused = false;
  bucket.push(lease);
  idlePool.set(lease.voice, bucket);
}

/** A failed or timed-out instance never goes back in the pool. */
function discardSynth(lease: PooledSynth): void {
  closeQuietly(lease.synth);
}

/**
 * Open connections ahead of a session so the first spoken line doesn't pay the
 * handshake. Fire-and-forget: failures are irrelevant because the pool falls
 * back to on-demand creation.
 */
export function prewarmVoices(speakers: string[]): void {
  if (!isTtsConfigured()) return;
  const voices = new Set(speakers.map((s) => resolveVoiceName(s)));
  for (const voice of voices) {
    try {
      const bucket = idlePool.get(voice);
      if (bucket && bucket.length > 0) continue; // already warm
      releaseSynth(createSynth(voice));
    } catch {
      /* best effort */
    }
  }
}

/** Escape text for safe inclusion inside SSML. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(text: string, voiceName: string): string {
  const safeText = escapeSsml(text);
  const safeVoice = escapeSsml(voiceName);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
  <voice name="${safeVoice}">
    <mstts:express-as style="chat">
      ${safeText}
    </mstts:express-as>
  </voice>
</speak>`;
}

function synthesizeWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TTS timed out after ${ms}ms`)), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** One synthesis attempt on a leased synthesizer. */
async function synthesizeOnce(
  text: string,
  voice: string,
  useSsml: boolean,
  forceFresh = false,
): Promise<ArrayBuffer> {
  const lease = acquireSynth(voice, forceFresh);
  const wasReused = lease.reused;
  let succeeded = false;

  try {
    const audio = await synthesizeWithTimeout(
      new Promise<ArrayBuffer>((resolve, reject) => {
        const onResult = (result: sdk.SpeechSynthesisResult) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(result.audioData);
          } else {
            reject(
              new Error(
                result.errorDetails ||
                  `Speech synthesis failed (reason: ${sdk.ResultReason[result.reason]})`,
              ),
            );
          }
        };
        const onError = (error: string) => reject(new Error(error));

        if (useSsml) {
          lease.synth.speakSsmlAsync(buildSsml(text, voice), onResult, onError);
        } else {
          lease.synth.speakTextAsync(text, onResult, onError);
        }
      }),
      SYNTHESIS_TIMEOUT_MS,
    );
    succeeded = true;
    return audio;
  } catch (err) {
    // Tell the caller whether this failure could have been a stale pooled
    // connection, so it only spends a retry when a retry can actually help.
    (err as any).reusedConnection = wasReused;
    throw err;
  } finally {
    if (succeeded) releaseSynth(lease);
    else discardSynth(lease);
  }
}

/**
 * Synthesize speech from text using Microsoft Azure Cognitive Services.
 * Returns raw PCM audio (24 kHz, 16-bit mono).
 */
export async function synthesizeSpeech(text: string, voiceName: string): Promise<ArrayBuffer> {
  const trimmed = text?.trim();
  if (!trimmed) {
    throw new Error("TTS received empty text");
  }
  const voice = voiceName?.trim() || PANELIST_VOICES.Marcus;

  try {
    return await synthesizeOnce(trimmed, voice, true);
  } catch (ssmlErr) {
    // A pooled connection Azure had already dropped fails on send. Retry the
    // SAME (expressive) SSML once on a guaranteed-fresh synthesizer — but only
    // when a reused connection was actually involved, so a genuine SSML
    // rejection still falls straight through to plain text instead of paying an
    // extra round trip.
    if ((ssmlErr as any).reusedConnection) {
      try {
        return await synthesizeOnce(trimmed, voice, true, true);
      } catch (retryErr) {
        console.warn(
          "⚠️ SSML synthesis failed after a fresh retry, falling back to plain text:",
          (retryErr as Error).message,
        );
        return synthesizeOnce(trimmed, voice, false, true);
      }
    }

    console.warn("⚠️ SSML synthesis failed, retrying with plain text:", (ssmlErr as Error).message);
    return synthesizeOnce(trimmed, voice, false, true);
  }
}

export function isTtsConfigured(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

/** Startup health check — validates Azure Speech credentials. */
export async function checkTtsStatus(): Promise<void> {
  if (!isTtsConfigured()) {
    console.error("\n🚨 WARNING: AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is missing!");
    console.error("👉 Voice output will not work until both are set in your cloud environment.\n");
    return;
  }

  try {
    await synthesizeSpeech("Ready.", PANELIST_VOICES.Marcus);
    console.log(
      `\n🟢 Azure TTS Status Check: Connection successful (region: ${config.azureSpeechRegion})!\n`,
    );
  } catch (err: any) {
    console.error("\n⚠️ Azure TTS startup check failed:", err.message);
    console.error(
      "👉 Verify AZURE_SPEECH_KEY matches the resource in region",
      config.azureSpeechRegion,
      "\n",
    );
  }
}
