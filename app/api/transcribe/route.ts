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

  // Map MIME type to a file extension Whisper recognises.
  // VAD path sends audio/wav; hold-to-speak sends audio/webm (Chrome) or
  // audio/mp4 (iOS Safari).
  const mimeType = audioBlob.type;
  let ext: string;
  if (mimeType.includes('wav')) {
    ext = 'wav';
  } else if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
    ext = 'm4a';
  } else {
    ext = 'webm';
  }
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

    // Quota exceeded — surface as 402 with a clear message rather than 500
    if (message.includes('429') || message.toLowerCase().includes('quota')) {
      return Response.json(
        { error: 'OpenAI quota exceeded. Add credits at platform.openai.com/account/billing.' },
        { status: 402 }
      );
    }

    // Whisper rejects silent or near-silent audio — treat as empty transcript
    // rather than crashing. Common messages: "Audio file is too short",
    // "Invalid file format", "no audio".
    const lc = message.toLowerCase();
    if (
      lc.includes('too short') ||
      lc.includes('no audio') ||
      lc.includes('no speech') ||
      lc.includes('invalid file') ||
      lc.includes('could not process')
    ) {
      console.warn('[transcribe] Treating Whisper rejection as empty transcript:', message);
      return Response.json({ transcript: '' });
    }

    return Response.json({ error: message }, { status: 500 });
  }
}
