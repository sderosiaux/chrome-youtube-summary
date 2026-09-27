import { DEFAULT_PROMPT, DETAIL_LEVELS, MODEL } from './config.js';
import { getSettings, saveSettings, clearCache } from './storage.js';

const $ = (id) => document.getElementById(id);
const status = (text, type = 'success') => {
  $('status').textContent = text;
  $('status').dataset.type = type;
  $('status').hidden = false;
};
$('defaultPrompt').textContent = DEFAULT_PROMPT;
async function load() {
  try {
    const settings = await getSettings();
    $('apiKey').value = settings.apiKey;
    $('rememberKey').checked = settings.rememberKey;
    $('customPrompt').value = settings.customPrompt || '';
    $('detail').value = DETAIL_LEVELS[settings.detail]
      ? settings.detail
      : 'detailed';
  } catch {
    status('Impossible de charger les paramètres.', 'error');
  }
}
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save').disabled = true;
  try {
    await saveSettings({
      apiKey: $('apiKey').value.trim(),
      rememberKey: $('rememberKey').checked,
      customPrompt: $('customPrompt').value.trim(),
      detail: $('detail').value,
    });
    status('Paramètres enregistrés.');
  } catch {
    status(
      'Impossible d’enregistrer les paramètres. Vérifie le stockage disponible.',
      'error',
    );
  } finally {
    $('save').disabled = false;
  }
});
$('reveal').addEventListener('click', () => {
  const show = $('apiKey').type === 'password';
  $('apiKey').type = show ? 'text' : 'password';
  $('reveal').textContent = show ? 'Masquer' : 'Afficher';
  $('reveal').setAttribute(
    'aria-label',
    show ? 'Masquer la clé' : 'Afficher la clé',
  );
});
$('testKey').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    status('Saisis une clé OpenAI pour vérifier l’accès.', 'error');
    $('apiKey').focus();
    return;
  }
  $('testKey').disabled = true;
  status('Vérification de l’accès à Luna…');
  try {
    const response = await fetch(`https://api.openai.com/v1/models/${MODEL}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok)
      status(
        'Luna est accessible. Ce contrôle ne génère aucun texte et ne vérifie pas le crédit disponible.',
      );
    else if (response.status === 401)
      status('La clé est invalide ou a expiré.', 'error');
    else if (response.status === 403)
      status(
        'Accès refusé au catalogue de modèles. Vérifie les permissions de la clé ; tu peux néanmoins l’enregistrer.',
        'error',
      );
    else if (response.status === 404)
      status('Luna n’est pas disponible pour cette clé.', 'error');
    else
      status(
        `OpenAI n’a pas pu vérifier l’accès (HTTP ${response.status}).`,
        'error',
      );
  } catch {
    status(
      'Connexion à OpenAI impossible. Vérifie le réseau et réessaie.',
      'error',
    );
  } finally {
    $('testKey').disabled = false;
  }
});
$('resetPrompt').addEventListener('click', () => {
  $('customPrompt').value = '';
  status(
    'Instructions par défaut sélectionnées. Clique sur Enregistrer pour les appliquer.',
  );
});
$('removeKey').addEventListener('click', async () => {
  try {
    await Promise.all([
      chrome.storage.local.remove('openaiApiKey'),
      chrome.storage.session.remove('openaiApiKey'),
    ]);
    $('apiKey').value = '';
    $('rememberKey').checked = false;
    status('Clé supprimée de cet appareil.');
  } catch {
    status('Impossible de supprimer la clé.', 'error');
  }
});
$('clearCache').addEventListener('click', async () => {
  try {
    await clearCache();
    status('Notes enregistrées et brouillons effacés.');
  } catch {
    status('Impossible d’effacer les notes enregistrées.', 'error');
  }
});
load();
