# PitchNest AI Features

## Gemini Models Used

| Use Case | Model | Reason |
|----------|-------|--------|
| Live chat / AI Judge | **gemini-1.5-flash** | Fast, low latency for real-time Q&A |
| Pitch evaluation / summary | **gemini-1.5-pro** | Better reasoning for structured feedback |

## Setup

Add to `.env`:

```
GEMINI_API_KEY=your_google_gemini_api_key
```

Get a Gemini API key: https://aistudio.google.com/apikey

## Features Implemented

### 1. Investor Personality Engine
- **Aggressive VC** – Interrupts often, challenges burn rate, competition
- **Friendly Angel** – Supportive, clarifying questions
- **Analytical** – Data, metrics, unit economics
- **Technical** – Product, tech stack, scalability
- **Skeptic** – Market size, moat, traction concerns

Pass `investor_archetype` when creating a room to select the persona.

### 2. AI Pitch Evaluation (on session end)
- Overall score, clarity, communication, market fit
- Panel verdict
- AI-written feedback
- Strengths, weaknesses, improvement suggestions

### 3. Pitch Summary Screen (PostPitchAnalytics)
- Overall score
- Panel verdict
- Strengths, weaknesses, AI feedback
- Improvement suggestions
- Pitch Again button

### 4. API

- `POST /api/ai/evaluate` – Body: `{"transcript": "..."}` – Returns full evaluation (Gemini 1.5-pro)

### 5. Real-time Voice Output (Implemented)
- AI responses spoken via browser SpeechSynthesis when "Voice" is on
- Toggle in live room controls (Voice button)
- User typing/sending cancels AI speech (interruption)

### 6. Dynamic Questioning
- Conversation history passed to AI for contextual follow-ups
- Adapts questions based on founder responses

### 7. Streaming Responses (Implemented)
- AI responses stream token-by-token for faster perceived latency
- Frontend shows typing indicator and accumulates chunks in real time

### 8. Voice Input (STT) (Implemented)
- Click mic button to speak; speech is transcribed and sent as a message
- Uses Web Speech API (Chrome, Edge, Safari)

### 9. Roadmap (future)
- Multimodal reasoning: audio, video, slides
- Agent orchestration: multiple AI agents responding to each other
