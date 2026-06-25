// This route has been retired. TTS is now handled entirely in the browser
// via the Web Speech API (SpeechSynthesis). No network round-trip needed.
export async function POST() {
  return new Response(
    JSON.stringify({
      error: 'This endpoint is retired. TTS is now handled by browser SpeechSynthesis.',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } }
  );
}
