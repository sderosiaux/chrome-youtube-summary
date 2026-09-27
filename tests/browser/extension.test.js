import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { summary, qa, segments, videoHTML, sse } from '../fixtures.js';

test('installed extension: reading, safety and request lifecycle', { timeout: 120_000 }, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'yt-summary-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1440, height: 1050 },
    args: [`--disable-extensions-except=${process.cwd()}`, `--load-extension=${process.cwd()}`],
  });
  t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ openaiApiKey: 'sk-test-not-a-real-key', settings: { detail: 'detailed', customPrompt: 'CUSTOM_PROMPT_TEST : organise en En bref, À retenir et Pour approfondir.' } });
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let calls = [];
  let respond = async request => sse(request.instructions.includes('Construis des questions-réponses') ? qa : summary);
  await context.route('https://api.openai.com/v1/responses', async route => {
    const request = route.request().postDataJSON();
    calls.push(request);
    try { await route.fulfill({ contentType: 'text/event-stream', body: await respond(request) }); } catch {}
  });
  await context.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: videoHTML(new URL(route.request().url()).searchParams.get('v') || 'abcdefghijk') }));
  async function openVideo(id = 'abcdefghijk') {
    const page = await context.newPage();
    await page.goto(`https://www.youtube.com/watch?v=${id}`);
    await page.getByRole('button', { name: 'Résumer la vidéo', exact: true }).click();
    const reader = await waitReader(page);
    return { page, reader };
  }
  const complete = reader => reader.waitForFunction(() => document.querySelector('#status').textContent.includes('sur cet appareil'));
  await t.test('Luna, custom prompt, Markdown, timestamps, cache, copying and responsive layout', async () => {
    const { page, reader } = await openVideo();
    await complete(reader);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'gpt-6-luna');
    assert.match(calls[0].instructions, /CUSTOM_PROMPT_TEST/);
    assert.equal(await reader.locator('#article ol > li').count(), 3);
    assert.equal(await reader.locator('#article ul ul li').count(), 2);
    assert.equal(await reader.locator('#article .timestamp').count(), 3);
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/reader-desktop.png' });
    await page.setViewportSize({ width: 500, height: 850 });
    await page.screenshot({ path: 'test-results/reader-narrow.png' });
    assert.equal(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await reader.getByRole('tab', { name: 'Transcription', exact: true }).click();
    await reader.locator('#search').fill('archive');
    assert.equal(await reader.locator('.transcript-row').count(), 1);
    assert.match(await reader.locator('.transcript-row').textContent(), /03:12/);
    await reader.locator('#close').click();
    await page.getByRole('button', { name: 'Résumer la vidéo', exact: true }).click();
    await page.waitForFunction(() => Boolean(document.getElementById('yt-summary-reader')));
    const reopened = await waitReader(page);
    await complete(reopened);
    assert.equal(calls.length, 1, 'reopening does not pay again');
    await reopened.getByRole('tab', { name: 'Résumé', exact: true }).focus();
    await reopened.press('#tab-summary', 'ArrowRight');
    assert.equal(await reopened.locator('#tab-qa').getAttribute('aria-selected'), 'true');
    await complete(reopened);
    assert.equal(calls.length, 2);
    await reopened.locator('#close').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'yt-summary-fab');
    await page.close();
  });
  await t.test('late Q&A cannot overwrite another tab and duplicate clicks send one request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    respond = async request => {
      if (request.instructions.includes('Construis des questions-réponses')) { await gate; return sse(qa); }
      return sse(summary);
    };
    const { page, reader } = await openVideo('bcdefghijkl');
    await complete(reader);
    const before = calls.length;
    await reader.locator('#tab-qa').click();
    await reader.waitForFunction(() => document.querySelector('#status').textContent.includes('Luna rédige'));
    await reader.locator('#tab-summary').click();
    await reader.locator('#tab-qa').click();
    await reader.locator('#tab-summary').click();
    release();
    await reader.waitForTimeout(150);
    assert.equal(calls.length, before + 1);
    assert.match(await reader.locator('#article').textContent(), /Stripe utilise Temporal/);
    assert.doesNotMatch(await reader.locator('#article').textContent(), /Pourquoi utiliser des workflows durables/);
    await page.close();
  });
  await t.test('cancelling before extraction finishes prevents the OpenAI call', async () => {
    respond = async () => sse(summary);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let requested;
    const extracting = new Promise(resolve => { requested = resolve; });
    const handler = async route => {
      requested();
      await gate;
      await route.fulfill({ json: { actions: segments.map(s => ({ transcriptSegmentRenderer: s })) } }).catch(() => {});
    };
    await context.route('https://www.youtube.com/youtubei/**', handler);
    const page = await context.newPage();
    await page.goto('https://www.youtube.com/watch?v=cdefghijklm');
    await page.evaluate(() => {
      document.querySelector('ytd-item-section-renderer').data = null;
      window.ytcfg = { get: key => ({ INNERTUBE_API_KEY: 'test', INNERTUBE_CLIENT_VERSION: 'test' })[key] };
    });
    const before = calls.length;
    await page.getByRole('button', { name: 'Résumer la vidéo', exact: true }).click();
    const reader = await waitReader(page);
    await extracting;
    await reader.locator('#stop').click();
    await reader.waitForFunction(() => document.querySelector('#status').textContent === 'Génération arrêtée');
    release();
    await reader.waitForTimeout(150);
    assert.equal(calls.length, before);
    await page.close();
    await context.unroute('https://www.youtube.com/youtubei/**', handler);
  });
  await t.test('incomplete output stays visible, is not cached, and is recovered as a draft', async () => {
    respond = async () => sse('## Partiel\n\nUne réponse inachevée.', true);
    const { page, reader } = await openVideo('defghijklmn');
    await reader.waitForFunction(() => document.querySelector('#notice-text').textContent.includes('incomplète'));
    assert.match(await reader.locator('#article').textContent(), /inachevée/);
    const count = calls.length;
    await reader.locator('#close').click();
    await page.getByRole('button', { name: 'Résumer la vidéo', exact: true }).click();
    const reopened = await waitReader(page);
    await reopened.waitForFunction(() => document.querySelector('#status').textContent === 'Texte partiel retrouvé');
    assert.equal(calls.length, count);
    await page.close();
  });
  await t.test('home-to-video SPA navigation injects the button and navigation closes the reader', async () => {
    respond = async () => sse(summary);
    const page = await context.newPage();
    await page.goto('https://www.youtube.com/');
    assert.equal(await page.locator('#yt-summary-fab').count(), 0);
    await page.evaluate(() => { history.pushState({}, '', '/watch?list=x&v=efghijklmno'); document.querySelector('ytd-watch-flexy').setAttribute('video-id', 'efghijklmno'); document.dispatchEvent(new Event('yt-navigate-finish')); });
    await page.getByRole('button', { name: 'Résumer la vidéo', exact: true }).click();
    const reader = await waitReader(page);
    await complete(reader);
    await page.evaluate(() => { document.dispatchEvent(new Event('yt-navigate-start')); history.pushState({}, '', '/watch?v=fghijklmnop'); document.dispatchEvent(new Event('yt-navigate-finish')); });
    assert.equal(await page.locator('#yt-summary-reader').count(), 0);
    await page.close();
  });
  assert.deepEqual(errors, []);
});

async function waitReader(page) {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find(f => f.url().includes('/reader.html'));
    if (frame) { await frame.waitForSelector('#video-title'); return frame; }
    await page.waitForTimeout(20);
  }
  throw new Error('Reader did not load');
}
