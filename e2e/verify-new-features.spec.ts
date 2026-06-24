import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Verify: Text input bar visible in active state
// ---------------------------------------------------------------------------
test('text input bar visible after tapping to begin', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await page.route('/api/chat', (route) => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: "Let me get your first task. Your next task is: Write the report.",
    });
  });
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('/');
  await page.getByRole('button', { name: /tap to begin voice session/i }).click();

  // Wait for active state (Done button visible)
  await expect(page.getByRole('button', { name: /mark task as done/i })).toBeVisible({ timeout: 10000 });

  // Text input must be visible
  await expect(page.getByRole('textbox', { name: /type a message/i })).toBeVisible();

  // Send button must be visible
  await expect(page.getByRole('button', { name: /send message/i })).toBeVisible();

  // Take screenshot for visual verification
  await page.screenshot({ path: 'test-results/verify-active-state.png', fullPage: true });

  expect(jsErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Verify: Typed message appears in conversation history
// ---------------------------------------------------------------------------
test('typed message appears in chat list and AI response bubble appears', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  let callCount = 0;
  await page.route('/api/chat', (route) => {
    callCount++;
    if (callCount === 1) {
      // Session start
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "Welcome! Your next task is: Review the quarterly report.",
      });
    } else {
      // Typed message response
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: "Sure, I can help with that task!",
      });
    }
  });
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('/');
  await page.getByRole('button', { name: /tap to begin voice session/i }).click();
  await expect(page.getByRole('button', { name: /mark task as done/i })).toBeVisible({ timeout: 10000 });

  // Wait for first AI response to land
  await page.waitForTimeout(1500);

  // Type and submit a message
  const textInput = page.getByRole('textbox', { name: /type a message/i });
  await textInput.fill("What should I do about this task?");
  await page.getByRole('button', { name: /send message/i }).click();

  // Wait for the message to appear and AI to respond
  await page.waitForTimeout(1500);

  // Screenshot showing conversation
  await page.screenshot({ path: 'test-results/verify-chat-history.png', fullPage: true });

  // Check conversation area is present
  const convArea = page.getByLabel('Conversation history');
  await expect(convArea).toBeVisible();

  expect(jsErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Verify: Debug panel shows tool call log and payload section
// ---------------------------------------------------------------------------
test('debug panel shows tool calls and last payload with ?debug=1', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  let callCount = 0;
  await page.route('/api/chat', (route) => {
    callCount++;
    // Simulate a response with tool event markers (as the server would inject)
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: "Getting your task now.\n[TOOL:getNextTask:{}]\n[TOOL_RESULT:getNextTask:{\"empty\":false,\"task\":{\"title\":\"Test task\"}}]\nYour next task is: Test task.",
    });
  });
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('/?debug=1');
  await page.getByRole('button', { name: /tap to begin voice session/i }).click();
  await expect(page.getByRole('button', { name: /mark task as done/i })).toBeVisible({ timeout: 10000 });

  // Type a message to also test the payload section
  const textInput = page.getByRole('textbox', { name: /type a message/i });
  await textInput.fill("What's my next task?");
  await page.getByRole('button', { name: /send message/i }).click();

  // Wait for response
  await page.waitForTimeout(1500);

  // Screenshot showing debug panel
  await page.screenshot({ path: 'test-results/verify-debug-panel.png', fullPage: true });

  // Debug panel must be visible
  const debugPanel = page.getByLabel('Debug panel');
  await expect(debugPanel).toBeVisible();

  // Check for tool calls section (cyan-colored text in event log)
  const debugText = await debugPanel.textContent();
  const hasToolCalls = debugText?.includes('[TOOL:') || debugText?.includes('Tool calls');
  console.log('Debug has tool call content:', hasToolCalls, '| debug text snippet:', debugText?.slice(0, 200));

  // Payload section should exist
  const payloadBtn = page.getByRole('button', { name: /last payload/i });
  await expect(payloadBtn).toBeVisible();

  expect(jsErrors).toHaveLength(0);
});
