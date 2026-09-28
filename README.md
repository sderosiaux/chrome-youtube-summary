# YouTube Summary

Extension Chrome pour transformer une vidéo YouTube en notes de lecture en français : résumé, questions-réponses et transcription horodatée. Génération avec **GPT-6 Luna**, via l’API Responses d’OpenAI.

## Installation et mise à jour

1. Ouvrir `chrome://extensions` et activer le mode développeur.
2. Choisir **Charger l’extension non empaquetée** et sélectionner ce dossier.
3. Pour une installation existante, cliquer sur **Recharger** et actualiser les onglets YouTube déjà ouverts. La nouvelle version ajoute l’accès à `api.openai.com`.
4. Ouvrir les options de l’extension et enregistrer une clé API OpenAI disposant d’un accès à `gpt-6-luna` et de crédit API.

Chrome 120 ou plus récent est requis. Les bibliothèques du rendu sont incluses dans `vendor/` : aucun build ni serveur n’est nécessaire pour charger l’extension.

## Utilisation

Sur une vidéo, cliquer sur **Résumer la vidéo**, sur l’icône de l’extension ou utiliser **⌘/Ctrl + Maj + S**. Le raccourci peut être modifié dans `chrome://extensions/shortcuts`.

- **Résumé** : lecture courte, détaillée ou approfondie. Les notes apparaissent progressivement.
- **Questions-réponses** : questions pédagogiques suivant les étapes de la vidéo, regroupées par chapitre, avec réponses et timestamps. Leur nombre dépend de la durée et de la densité du contenu, sans plafond de questions. Le format de lecture règle la profondeur des réponses.
- **Transcription** : recherche par texte et accès au passage vidéo en cliquant sur un timestamp.
- **Copie** : Markdown, texte ou toutes les notes disponibles pour le format choisi, avec la transcription. Un fichier `.md` peut également être téléchargé.
- **Arrêter** : annule la génération, y compris lorsqu’elle attend encore la transcription.
- **Échap / fermer** : ferme le dialogue et interrompt les requêtes en cours. Les notes terminées restent dans le cache.

Les options permettent de choisir le format par défaut, remplacer les instructions du résumé, vérifier l’accès à Luna, supprimer la clé et effacer les notes enregistrées. Le contrôle de clé consulte le catalogue des modèles : il ne génère pas de texte et ne vérifie pas le crédit disponible.

Le lecteur, les paramètres et le bouton YouTube suivent automatiquement le thème clair ou sombre du système, y compris lors d’un changement pendant la lecture.

Les résumés et Q/R peuvent intégrer des schémas entre les paragraphes lorsqu’un workflow, une décision ou des relations entre concepts s’y prêtent. Ils reprennent les informations sourcées du passage, sans appel IA supplémentaire. Le prompt évalue chaque section et chaque mécanisme indépendamment, sans quota global ni obligation d’illustrer chaque section. La lecture courte privilégie les mécanismes essentiels ; les formats longs couvrent aussi les autres mécanismes qui gagnent à être visualisés, sans répéter un schéma équivalent. Les objectifs de longueur de prose excluent le JSON des schémas, sans augmenter les plafonds de sortie. Les schémas suivent le thème du système et les plus larges se parcourent horizontalement sur petit écran. Une description textuelle est disponible aux lecteurs d’écran.

La copie Markdown et le téléchargement exportent les schémas en blocs Mermaid ; la copie texte restitue les relations avec des flèches. Les anciens résultats sont renouvelés avec la nouvelle version des prompts lors de la prochaine génération.

## Prompts et modèle

Le modèle est défini dans `config.js` : `gpt-6-luna`, avec `reasoning.effort: none`. Les requêtes utilisent `stream: true` et `store: false`, sans température imposée.

Les instructions sont séparées de la transcription. Le résumé doit rester fidèle à la source, préserver les nuances, attribuer les opinions, et éviter les citations et timestamps inventés. Les instructions personnalisées remplacent la structure par défaut, tout en conservant ces règles de fidélité. Q&A possède un prompt distinct : il transforme le déroulement de la vidéo en questions pédagogiques, sans les présenter comme des paroles de l’intervenant.

Le résumé par défaut commence par « En bref », puis adapte son organisation au contenu : cheminement du raisonnement pour une conférence argumentative, thèmes et points de vue pour un entretien ou un débat, notions et fonctionnement pour une explication technique, contexte et déroulement pour un témoignage. Les contenus hybrides peuvent combiner ces approches. Seules les sections utiles sont conservées, sans attribution d’intervenants incertaine ni désaccord inventé.

Les limites de sortie du résumé sont de 2 200, 6 000 et 12 000 tokens selon le format. Le Q/R n’impose pas de budget de sortie fixe par mode : le paramètre optionnel [`max_output_tokens`](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) est omis, et les limites de l’API et du modèle restent applicables. Une réponse interrompue ou tronquée est signalée comme partielle et n’est jamais mise en cache comme terminée. Aucune transcription n’est tronquée silencieusement : les requêtes au-delà de 700 000 caractères sérialisés sont refusées avant tout appel.

