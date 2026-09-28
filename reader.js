import {
  buildRequest,
  DETAIL_LEVELS,
  formatTime,
  normalizeSegments,
} from './config.js';
import { generate } from './api.js';
import { generateQA } from './qa.js';
import { getSettings, cacheKey, readCache, writeCache } from './storage.js';
import { renderMarkdown } from './render.js';
import { exportDiagrams, readableDiagramText } from './diagrams.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const videoId = params.get('videoId');
const token = params.get('token');
const states = new Map();
let metadata,
  settings,
  source,
  sourcePromise,
  sourceError,
  closed = false;
let sourceVersion = 0;
let mode = 'summary';
let selectedDetail = 'detailed';
const stateKey = () => `${mode}:${selectedDetail}`;
const busy = (state) => ['preparing', 'generating'].includes(state?.status);
function stateFor(key = stateKey()) {
  if (!states.has(key))
    states.set(key, {
      text: '',
      status: 'idle',
      scroll: 0,
      writeQueue: Promise.resolve(),
    });
  return states.get(key);
}
async function message(action, extra = {}) {
  const result = await chrome.runtime.sendMessage({
    action,
    token,
    videoId,
    ...extra,
  });
  if (result?.cancelled) throw new DOMException('Annulé', 'AbortError');
  if (result?.error) throw new Error(result.error);
  return result;
}
function showMetadata(value) {
  metadata = value;
  $('video-title').textContent = metadata.title;
  document.title = `${metadata.title} — Notes`;
}
async function getSource() {
  if (source) return source;
  if (sourcePromise) return sourcePromise;
  sourceError = null;
  const version = ++sourceVersion;
  sourcePromise = message('readerExtract')
    .then((value) => {
      if (version !== sourceVersion || closed)
        throw new DOMException('Annulé', 'AbortError');
      const segments = normalizeSegments(value?.segments);
      if (!segments.length)
        throw new Error(
          'La transcription est vide. Ouvre-la dans YouTube, puis réessaie.',
        );
      source = { ...value, segments };
      if (value.metadata?.videoId === videoId) showMetadata(value.metadata);
      return source;
    })
    .catch((error) => {
      if (version === sourceVersion) sourceError = error;
      throw error;
    })
    .finally(() => {
      if (version === sourceVersion) {
        sourcePromise = null;
        if (!closed) paint();
      }
    });
  return sourcePromise;
}
function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function drawTranscript() {
  const query = $('search').value.toLocaleLowerCase('fr').trim();
  const rows = (source?.segments || []).filter((s) =>
    s.text.toLocaleLowerCase('fr').includes(query),
  );
  const fragment = document.createDocumentFragment();
  const count = document.createElement('p');
  count.className = 'transcript-count';
  count.textContent = `${rows.length} passage${rows.length === 1 ? '' : 's'}${query ? ' trouvé' + (rows.length === 1 ? '' : 's') : ''}`;
  fragment.append(count);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'no-results';
    empty.textContent = 'Aucun passage ne correspond à cette recherche.';
    fragment.append(empty);
  }
  for (const segment of rows) {
    const row = document.createElement('div');
    row.className = 'transcript-row';
    const time = document.createElement(
      segment.start === null ? 'span' : 'button',
    );
    if (segment.start !== null) {
      time.className = 'timestamp';
      time.dataset.seconds = segment.start;
      time.textContent = formatTime(segment.start);
      time.setAttribute(
        'aria-label',
        `Voir le passage à ${formatTime(segment.start)}`,
      );
    }
    const text = document.createElement('p');
    text.textContent = segment.text;
    row.append(time, text);
    fragment.append(row);
  }
  $('transcript').replaceChildren(fragment);
}
function paint() {
  if (closed) return;
  const transcriptMode = mode === 'transcript';
  const state = stateFor();
  const working = transcriptMode ? Boolean(sourcePromise) : busy(state);
  const hasContent = transcriptMode ? Boolean(source) : Boolean(state.text);
  const error = transcriptMode ? sourceError : state.error;
  $('panel').setAttribute('aria-labelledby', `tab-${mode}`);
  $('panel').setAttribute('aria-busy', String(working));
  $('detail-control').hidden = transcriptMode;
  for (const button of document.querySelectorAll('[data-detail]')) {
    button.setAttribute(
      'aria-pressed',
      String(button.dataset.detail === selectedDetail),
    );
  }
  $('search-control').hidden = !transcriptMode;
  $('article').hidden = transcriptMode || !hasContent;
  $('transcript').hidden = !transcriptMode || !hasContent;
  $('empty').hidden = hasContent;
  $('empty').querySelector('.skeleton').hidden = !working;
  $('empty').querySelector('.eyebrow').textContent = working
    ? 'Préparation des notes'
    : 'Notes de vidéo';
  $('empty').querySelector('h2').textContent = working
    ? 'De la vidéo à l’essentiel.'
    : 'La lecture commence ici.';
  $('empty-text').textContent = working
    ? source
      ? 'Luna organise les idées. Les notes apparaîtront au fil de la génération.'
      : 'Récupération de la transcription…'
    : 'Choisis un format de lecture pour créer les notes.';
  $('source-warning').hidden = !source?.partial;
  const notice =
    error?.message ||
    (state.status === 'cancelled' && !transcriptMode
      ? 'Génération arrêtée. Tu peux conserver le texte partiel ou recommencer.'
      : state.warning);
  $('notice').hidden = !notice;
  $('notice').dataset.kind = error ? 'error' : 'info';
  $('notice-text').textContent = notice || '';
  $('retry').hidden = !notice || working;
  $('configure').hidden = error?.code !== 'auth';
  $('copy').disabled = !hasContent;
  $('copy').textContent =
    $('copy-format').value === 'download' ? 'Télécharger' : 'Copier';
  $('stop').hidden = !working;
  const status = transcriptMode
    ? working
      ? 'Lecture de la transcription…'
      : source
        ? 'Transcription de la vidéo'
        : 'Transcription indisponible'
    : {
        idle: 'Prêt à générer',
        preparing: 'Préparation de la transcription…',
        generating: 'Luna rédige les notes…',
        complete: state.cached
          ? 'Notes retrouvées sur cet appareil'
          : state.persisted
            ? 'Notes enregistrées sur cet appareil'
            : 'Notes prêtes',
        cancelled: 'Génération arrêtée',
        error: 'À vérifier',
        interrupted: 'Texte partiel retrouvé',
      }[state.status];
  $('status').textContent = status || 'Préparation…';
  if (transcriptMode && source) drawTranscript();
  else if (state.text) {
    const focused = document.activeElement?.dataset.seconds;
    renderMarkdown($('article'), state.text, source?.segments);
    if (focused)
      [...$('article').querySelectorAll('[data-seconds]')]
        .find((el) => el.dataset.seconds === focused)
        ?.focus({ preventScroll: true });
  }
}
function persistDraft(state, key) {
  const value = { text: state.text, createdAt: Date.now() };
  state.writeQueue = state.writeQueue
    .then(() => chrome.storage.session.set({ [`draft:${key}`]: value }))
    .catch(() => {});
}
async function startGeneration(force = false) {
  if (!metadata || closed || mode === 'transcript') return;
  const key = stateKey();
  const state = stateFor(key);
  if (busy(state)) return;
  if (
    !force &&
    ['complete', 'interrupted', 'cancelled', 'error'].includes(state.status)
  ) {
    paint();
    return;
  }
  const currentMode = mode;
  const detail = selectedDetail;
  const previous =
    state.status === 'complete'
      ? {
          text: state.text,
          usage: state.usage,
          persisted: state.persisted,
          cached: state.cached,
        }
      : null;
  const controller = new AbortController();
  state.controller = controller;
  state.status = 'preparing';
  state.error = null;
  state.warning = null;
  state.cached = false;
  paint();
  let storageKey;
  let renderTimer;
  let lastSave = 0;
  let receivedText = false;
  try {
    settings = await getSettings();
    controller.signal.throwIfAborted();
    const transcript = await withSignal(getSource(), controller.signal);
    controller.signal.throwIfAborted();
    const input = {
      metadata,
      segments: transcript.segments,
      mode: currentMode,
      detail,
      customPrompt: settings.customPrompt,
    };
    storageKey = await cacheKey(input);
    controller.signal.throwIfAborted();
    if (!force) {
      const cached = await readCache(storageKey);
      controller.signal.throwIfAborted();
      if (cached) {
        Object.assign(state, cached, {
          status: 'complete',
          cached: true,
          persisted: true,
        });
        return;
      }
      const draft = (await chrome.storage.session.get(`draft:${storageKey}`))[
        `draft:${storageKey}`
      ];
      controller.signal.throwIfAborted();
      if (draft?.text) {
        state.text = draft.text;
        state.status = 'interrupted';
        state.warning =
          'Une génération interrompue a été retrouvée. Ce texte est partiel. Réessayer relance une nouvelle requête.';
        return;
      }
    }
    if (!settings.apiKey) {
      const error = new Error(
        'Ajoute ta clé OpenAI dans les paramètres pour générer de nouvelles notes.',
      );
      error.code = 'auth';
      throw error;
    }
    state.status = 'generating';
    if (stateKey() === key) paint();
    const request = buildRequest(input);
    if (transcript.partial)
      request.instructions +=
        '\nLa transcription disponible est potentiellement partielle. Indique cette limite ; ne prétends pas couvrir toute la vidéo.';
    const generateNotes = currentMode === 'qa' ? generateQA : generate;
    const result = await generateNotes({
      apiKey: settings.apiKey,
      request,
      signal: controller.signal,
      onDelta: (text) => {
        if (controller.signal.aborted || closed) return;
        receivedText = true;
        state.text = text;
        if (Date.now() - lastSave > 1000) {
          persistDraft(state, storageKey);
          lastSave = Date.now();
        }
        if (!renderTimer)
          renderTimer = setTimeout(() => {
            renderTimer = null;
            if (stateKey() === key) paint();
          }, 100);
      },
    });
    controller.signal.throwIfAborted();
    Object.assign(state, result, { status: 'complete', persisted: false });
    await state.writeQueue;
    try {
      await writeCache(storageKey, result);
      state.persisted = true;
      await chrome.storage.session.remove(`draft:${storageKey}`);
    } catch {
      state.warning =
        'Les notes sont prêtes, mais leur enregistrement local a échoué. Tu peux les copier.';
    }
  } catch (error) {
    if (state.controller !== controller) return;
    if (previous && !receivedText) {
      Object.assign(state, previous, { status: 'complete' });
      if (controller.signal.aborted || error.name === 'AbortError')
        state.warning =
          'Régénération arrêtée. Les notes précédentes sont conservées.';
      else {
        state.error = error;
        state.warning = 'Les notes précédentes sont conservées.';
      }
    } else if (controller.signal.aborted || error.name === 'AbortError')
      state.status = 'cancelled';
    else {
      state.status = 'error';
      state.error = error;
      state.text = error.partial || state.text;
    }
    if (storageKey && state.text && state.status !== 'complete')
      persistDraft(state, storageKey);
  } finally {
    clearTimeout(renderTimer);
    if (state.controller === controller) {
      state.controller = null;
      if (stateKey() === key) paint();
    }
  }
}
function stop(state = stateFor()) {
  state.controller?.abort();
  // Only abort the shared extraction when no other view still needs it.
  if (
    ![...states.values()].some(
      (s) => s.controller && !s.controller.signal.aborted,
    )
  ) {
    sourceVersion++;
    sourcePromise = null;
    if (!source)
      sourceError = new DOMException(
        'Extraction arrêtée. Tu peux réessayer.',
        'AbortError',
      );
    message('readerCancel').catch(() => {});
    paint();
  }
}
function close() {
  for (const state of states.values()) state.controller?.abort();
  message('readerClose').catch(() => {});
  closed = true;
}
async function selectMode(next) {
  stateFor().scroll = $('reading-area').scrollTop;
  mode = next;
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const selected = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  paint();
  $('reading-area').scrollTop = stateFor().scroll;
  if (mode === 'transcript') {
    try {
      await getSource();
    } catch {}
    paint();
  } else await startGeneration();
}
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => selectMode(tab.dataset.mode));
  tab.addEventListener('keydown', (event) => {
    const tabs = [...document.querySelectorAll('[role=tab]')];
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft')
      index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[index].focus();
    selectMode(tabs[index].dataset.mode);
  });
}
for (const button of document.querySelectorAll('[data-detail]')) {
  button.addEventListener('click', () => {
    if (selectedDetail === button.dataset.detail) return;
    stateFor().scroll = $('reading-area').scrollTop;
    for (const state of states.values()) stop(state);
    selectedDetail = button.dataset.detail;
    paint();
    $('reading-area').scrollTop = stateFor().scroll;
    startGeneration();
  });
}
$('search').addEventListener('input', drawTranscript);
$('stop').addEventListener('click', () => {
  stop();
});
$('retry').addEventListener('click', async () => {
  if (mode === 'transcript') {
    try {
      await getSource();
    } catch {}
    paint();
  } else startGeneration(true);
});
const openSettings = () =>
  message('openOptions').catch((error) => {
    stateFor().error = error;
    paint();
  });
