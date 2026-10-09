# Making the live panel feel conversational

**Owner:** AI / ML · **Date:** 9 Oct 2026

The feedback was that the panel "doesn't feel conversational" compared with the best voice-AI products. This doc explains why, and gives a phased plan from cheapest to biggest.

## Why it feels less natural today

The live room is a **cascaded pipeline**: Azure Speech turns speech into text, then the LLM writes a reply, then Azure TTS speaks it, sentence by sentence. It is already well tuned: replies stream, the first sentence is spoken while the rest is still generating, barge-in cuts the panel off, and voices use the "chat" speaking style. Three things still hold it back:

1. **Turn-taking is silence-based.** The system decides the founder has finished purely from a pause. Too short, and it jumps in mid-thought; too long, and it feels laggy. Natural voice agents decide from *meaning* ("is this sentence finished?").
2. **Older voices.** Davis, Aria, Jason and Jenny are standard neural voices. Azure's newer HD voices vary tone and emotion with the content, and some are tuned for conversation.
3. **Latency we haven't measured in production.** Every turn already logs `[turn] first token …ms, first audio …ms`. Natural conversation needs the first audio within roughly a second of the founder stopping.

## Phase 0: measure (this week, no code)

Pull a day of live-service logs and chart `first audio` per turn. Target: median < 1.2 s, 90th percentile < 2 s. If the LLM's first token dominates, try a lighter deployment for live turns (and keep the full model for the report).

## Phase 1: better voices (this week, config only)

Each panelist's voice can now be changed via environment variables, with no deploy needed (`TTS_VOICE_MARCUS`, `TTS_VOICE_SARAH`, `TTS_VOICE_CHEN`, `TTS_VOICE_RILEY`). Invalid names are ignored. If a voice doesn't support our speaking-style tag, synthesis already falls back to plain text in the same voice.

Candidates to A/B on the preview environment (check availability in our Azure Speech region first):

| Panelist | Try | Why |
|---|---|---|
| Marcus | `en-US-Andrew2:DragonHDLatestNeural` | HD voice Microsoft lists as optimised for conversation |
| Sarah | `en-US-Ava:DragonHDLatestNeural` | HD, expressive |
| Chen | `en-US-Andrew:DragonHDLatestNeural` (or another HD male voice) | HD |
| Riley (coach) | `en-US-Emma2:DragonHDLatestNeural` | HD, listed as conversational |
| Optional | `en-NG-AbeoNeural` / `en-NG-EzinneNeural` | Nigerian English voices: a panel that sounds local to our first market |

HD voices can add latency and are only offered in some regions, so compare `first audio` before and after.

## Phase 2: smarter turn-taking (next sprint)

Azure's **Voice Live** service (GA Oct 2025) provides *semantic* end-of-turn detection (`azure_semantic_vad`, which also ignores fillers like "uh" and "hmm"), plus server-side noise suppression and echo cancellation. Microsoft documents that these can be added to an existing app without changing its architecture. Prototype it on the coach (Riley) first, then the panel. Expected result: fewer interruptions of slow or accented speakers *and* faster replies when the founder clearly finishes. That removes today's trade-off between the two.

Until then, the accent PR raises the pause allowance to 800 ms (`STT_SEGMENTATION_SILENCE_MS`). Tune it from real sessions.

## Phase 3: speech-to-speech (evaluate, don't rush)

Voice Live can also run a full speech-to-speech model (`gpt-realtime`) with Azure voices, including HD and custom voices. That is how the most conversational products get sub-second, emotionally aware replies. Open questions before committing:

- **Three panelists, three voices.** Realtime sessions are built around one voice. Confirm we can switch voices per response, or keep the panel cascaded and use realtime for the single-voice coach.
- **Our guardrails.** Pitch memory, the fair-challenge rules, `@@INTEREST` tags, the verdict flow and the report pipeline are all built on text turns. They would need to move to realtime tool calls and events.
- **Cost and latency** compared with the current pipeline. Run `scripts/persona-eval.ts` for quality, plus a latency A/B.

Recommendation: do Phase 0 and Phase 1 now, Phase 2 after Tech Week, and a Phase 3 spike on the coach only.

## Sources
- [Voice Live overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
- [Voice Live how-to (turn detection, voices, models)](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Azure HD voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices)
