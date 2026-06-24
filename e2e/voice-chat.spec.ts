import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Test 1: Idle screen renders correctly
// ---------------------------------------------------------------------------
test('idle screen renders correctly', async ({ page }) => {
  // Collect console errors so we can report them at the end
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/');

  // Page title
  await expect(page).toHaveTitle(/Notion Voice Chat/);

  // The "Tap to begin" button must be visible
  const tapButton = page.getByRole('button', { name: /tap to begin voice session/i });
  await expect(tapButton).toBeVisible();

  // Dark background — bg-gray-950 computes to rgb(3, 7, 18)
  // We check the outermost container div (first child of body)
  const container = page.locator('div.bg-gray-950').first();
  await expect(container).toBeVisible();
  const bgColor = await container.evaluate((el) =>
    window.getComputedStyle(el).backgroundColor
  );
  // Accept either the exact value or anything that is not white (#ffffff / rgb(255,255,255))
  expect(bgColor).not.toBe('rgb(255, 255, 255)');

  // Report console errors but do not fail the test over them — WASM warnings are expected
  if (consoleErrors.length > 0) {
    console.log('[Test 1] Console errors observed:', consoleErrors);
  }
});

// ---------------------------------------------------------------------------
// Test 2: Tap transitions to active state
// ---------------------------------------------------------------------------
test('tap transitions away from idle screen and triggers /api/chat', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Intercept /api/chat so the 503 response is controlled and we can detect the call
  let chatRequestMade = false;
  await page.route('/api/chat', async (route) => {
    chatRequestMade = true;
    // Return a minimal 503 to simulate missing env vars
    await route.fulfill({ status: 503, body: 'Service Unavailable' });
  });

  await page.goto('/');

  const tapButton = page.getByRole('button', { name: /tap to begin voice session/i });
  await expect(tapButton).toBeVisible();

  // Click — this moves the component out of idle state
  await tapButton.click();

  // The idle button should no longer be visible
  await expect(tapButton).not.toBeVisible({ timeout: 5000 });

  // Wait for the /api/chat request — with a generous timeout because VAD may
  // take a moment to resolve (or error) before sendMessages fires
  await page.waitForFunction(() => true); // flush microtasks
  // Give up to 10 s for the fetch to fire
  await expect
    .poll(() => chatRequestMade, { timeout: 10000, message: 'expected /api/chat to be called' })
    .toBe(true);

  // After a 503, the component transitions to 'unlocked'. The active screen
  // shows Done and Skip buttons.
  const doneButton = page.getByRole('button', { name: /mark task as done/i });
  const skipButton = page.getByRole('button', { name: /skip task to tomorrow/i });
  await expect(doneButton).toBeVisible({ timeout: 5000 });
  await expect(skipButton).toBeVisible({ timeout: 5000 });

  if (consoleErrors.length > 0) {
    console.log('[Test 2] Console errors observed:', consoleErrors);
  }
});

// ---------------------------------------------------------------------------
// Test 3: Done and Skip buttons are visible and clickable without JS crash
// ---------------------------------------------------------------------------
test('Done and Skip buttons are visible and clickable in active state', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // Intercept all three API endpoints that get called
  await page.route('/api/chat', (route) =>
    route.fulfill({ status: 503, body: 'Service Unavailable' })
  );
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 503, body: 'Service Unavailable' })
  );
  await page.route('/api/transcribe', (route) =>
    route.fulfill({ status: 503, body: 'Service Unavailable' })
  );

  await page.goto('/');

  // Tap to enter active state
  const tapButton = page.getByRole('button', { name: /tap to begin voice session/i });
  await tapButton.click();
  await expect(tapButton).not.toBeVisible({ timeout: 5000 });

  // Wait for active-state buttons
  const doneButton = page.getByRole('button', { name: /mark task as done/i });
  const skipButton = page.getByRole('button', { name: /skip task to tomorrow/i });
  await expect(doneButton).toBeVisible({ timeout: 10000 });
  await expect(skipButton).toBeVisible({ timeout: 10000 });

  // Verify text labels (alternative selectors as a sanity check)
  await expect(page.getByRole('button', { name: /mark task as done/i })).toContainText('Done');
  await expect(page.getByRole('button', { name: /skip task to tomorrow/i })).toContainText('Skip');

  // Click Done — intercept the follow-up /api/chat call so it doesn't hang
  await page.route('/api/chat', (route) =>
    route.fulfill({ status: 503, body: 'Service Unavailable' })
  );
  await doneButton.click();

  // The page must still be alive — check body is still rendered
  await expect(page.locator('body')).toBeVisible();

  // No uncaught JS exceptions
  expect(jsErrors).toHaveLength(0);

  if (consoleErrors.length > 0) {
    console.log('[Test 3] Console errors observed:', consoleErrors);
  }
});

// ---------------------------------------------------------------------------
// Test 4: Empty state note
// ---------------------------------------------------------------------------
// The empty state (`voiceState === 'empty'`) is triggered when the AI response
// contains one of the EMPTY_PHRASES (e.g. "no more tasks"). Because the API
// returns 503 locally, the response stream never completes successfully and the
// component stays in 'unlocked' state — detectEmpty() is never called.
//
// Testing this state in isolation requires either:
//   (a) mocking the streaming /api/chat response to return "no more tasks", or
//   (b) direct component-level state injection (not possible in a black-box E2E test).
//
// We implement (a): fake a successful streaming response body.
test('empty state renders when AI signals no tasks remain', async ({ page }) => {
  const jsErrors: string[] = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  // Return a streamed response that contains one of the EMPTY_PHRASES
  await page.route('/api/chat', (route) => {
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      // The body must include a sentence-ending punctuation + an empty phrase
      body: 'No more tasks to review. All done!',
    });
  });

  // Stub speak and transcribe so they don't produce noise
  await page.route('/api/speak', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(0) })
  );

  await page.goto('/');

  const tapButton = page.getByRole('button', { name: /tap to begin voice session/i });
  await tapButton.click();
  await expect(tapButton).not.toBeVisible({ timeout: 5000 });

  // Wait for empty state — heading "All caught up!" should appear
  await expect(page.getByRole('heading', { name: /all caught up/i })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(/no more tasks to review/i)).toBeVisible();

  expect(jsErrors).toHaveLength(0);
});