$('settings').addEventListener('click', openSettings);
$('configure').addEventListener('click', openSettings);
$('close').addEventListener('click', close);
$('copy-format').addEventListener('change', paint);
$('panel').addEventListener('click', (event) => {
  const target = event.target.closest('[data-seconds]');
  if (target) {
    for (const state of states.values()) state.controller?.abort();
    message('readerSeek', { seconds: Number(target.dataset.seconds) }).catch(
      () => {},
    );
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  }
  if (event.key === 'Tab') {
    // Keep keyboard navigation within the iframe as well as the parent dialog.
    const focusable = [
      ...document.querySelectorAll(
        'button:not(:disabled),select,input,a[href],[tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length);
    const first = focusable[0],
      last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
});
window.addEventListener('pagehide', () => {
  closed = true;
  for (const state of states.values()) state.controller?.abort();
});

function transcriptText() {
  return (source?.segments || [])
    .map(
      (s) => `${s.start === null ? '' : `[${formatTime(s.start)}] `}${s.text}`,
    )
    .join('\n');
}
function exportText(all = false) {
  const heading = `# ${metadata.title}\n\n${metadata.channel}\n${metadata.url}\n\n`;
  if (mode === 'transcript' && !all) return heading + transcriptText();
  if (!all)
    return (
      heading +
      (stateFor().status === 'complete' ? '' : '> Texte partiel\n\n') +
      exportDiagrams(stateFor().text)
    );
  const detail = selectedDetail;
  let text = heading;
  for (const [kind, label] of [
    ['summary', 'Résumé'],
    ['qa', 'Questions-réponses'],
  ]) {
    const state = states.get(`${kind}:${detail}`);
    if (state?.text)
      text += `## ${label}\n\n${state.status === 'complete' ? '' : '> Texte partiel\n\n'}${exportDiagrams(state.text)}\n\n`;
  }
  return text + `## Transcription\n\n${transcriptText()}`;
}
$('copy').addEventListener('click', async () => {
  const format = $('copy-format').value;
  try {
    let text = exportText(format === 'all');
    if (format === 'text')
      text = `${metadata.title}\n${metadata.url}\n\n${mode !== 'transcript' && stateFor().status !== 'complete' ? 'Texte partiel\n\n' : ''}${mode === 'transcript' ? transcriptText() : readableDiagramText($('article'))}`;
    if (format === 'download') {
      const url = URL.createObjectURL(
        new Blob([text], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `notes-${videoId}-${mode}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else await navigator.clipboard.writeText(text);
    $('copy').textContent = format === 'download' ? 'Téléchargé' : 'Copié';
    setTimeout(() => {
      if (!closed)
        $('copy').textContent =
          $('copy-format').value === 'download' ? 'Télécharger' : 'Copier';
    }, 1800);
  } catch {
    stateFor().warning =
      'La copie est indisponible. Choisis « Fichier .md » pour télécharger les notes.';
    paint();
  }
});

async function initialize() {
  try {
    // Authenticate the reader session before reading secrets or generating anything.
    const context = await message('readerContext');
    if (!context?.metadata || context.metadata.videoId !== videoId)
      throw new Error('Ouvre les notes depuis une vidéo YouTube.');
    showMetadata(context.metadata);
    settings = await getSettings();
    selectedDetail = DETAIL_LEVELS[settings.detail]
      ? settings.detail
      : 'detailed';
    $('tab-summary').focus();
    await startGeneration();
  } catch (error) {
    stateFor().status = 'error';
    stateFor().error = error;
    paint();
  }
}
initialize();
