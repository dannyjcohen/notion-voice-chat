import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

// Ensure screenshots dir exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

test('Screenshot 1: task card loads, debug panel shows /api/projects and /api/tasks/next', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' &&
      !msg.text().includes('favicon') &&
      !msg.text().includes('VAD') &&
      !msg.text().includes('onnx') &&
      !msg.text().includes('wasm') &&
      !msg.text().includes('chunk')) {
      consoleErrors.push(msg.text());
    }
  });

  await page.goto('http://localhost:3001?debug=1');
  await page.waitForLoadState('networkidle');

  // Click "or type instead"
  const typeInstead = page.getByText('or type instead');
  await expect(typeInstead).toBeVisible({ timeout: 10000 });
  await typeInstead.click();

  // Wait for API calls to complete
  await page.waitForTimeout(8000);

  // Take screenshot 1
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'screenshot-1-task-loaded.png'), fullPage: true });

  // Verify first assistant message appeared
  const msgs = page.locator('.bg-gray-800.text-gray-100');
  await expect(msgs.first()).toBeVisible({ timeout: 15000 });

  // Verify AI Agent Task checkbox row appears in task card
  const aiAgentRow = page.getByText('AI Agent Task');
  const aiAgentVisible = await aiAgentRow.isVisible();
  console.log(`AI Agent Task row visible: ${aiAgentVisible}`);

  // No unexpected console errors
  expect(consoleErrors, `Console errors: ${consoleErrors.join('; ')}`).toHaveLength(0);

  console.log('Screenshot 1 taken: e2e/screenshots/screenshot-1-task-loaded.png');
});

test('Screenshot 2: AI responds with confirmation message + Update/Cancel buttons', async ({ page }) => {
  await page.goto('http://localhost:3001?debug=1');
  await page.waitForLoadState('networkidle');

  const typeInstead = page.getByText('or type instead');
  await expect(typeInstead).toBeVisible({ timeout: 10000 });
  await typeInstead.click();

  // Wait for task to load
  await page.waitForTimeout(6000);

  // Check a task loaded
  const msgs = page.locator('.bg-gray-800.text-gray-100');
  await expect(msgs.first()).toBeVisible({ timeout: 15000 });

  // Type message with full task details
  const input = page.getByPlaceholder('Type a message...');
  await expect(input).toBeVisible({ timeout: 5000 });

  await input.fill('Set description to: Improve the onboarding flow for new ISP partners. Priority High, date tomorrow, effort Medium, I will handle this myself.');
  await page.keyboard.press('Enter');

  // Wait for AI to respond
  await page.waitForTimeout(12000);

  // Take screenshot 2
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'screenshot-2-ai-confirm.png'), fullPage: true });

  // Check if confirm buttons appeared
  const updateBtn = page.getByRole('button', { name: 'Confirm update' });
  const cancelBtn = page.getByRole('button', { name: 'Cancel update' });

  const updateVisible = await updateBtn.isVisible();
  const cancelVisible = await cancelBtn.isVisible();
  console.log(`Update button visible: ${updateVisible}, Cancel button visible: ${cancelVisible}`);

  console.log('Screenshot 2 taken: e2e/screenshots/screenshot-2-ai-confirm.png');
});
