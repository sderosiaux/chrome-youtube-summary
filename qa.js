import { generate, GenerationError } from './api.js';

const normalize = (value) =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const headingText = (value) =>
  value.replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>]/g, '\\$&');

function markdown(questions) {
  if (!questions.length) return '';
  const parts = ['*Questions pédagogiques reformulées à partir de la vidéo.*'];
  let chapter;
  questions.forEach((item, index) => {
    if (normalize(item.chapter) !== chapter) {
      parts.push(`## ${headingText(item.chapter)}`);
      chapter = normalize(item.chapter);
    }
    parts.push(`### ${index + 1}. ${headingText(item.question)}`, item.answer.trim());
  });
  return parts.join('\n\n');
}

// Read only closed objects in the streamed array. Braces and escaped quotes
// inside answers are text, not JSON boundaries. An unfinished answer stays hidden.
function completedQuestions(raw) {
  const prefix = /^\s*\{\s*"questions"\s*:\s*\[/.exec(raw);
  if (!prefix) {
    if (raw.length > 80) throw new Error('Invalid Q&A envelope');
    return [];
  }
  const questions = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = prefix[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') {
      if (depth++ === 0) start = i;
    } else if (char === '}') {
      if (--depth === 0) questions.push(JSON.parse(raw.slice(start, i + 1)));
    } else if (char === ']' && depth === 0) break;
  }
  return questions;
}

export class QAStream {
  constructor() {
    this.text = '';
  }

  update(raw, complete = false) {
    let questions;
    try {
      if (complete) {
        const result = JSON.parse(raw);
        if (!result || !Array.isArray(result.questions) || Object.keys(result).length !== 1)
          throw new Error('Invalid Q&A envelope');
        questions = result.questions;
      } else questions = completedQuestions(raw);
    } catch {
      throw new GenerationError(
        'Le modèle n’a pas respecté le format Q/R. Les réponses complètes déjà reçues sont conservées ; tu peux réessayer.',
        'qa_format', this.text,
      );
    }
    const accepted = [];
    const seenQuestions = new Set();
    const seenAnswers = new Set();
    const stop = (message, code) => {
      throw new GenerationError(message, code, markdown(accepted));
    };
    for (const item of questions) {
      if (!item || Object.keys(item).length !== 3 ||
          !['chapter', 'question', 'answer'].every((key) => typeof item[key] === 'string' && item[key].trim()) ||
          item.chapter.length > 160 || item.question.length > 400 || item.answer.length > 2200)
        stop('Une réponse Q/R ne respecte pas le format attendu. Les réponses précédentes sont conservées.', 'qa_format');
      const question = normalize(item.question);
      const answer = normalize(item.answer);
      if (seenQuestions.has(question) || (answer.length > 80 && seenAnswers.has(answer)))
        stop('La génération a été arrêtée car le modèle répétait une question ou une réponse. Les Q/R précédentes sont conservées.', 'qa_repetition');
      seenQuestions.add(question);
      seenAnswers.add(answer);
      accepted.push(item);
    }
    this.text = markdown(accepted);
    if (complete && !questions.length)
      this.text = 'La transcription ne contient pas assez d’informations pour construire des questions-réponses utiles.';
    return this.text;
  }
}

export async function generateQA({ request, onDelta = () => {}, ...options }) {
  const stream = new QAStream();
  let displayed = '';
  const publish = (text) => {
    if (text !== displayed) {
      displayed = text;
      onDelta(text);
    }
  };
  try {
    const result = await generate({
      ...options, request,
      onDelta: (raw) => publish(stream.update(raw)),
    });
    const text = stream.update(result.text, true);
    publish(text);
    return { ...result, text };
  } catch (error) {
    // The reader, cache and exports only ever see Markdown, including failures.
    if (error instanceof GenerationError && !error.code.startsWith('qa_'))
      error.partial = stream.text;
    throw error;
  }
}
