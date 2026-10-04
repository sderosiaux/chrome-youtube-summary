import { cacheKey, readCache } from './storage.js';
import { formatTime } from './config.js';
import { exportDiagrams } from './diagrams.js';
import { buildArchiveDocument, selectCompletedSummary } from './github-archive.js';

export function linkVideoTimestamps(markdown, videoId, segments) {
  const times = new Map(segments.filter(s => s.start !== null).map(s => [formatTime(s.start), Math.floor(s.start)]));
  let fence = null;
  return markdown.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/\[(\d+:\d{2}(?::\d{2})?)\](?!\()/g, (match, time) => times.has(time)
      ? `[${time}](https://www.youtube.com/watch?v=${videoId}&t=${times.get(time)}s)` : match);
  }).join('\n');
}

export async function summaryArchive({ metadata, source, settings, states }) {
  const { detail, result } = await selectCompletedSummary(async depth => {
    const state = states.get(`summary:${depth}`);
    if (state?.status === 'complete' && state.text?.trim()) return state;
    const key = await cacheKey({ metadata, segments: source.segments, mode: 'summary', detail: depth, customPrompt: settings.customPrompt });
    const cached = await readCache(key);
    return cached?.text?.trim() ? cached : null;
  });
  const url = `https://www.youtube.com/watch?v=${metadata.videoId}`;
  const title = metadata.title.replace(/[\\`*_{}\[\]()#+!<>|]/g, '\\$&');
  const text = linkVideoTimestamps(exportDiagrams(result.text), metadata.videoId, source.segments);
  const markdown = `# ${title}\n\n[YouTube](${url})\n\n${source.partial ? '> Transcription potentiellement partielle : les notes peuvent omettre une partie de la vidéo.\n\n' : ''}${text}`;
  return buildArchiveDocument({ medium: 'youtube', id: metadata.videoId, title: metadata.title, url, detail, markdown });
}
