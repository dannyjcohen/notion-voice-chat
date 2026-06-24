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

  // iOS Safari sends audio/mp4, desktop Chrome sends audio/webm
  // Whisper accepts both — just need correct file extension
  const mimeType = audioBlob.type;
  const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
  const filename = `audio.${ext}`;

  // Convert the File to a format OpenAI SDK accepts
  const buffer = await audioBlob.arrayBuffer();
  const file = new File([buffer], filename, { type: mimeType });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  });

  return new Response(
    JSON.stringify({ transcript: transcription.text }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
