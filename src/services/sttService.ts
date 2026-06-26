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
 * onFinalText fires once per recognized utterance (final result only). It
 * receives the recognized text plus the recognizer's confidence (0..1) for the
 * top hypothesis, so the caller can ask the founder to repeat low-confidence
 * (likely mis-transcribed) input instead of answering garbage.
 */
export function createStreamingRecognizer(
  onFinalText: (text: string, confidence: number) => void,
  onPartialText?: (text: string) => void,
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
  // Detailed output so each final result carries an NBest array with a per-
  // utterance Confidence score (used to detect likely mis-transcriptions).
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  // Slightly longer end-of-utterance silence tolerance for pitch speech
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
    "300",
  );

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognizing = (_s, e) => {
    if (e.result.reason === sdk.ResultReason.RecognizingSpeech) {
      const text = e.result.text?.trim();
      if (text && onPartialText) {
        onPartialText(text);
      }
    }
  };

  recognizer.recognized = (_s, e) => {
    if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
      const text = e.result.text?.trim();
      if (text) {
        // Extract the top hypothesis confidence from the detailed JSON result.
        // Defaults to 1 if it can't be read, so behaviour is unchanged when the
        // score is unavailable.
        let confidence = 1;
        try {
          const json = e.result.properties.getProperty(
            sdk.PropertyId.SpeechServiceResponse_JsonResult,
          );
          const best = json ? JSON.parse(json)?.NBest?.[0] : null;
          if (best && typeof best.Confidence === "number") confidence = best.Confidence;
        } catch {
          /* keep default confidence */
        }
        console.log(`[stt] recognized (conf ${confidence.toFixed(2)}):`, text);
        onFinalText(text, confidence);
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
