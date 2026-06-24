import { test, expect } from '@playwright/test';

// Verifies Change 1 (debug bubbles) and Change 2 (no full-screen empty state).
test('debug bubbles appear in chat after sending a message with ?debug=1', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  // Mock /api/speak so audio doesn't block
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('http://localhost:3001/?debug=1');

  // Enter text-only mode
  await page.getByRole('button', { name: /skip microphone and type instead/i }).click();

  const textInput = page.getByRole('textbox', { name: /type a message/i });
  await expect(textInput).toBeVisible({ timeout: 5000 });

  // Send the question
  await textInput.fill("What's my next task?");
  await page.getByRole('button', { name: /send message/i }).click();

  const convArea = page.locator('[aria-label="Conversation history"]');

  // Wait for the assistant's response bubble (bg-gray-800 assistant bubble)
  await page.waitForFunction(
    () => {
      const area = document.querySelector('[aria-label="Conversation history"]');
      if (!area) return false;
      const bubbles = area.querySelectorAll('.bg-gray-800');
      return bubbles.length > 0 && (bubbles[0].textContent?.trim().length ?? 0) > 10;
    },
    { timeout: 30000 }
  );

  // Take a screenshot
  await page.screenshot({ path: 'test-results/debug-bubbles.png', fullPage: true });

  // Check that debug bubbles (bg-teal-950) appear in the chat
  const debugBubbles = convArea.locator('pre.bg-teal-950');
  const debugCount = await debugBubbles.count();
  console.log(`Debug bubbles found: ${debugCount}`);

  // There should be at least 1 debug bubble
  expect(debugCount).toBeGreaterThan(0);

  // Log debug bubble content for inspection
  for (let i = 0; i < debugCount; i++) {
    const text = await debugBubbles.nth(i).textContent();
    console.log(`Debug bubble [${i}]: ${text?.slice(0, 200)}`);
  }

  // At least one debug bubble should mention /api/chat (summary) or be a tool/error bubble
  const allDebugText = await convArea.locator('pre.bg-teal-950').allTextContents();
  const hasApiOrErrorBubble = allDebugText.some(
    (t) => t.includes('/api/chat') || t.includes('⚠') || t.includes('🔧') || t.includes('↩')
  );
  console.log('Has expected debug bubble:', hasApiOrErrorBubble);
  expect(hasApiOrErrorBubble).toBe(true);

  // Change 2: verify there is NO full-screen empty-state overlay
  // (the green checkmark div with "All caught up!" text)
  const emptyOverlay = page.locator('h2:text("All caught up!")');
  await expect(emptyOverlay).not.toBeVisible();

  // Verify no JS errors
  expect(jsErrors).toHaveLength(0);
});

test('empty state: inline message instead of full-screen overlay', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  // Mock /api/chat to return "all caught up" immediately
  await page.route('/api/chat', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: "You're all caught up — no more tasks to review.",
    })
  );

  await page.goto('http://localhost:3001/?debug=1');
  await page.getByRole('button', { name: /skip microphone and type instead/i }).click();

  const textInput = page.getByRole('textbox', { name: /type a message/i });
  await expect(textInput).toBeVisible({ timeout: 5000 });

  await textInput.fill('Any tasks?');
  await page.getByRole('button', { name: /send message/i }).click();

  // Wait for the assistant response to appear
  await page.waitForFunction(
    () => {
      const area = document.querySelector('[aria-label="Conversation history"]');
      if (!area) return false;
      return area.textContent?.includes('caught up') ?? false;
    },
    { timeout: 10000 }
  );

  await page.screenshot({ path: 'test-results/empty-state-inline.png', fullPage: true });

  // There should be NO full-screen overlay (no h2 with "All caught up!")
  const emptyOverlay = page.locator('h2:text("All caught up!")');
  await expect(emptyOverlay).not.toBeVisible();

  // The conversation area should still be visible
  const convArea = page.locator('[aria-label="Conversation history"]');
  await expect(convArea).toBeVisible();

  // The inline "✅ All caught up" message should appear in the chat
  const chatText = await convArea.textContent();
  console.log('Chat text after empty:', chatText?.slice(0, 300));
  expect(chatText).toContain('All caught up');

  // Text input should be disabled (session is empty)
  const sendButton = page.getByRole('button', { name: /send message/i });
  await expect(sendButton).toBeDisabled();

  expect(jsErrors).toHaveLength(0);
});
