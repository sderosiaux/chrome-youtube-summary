// background.js
console.log("YouTube Summary: Background script loaded");

// Store active AbortControllers to allow cancellation
const activeRequests = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log("YouTube Summary: Extension installed");
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("YouTube Summary: Message received in background:", request);

  if (request.action === "cancelRequest") {
    const controller = activeRequests.get(request.requestId);
    if (controller) {
      controller.abort();
      activeRequests.delete(request.requestId);
      console.log("YouTube Summary: Request cancelled:", request.requestId);
    }
    sendResponse({ cancelled: true });
    return true;
  }

  if (request.action === "extractTranscriptData") {
    extractTranscriptFromMainWorld(sender.tab.id)
      .then((transcript) => sendResponse({ transcript }))
      .catch((error) => {
        console.error("YouTube Summary: [BG] extractTranscript error:", error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  if (request.action === "generateSummary") {
    const requestId = request.requestId || Date.now().toString();
    generateAISummary(request, requestId)
      .then((summary) => {
        activeRequests.delete(requestId);
        sendResponse({ summary });
      })
      .catch((error) => {
        activeRequests.delete(requestId);
        console.error("YouTube Summary: Error generating summary:", error);
        sendResponse({ error: error.message, cancelled: error.name === 'AbortError' });
      });
    return true; // Keep message channel open for async response
  }

  if (request.action === "generateQA") {
    const requestId = request.requestId || Date.now().toString();
    generateQAExtraction(request, requestId)
      .then((qa) => {
        activeRequests.delete(requestId);
        sendResponse({ qa });
      })
      .catch((error) => {
        activeRequests.delete(requestId);
        console.error("YouTube Summary: Error generating Q&A:", error);
        sendResponse({ error: error.message, cancelled: error.name === 'AbortError' });
      });
    return true;
  }

  return true;
});

// API timeout in milliseconds (10 minutes for very long videos)
const API_TIMEOUT_MS = 600000;

// Generate AI summary using OpenAI API
async function generateAISummary({ transcript, title, channel, url }, requestId) {
  // Create AbortController for timeout and cancellation
  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  // Set timeout
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.error("YouTube Summary: API request timed out after", API_TIMEOUT_MS / 1000, "seconds");
  }, API_TIMEOUT_MS);

  try {
    // Get API key from storage
    const result = await chrome.storage.sync.get([
      "openaiApiKey",
      "customPrompt",
    ]);
    const apiKey = result.openaiApiKey;

    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Please set it in the extension options.",
      );
    }

    // Default prompt if none provided
    const customPrompt = `
Résumé EXHAUSTIF en français • Termes techniques → anglais • Longueur proportionnelle au contenu

STYLE: Incisif, direct • Symboles: →, ≠, ~, +, *, etc.

TYPE AUTO-DÉTECTÉ:
- TALK/CONFÉRENCE → thèse + arguments + implications
- REVIEW/ANALYSE → méthodologie + évaluation + recommandations

---

## TL;DR
[TALK/REVIEW] → Une phrase brutale capturant l'essence + positionnement

## Points Clés (8-12)
Classés par importance décroissante. Pour chaque point:
* **Point** → Affirmation factuelle extraite de la transcription
  - 💭 *Opinion*: Position/jugement de l'auteur (si applicable)
  - 📊 *Preuve*: Donnée/étude/stat citée (si applicable)
  - ⚡ *Impact*: Conséquence pratique

## Données & Stats
Extraire TOUS les chiffres mentionnés:
* % | Montants | Volumes | Dates | Comparaisons | Métriques

## Citations Clés
* 📌 Factuelles (vérifiables)
* 💬 Opinionnelles (jugements personnels)
* ⚠️ À vérifier (claims sans source)

## Fiabilité
* ⚠️ Points faibles ou manquant de support dans la transcription
* Confiance globale: 🟢 ÉLEVÉE | 🟡 MOYENNE | 🔴 FAIBLE
    `.trim();

    const prompt = `
${customPrompt}

Video Title: ${title}
Channel: ${channel || "Unknown"}

Transcript:
${transcript}
    `.trim();

    console.log("YouTube Summary: Making OpenAI API request");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.1",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_completion_tokens: 8000,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      console.error("YouTube Summary: OpenAI API error response:", JSON.stringify(errorData, null, 2));
      console.error("YouTube Summary: HTTP status:", response.status, response.statusText);
      throw new Error(
        `OpenAI API error: ${errorData.error?.message || response.statusText}`,
      );
    }

    const data = await response.json();
    const summary = data.choices[0]?.message?.content?.trim();

    if (!summary) {
      throw new Error("No summary generated by OpenAI API");
    }

    console.log("YouTube Summary: Summary generated successfully");
    return summary;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error("Requête annulée ou timeout dépassé (2 min)");
    }
    console.error("YouTube Summary: Error in generateAISummary:", error);
    console.error("YouTube Summary: Full error details:", error.message, error.stack);
    throw error;
  }
}

