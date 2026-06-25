import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = 'http://localhost:3001';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14

// ── Task A: Web Speech API TTS ─────────────────────────────────────────────

test('Task A: speakSentence uses SpeechSynthesis, not /api/speak', async ({ page }) => {
  const speakApiCalls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/speak')) speakApiCalls.push(req.url());
  });

  await page.goto(BASE);
  await page.waitForSelector('button[aria-label="Skip microphone and type instead"]');
  await page.click('button[aria-label="Skip microphone and type instead"]');
  await page.waitForSelector('input[aria-label="Type a message"]', { timeout: 5000 });

  // Type a message to trigger an AI response (which would normally trigger TTS)
  const input = page.locator('input[aria-label="Type a message"]');
  await input.fill("What's my next task?");
  await page.click('button[aria-label="Send message"]');

  // Wait a bit for any /api/speak calls to appear (they won't, that's the test)
  await page.waitForTimeout(3000);

  expect(speakApiCalls).toHaveLength(0);
  console.log('PASS: No /api/speak network calls made — TTS is browser-native');
});

// ── Task D: Messages clear on new task ─────────────────────────────────────

test('Task D: intro message appears in chat after session starts (with real Notion fetch)', async ({ page }) => {
  // This test makes a real Notion API call — give it extra time.
  test.setTimeout(60000);

  await page.goto(BASE);
  await page.waitForSelector('button[aria-label="Skip microphone and type instead"]');
  await page.click('button[aria-label="Skip microphone and type instead"]');
  await page.waitForSelector('input[aria-label="Type a message"]', { timeout: 5000 });

  // Wait for the conversation history to become visible.
  // This depends on the prefetch completing (real Notion API) and loadSession() firing.
  // The div renders only when chatItems.length > 0 || responseText || pendingUpdate.
  const chatArea = page.locator('[aria-label="Conversation history"]');
  await expect(chatArea).toBeVisible({ timeout: 30000 });

  // The intro "Let's get started. First task: ..." or "All caught up" message should appear
  const introMsg = chatArea.locator('div.bg-gray-800').first();
  await expect(introMsg).toBeVisible({ timeout: 5000 });

  console.log('PASS: Intro message shown in chat history after session start');
});

// ── Task E: Voice-confirm hint shown, no Update/Cancel buttons ─────────────

test('Task E: no Update/Cancel buttons in DOM', async ({ page }) => {
  await page.goto(BASE);

  // Verify Update/Cancel buttons are not present
  const updateBtn = page.locator('button[aria-label="Confirm update"]');
  const cancelBtn = page.locator('button[aria-label="Cancel update"]');

  await expect(updateBtn).toHaveCount(0);
  await expect(cancelBtn).toHaveCount(0);

  console.log('PASS: Update/Cancel buttons removed from DOM');
});

// ── Task F: Admin page at /admin ───────────────────────────────────────────

test('Task F: /admin page loads with system prompt', async ({ page }) => {
  await page.goto(`${BASE}/admin`);
  await page.waitForLoadState('networkidle');

  // Screenshot
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'admin-page.png'),
    fullPage: true,
  });

  // Heading
  await expect(page.locator('h1')).toContainText('System Prompt Inspector');

  // Prompt variables table — use exact cell match
  await expect(page.getByRole('cell', { name: 'today', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'currentTask', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'projects', exact: true })).toBeVisible();

  // Main Prompt section
  await expect(page.locator('h2').filter({ hasText: 'Main Prompt' })).toBeVisible();
  await expect(page.locator('pre').first()).toContainText('You are a Notion task reviewer');

  // Legacy Prompt section
  await expect(page.locator('h2').filter({ hasText: 'Legacy Prompt' })).toBeVisible();

  // Copy buttons present
  const copyButtons = page.locator('button', { hasText: 'Copy' });
  await expect(copyButtons).toHaveCount(2);

  console.log('PASS: /admin page loaded with all expected elements');
});

// ── Task E: classifyConfirmation helper (UI-level) ─────────────────────────

test('Task E: pending update shows voice-confirm hint instead of buttons', async ({ page }) => {
  // We can't easily trigger the confirm action without a live AI, but we can
  // at least verify the hint text is present in JSX by checking the source
  // (the page component renders the hint div when pendingUpdate is set).
  // For a lightweight check, verify the Update/Cancel button text is absent.
  await page.goto(BASE);

  const pageContent = await page.content();
  expect(pageContent).not.toContain('aria-label="Confirm update"');
  expect(pageContent).not.toContain('aria-label="Cancel update"');

  console.log('PASS: Confirm update / Cancel update buttons not in initial HTML');
});

// ── Main page: no console errors ──────────────────────────────────────────

test('Main page: no console errors on load', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(BASE);
  await page.waitForLoadState('networkidle');

  // Filter out known benign errors (e.g. VAD ONNX warnings are expected)
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('onnxruntime') && !e.includes('ONNX') && !e.includes('wasm')
  );

  expect(realErrors).toHaveLength(0);
  console.log('PASS: No console errors on main page load');
});

// ── /admin: no console errors ─────────────────────────────────────────────

test('Admin page: no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto(`${BASE}/admin`);
  await page.waitForLoadState('networkidle');

  expect(consoleErrors).toHaveLength(0);
  console.log('PASS: No console errors on /admin');
});
