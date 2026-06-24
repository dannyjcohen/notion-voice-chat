import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack config (Next.js 16 default)
  // An empty turbopack object silences the webpack/turbopack mismatch warning.
  // WASM and fs fallback will be configured here when @ricky0123/vad-react is
  // wired into the UI. For now, leaving empty so the build passes cleanly.
  turbopack: {},
};

export default nextConfig;