Le Q/R utilise un [schéma JSON strict](https://developers.openai.com/api/docs/guides/structured-outputs) avec un tableau de questions sans limite de taille et des champs de longueur bornée pour chaque réponse. L’application construit les titres et affiche chaque réponse terminée au fil de la génération. Elle interrompt le flux si une question ou une longue réponse identique réapparaît. Un retour à un thème déjà abordé est autorisé s’il apporte des questions et réponses distinctes. Les réponses précédentes restent accessibles comme texte partiel, sans relance automatique. Le cache et les exports contiennent du Markdown, jamais le JSON brut ; la version du cache Q/R est indépendante de celle du résumé.

## Stockage et confidentialité

- L’extension n’utilise aucun serveur applicatif intermédiaire et aucune télémétrie.
- Le titre, la chaîne et la transcription sont envoyés directement à OpenAI pour la génération. L’extension ne traite pas l’image ni l’audio de la vidéo.
- Par défaut, une nouvelle clé reste uniquement dans `chrome.storage.session` jusqu’à la fermeture du navigateur. L’option **Mémoriser la clé sur cet appareil** utilise le stockage local de l’extension, qui n’est pas un coffre chiffré.
- Les anciennes clés présentes dans Chrome Sync sont migrées vers le stockage local puis supprimées de Sync. Le prompt personnalisé existant est conservé.
- Le stockage contenant les clés est limité aux pages de l’extension et au service worker. Le script injecté dans YouTube ne reçoit jamais la clé.
- Les réponses terminées sont conservées localement, avec une limite de 30 entrées et un budget d’environ 3 Mo. La clé de cache tient compte de la vidéo, de la transcription, du modèle, du prompt et du niveau de détail.
- Les brouillons interrompus sont conservés dans le stockage de session ; les retrouver ne relance pas automatiquement une requête payante.
- `store: false` désactive le stockage de la réponse comme état réutilisable dans Responses. Cela ne remplace pas les politiques de traitement et de rétention d’OpenAI : voir [les contrôles de données de l’API](https://developers.openai.com/api/docs/guides/your-data).

Les bibliothèques et les styles sont embarqués, sans CDN, police distante ni image de tracking. Le rendu Markdown est nettoyé avec DOMPurify ; le HTML brut et les images générées par le modèle ne sont pas interprétés. Les schémas sont des graphes JSON validés et transformés localement en SVG par l’extension, jamais du SVG fourni par le modèle. Un schéma incomplet ou invalide reste masqué et ne bloque pas le texte environnant.

## Architecture

| Fichier | Rôle |
|---|---|
| `content.js`, `content.css` | Bouton YouTube, dialogue natif isolé, navigation et extraction annulable |
| `background.js` | Messages validés, raccourcis et exécution dans le contexte YouTube |
| `transcript.js` | Extraction depuis les données des composants, le DOM et le fallback `get_transcript` |
| `reader.html`, `reader.js`, `reader.css` | Page de lecture dans une iframe de l’extension, états séparés et navigation clavier |
| `theme.css` | Couleurs claires et sombres partagées par le lecteur et les paramètres |
| `diagrams.js`, `diagrams.css` | Instructions, validation, dessin SVG et exports des schémas intégrés |
| `api.js` | Appel Responses, flux SSE, annulation, timeout, erreurs et tentatives limitées |
| `qa.js` | Lecture du Q/R structuré, limites, détection des répétitions et conversion en Markdown |
| `config.js` | Luna, prompts communs, formats et normalisation |
| `render.js`, `vendor/` | Markdown, nettoyage HTML et timestamps vérifiés |
| `storage.js` | Migration de la clé, préférences et cache |
| `options.*` | Configuration |

Les appels OpenAI sont exécutés par la page de lecture, pas par le service worker : une génération longue ne dépend donc pas de la durée de vie de celui-ci. La fermeture de la page annule les appels. Le service worker reste chargé d’opérations courtes et des ponts vers YouTube.

L’iframe est limitée aux pages YouTube et doit présenter le jeton de la session de lecture ouverte. Les données dynamiques de la vidéo et les erreurs sont insérées comme texte. Les styles de la page YouTube n’affectent pas le lecteur.

## Limites

YouTube modifie régulièrement son interface et son API interne. L’extraction nécessite une transcription accessible ; les vidéos privées, restreintes, certains directs et les vidéos sans sous-titres peuvent ne pas fonctionner. Les données de tous les chapitres sont réunies et les doublons entre composants parents et enfants sont supprimés. Si seules les lignes visibles du DOM ou une réponse avec continuation sont disponibles, ou si la transcription s’arrête très loin de la fin de la vidéo, une indication de transcription potentiellement partielle est affichée et cette extraction n’est pas mémorisée comme complète. Les timestamps absents ne sont pas inventés.

Une clé API personnelle est nécessaire. Le coût et la qualité dépendent du contenu et du format. Les assertions du résumé ne constituent pas une vérification externe des propos de la vidéo.

## Développement et vérification

Node.js 22+ :

```sh
npm ci
npm run vendor
npm test
npx playwright install chromium
npm run test:browser
```

`npm run vendor` recopie les versions verrouillées de Marked et DOMPurify avec leurs licences. Les dépendances de production sont distribuées dans `vendor/` et le lockfile fixe les versions utilisées.

Les tests unitaires couvrent les prompts, le protocole SSE, les erreurs, les réponses incomplètes, la migration du stockage, les formats de transcription et l’injection HTML. Les tests navigateur chargent réellement l’extension dans Chromium, avec des pages YouTube et des réponses OpenAI simulées. Ils vérifient le cache, les onglets, l’annulation, les brouillons et la navigation SPA ; ils ne consomment aucun crédit API. Les captures sont enregistrées dans `test-results/`.
