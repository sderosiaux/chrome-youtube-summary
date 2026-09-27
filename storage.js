import { MODEL, PROMPT_VERSION, QA_PROMPT_VERSION } from './config.js';

let ready;
export function initializeStorage() {
  return (ready ||= (async () => {
    await Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      chrome.storage.sync.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_CONTEXTS',
      }),
    ]);
    const [legacy, local] = await Promise.all([
      chrome.storage.sync.get(['openaiApiKey', 'customPrompt']),
      chrome.storage.local.get(['openaiApiKey', 'settings']),
    ]);
    const migration = {};
    if (legacy.openaiApiKey && !local.openaiApiKey)
      migration.openaiApiKey = legacy.openaiApiKey;
    if (!local.settings && legacy.customPrompt)
      migration.settings = { customPrompt: legacy.customPrompt };
    if (Object.keys(migration).length)
      await chrome.storage.local.set(migration);
    await chrome.storage.sync.remove(['openaiApiKey', 'customPrompt']);
  })());
}

export async function getSettings() {
  await initializeStorage();
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'openaiApiKey']),
    chrome.storage.session.get('openaiApiKey'),
  ]);
  return {
    detail: 'detailed',
    customPrompt: '',
    ...local.settings,
    apiKey: session.openaiApiKey || local.openaiApiKey || '',
    rememberKey: Boolean(local.openaiApiKey),
  };
}

export async function saveSettings({
  apiKey,
  rememberKey,
  customPrompt,
  detail,
}) {
  await initializeStorage();
  await chrome.storage.local.set({ settings: { customPrompt, detail } });
  if (rememberKey) {
    await chrome.storage.local.set({ openaiApiKey: apiKey });
    await chrome.storage.session.remove('openaiApiKey');
  } else {
    await chrome.storage.session.set({ openaiApiKey: apiKey });
    await chrome.storage.local.remove('openaiApiKey');
  }
}

export async function cacheKey({
  metadata,
  segments,
  mode,
  detail,
  customPrompt,
}) {
  const data = JSON.stringify({
    videoId: metadata.videoId,
    title: metadata.title,
    channel: metadata.channel,
    segments,
    mode,
    detail,
    prompt: mode === 'qa' ? '' : customPrompt,
    model: MODEL,
    version: mode === 'qa' ? QA_PROMPT_VERSION : PROMPT_VERSION,
  });
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return `summary:${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')}`;
}

export async function readCache(key) {
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function writeCache(key, value) {
  // Entries have separate keys so simultaneous videos cannot overwrite each other.
  await chrome.storage.local.set({
    [key]: { ...value, createdAt: Date.now() },
  });
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith('summary:'))
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  let bytes = 0;
  const remove = entries
    .filter((entry, i) => {
      bytes += JSON.stringify(entry).length * 2;
      return i >= 30 || bytes > 3_000_000;
    })
    .map(([k]) => k);
  if (remove.length) await chrome.storage.local.remove(remove);
}

export async function clearCache() {
  for (const area of [chrome.storage.local, chrome.storage.session]) {
    const all = await area.get(null);
    await area.remove(
      Object.keys(all).filter(
        (k) => k.startsWith('summary:') || k.startsWith('draft:'),
      ),
    );
  }
}
