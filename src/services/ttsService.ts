import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env.ts";

export const PANELIST_VOICES: Record<string, string> = {
  Marcus: "en-US-DavisNeural",
  Sarah: "en-US-AriaNeural",
  Chen: "en-US-JasonNeural",
  Riley: "en-US-JennyNeural",
};

const SYNTHESIS_TIMEOUT_MS = 25_000;

let cachedSpeechConfig: sdk.SpeechConfig | null = null;

function getSpeechConfig(): sdk.SpeechConfig {
  if (!config.azureSpeechKey || !config.azureSpeechRegion) {
    throw new Error("Azure Speech Key or Region is missing. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.");
  }

  if (!cachedSpeechConfig) {
    cachedSpeechConfig = sdk.SpeechConfig.fromSubscription(
      config.azureSpeechKey,
      config.azureSpeechRegion,
    );
    cachedSpeechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  }

  return cachedSpeechConfig;
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

/**
 * Synthesize speech from text using Microsoft Azure Cognitive Services.
 * Returns raw PCM audio (24 kHz, 16-bit mono).
 */
export async function synthesizeSpeech(text: string, voiceName: string): Promise<ArrayBuffer> {
  const trimmed = text?.trim();
  if (!trimmed) {
    throw new Error("TTS received empty text");
  }

  const speechConfig = getSpeechConfig();
  speechConfig.speechSynthesisVoiceName = voiceName;

  const runSynthesis = (useSsml: boolean) =>
    new Promise<ArrayBuffer>((resolve, reject) => {
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

      const onResult = (result: sdk.SpeechSynthesisResult) => {
        synthesizer.close();
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

      const onError = (error: string) => {
        synthesizer.close();
        reject(new Error(error));
      };

      if (useSsml) {
        synthesizer.speakSsmlAsync(buildSsml(trimmed, voiceName), onResult, onError);
      } else {
        synthesizer.speakTextAsync(trimmed, onResult, onError);
      }
    });

  try {
    return await synthesizeWithTimeout(runSynthesis(true), SYNTHESIS_TIMEOUT_MS);
  } catch (ssmlErr) {
    console.warn("⚠️ SSML synthesis failed, retrying with plain text:", (ssmlErr as Error).message);
    return synthesizeWithTimeout(runSynthesis(false), SYNTHESIS_TIMEOUT_MS);
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
