import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { config } from "../config/env";
import {
  PITCH_PHRASE_LIST,
  resolveSttLocale,
  sttLocaleLabel,
} from "../utils/transcriptionLocales";

export function hasAzureSttConfig(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

export interface StreamingRecognizer {
  pushAudio: (pcm16: Buffer) => void;
  /** Adds session vocabulary after start (e.g. once the deck text resolves).
   *  Phrases added mid-session may only apply from a later utterance. */
  addPhrases: (phrases: string[]) => void;
  stop: () => void;
}

/**
 * Starts a continuous Azure Speech recognizer fed by a push stream.
 * Call pushAudio() with raw 16kHz mono PCM16 buffers as they arrive.
 * onFinalText fires once per recognized utterance (final result only). It
 * receives the recognized text plus the recognizer's confidence (0..1) for the
 * top hypothesis, so the caller can ask the founder to repeat low-confidence
 * (likely mis-transcribed) input instead of answering garbage.
 *
 * `locale` is the founder's chosen recognition language (BCP-47). It defaults to
 * the configured default — en-NG — rather than to US English, because defaulting
 * to en-US is precisely the bug this parameter exists to remove: the panel
 * prompts tolerate Nigerian English, but the recognizer previously did not, and
 * mis-transcription is scored as though the founder actually said it. Any value
 * outside the supported allowlist is coerced to the default rather than passed
 * to Azure, where it would fail every session.
 */
export function createStreamingRecognizer(
  onFinalText: (text: string, confidence: number) => void,
  onPartialText?: (text: string) => void,
  locale?: string,
  /** This founder's own vocabulary (utils/speechPhrases.ts), added on top of
   *  the shared pitch list. */
  sessionPhrases: string[] = [],
): StreamingRecognizer | null {
  if (!hasAzureSttConfig()) {
    console.warn("[stt] Azure Speech not configured — server STT disabled");
    return null;
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeechKey,
    config.azureSpeechRegion,
  );
  const recognitionLocale = resolveSttLocale(locale, config.sttDefaultLocale);
  speechConfig.speechRecognitionLanguage = recognitionLocale;
  // Detailed output so each final result carries an NBest array with a per-
  // utterance Confidence score (used to detect likely mis-transcriptions).
  speechConfig.outputFormat = sdk.OutputFormat.Detailed;
  // Slightly longer end-of-utterance silence tolerance for pitch speech
  speechConfig.setProperty(
    sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
    "300",
  );

  console.log(
    `[stt] recognizing as ${recognitionLocale} (${sttLocaleLabel(recognitionLocale)})${locale ? "" : " [default]"}`,
  );

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
  const pushStream = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

  // Bias the recognizer toward the vocabulary of pitching. A phrase list biases
  // rather than constrains, so conversational speech is unaffected, but domain
  // tokens stop being mangled — and a mangled METRIC is not cosmetic, it is a
  // wrong number reaching the model that scores the answer. Wrapped because a
  // grammar failure must never cost the founder their session.
  let phraseList: sdk.PhraseListGrammar | null = null;
  try {
    phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
    phraseList.addPhrases([...PITCH_PHRASE_LIST, ...sessionPhrases]);
  } catch (e) {
    console.warn("[stt] phrase list unavailable (non-fatal):", e);
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
        // Never log recognized speech. Founder pitches routinely contain
        // confidential company, customer, revenue and fundraising information.
        onFinalText(text, confidence);
      }
    } else if (e.result.reason === sdk.ResultReason.NoMatch) {
      // Speech was heard but no words came back, so the panel never replies
      // and the founder is left waiting. Logged (there is no text to leak) so a
      // missed answer can be told apart from silence; silence timeouts are
      // routine during pauses and stay quiet.
      const reason = sdk.NoMatchDetails.fromResult(e.result).reason;
      if (reason !== sdk.NoMatchReason.InitialSilenceTimeout) {
        console.warn(`[stt] speech heard but not recognized (${sdk.NoMatchReason[reason]}, ${recognitionLocale})`);
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
    addPhrases: (phrases: string[]) => {
      if (!phraseList || phrases.length === 0) return;
      try {
        phraseList.addPhrases(phrases);
      } catch (e) {
        console.warn("[stt] could not extend phrase list (non-fatal):", e);
      }
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
