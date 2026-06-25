'use client';

import { useState } from 'react';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently ignore
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 text-xs transition-colors border border-gray-700"
      aria-label={label}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}
