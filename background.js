// background.js
console.log("YouTube Summary: Background script loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.log("YouTube Summary: Extension installed");
});

// Handle messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("YouTube Summary: Message received in background:", request);

  if (request.action === "generateSummary") {
    generateAISummary(request)
      .then((summary) => {
        sendResponse({ summary });
      })
      .catch((error) => {
        console.error("YouTube Summary: Error generating summary:", error);
        sendResponse({ error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (request.action === "generateQA") {
    generateQAExtraction(request)
      .then((qa) => {
        sendResponse({ qa });
      })
      .catch((error) => {
        console.error("YouTube Summary: Error generating Q&A:", error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  return true;
});

// Generate AI summary using OpenAI API
async function generateAISummary({ transcript, title, channel, url }) {
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
Résumé EXHAUSTIF en français • Termes techniques → anglais • Vidéo ~1h+ = analyse proportionnelle

STYLE REQUIS:
* Nettoyer les formulations peu importantes pour polir le style et le rendre plus incisif
* Utiliser des symboles pour raccourcir les idées (*, →, ≠, ~, +, etc.)

DÉTECTION AUTO DU TYPE:
* TALK/CONFÉRENCE → focus sur thèse centrale + arguments + implications pratiques
* REVIEW/ANALYSE → focus sur méthodologie + évaluation + comparaisons + recommandations

## 0. Résumé brutal
→ Une phrase directe qui capture l'essence du contenu

## 1. Sujet Principal
[TALK] * Thèse/message central défendu + pourquoi maintenant
[REVIEW] * Sujet analysé + méthodologie/angle d'évaluation utilisé
* Contexte & problématique abordée
* Positionnement dans son domaine

## 1.5. Hiérarchie d'Importance
CRITIQUE (20% → 80% valeur):
* Les 2-3 insights qui changent vraiment la donne
* Points que l'auteur répète/emphasise le plus

IMPORTANT (30% du contenu):
* Arguments solides qui supportent le message principal
* Exemples concrets avec impact mesurable

SECONDAIRE (50% restant):
* Contexte utile mais pas essentiel
* Détails techniques ou anecdotes illustratives

## 2. Points Clés (8-12) - AVEC DISTINCTION
Format pour chaque point:
* Point principal → Fait établi basé sur la transcription
  - Opinion: Position/jugement exprimé par l'auteur
  - Preuve: Recherche/stats/données citées par le speaker
  - Implication: Analyse/conséquence déduite

## 3. Insights & Leçons - AVEC SOURCES
Format pour chaque insight:
* Insight principal avec base factuelle (citations directes)
  - Opinion: Perspective/position exprimée par l'auteur
  - Preuve: Étude/recherche/statistique mentionnée pour appuyer
  - Application: Conséquences pratiques et implications

## 4. Citations Marquantes
* Citations FACTUELLES: [Affirmations vérifiables]
* Citations OPINIONNELLES: [Jugements/positions personnelles]
* Affirmations à vérifier: [Claims qui demandent validation externe]

## 4.5. Statistiques & Données Clés
Extraire tous les nombres précis et stats importantes mentionnés:
* Pourcentages: [Ex: "75% des entreprises utilisent..."]
* Montants/Budget: [Ex: "$2.5M de financement levé"]
* Volumes/Quantités: [Ex: "10 millions d'utilisateurs"]
* Dates/Années: [Ex: "Depuis 2019, croissance de..."]
* Comparaisons chiffrées: [Ex: "3x plus rapide que..."]
* Métriques business: [Ex: "ROI de 150%", "Conversion +25%"]

## 5. À Retenir (par thème + type)
* FAITS établis: Points vérifiables
* POSITIONS défendues: Arguments de l'auteur
* IMPLICATIONS: Conséquences logiques

## 6. Actions Recommandées
* IMMÉDIAT (impact élevé, effort faible): Action → résultat dans X jours
* COURT TERME (préparation requise): Action → prérequis → ROI
* LONG TERME (investissement important): Vision → étapes → indicateurs

## 6.5. Mindmap ASCII - Concepts Principaux/Secondaires
Structure hiérarchique en ASCII des concepts clés dans un block code:

SUJET PRINCIPAL
Concept Principal 1
-> Sous-concept A
-> Sous-concept B
Concept Principal 2
-> Détail important
-> Application pratique
Concept Principal 3
-> Implication majeure
-> Lien avec autres domaines

Organiser par ordre d'importance décroissante

## 7. Conclusion + Validation
* Synthèse: éléments majeurs + implications + prochaines étapes
* Points manquant de support dans la transcription originale
* Niveau de confiance global: ÉLEVÉ → FAIBLE
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
    });

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
    console.error("YouTube Summary: Error in generateAISummary:", error);
    console.error("YouTube Summary: Full error details:", error.message, error.stack);
    throw error;
  }
}

// Generate Q&A extraction using OpenAI API
async function generateQAExtraction({ transcript, title, channel, url }) {
  try {
    // Get API key from storage
    const result = await chrome.storage.sync.get(["openaiApiKey"]);
    const apiKey = result.openaiApiKey;

    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Please set it in the extension options.",
      );
    }

    const qaPrompt = `Tu es mon extracteur de Q&A pour les vidéos et webinars avec des intervenants.
À partir de la transcription ci-dessous, trouve les questions posées par l'hôte ou l'intervieweur et les réponses données par le(s) invité(s).

IMPORTANT: Réponds TOUJOURS en français, peu importe la langue de la discussion.

Retourne le résultat dans ce format exact:

Question: <paraphrase très courte de la question en français>
- <réponse très résumée, focus sur ce qu'ils expliquent ou affirment réellement>

Règles:
- Ignore les bavardages et l'intendance (bienvenue, sponsors, café, bons de réduction, "tu m'entends ?", etc.).
- Fusionne les questions de suivi dans la question principale quand elles restent sur le même sujet.
- Saute les questions ou réponses répétées.
- Utilise un langage simple et direct, pas de hype, pas de blabla.
- S'il y a du contenu pédagogique qui n'est pas sous forme Q&A, ignore-le sauf s'il répond clairement à une question de l'hôte.
- Si cette vidéo ne semble pas être au format interview, webinar, session Q&A ou panel, réponds: "Ce contenu ne semble pas être au format Q&A (interview, webinar, panel)."`;

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
    });

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
    console.error("YouTube Summary: Error in generateQAExtraction:", error);
    throw error;
  }
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
