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

  const formData = await request.formData();
  const audioBlob = formData.get('audio') as File | null;

  if (!audioBlob) {
    return new Response(
      JSON.stringify({ error: 'No audio file provided. Send a multipart form with an "audio" field.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Guard against empty or near-empty audio (too short to contain real speech)
  if (audioBlob.size < 1000) {
    return Response.json({ transcript: '' });
  }

  // iOS Safari sends audio/mp4, desktop Chrome sends audio/webm
  // Whisper accepts both — just need correct file extension
  const mimeType = audioBlob.type;
  const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
  const filename = `audio.${ext}`;

  // Convert the File to a format OpenAI SDK accepts
  const buffer = await audioBlob.arrayBuffer();
  const file = new File([buffer], filename, { type: mimeType });

  try {
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });
    return Response.json({ transcript: transcription.text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[transcribe] Whisper error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
