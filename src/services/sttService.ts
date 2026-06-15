import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env";

export function hasAzureSttConfig(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

export interface StreamingRecognizer {
  pushAudio: (pcm16: Buffer) => void;
  stop: () => void;
}

/**
 * Starts a continuous Azure Speech recognizer fed by a push stream.
 * Call pushAudio() with raw 16kHz mono PCM16 buffers as they arrive.
 * onFinalText fires once per recognized utterance (final result only).
 */
export function createStreamingRecognizer(
  onFinalText: (text: string) => void,
): StreamingRecognizer | null {
  if (!hasAzureSttConfig()) {
    console.warn("[stt] Azure Speech not configured — server STT disabled");
    return null;
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeechKey,
    config.azureSpeechRegion,
  );
  speechConfig.speechRecognitionLanguage = "en-US";
  // Slightly longer end-of-utterance silence tolerance for pitch speech
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
    "800",
  );

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognized = (_s, e) => {
    if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
      const text = e.result.text?.trim();
      if (text) {
        console.log("[stt] recognized:", text);
        onFinalText(text);
      }
    }
  };

  recognizer.canceled = (_s, e) => {
    console.error("[stt] canceled:", e.errorDetails);
  };

  recognizer.sessionStopped = () => {
    console.log("[stt] session stopped");
  };

  recognizer.startContinuousRecognitionAsync(
    () => console.log("[stt] continuous recognition started"),
    (err) => console.error("[stt] failed to start:", err),
  );

  return {
    pushAudio: (pcm16: Buffer) => {
      const arrayBuf = pcm16.buffer.slice(
        pcm16.byteOffset,
        pcm16.byteOffset + pcm16.byteLength,
      );
      pushStream.write(arrayBuf as ArrayBuffer);
    },
    stop: () => {
      try {
        recognizer.stopContinuousRecognitionAsync(
          () => {
            pushStream.close();
            recognizer.close();
          },
          () => {
            pushStream.close();
            recognizer.close();
          },
        );
      } catch (e) {
        console.error("[stt] error stopping:", e);
      }
    },
  };
}
