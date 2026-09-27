(() => {
  if (window.youtubeTranscriptExtensionInitialized) return;
  window.youtubeTranscriptExtensionInitialized = true;
  let session = null;
  let extraction = null;
  let transcriptCache = null;
  const getVideoId = () => {
    const url = new URL(location.href);
    const id = url.searchParams.get('v');
    return url.pathname === '/watch' && /^[\w-]{11}$/.test(id || '')
      ? id
      : null;
  };
  const metadata = (videoId) => ({
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: (
      document.querySelector(
        'h1.ytd-watch-metadata yt-formatted-string, h1.title',
      )?.textContent || document.title.replace(/ - YouTube$/, '')
    ).trim(),
    channel: (
      document.querySelector(
        'ytd-watch-metadata #channel-name a, #owner #channel-name a',
      )?.textContent || ''
    ).trim(),
    duration: Number.isFinite(document.querySelector('video')?.duration)
      ? document.querySelector('video').duration
      : null,
  });
  const abortError = () => new DOMException('Annulé', 'AbortError');
  function cancelExtraction() {
    extraction?.abort();
    extraction = null;
  }
  function closeReader() {
    if (!session) return;
    cancelExtraction();
    const previous = session;
    session = null;
    previous.dialog.close();
    previous.host.remove();
    if (previous.focus?.isConnected) previous.focus.focus();
  }
  function openReader() {
    const videoId = getVideoId();
    if (!videoId) return;
    if (session?.videoId === videoId) {
      session.frame.focus();
      return;
    }
    closeReader();
    const host = document.createElement('div');
    host.id = 'yt-summary-reader';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial}dialog{box-sizing:border-box;padding:0;border:1px solid #deded9;border-radius:12px;width:min(1120px,calc(100vw - 16px));height:calc(100dvh - 40px);max-width:none;max-height:none;background:#fff;box-shadow:0 28px 100px #171b2533;overflow:hidden}dialog::backdrop{background:#151b2859;backdrop-filter:blur(3px)}iframe{display:block;width:100%;height:100%;border:0} @media(max-width:640px){dialog{width:100vw;height:calc(100dvh - 24px);border:0;border-radius:8px;margin:12px 0}}`;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Notes de la vidéo');
    const frame = document.createElement('iframe');
    frame.title = 'Résumé et transcription de la vidéo';
    frame.allow = 'clipboard-write';
    const token = crypto.randomUUID();
    frame.src = chrome.runtime.getURL(
      `reader.html?videoId=${videoId}&token=${token}`,
    );
    session = {
      videoId,
      token,
      host,
      dialog,
      frame,
      focus: document.activeElement,
    };
    dialog.append(frame);
    root.append(style, dialog);
    document.body.append(host);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeReader();
    });
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      if (
        event.target === dialog &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      )
        closeReader();
    });
    dialog.showModal();
    frame.focus();
  }
  const pause = (ms, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  function assertCurrent(videoId, signal) {
    signal.throwIfAborted();
    if (getVideoId() !== videoId || session?.videoId !== videoId)
      throw abortError();
  }
  async function extract(videoId) {
    if (transcriptCache?.videoId === videoId) return transcriptCache.value;
    cancelExtraction();
    const controller = new AbortController();
    extraction = controller;
    const signal = controller.signal;
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        assertCurrent(videoId, signal);
        const mountedId = document
          .querySelector('ytd-watch-flexy')
          ?.getAttribute('video-id');
        if (!mountedId || mountedId === videoId) break;
        if (attempt === 19)
          throw new Error(
            'YouTube charge encore la vidéo. Réessaie dans quelques instants.',
          );
        await pause(150, signal);
      }
      const read = async (useAPI) => {
        assertCurrent(videoId, signal);
        const value = await chrome.runtime.sendMessage({
          action: 'extractTranscript',
          videoId,
          useAPI,
        });
        assertCurrent(videoId, signal);
        return value || {};
      };
      let dom = await read(false);
      if (!dom.segments?.length) {
        document
          .querySelector('ytd-watch-metadata tp-yt-paper-button#expand')
          ?.click();
        await pause(250, signal);
        const selectors =
          '[aria-label="Show transcript"], [aria-label="Afficher la transcription"], [aria-label*="transcript" i], [aria-label*="transcription" i]';
        const button = [...document.querySelectorAll(selectors)].find(
          (el) => el.offsetHeight > 0,
        );
        button?.click();
        if (button) {
          for (let i = 0; i < 10; i++) {
            await pause(400, signal);
            dom = await read(false);
            if (dom.segments?.length) break;
          }
        }
      }
      let value = dom;
      if (!dom.segments?.length || dom.partial) {
        const api = await read(true);
        const lastTimestamp = (result) =>
          Math.max(
            -1,
            ...(result.segments || []).map((s) => s.start).filter(Number.isFinite),
          );
        const apiEnd = lastTimestamp(api);
        const domEnd = lastTimestamp(dom);
        if (
          api.segments?.length &&
          (!api.partial || apiEnd > domEnd ||
            (apiEnd === domEnd &&
              api.segments.length > (dom.segments?.length || 0)))
        )
          value = api;
      }
      assertCurrent(videoId, signal);
      if (!value.segments?.length)
        throw new Error(
          'Aucune transcription accessible. Ouvre la transcription dans YouTube, puis réessaie.',
        );
      value = { ...value, metadata: metadata(videoId) };
      // A visible-only transcript may grow when YouTube loads more segments.
      if (!value.partial) transcriptCache = { videoId, value };
      return value;
    } finally {
      if (extraction === controller) extraction = null;
    }
  }
  chrome.runtime.onMessage.addListener((request, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (request.action === 'triggerSummary') {
      openReader();
      reply({ ok: true });
      return false;
    }
    if (!request.action?.startsWith('reader')) return false;
    if (
      !session ||
      request.token !== session.token ||
      request.videoId !== session.videoId ||
      getVideoId() !== session.videoId
    ) {
      reply({
        error: 'Cette fenêtre ne correspond plus à la vidéo. Rouvre le résumé.',
      });
      return false;
    }
    if (request.action === 'readerContext')
      reply({ metadata: metadata(session.videoId) });
    if (request.action === 'readerExtract') {
      extract(session.videoId).then(reply, (error) =>
        reply({ error: error.message, cancelled: error.name === 'AbortError' }),
      );
      return true;
    }
    if (request.action === 'readerCancel') {
      cancelExtraction();
      reply({ ok: true });
    }
    if (request.action === 'readerClose') {
      reply({ ok: true });
      closeReader();
    }
    if (request.action === 'readerSeek') {
      const video = document.querySelector('video');
      const seconds = Number(request.seconds);
      if (
        video &&
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        (!Number.isFinite(video.duration) || seconds <= video.duration)
      )
        video.currentTime = seconds;
      reply({ ok: true });
      closeReader();
    }
    return false;
  });
  function updateButton() {
    const videoId = getVideoId();
    if (session && session.videoId !== videoId) closeReader();
    if (transcriptCache?.videoId !== videoId) transcriptCache = null;
    let button = document.getElementById('yt-summary-fab');
    if (!videoId) {
      button?.remove();
      return;
    }
    if (button) return;
    button = document.createElement('button');
    button.id = 'yt-summary-fab';
    button.textContent = 'Résumer la vidéo';
    button.title = 'Ouvrir les notes de la vidéo';
    button.addEventListener('click', openReader);
    document.body.append(button);
  }
  document.addEventListener('yt-navigate-start', closeReader);
  document.addEventListener('yt-navigate-finish', updateButton);
  window.addEventListener('popstate', updateButton);
  window.addEventListener('pagehide', closeReader);
  updateButton();
})();
