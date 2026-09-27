export const summary = `## En bref

Stripe utilise Temporal pour coordonner les opérations de son infrastructure Kafka. Les workflows durables simplifient les tâches longues et les reprises après incident, mais leur intérêt dépend du problème à résoudre.

## À retenir

1. **Un control plane pour les opérations critiques.** Le remplacement de brokers, les rebalances et les redémarrages sont orchestrés avec un état explicite. [00:12]
2. **La durabilité est utile lorsque l’attente fait partie du travail.** Un workflow peut attendre la disponibilité d’une archive S3, reprendre après un échec et conserver sa progression. [03:12]
3. **L’orchestration a aussi un coût.** Des tâches simples restent plus faciles à maintenir avec un cron ou une API. Le choix dépend des reprises et de la durée de l’opération. [08:40]

## Pour approfondir

### Attendre une archive sans multiplier les alertes

L’Archive Monitor lance des vérifications et attend leur résultat. Cette approche évite de traiter un retard normal de disponibilité comme une panne.

- Un parent workflow coordonne les vérifications.
- Les child workflows vérifient les archives attendues.
  - L’état est conservé entre les tentatives.
  - Une erreur reste visible jusqu’à sa résolution.

### Choisir la bonne frontière

Temporal est pertinent pour une séquence longue qui nécessite un suivi et des reprises. Une opération courte et autonome ne bénéficie pas forcément de cette complexité.
`;
export const qa = JSON.stringify({ questions: [{
  chapter: 'Comprendre les choix',
  question: 'Pourquoi utiliser des workflows durables ?',
  answer: 'Ils conservent la progression des opérations longues et permettent leur reprise. [03:12]',
}] });
export const segments = [
  { startMs: '12000', snippet: { simpleText: 'Stripe utilise Temporal pour orchestrer les opérations de son infrastructure Kafka.' } },
  { startMs: '192000', snippet: { simpleText: 'Un workflow durable peut attendre une archive S3 et reprendre après un incident.' } },
  { startMs: '520000', snippet: { simpleText: 'Une tâche simple peut rester un cron ou une API. Le choix dépend du besoin de reprise.' } },
];
export function videoHTML(id = 'abcdefghijk', withTranscript = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vidéo — YouTube</title><style>body{font:16px system-ui;background:#f9f9f9;margin:40px}.player{height:480px;background:#e9ece5;width:75%;border-radius:12px}h1{font-size:24px}</style></head><body><h1 class="title">Mastering Kafka at Scale: Unleashing the Power of Temporal at Stripe | Replay 2023</h1><div id="owner"><span id="channel-name"><a>Temporal</a></span></div><div class="player"></div><video></video><a href="#outside">Lien de la page</a><ytd-watch-flexy video-id="${id}"></ytd-watch-flexy>${withTranscript ? '<ytd-engagement-panel-section-list-renderer target-id="transcript"><ytd-item-section-renderer></ytd-item-section-renderer></ytd-engagement-panel-section-list-renderer>' : ''}<script>Object.defineProperty(document.querySelector('video'),'duration',{get:()=>1832});${withTranscript ? `document.querySelector('ytd-item-section-renderer').data={contents:${JSON.stringify(segments.map(s => ({ transcriptSegmentRenderer: s })))}};` : ''}</script></body></html>`;
}
export function sse(text, incomplete = false) {
  return [
    { type: 'response.output_text.delta', delta: text },
    incomplete ? { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
      : { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1234, output_tokens: 678 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}
