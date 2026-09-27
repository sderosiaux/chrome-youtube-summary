import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('vendor', { recursive: true });
for (const [source, target] of [
  ['marked/lib/marked.esm.js', 'marked.js'],
  ['marked/LICENSE', 'marked.LICENSE'],
  ['dompurify/dist/purify.es.mjs', 'purify.js'],
  ['dompurify/LICENSE', 'dompurify.LICENSE'],
]) {
  await copyFile(`node_modules/${source}`, `vendor/${target}`);
}
