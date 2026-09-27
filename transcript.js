// Self-contained: Chrome serializes this function into YouTube's MAIN world.
export async function extractInPage(videoId, useAPI = false) {
  const currentId = () => new URL(location.href).searchParams.get('v');
  if (currentId() !== videoId) return { error: 'La vidéo a changé.' };
  const mountedId = document
    .querySelector('ytd-watch-flexy')
    ?.getAttribute('video-id');
  if (mountedId && mountedId !== videoId)
    return { error: 'La vidéo est encore en cours de chargement.' };
  const textOf = (value) =>
    typeof value === 'string'
      ? value
      : value?.simpleText ||
        value?.runs?.map((r) => r.text).join('') ||
        value?.content ||
        '';
  const timeOf = (value) => {
    if (typeof value !== 'string' || !/^\s*\d+(?::\d{2}){1,2}\s*$/.test(value))
      return null;
    return value
      .trim()
      .split(':')
      .reduce((total, part) => total * 60 + Number(part), 0);
  };
  const msOf = (...values) => {
    const n = values.find(
      (v) =>
        v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)),
    );
    return n === undefined ? null : Number(n) / 1000;
  };
  const mergeSegments = (segments) => {
    const unique = new Map();
    for (const segment of segments) {
      const text = segment.text?.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const key = JSON.stringify([segment.start, text]);
      if (!unique.has(key)) unique.set(key, { ...segment, text });
    }
    return [...unique.values()].sort(
      (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity),
    );
  };
  const suspiciousCoverage = (segments) => {
    const duration = document.querySelector('video')?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const starts = segments.map((s) => s.start).filter(Number.isFinite);
    if (!starts.length) return true;
    // Missing continuation metadata does not prove that every chapter loaded.
    // Allow a short outro; flag a large uncovered tail without discarding text.
    return duration - Math.max(...starts) > Math.max(60, duration * 0.1);
  };
  const collect = (root) => {
    const segments = [];
    let continuation = false;
    const visited = new WeakSet();
    const visit = (value, inheritedStart = null, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 40) return;
      if (visited.has(value)) return;
      visited.add(value);
      if (value.continuationItemRenderer || value.continuations?.length)
        continuation = true;
      if (value.transcriptSegmentRenderer) {
        const s = value.transcriptSegmentRenderer;
        segments.push({
          text: textOf(s.snippet),
          start:
            msOf(s.startMs, s.startTimeMs) ?? timeOf(textOf(s.startTimeText)),
        });
        return;
      }
      if (value.transcriptCueGroupRenderer) {
        const g = value.transcriptCueGroupRenderer;
        const start =
          msOf(g.startOffsetMs) ?? timeOf(textOf(g.formattedStartOffset));
        for (const cue of g.cues || []) visit(cue, start, depth + 1);
        return;
      }
      if (value.transcriptCueRenderer) {
        const c = value.transcriptCueRenderer;
        segments.push({
          text: textOf(c.cue),
          start: msOf(c.startOffsetMs) ?? inheritedStart,
        });
        return;
      }
      if (value.transcriptSegmentViewModel) {
        const s = value.transcriptSegmentViewModel;
        segments.push({
          text: textOf(s.simpleText || s.text || s.snippet),
          start:
            msOf(s.startMs, s.startTimeMs) ??
            timeOf(textOf(s.startTimeText || s.timestamp)) ??
            inheritedStart,
        });
        return;
      }
      if (value.timelineItemViewModel) {
        const s = value.timelineItemViewModel;
        const start =
          msOf(s.startMs, s.startTimeMs) ??
          timeOf(textOf(s.timestamp || s.title)) ??
          inheritedStart;
        visit(s.contentItems, start, depth + 1);
        return;
      }
      for (const child of Object.values(value))
        visit(child, inheritedStart, depth + 1);
    };
    visit(root);
    return {
      segments: segments.filter((s) => s.text?.trim()),
      partial: continuation,
    };
  };
  const candidates = [
    ...document.querySelectorAll('ytd-engagement-panel-section-list-renderer'),
  ].filter(
    (p) =>
      p.getAttribute('target-id')?.includes('transcript') ||
      p.getAttribute('panel-identifier')?.includes('transcript') ||
      p.querySelector(
        'ytd-transcript-renderer, ytd-transcript-segment-renderer, transcript-segment-view-model, [data-target-id*="transcript"]',
      ),
  );
  const expanded = candidates.filter(
    (p) =>
      p.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
  );
  const panels = expanded.length ? expanded : candidates;
  if (!useAPI) {
    // Component data is preferred to visible DOM, which YouTube may virtualize.
    // Each item-section can be ONE chapter, not the complete transcript.
    // Collect the entire forest before deciding whether extraction is complete.
    const roots = [];
    for (const panel of panels) {
      const data = [
        ...panel.querySelectorAll(
          'ytd-section-list-renderer, yt-section-list-renderer, ytd-item-section-renderer, yt-item-section-renderer, ytd-transcript-renderer, ytd-transcript-segment-list-renderer',
        ),
      ]
        .map((el) => el.data)
        .filter(Boolean);
      roots.push(...data);
      if (panel.data) roots.push(panel.data);
    }
    const component = collect(roots);
    const componentSegments = mergeSegments(component.segments);
    const segments = [];
    for (const panel of panels) {
      for (const el of panel.querySelectorAll(
        'ytd-transcript-segment-renderer, transcript-segment-view-model',
      )) {
        const text = el.querySelector(
          '.segment-text, span[role="text"], span.ytAttributedStringHost',
        )?.textContent;
        const timestamp = el.querySelector(
          '.segment-timestamp, [class*="timestamp"], [class*="Timestamp"]',
        )?.textContent;
        if (text) segments.push({ text, start: timeOf(timestamp) });
      }
    }
    const allSegments = mergeSegments([...componentSegments, ...segments]);
    // DOM rows can fill holes while new component data is still loading, but
    // that combination remains partial until a complete data source is found.
    const domAddedRows = allSegments.length > componentSegments.length;
    return {
      segments: allSegments,
      partial:
        !componentSegments.length || component.partial || domAddedRows ||
        suspiciousCoverage(allSegments),
      method: componentSegments.length ? 'component' : 'visible-dom',
    };
  }
  try {
    const apiKey = window.ytcfg?.get('INNERTUBE_API_KEY');
    const context = window.ytcfg?.get('INNERTUBE_CONTEXT');
    const clientVersion = window.ytcfg?.get('INNERTUBE_CLIENT_VERSION');
    if (!apiKey || (!context && !clientVersion))
      return { error: 'La configuration YouTube est indisponible.' };
    let params;
    const findParams = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 35 || params) return;
      if (value.getTranscriptEndpoint?.params) {
        params = value.getTranscriptEndpoint.params;
        return;
      }
      for (const child of Object.values(value)) findParams(child, depth + 1);
    };
    // ytInitialData can refer to the previous video after SPA navigation.
    const watch = document.querySelector('ytd-watch-flexy');
    if (watch?.getAttribute('video-id') === videoId) findParams(watch.data);
    for (const panel of panels) findParams(panel.data);
    if (!params) {
      const inner = '\x12' + String.fromCharCode(videoId.length) + videoId;
      params = btoa('\x0a' + String.fromCharCode(inner.length) + inner);
    }
    const headers = { 'Content-Type': 'application/json' };
    const sapisid = document.cookie.match(
      /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/,
    )?.[1];
    if (sapisid) {
      const timestamp = Math.floor(Date.now() / 1000);
      const buffer = await crypto.subtle.digest(
        'SHA-1',
        new TextEncoder().encode(
          `${timestamp} ${sapisid} https://www.youtube.com`,
        ),
      );
      headers.Authorization = `SAPISIDHASH ${timestamp}_${[...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
      headers['X-Origin'] = 'https://www.youtube.com';
    }
    const body = JSON.stringify({
      context: context || { client: { clientName: 'WEB', clientVersion } },
      params,
    });
    const url = `/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
    let data;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'include',
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = await response.json();
    } catch {
      data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.timeout = 8000;
        xhr.withCredentials = true;
        for (const [key, value] of Object.entries(headers))
          xhr.setRequestHeader(key, value);
        xhr.onload = () => {
          try {
            if (xhr.status < 200 || xhr.status >= 300)
              throw new Error(`HTTP ${xhr.status}`);
            resolve(JSON.parse(xhr.responseText));
          } catch (error) {
            reject(error);
          }
        };
        xhr.onerror = xhr.ontimeout = () =>
          reject(new Error('La transcription YouTube est inaccessible.'));
        xhr.send(body);
      });
    }
    if (currentId() !== videoId) return { error: 'La vidéo a changé.' };
    const result = collect(data.actions || data);
    const segments = mergeSegments(result.segments);
    return {
      segments,
      partial: result.partial || suspiciousCoverage(segments),
      method: 'api',
    };
  } catch (error) {
    return { error: error.message };
  }
}
