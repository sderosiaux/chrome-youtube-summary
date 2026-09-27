import test from 'node:test';
import assert from 'node:assert/strict';

function area(initial = {}) {
  const data = { ...initial };
  return { data, access: '', async setAccessLevel({ accessLevel }) { this.access = accessLevel; },
    async get(keys) { return Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])); },
    async set(values) { Object.assign(data, values); }, async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; } };
}
test('legacy secrets migrate before sync deletion; preferences and unrelated data survive', async () => {
  const storage = { local: area(), sync: area({ openaiApiKey: 'old-key', customPrompt: 'custom', unrelated: 'keep' }), session: area() };
  globalThis.chrome = { storage };
  const module = await import('../storage.js?migration');
  const settings = await module.getSettings();
  assert.equal(settings.apiKey, 'old-key');
  assert.equal(settings.customPrompt, 'custom');
  assert.equal(settings.rememberKey, true);
  assert.deepEqual(storage.sync.data, { unrelated: 'keep' });
  assert.equal(storage.local.access, 'TRUSTED_CONTEXTS');
  await module.saveSettings({ apiKey: 'new-key', rememberKey: false, customPrompt: 'changed', detail: 'short' });
  assert.equal(storage.local.data.openaiApiKey, undefined);
  assert.equal(storage.session.data.openaiApiKey, 'new-key');
  await Promise.all([module.writeCache('summary:a', { text: 'A' }), module.writeCache('summary:b', { text: 'B' })]);
  assert.equal((await module.readCache('summary:a')).text, 'A');
  assert.equal((await module.readCache('summary:b')).text, 'B');
  await module.clearCache();
  assert.equal((await module.getSettings()).apiKey, 'new-key');
  assert.equal((await module.getSettings()).customPrompt, 'changed');
});
test('cache identity changes with content, prompt, mode and detail', async () => {
  const { cacheKey } = await import('../storage.js');
  const input = { metadata: { videoId: 'abcdefghijk', title: 'Title' }, segments: [{ start: 1, text: 'A' }], mode: 'summary', detail: 'short', customPrompt: '' };
  const a = await cacheKey(input);
  for (const change of [{ customPrompt: 'new' }, { mode: 'qa' }, { detail: 'deep' }, { segments: [{ start: 1, text: 'B' }] }]) assert.notEqual(await cacheKey({ ...input, ...change }), a);
});
