import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../config.js';
import { QAStream, generateQA } from '../qa.js';
import { sse } from './fixtures.js';

const request = buildRequest({ mode: 'qa', detail: 'short', metadata: {}, segments: [] });
const first = {
  chapter: 'Le problème initial',
  question: 'Pourquoi conserver un état ?',
  answer: 'L’exemple « {état} » permet de reprendre une opération interrompue. [03:12]',
};
const second = {
  chapter: 'Les limites',
  question: 'Quand préférer une solution simple ?',
  answer: 'Une tâche courte et autonome peut rester un cron ou une API. [08:40]',
};
const options = () => ({ apiKey: 'test-key', request, signal: new AbortController().signal });

test('fragmented JSON produces complete questions with real Markdown boundaries', () => {
  const stream = new QAStream();
  const raw = JSON.stringify({ questions: [first, second] });
  for (let i = 1; i <= raw.length; i++) {
    const text = stream.update(raw.slice(0, i));
    assert.ok(!text || text.includes(first.answer));
    assert.doesNotMatch(text, /"questions"\s*:/);
  }
  const text = stream.update(raw, true);
  assert.match(text, /## Le problème initial\n\n### 1\. Pourquoi conserver un état \?/);
  assert.match(text, /## Les limites\n\n### 2\. Quand préférer une solution simple \?/);
});

test('a repetition stops and cancels a still-open response without retrying', async () => {
  let cancelled = false, calls = 0;
  const raw = `{"questions":[${JSON.stringify(first)},${JSON.stringify(first)},`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: raw })}\n\n`));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(generateQA({
    ...options(), timeoutMs: 1000,
    fetchImpl: async () => { calls++; return new Response(body); },
  }), error => error.code === 'qa_repetition' && error.partial.includes(first.answer) && !error.partial.includes('"questions"'));
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('long talks can have many distinct questions and revisit an earlier theme', () => {
  const questions = Array.from({ length: 80 }, (_, index) => ({
    chapter: index % 2 ? second.chapter : first.chapter,
    question: `Quelle nouvelle idée est développée à l’étape ${index + 1} ?`,
    answer: `L’étape ${index + 1} apporte un argument distinct : ${'une explication détaillée '.repeat(40)}`,
  }));
  const stream = new QAStream();
  const text = stream.update(JSON.stringify({ questions }), true);
  assert.match(text, /### 80\./);
  assert.equal((text.match(/^### /gm) || []).length, 80);
});

test('incomplete API responses preserve Markdown only, including the last complete answer', async () => {
  const raw = `{"questions":[${JSON.stringify(first)},{"chapter":"Les limites","question":"Quand`;
  await assert.rejects(generateQA({
    ...options(), fetchImpl: async () => new Response(sse(raw, true)),
  }), error => error.code === 'incomplete' && error.partial.includes(first.answer) && !error.partial.includes('Les limites'));
});

test('completed Q&A is converted before caching and malformed final JSON stays partial', async () => {
  const result = await generateQA({
    ...options(), fetchImpl: async () => new Response(sse(JSON.stringify({ questions: [first, second] }))),
  });
  assert.match(result.text, /### 2\./);
  assert.doesNotMatch(result.text, /"questions"\s*:/);
  const raw = `{"questions":[${JSON.stringify(first)},`;
  await assert.rejects(generateQA({
    ...options(), fetchImpl: async () => new Response(sse(raw)),
  }), error => error.code === 'qa_format' && error.partial.includes(first.answer));
});
