import { test, expect } from '@playwright/test';

// End-to-end test that hits the REAL /api/chat endpoint (no mocking).
// Verifies that typing a message returns an actual AI response within 30 seconds.
test('real API: type a message and receive an AI response', async ({ page }) => {
  const jsErrors: string[] = [];
  const consoleMessages: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('console', (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));

  // Mock only /api/speak so audio doesn't block anything
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('/?debug=1');

  // Click "or type instead" to skip the mic/VAD entirely
  // The visible text is "or type instead"; aria-label is "Skip microphone and type instead"
  await page.getByRole('button', { name: /skip microphone and type instead/i }).click();

  // Text input should now be visible (unlocked state)
  const textInput = page.getByRole('textbox', { name: /type a message/i });
  await expect(textInput).toBeVisible({ timeout: 5000 });

  // Type the question
  await textInput.fill('What is my next task?');
  await page.getByRole('button', { name: /send message/i }).click();

  const convArea = page.locator('[aria-label="Conversation history"]');

  // Wait up to 30 seconds for the AI's assistant bubble to appear in the history.
  // The AI response gets committed to messages[] after streaming completes —
  // wait for a div with class containing "bg-gray-800" (assistant bubble style).
  await page.waitForFunction(
    () => {
      const area = document.querySelector('[aria-label="Conversation history"]');
      if (!area) return false;
      // Look for assistant bubble: bg-gray-800 rounded-bl-sm
      const bubbles = area.querySelectorAll('.bg-gray-800');
      return bubbles.length > 0 && (bubbles[0].textContent?.trim().length ?? 0) > 10;
    },
    { timeout: 30000 }
  );

  // Take screenshot with the completed response
  await page.screenshot({ path: 'test-results/real-api-response.png', fullPage: true });

  // Get the conversation content
  const chatText = await convArea.textContent();
  console.log('Conversation content:', chatText?.slice(0, 500));

  // Must contain the user message AND an assistant response
  expect(chatText).toContain('What is my next task?');
  // Response should have some meaningful content (AI discusses a task)
  expect(chatText?.trim().length).toBeGreaterThan(30);

  // No JS errors
  if (jsErrors.length > 0) {
    console.log('JS errors:', jsErrors);
  }
  expect(jsErrors).toHaveLength(0);
});
