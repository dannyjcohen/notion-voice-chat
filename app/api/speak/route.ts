import OpenAI from 'openai';

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'OPENAI_API_KEY is not configured. Set it in your environment variables.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let text: string;
  try {
    const body = await request.json();
    text = body.text;
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body. Expected { "text": "..." }' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!text || typeof text !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid "text" field in request body.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const mp3Response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
  });

  const audioBuffer = await mp3Response.arrayBuffer();

  return new Response(audioBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(audioBuffer.byteLength),
    },
  });
}