// Generate Q&A extraction using OpenAI API
async function generateQAExtraction({ transcript, title, channel, url }, requestId) {
  // Create AbortController for timeout and cancellation
  const controller = new AbortController();
  activeRequests.set(requestId, controller);

  // Set timeout
  const timeoutId = setTimeout(() => {
    controller.abort();
    console.error("YouTube Summary: Q&A API request timed out after", API_TIMEOUT_MS / 1000, "seconds");
  }, API_TIMEOUT_MS);

  try {
    // Get API key from storage
    const result = await chrome.storage.sync.get(["openaiApiKey"]);
    const apiKey = result.openaiApiKey;

    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Please set it in the extension options.",
      );
    }

    const qaPrompt = `Tu es mon extracteur de Q&A pour les vidéos, qu'elles soient des interviews, webinars, conférences ou monologues éducatifs.
À partir de la transcription ci-dessous, extrais les questions et réponses, qu'elles soient:
- Explicites: posées par un hôte/intervieweur à un invité
- Rhétoriques: posées par le speaker lui-même ("Qu'est-ce que X ? Laissez-moi vous expliquer...")
- Implicites: sujets introduits puis expliqués, même sans question formelle

IMPORTANT: Réponds TOUJOURS en français, peu importe la langue de la discussion.

Retourne le résultat dans ce format exact:

Question: <paraphrase très courte de la question en français>
- <réponse très résumée, focus sur ce qu'ils expliquent ou affirment réellement>

Règles:
- Ignore les bavardages et l'intendance (bienvenue, sponsors, café, bons de réduction, "tu m'entends ?", etc.).
- Détecte les questions rhétoriques ("Vous vous demandez peut-être...", "La question est...", "Comment faire X ?")
- Extrais les questions implicites: quand un concept est introduit puis expliqué, formule la question sous-jacente
- Fusionne les questions de suivi dans la question principale quand elles restent sur le même sujet.
- Saute les questions ou réponses répétées.
- Utilise un langage simple et direct, pas de hype, pas de blabla.
- Même pour un monologue solo, crée une structure Q&A artificielle si le contenu s'y prête (enseignement, explication de concepts)
- Seulement si le contenu est vraiment narratif sans aucune structure pédagogique, réponds: "Ce contenu est purement narratif, sans structure Q&A adaptable."`;

    const prompt = `
${qaPrompt}

Video Title: ${title}
Channel: ${channel || "Unknown"}

Transcript:
${transcript}
    `.trim();

    console.log("YouTube Summary: Making OpenAI API request for Q&A");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.1",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        max_completion_tokens: 4000,
        temperature: 0.5,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `OpenAI API error: ${errorData.error?.message || response.statusText}`,
      );
    }

    const data = await response.json();
    const qa = data.choices[0]?.message?.content?.trim();

    if (!qa) {
      throw new Error("No Q&A generated by OpenAI API");
    }

    console.log("YouTube Summary: Q&A generated successfully");
    return qa;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error("Requête annulée ou timeout dépassé (2 min)");
    }
    console.error("YouTube Summary: Error in generateQAExtraction:", error);
    throw error;
  }
}

// Extract transcript by running code in the page's MAIN world via chrome.scripting
// This bypasses the content script's isolated world limitation to access Polymer component data
async function extractTranscriptFromMainWorld(tabId) {
  console.log("YouTube Summary: [BG] Extracting transcript via MAIN world for tab:", tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const panel = document.querySelector(
        '[target-id="PAmodern_transcript_view"], [target-id*="transcript"]'
      );
      const section = panel?.querySelector('ytd-item-section-renderer');
      const contents = section?.data?.contents;
      if (!contents || contents.length === 0) return { error: 'no contents', contentsLength: 0 };

      // Modern format: macroMarkersPanelItemViewModel
      const texts = contents.map(item => {
        const vm = item.macroMarkersPanelItemViewModel?.item?.timelineItemViewModel;
        if (!vm?.contentItems) return null;
        return vm.contentItems
          .map(ci => ci.transcriptSegmentViewModel?.simpleText)
          .filter(Boolean)
          .join(' ');
      }).filter(Boolean);

      if (texts.length > 0) {
        return { transcript: texts.join(' ').replace(/\s+/g, ' ').trim(), segments: texts.length };
      }

      // Older format: transcriptSegmentRenderer
      const textsOld = contents.map(item => {
        const seg = item.transcriptSegmentRenderer;
        if (!seg?.snippet) return null;
        if (seg.snippet.runs) return seg.snippet.runs.map(r => r.text).join('');
        return seg.snippet.simpleText || null;
      }).filter(Boolean);

      if (textsOld.length > 0) {
        return { transcript: textsOld.join(' ').replace(/\s+/g, ' ').trim(), segments: textsOld.length };
      }

      return { error: 'unknown structure', firstKey: Object.keys(contents[0])[0] };
    }
  });

  const result = results?.[0]?.result;
  if (!result) {
    console.error("YouTube Summary: [BG] No result from MAIN world script");
    return null;
  }

  if (result.error) {
    console.error("YouTube Summary: [BG] MAIN world extraction failed:", result.error, result.firstKey);
    return null;
  }

  console.log("YouTube Summary: [BG] Extracted", result.segments, "segments,", result.transcript.length, "chars");
  return result.transcript;
}

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.url.includes("youtube.com/watch")) {
    chrome.tabs.sendMessage(tab.id, { action: "triggerSummary" });
  } else {
    console.log("YouTube Summary: Not on a YouTube video page");
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "trigger-summary") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url.includes("youtube.com/watch")) {
        chrome.tabs.sendMessage(tab.id, { action: "triggerSummary" });
      } else {
        console.log("YouTube Summary: Not on a YouTube video page");
      }
    });
  }
});
