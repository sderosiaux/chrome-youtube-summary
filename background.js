import { initializeStorage } from './storage.js';
import { videoIdFromUrl } from './config.js';
import { extractInPage } from './transcript.js';

initializeStorage().catch(() =>
  console.error('YouTube Summary: migration du stockage impossible.'),
);

function isReader(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url?.startsWith(chrome.runtime.getURL('reader.html') + '?') &&
    Number.isInteger(sender.tab?.id)
  );
}
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  let work;
  if (
    [
      'readerContext',
      'readerExtract',
      'readerCancel',
      'readerClose',
      'readerSeek',
    ].includes(request.action) &&
    isReader(sender)
  ) {
    work = chrome.tabs.sendMessage(sender.tab.id, request, { frameId: 0 });
  } else if (
    request.action === 'extractTranscript' &&
    sender.frameId === 0 &&
    Number.isInteger(sender.tab?.id) &&
    sender.url?.startsWith('https://www.youtube.com/')
  ) {
    // MessageSender.url can retain the document's initial URL after a YouTube SPA navigation.
    work = chrome.tabs
      .get(sender.tab.id)
      .then((tab) => {
        if (videoIdFromUrl(tab.url) !== request.videoId)
          throw new Error('La vidéo a changé. Rouvre les notes.');
        return chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          world: 'MAIN',
          func: extractInPage,
          args: [request.videoId, Boolean(request.useAPI)],
        });
      })
      .then(
        (results) =>
          results?.[0]?.result || {
            error: 'La transcription est inaccessible.',
          },
      );
  } else if (request.action === 'openOptions' && isReader(sender)) {
    work = chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
  } else return false;
  Promise.resolve(work).then(reply, (error) =>
    reply({
      error: error.message || 'La connexion à la vidéo a été interrompue.',
    }),
  );
  return true;
});
async function openReader(tab) {
  if (!videoIdFromUrl(tab?.url)) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.tabs.sendMessage(
      tab.id,
      { action: 'triggerSummary' },
      { frameId: 0 },
    );
  } catch {
    // Existing tabs may predate installation/reload.
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    await chrome.tabs.sendMessage(
      tab.id,
      { action: 'triggerSummary' },
      { frameId: 0 },
    );
  }
}
chrome.action.onClicked.addListener((tab) => openReader(tab).catch(() => {}));
chrome.commands.onCommand.addListener((command) => {
  if (command === 'trigger-summary')
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => openReader(tab))
      .catch(() => {});
});
