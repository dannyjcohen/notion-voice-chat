# notion-voice-chat

Voice-first AI agent for reviewing and managing Notion tasks.

## Stack

- **Framework:** Next.js 15+ (App Router, TypeScript)
- **Styling:** Tailwind CSS
- **LLM:** OpenRouter via Vercel AI SDK (`ai` package + `@openrouter/ai-sdk-provider`)
- **STT:** OpenAI Whisper (`openai` package, `whisper-1` model)
- **TTS:** OpenAI TTS (`openai` package, `tts-1` model, `alloy` voice)
- **VAD:** `@ricky0123/vad-react` + `onnxruntime-web` (client-side voice activity detection)
- **Notion:** `@notionhq/client` (official Notion JS SDK)

## Running locally

```bash
cp .env.local.example .env.local
# Fill in your env vars (see below)
npm run dev
```

App runs at http://localhost:3000.

## Required environment variables

Copy `.env.local.example` to `.env.local` and fill in:

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key — get from https://openrouter.ai/keys |
| `AI_MODEL` | Model string for OpenRouter (default: `anthropic/claude-sonnet-4-5`) |
| `OPENAI_API_KEY` | OpenAI API key — used for Whisper STT and TTS |
| `NOTION_API_KEY` | Notion integration secret — from https://www.notion.so/my-integrations |
| `NOTION_TASK_DB_ID` | Notion database ID for the task queue (default: `e7870227f50445e49d23e78958bbe61b`) |

Set these same variables in Vercel dashboard under Settings > Environment Variables for production.

## API routes

### POST /api/chat

Vercel AI SDK streaming chat endpoint. Accepts `{ messages: Message[] }` and streams an AI response using OpenRouter. Has `maxSteps: 10` to allow multi-step tool use.

### POST /api/transcribe

Accepts `multipart/form-data` with an `audio` field (File). Calls OpenAI Whisper. Returns `{ transcript: string }`.

Handles iOS Safari (sends `audio/mp4`, uses `.m4a` extension) and desktop Chrome (sends `audio/webm`).

### POST /api/speak

Accepts `{ text: string }`. Calls OpenAI TTS (`tts-1`, voice `alloy`). Returns audio as `audio/mpeg` stream.

## Notion tools (registered in /api/chat)

Four tools are wired into the chat endpoint via Vercel AI SDK `tool()`:

| Tool | What it does |
|---|---|
| `getNextTask` | Queries the Notion DB for the first task where `AI Clean Up Status` is not `Completed` (sorted by created_time ascending). Returns task details or `{ empty: true }`. |
| `markTaskDone` | Sets `AI Clean Up Status = Completed` on a task. |
| `skipTask` | Sets `Date To Work On` to tomorrow (ISO date string). |
| `updateTaskFields` | PATCHes `Task` (title), `Description` (rich_text), and/or `Date To Work On` (date) on a task. |

## Voice loop architecture

1. User taps the button — VAD activates on-device audio detection.
2. When the user stops speaking, VAD fires `onSpeechEnd`.
3. Client sends audio blob to `POST /api/transcribe` to get the transcript.
4. Transcript is appended to messages and sent to `POST /api/chat`.
5. The LLM streams a response, calling Notion tools as needed.
6. The assistant's text response is sent to `POST /api/speak` and audio plays back.
7. Loop continues until user stops or the task queue is empty.

## OpenRouter model swapping

The model is configured via `AI_MODEL` env var. Any OpenRouter-supported model can be used:

```
AI_MODEL=anthropic/claude-sonnet-4-5       # default
AI_MODEL=anthropic/claude-opus-4           # more capable, slower
AI_MODEL=openai/gpt-4o                     # OpenAI option
AI_MODEL=google/gemini-2.5-pro             # Google option
```

The `lib/openrouter.ts` module exports the configured `model` used by the chat route.
