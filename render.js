import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { formatTime } from './config.js';
import { splitDiagrams, renderDiagram } from './diagrams.js';

const escapeHTML = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const renderer = new marked.Renderer();
renderer.html = (token) => escapeHTML(token.text);
renderer.image = () => '';

export function renderMarkdown(container, text, segments = []) {
  const previous = [...container.querySelectorAll('.inline-diagram')];
  const focused = container.contains(document.activeElement) &&
    document.activeElement.closest('.inline-diagram') ? document.activeElement : null;
  let diagramIndex = 0;
  container.replaceChildren();
  for (const part of splitDiagrams(text)) {
    if (part.type === 'diagram') {
      const figure = renderDiagram(part.diagram, previous[diagramIndex++]);
      if (figure) container.append(figure);
      continue;
    }
    const parsed = marked.parse(part.text, {
      renderer, gfm: true, breaks: false, async: false,
    });
    container.append(DOMPurify.sanitize(parsed, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: [
        'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em',
        'del', 'blockquote', 'pre', 'code', 'a', 'br', 'hr', 'table',
        'thead', 'tbody', 'tr', 'th', 'td',
      ],
      ALLOWED_ATTR: ['href', 'title', 'start'],
      ALLOW_DATA_ATTR: false,
    }));
  }
  if (focused && container.contains(focused)) focused.focus({ preventScroll: true });
  for (const link of container.querySelectorAll('a')) {
    try {
      const url = new URL(link.getAttribute('href'));
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } catch {
      link.replaceWith(document.createTextNode(link.textContent));
    }
  }
  const timestamps = new Map(
    segments
      .filter((s) => s.start !== null)
      .map((s) => [formatTime(s.start), s.start]),
  );
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode())
    if (!walker.currentNode.parentElement.closest('a, code, pre, .inline-diagram'))
      nodes.push(walker.currentNode);
  for (const node of nodes) {
    const pattern = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
    let cursor = 0;
    const fragment = document.createDocumentFragment();
    for (const match of node.textContent.matchAll(pattern)) {
      const normalized =
        match[1].split(':').length === 2 ? match[1].padStart(5, '0') : match[1];
      if (!timestamps.has(normalized)) continue;
      fragment.append(
        document.createTextNode(node.textContent.slice(cursor, match.index)),
      );
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'timestamp';
      button.dataset.seconds = timestamps.get(normalized);
      button.textContent = match[1];
      button.setAttribute('aria-label', `Voir le passage à ${match[1]}`);
      fragment.append(button);
      cursor = match.index + match[0].length;
    }
    if (cursor) {
      fragment.append(document.createTextNode(node.textContent.slice(cursor)));
      node.replaceWith(fragment);
    }
  }
}
