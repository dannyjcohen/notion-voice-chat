import { test, expect } from '@playwright/test';

test('fix verification: animation warning gone + TTS toggle visible', async ({ page }) => {
  const consoleMessages: Array<{ type: string; text: string }> = [];

  page.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });

  // 1. Load the idle screen
  await page.goto('http://localhost:3001');
  await expect(page.getByRole('button', { name: /tap to begin/i })).toBeVisible();

  // 2. Click "or type instead" to reach the active screen
  await page.getByRole('button', { name: /type instead/i }).click();
  await page.waitForTimeout(600);

  // 3. Screenshot — should show speaker button in top-right
  await page.screenshot({ path: 'e2e/screenshots/tts-toggle-visible.png', fullPage: true });

  // 4. Verify the TTS toggle button is present
  const ttsBtn = page.getByRole('button', { name: /mute text-to-speech/i });
  await expect(ttsBtn).toBeVisible();

  // 5. Click the toggle — aria-label should switch to "unmute"
  await ttsBtn.click();
  const unmutedBtn = page.getByRole('button', { name: /unmute text-to-speech/i });
  await expect(unmutedBtn).toBeVisible();

  // 6. Screenshot with muted state
  await page.screenshot({ path: 'e2e/screenshots/tts-toggle-muted.png', fullPage: true });

  // 7. Verify NO animation warning in console
  const animationWarnings = consoleMessages.filter(
    (m) => m.text.includes('animation') && m.text.includes('animationDelay')
  );
  expect(
    animationWarnings,
    `Animation conflict warnings found: ${animationWarnings.map((m) => m.text).join('\n')}`
  ).toHaveLength(0);

  // 8. Verify no fatal errors (excluding known-noisy VAD/onnx/favicon noise)
  const fatalErrors = consoleMessages.filter(
    (m) =>
      m.type === 'error' &&
      !m.text.includes('favicon') &&
      !m.text.includes('VAD') &&
      !m.text.includes('onnx') &&
      !m.text.includes('wasm') &&
      !m.text.includes('chunk')
  );
  expect(fatalErrors, `Unexpected console errors:\n${fatalErrors.map((m) => m.text).join('\n')}`).toHaveLength(0);
});
