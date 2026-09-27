import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractInPage } from '../transcript.js';

function page() {
  const dom = new JSDOM('<ytd-engagement-panel-section-list-renderer target-id="transcript"><ytd-item-section-renderer></ytd-item-section-renderer></ytd-engagement-panel-section-list-renderer>', { url: 'https://www.youtube.com/watch?v=abcdefghijk', runScripts: 'outside-only' });
  dom.window.eval(`window.extract = ${extractInPage.toString()}`);
  return dom.window;
}
test('all cues in a group are retained with their supplied timestamps', async () => {
  const window = page();
  window.ytcfg = { get: key => ({ INNERTUBE_API_KEY: 'test', INNERTUBE_CLIENT_VERSION: 'test-version' })[key] };
  window.AbortSignal = AbortSignal;
  window.fetch = async () => Response.json({ actions: [{ transcriptCueGroupRenderer: { startOffsetMs: '1500', cues: [
    { transcriptCueRenderer: { cue: { simpleText: 'First' } } },
    { transcriptCueRenderer: { cue: { runs: [{ text: 'Second' }] }, startOffsetMs: '2500' } },
  ] } }] });
  const result = JSON.parse(JSON.stringify(await window.extract('abcdefghijk', true)));
  assert.deepEqual(result.segments, [{ text: 'First', start: 1.5 }, { text: 'Second', start: 2.5 }]);
  assert.equal(result.partial, false);
});
test('component data is used before potentially virtualized DOM', async () => {
  const window = page();
  window.document.querySelector('ytd-item-section-renderer').data = { contents: [
    { transcriptSegmentRenderer: { snippet: { simpleText: 'Full data' }, startMs: '4000' } },
    { transcriptSegmentRenderer: { snippet: { simpleText: 'Without a timestamp' } } },
  ] };
  const result = JSON.parse(JSON.stringify(await window.extract('abcdefghijk')));
  assert.equal(result.method, 'component');
  assert.deepEqual(result.segments, [{ text: 'Full data', start: 4 }, { text: 'Without a timestamp', start: null }]);
});
test('DOM-only transcripts are explicitly marked potentially partial', async () => {
  const window = page();
  window.document.querySelector('ytd-item-section-renderer').innerHTML = '<ytd-transcript-segment-renderer><div class="segment-timestamp">1:02</div><span class="segment-text">Visible text</span></ytd-transcript-segment-renderer>';
  const result = await window.extract('abcdefghijk');
  assert.equal(result.partial, true);
  assert.equal(result.segments[0].start, 62);
  assert.equal((await window.extract('wrongvideo1')).error, 'La vidéo a changé.');
});
test('all chapter components are merged instead of returning the first chapter', async () => {
  const window = page();
  const panel = window.document.querySelector('ytd-engagement-panel-section-list-renderer');
  const video = window.document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 3702 });
  window.document.body.append(video);
  const chapter = (start, text) => ({ contents: [{ transcriptSegmentRenderer: {
    snippet: { simpleText: text }, startMs: String(start * 1000),
  } }] });
  const intro = chapter(125, 'Fin de l’introduction');
  const middle = chapter(129, 'Le deuxième chapitre commence');
  const last = chapter(3690, 'Conclusion de la discussion');
  panel.querySelector('ytd-item-section-renderer').data = intro;
  for (const data of [middle, last]) {
    const section = window.document.createElement('ytd-item-section-renderer');
    section.data = data;
    panel.append(section);
  }
  // Parent data may be a separate copy of the same chapter trees.
  panel.data = JSON.parse(JSON.stringify({ contents: [intro, middle, last] }));
  const result = JSON.parse(JSON.stringify(await window.extract('abcdefghijk')));
  assert.deepEqual(result.segments.map(s => s.start), [125, 129, 3690]);
  assert.equal(result.partial, false);
  assert.equal(result.method, 'component');
});
test('a two-minute chapter from an hour-long video is partial without a continuation marker', async () => {
  const window = page();
  const video = window.document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 3702 });
  window.document.body.append(video);
  window.document.querySelector('ytd-item-section-renderer').data = { contents: [
    { transcriptSegmentRenderer: { snippet: { simpleText: 'Introduction' }, startMs: '125000' } },
  ] };
  const result = await window.extract('abcdefghijk');
  assert.equal(result.partial, true);
  assert.equal(result.segments.at(-1).start, 125);
});
test('later visible chapters supplement component data without duplicating earlier rows', async () => {
  const window = page();
  const section = window.document.querySelector('ytd-item-section-renderer');
  section.data = { contents: [
    { transcriptSegmentRenderer: { snippet: { simpleText: 'Premier chapitre' }, startMs: '125000' } },
  ] };
  section.innerHTML = '<ytd-transcript-segment-renderer><div class="segment-timestamp">2:05</div><span class="segment-text">Premier chapitre</span></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><div class="segment-timestamp">2:09</div><span class="segment-text">Deuxième chapitre</span></ytd-transcript-segment-renderer>';
  const result = JSON.parse(JSON.stringify(await window.extract('abcdefghijk')));
  assert.deepEqual(result.segments.map(s => s.start), [125, 129]);
  assert.equal(result.partial, true);
});
