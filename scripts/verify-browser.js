// Quick browser verification script — headless Playwright
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleMessages = [];
  const jsErrors = [];

  page.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    jsErrors.push(err.message);
  });

  await page.goto('http://localhost:3001?debug=1', { waitUntil: 'networkidle' });

  // Initial screenshot before clicking
  await page.screenshot({ path: 'C:/xampp/htdocs/dc-projects/notion-voice-chat/test-results/debug-initial.png', fullPage: true });
  console.log('Initial screenshot saved.');

  // Find and click the mic/tap button
  const tapButton = page.getByRole('button', { name: /tap to begin voice session/i });
  const tapVisible = await tapButton.isVisible();
  console.log('Tap button visible:', tapVisible);
  if (tapVisible) {
    await tapButton.click();
    console.log('Clicked tap button.');
  }

  // Wait 5 seconds
  await page.waitForTimeout(5000);

  // Take screenshot after 5s
  await page.screenshot({ path: 'C:/xampp/htdocs/dc-projects/notion-voice-chat/verify-screenshot.png', fullPage: true });
  console.log('Post-click 5s screenshot saved.');

  console.log('\n=== Console output ===');
  for (const msg of consoleMessages) {
    console.log(`[${msg.type}] ${msg.text}`);
  }

  console.log('\n=== JS Errors ===');
  if (jsErrors.length === 0) {
    console.log('None');
  } else {
    for (const e of jsErrors) {
      console.log(e);
    }
  }

  // Check debug panel text
  const bodyText = await page.locator('body').innerText();
  console.log('\n=== Debug panel / body text (first 800 chars) ===');
  console.log(bodyText.slice(0, 800));
  console.log(bodyText.includes('VAD') ? '\n[DEBUG PANEL] VAD content visible' : '\n[DEBUG PANEL] No VAD content found');

  await browser.close();
})().catch((err) => {
  console.error('Playwright script failed:', err);
  process.exit(1);
});
