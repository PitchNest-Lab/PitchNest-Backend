import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env.ts";

export const PANELIST_VOICES: Record<string, string> = {
  "Marcus": "en-US-DavisNeural",
  "Sarah": "en-US-AriaNeural",
  "Chen": "en-US-JasonNeural"
};

/**
 * Synthesize speech from text using Microsoft Azure Cognitive Services.
 * Returns an ArrayBuffer containing raw PCM audio (24kHz, 16-bit, Mono).
 */
export async function synthesizeSpeech(text: string, voiceName: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (!config.azureSpeechKey || !config.azureSpeechRegion) {
      return reject(new Error("Azure Speech Key or Region is missing. Check your environment variables."));
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(config.azureSpeechKey, config.azureSpeechRegion);
    speechConfig.speechSynthesisVoiceName = voiceName;
    
    // The frontend currently expects raw PCM. 
    // Gemini Live defaults to 24kHz (or 16kHz). Let's use 24kHz for high quality.
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">
  <voice name="${voiceName}">
    <mstts:express-as style="chat">
      ${text}
    </mstts:express-as>
  </voice>
</speak>`;

    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          synthesizer.close();
          resolve(result.audioData);
        } else {
          synthesizer.close();
          reject(new Error(`Speech synthesis canceled/failed: ${result.errorDetails}`));
        }
      },
      (error) => {
        synthesizer.close();
        reject(error);
      }
    );
  });
}
