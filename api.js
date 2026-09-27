export class GenerationError extends Error {
  constructor(message, code = 'api', partial = '') {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    this.partial = partial;
  }
}

function apiError(status, data) {
  if (status === 401)
    return new GenerationError(
      'La clé OpenAI est invalide ou a expiré. Vérifie les paramètres.',
      'auth',
    );
  if (status === 403)
    return new GenerationError(
      'Cette clé ne permet pas d’utiliser Luna. Vérifie les droits du projet OpenAI.',
      'auth',
    );
  if (status === 429)
    return new GenerationError(
      data?.error?.code === 'insufficient_quota'
        ? 'Le crédit OpenAI est épuisé. Vérifie la facturation du projet.'
        : 'OpenAI limite temporairement les requêtes. Réessaie dans quelques instants.',
      'rate_limit',
    );
  if (status >= 500)
    return new GenerationError(
      'OpenAI est temporairement indisponible. Réessaie dans quelques instants.',
    );
  return new GenerationError(
    data?.error?.message || `La requête OpenAI a échoué (HTTP ${status}).`,
  );
}

export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
    const tail = buffer
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (tail && tail !== '[DONE]') yield JSON.parse(tail);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function generate({
  apiKey,
  request,
  signal,
  onDelta = () => {},
  fetchImpl = fetch,
  timeoutMs = 300_000,
}) {
  if (!apiKey)
    throw new GenerationError(
      'Ajoute ta clé OpenAI dans les paramètres pour générer un résumé.',
      'auth',
    );
  const body = JSON.stringify(request);
  if (body.length > 700_000)
    throw new GenerationError(
      'Cette transcription dépasse la taille prise en charge. Aucun passage n’a été supprimé et aucun appel n’a été envoyé.',
      'too_large',
    );
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs,
  );
  const combined = AbortSignal.any([signal, timeout.signal]);
  let text = '';
  try {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      combined.throwIfAborted();
      response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: combined,
      });
      if (response.ok) break;
      const data = await response.json().catch(() => ({}));
      const retryable =
        (response.status === 429 &&
          data?.error?.code !== 'insufficient_quota') ||
        response.status >= 500;
      if (!retryable || attempt === 2) throw apiError(response.status, data);
      const seconds = Number(response.headers.get('retry-after'));
      await wait(
        Math.min(10_000, seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt),
        combined,
      );
    }
    if (!response.body)
      throw new GenerationError('OpenAI n’a pas renvoyé de contenu.');
    for await (const event of readEvents(response.body)) {
      combined.throwIfAborted();
      if (event.type === 'response.output_text.delta') {
        text += event.delta || '';
        onDelta(text);
      } else if (
        event.type === 'response.refusal.delta' ||
        event.type === 'response.refusal.done'
      ) {
        throw new GenerationError(
          'Le modèle n’a pas pu produire de résumé pour ce contenu.',
          'refusal',
          text,
        );
      } else if (event.type === 'response.incomplete') {
        throw new GenerationError(
          'Réponse incomplète : la génération a atteint sa limite. Le texte partiel est conservé ; tu peux relancer avec un format plus court.',
          'incomplete',
          text,
        );
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new GenerationError(
          event.response?.error?.message ||
            event.message ||
            'La génération a échoué.',
          'api',
          text,
        );
      } else if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed')
          throw new GenerationError(
            'La réponse n’est pas complète.',
            'incomplete',
            text,
          );
        const finalText = (event.response.output || [])
          .flatMap((item) =>
            item.type === 'message' ? item.content || [] : [],
          )
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('');
        text = finalText || text;
        if (!text.trim())
          throw new GenerationError(
            'Le modèle a renvoyé une réponse vide. Réessaie.',
            'empty',
          );
        onDelta(text);
        return { text: text.trim(), usage: event.response.usage || null };
      }
    }
    throw new GenerationError(
      'La connexion a été interrompue avant la fin. Le texte partiel est conservé.',
      'interrupted',
      text,
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timeout.signal.aborted)
      throw new GenerationError(
        'La génération a dépassé cinq minutes. Le texte partiel est conservé.',
        'timeout',
        text,
      );
    if (error instanceof GenerationError) throw error;
    throw new GenerationError(
      'Impossible de joindre OpenAI ou de lire sa réponse. Vérifie la connexion, puis réessaie.',
      'network',
      text,
    );
  } finally {
    clearTimeout(timer);
  }
}
