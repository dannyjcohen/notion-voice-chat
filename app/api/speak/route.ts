import OpenAI from 'openai';

const VALID_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'] as const;
type Voice = typeof VALID_VOICES[number];

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'OPENAI_API_KEY is not configured.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const body = await request.json() as { text?: string; voice?: string };
  const text = body.text?.trim();
  const voiceInput = body.voice ?? 'nova';
  const voice: Voice = VALID_VOICES.includes(voiceInput as Voice) ? (voiceInput as Voice) : 'nova';

  if (!text) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: text' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(buffer.length),
    },
  });
}
