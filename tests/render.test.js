import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<article></article>', { url: 'https://extension.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, NodeFilter: dom.window.NodeFilter });
const { renderMarkdown } = await import('../render.js');
const article = document.querySelector('article');

test('nested lists, ordered lists, separators and code render correctly', () => {
  renderMarkdown(article, '## Notes\n\n1. **First**\n   - Child\n2. Second\n\n---\n\n`code`');
  assert.equal(article.querySelectorAll('ol > li').length, 2);
  assert.equal(article.querySelector('ol ul li').textContent, 'Child');
  assert.ok(article.querySelector('hr'));
  assert.equal(article.querySelector('code').textContent, 'code');
});
test('untrusted HTML, event handlers, remote images and script URLs cannot render active content', () => {
  renderMarkdown(article, '<img src="https://evil.test/leak" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n[click](javascript:alert%281%29)\n\n![tracking](https://evil.test/pixel)\n\n<iframe src="https://evil.test"></iframe>');
  assert.equal(article.querySelectorAll('img,script,iframe,[onerror],[onclick]').length, 0);
  assert.equal(article.querySelector('a'), null);
});
test('only timestamps actually present in the transcript become seek controls', () => {
  renderMarkdown(article, '## Topic\n\nClaim [03:12], invented [09:99], and `code [03:12]`.', [{ start: 192, text: 'source' }]);
  assert.equal(article.querySelectorAll('button.timestamp').length, 1);
  assert.equal(article.querySelector('button').dataset.seconds, '192');
});
