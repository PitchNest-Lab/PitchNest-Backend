import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env";
import { resolveSpeechLocale, FALLBACK_SPEECH_LOCALE } from "./speechLocale.ts";

export function hasAzureSttConfig(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

export interface StreamingRecognizer {
  pushAudio: (pcm16: Buffer) => void;
  stop: () => void;
}

export interface RecognizerOptions {
  /** Regional English model requested for this session, e.g. "en-NG". */
  locale?: string;
  /** Names and terms to bias recognition towards (business name, deck terms). */
  phrases?: string[];
}

/**
 * Silence (ms) that ends an utterance. Azure's default (~500 ms) split
 * founders who pause mid-thought, which is common for accented and
 * second-language speakers, so the panel answered half sentences. Override
 * with STT_SEGMENTATION_SILENCE_MS.
 */
const SEGMENTATION_SILENCE_MS = (() => {
  const v = Number(process.env.STT_SEGMENTATION_SILENCE_MS);
  return Number.isFinite(v) && v >= 100 && v <= 5000 ? Math.round(v) : 800;
})();

type ActiveRecognizer = {
  locale: string;
  recognizer: sdk.SpeechRecognizer;
  pushStream: sdk.PushAudioInputStream;
};

function closeQuietly(r: ActiveRecognizer | null) {
  if (!r) return;
  const done = () => {
    try {
      r.pushStream.close();
      r.recognizer.close();
    } catch {
      /* already closed */
    }
  };
  try {
    r.recognizer.stopContinuousRecognitionAsync(done, done);
  } catch (e) {
    console.error("[stt] error stopping:", e);
  }
}

/**
 * Starts a continuous Azure Speech recognizer fed by a push stream.
 * Call pushAudio() with raw 16kHz mono PCM16 buffers as they arrive.
 * onFinalText fires once per recognized utterance (final result only). It
 * receives the recognized text plus the recognizer's confidence (0..1) for the
 * top hypothesis, so the caller can ask the founder to repeat low-confidence
 * (likely mis-transcribed) input instead of answering garbage.
 *
 * The session's regional English model comes from options.locale (validated
 * against SPEECH_LOCALES), else AZURE_SPEECH_DEFAULT_LOCALE, else en-US. If a
 * regional model fails before anything was recognised (e.g. it is not offered
 * in this Azure region), the recognizer restarts once on en-US so the session
 * still works.
 */
export function createStreamingRecognizer(
  onFinalText: (text: string, confidence: number) => void,
  onPartialText?: (text: string) => void,
  options: RecognizerOptions = {},
): StreamingRecognizer | null {
  if (!hasAzureSttConfig()) {
    console.warn("[stt] Azure Speech not configured — server STT disabled");
    return null;
  }

  const phrases = options.phrases || [];
  let current: ActiveRecognizer | null = null;
  let stopped = false;
  let recognizedAny = false;
  let fellBack = false;

  const start = (locale: string): ActiveRecognizer => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      config.azureSpeechKey,
      config.azureSpeechRegion,
    );
    speechConfig.speechRecognitionLanguage = locale;
    // Detailed output so each final result carries an NBest array with a per-
    // utterance Confidence score (used to detect likely mis-transcriptions).
    speechConfig.outputFormat = sdk.OutputFormat.Detailed;
    speechConfig.setProperty(
      sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
      String(SEGMENTATION_SILENCE_MS),
    );

    const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
    const pushStream = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    const active: ActiveRecognizer = { locale, recognizer, pushStream };

    if (phrases.length > 0) {
      const grammar = sdk.PhraseListGrammar.fromRecognizer(recognizer);
      for (const p of phrases) grammar.addPhrase(p);
    }

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
          recognizedAny = true;
          console.log(`[stt] recognized (${locale}, conf ${confidence.toFixed(2)}):`, text);
          onFinalText(text, confidence);
        }
      }
    };

    recognizer.canceled = (_s, e) => {
      console.error(`[stt] canceled (${locale}):`, e.errorDetails);
      if (
        e.reason === sdk.CancellationReason.Error &&
        !stopped &&
        !recognizedAny &&
        !fellBack &&
        locale !== FALLBACK_SPEECH_LOCALE &&
        current === active
      ) {
        fellBack = true;
        console.warn(
          `[stt] ${locale} failed before any speech was recognised — falling back to ${FALLBACK_SPEECH_LOCALE}`,
        );
        closeQuietly(active);
        current = start(FALLBACK_SPEECH_LOCALE);
      }
    };

    recognizer.sessionStopped = () => {
      console.log(`[stt] session stopped (${locale})`);
    };

    recognizer.startContinuousRecognitionAsync(
      () =>
        console.log(
          `[stt] continuous recognition started (${locale}, ${phrases.length} phrases, ${SEGMENTATION_SILENCE_MS}ms segmentation)`,
        ),
      (err) => console.error(`[stt] failed to start (${locale}):`, err),
    );

    return active;
  };

  current = start(resolveSpeechLocale(options.locale, config.azureSpeechDefaultLocale));

  return {
    pushAudio: (pcm16: Buffer) => {
      if (stopped || !current) return;
      const arrayBuf = pcm16.buffer.slice(
        pcm16.byteOffset,
        pcm16.byteOffset + pcm16.byteLength,
      );
      current.pushStream.write(arrayBuf as ArrayBuffer);
    },
    stop: () => {
      stopped = true;
      closeQuietly(current);
      current = null;
    },
  };
}
