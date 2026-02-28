// content.js
(function() {
  if (window.youtubeTranscriptExtensionInitialized) {
    return;
  }
  window.youtubeTranscriptExtensionInitialized = true;

  console.log('YouTube Summary: Content script loaded');

  let currentUrl = location.href;
  let transcriptData = null;

  // Wait for video to be ready
  function waitForVideoElement() {
    return new Promise((resolve) => {
      const checkForVideo = () => {
        const video = document.querySelector('video');
        if (video && video.readyState >= 1) {
          resolve(video);
        } else {
          setTimeout(checkForVideo, 100);
        }
      };
      checkForVideo();
    });
  }

  // Extract transcript using DOM method
  async function extractTranscriptFromDOM() {
    try {
      console.log('YouTube Summary: Attempting DOM transcript extraction');

      // Try to find and click the transcript button (language-agnostic selectors)
      const transcriptButtons = [
        '[aria-label="Show transcript"]',
        '[aria-label="Afficher la transcription"]',
        '[aria-label*="transcript" i]',
        '[aria-label*="transcription" i]',
        'button[aria-label*="Transcript" i]',
        'button[aria-label*="Transcription" i]'
      ];

      let transcriptButton = null;
      for (const selector of transcriptButtons) {
        transcriptButton = document.querySelector(selector);
        if (transcriptButton) break;
      }

      if (transcriptButton) {
        console.log('YouTube Summary: Found transcript button, clicking...');
        transcriptButton.click();
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      // Try to extract from segments container
      const segmentsContainer = document.querySelector('#segments-container');
      if (segmentsContainer) {
        console.log('YouTube Summary: Found segments container');
        const segments = segmentsContainer.querySelectorAll('[data-text]');
        if (segments.length > 0) {
          const transcript = Array.from(segments)
            .map(segment => segment.getAttribute('data-text') || segment.textContent)
            .join(' ')
            .trim();
          return transcript;
        }

        const transcriptText = segmentsContainer.textContent
          .replace(/[\n\r0-9:]+/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (transcriptText.length > 50) {
          return transcriptText;
        }
      }

      return null;
    } catch (error) {
      console.error('YouTube Summary: Error extracting transcript from DOM:', error);
      return null;
    }
  }

  // Get caption tracks by reading <script> tags from the DOM (no fetch, no injection)
  function getCaptionTracksFromPage() {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        const marker = '"captionTracks":';
        const startIdx = text.indexOf(marker);
        if (startIdx === -1) continue;

        const arrayStart = startIdx + marker.length;
        let depth = 0;
        let endIdx = arrayStart;
        for (let i = arrayStart; i < text.length; i++) {
          if (text[i] === '[') depth++;
          if (text[i] === ']') depth--;
          if (depth === 0) { endIdx = i + 1; break; }
        }

        const tracks = JSON.parse(text.substring(arrayStart, endIdx));
        if (tracks.length > 0) return tracks;
      }
      return null;
    } catch (error) {
      console.error('YouTube Summary: Error parsing caption tracks from DOM:', error);
      return null;
    }
  }

  // Fetch and parse transcript from a caption track URL (handles XML and JSON3 formats)
  async function fetchTranscriptFromUrl(baseUrl) {
    const response = await fetch(baseUrl);
    if (!response.ok) {
      console.error('YouTube Summary: Caption fetch failed:', response.status, response.statusText);
      return null;
    }

    const body = await response.text();
    console.log('YouTube Summary: Caption response format:', body.substring(0, 100));

    // Try JSON3 format first (YouTube's newer format for ASR captions)
    if (body.startsWith('{')) {
      try {
        const json = JSON.parse(body);
        const segments = (json.events || [])
          .filter(e => e.segs)
          .flatMap(e => e.segs.map(s => s.utf8))
          .filter(Boolean);
        if (segments.length > 0) {
          const transcript = segments.join('').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
          return transcript.length > 50 ? transcript : null;
        }
      } catch (e) {
        console.error('YouTube Summary: JSON3 parse error:', e);
      }
    }

    // Try XML format
    const parser = new DOMParser();
    const doc = parser.parseFromString(body, 'text/xml');
    const textNodes = doc.querySelectorAll('text');

    if (textNodes.length > 0) {
      const transcript = Array.from(textNodes)
        .map(node => {
          const temp = document.createElement('span');
          temp.innerHTML = node.textContent;
          return temp.textContent;
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return transcript.length > 50 ? transcript : null;
    }

    console.error('YouTube Summary: Unknown caption format, body starts with:', body.substring(0, 200));
    return null;
  }

  // Pick the best caption track (prefer original language, then English, then first)
  function pickBestTrack(tracks) {
    // Prefer a non-auto-generated track in original language
    const original = tracks.find(t => t.kind !== 'asr');
    if (original) return original;
    // Then any English track
    const english = tracks.find(t => t.languageCode === 'en');
    if (english) return english;
    // Then first available
    return tracks[0];
  }

  // Extract transcript by fetching caption track content
  async function extractTranscriptFromCaptionTracks() {
    try {
      console.log('YouTube Summary: Attempting caption tracks extraction');

      const tracks = await getCaptionTracksFromPage();
      if (!tracks) {
        console.log('YouTube Summary: No caption tracks found');
        return null;
      }

      console.log(`YouTube Summary: Found ${tracks.length} caption track(s)`);
      const track = pickBestTrack(tracks);
      if (!track || !track.baseUrl) {
        console.log('YouTube Summary: No usable caption track');
        return null;
      }

      console.log(`YouTube Summary: Fetching transcript from track: ${track.languageCode} (kind: ${track.kind || 'manual'})`);
      return await fetchTranscriptFromUrl(track.baseUrl);
    } catch (error) {
      console.error('YouTube Summary: Error fetching caption tracks:', error);
      return null;
    }
  }

  // Main transcript extraction function
  async function extractTranscript() {
    console.log('YouTube Summary: Starting transcript extraction');

    await waitForVideoElement();

    // Method 1: Fetch directly from YouTube caption tracks API (most reliable)
    let transcript = await extractTranscriptFromCaptionTracks();
    if (transcript && transcript.length > 50) {
      transcriptData = transcript;
      console.log('YouTube Summary: Transcript extracted via caption tracks', transcript.substring(0, 100) + '...');
      return transcript;
    }

    // Method 2: DOM scraping fallback
    console.log('YouTube Summary: Caption tracks failed, trying DOM method');
    transcript = await extractTranscriptFromDOM();
    if (transcript && transcript.length > 50) {
      transcriptData = transcript;
      console.log('YouTube Summary: Transcript extracted via DOM', transcript.substring(0, 100) + '...');
      return transcript;
    }

    console.log('YouTube Summary: No transcript found');
    return null;
  }

  // Get video title and metadata
  function getVideoMetadata() {
    const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent ||
                  document.querySelector('h1.title')?.textContent ||
                  document.title;

    const channel = document.querySelector('#text.ytd-channel-name a')?.textContent ||
                    document.querySelector('.ytd-channel-name a')?.textContent;

    return { title, channel, url: location.href };
  }

  // Simple markdown renderer
  function renderMarkdown(text) {
    if (!text) return '';

    let html = text
      // Split into lines for processing
      .split('\n')
      .map(line => {
        // Headers
        if (line.startsWith('### ')) return `<h3>${line.substring(4)}</h3>`;
        if (line.startsWith('## ')) return `<h2>${line.substring(3)}</h2>`;
        if (line.startsWith('# ')) return `<h1>${line.substring(2)}</h1>`;
        // Lists
        if (line.startsWith('- ')) return `<li>${line.substring(2)}</li>`;
        if (line.match(/^\d+\. /)) return `<li>${line}</li>`;
        // Empty lines
        if (line.trim() === '') return '<br>';
        // Regular paragraphs
        return `<p>${line}</p>`;
      })
      .join('\n')
      // Process inline formatting
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Wrap consecutive list items
      .replace(/(<li>.*<\/li>\n?)+/g, (match) => {
        return `<ul>${match}</ul>`;
      })
      // Clean up
      .replace(/<br>\n?<\/p>/g, '</p>')
      .replace(/<p><br>/g, '<p>')
      .replace(/\n/g, '');

    return html;
  }

  // Initialize markdown preview
  function initializeMarkdownPreview(summary) {
    const previewDiv = document.querySelector('.markdown-preview');

    if (previewDiv) {
      const renderedContent = renderMarkdown(summary);
      previewDiv.innerHTML = renderedContent;
      previewDiv.style.padding = '24px';
      previewDiv.style.flex = '1';
      previewDiv.style.overflowY = 'auto';
    }
  }


  // Store content for tabs
  let currentSummary = null;
  let currentQA = null;
  let currentMetadata = null;

  // Show fullscreen popup
  function showSummaryPopup(summary, metadata, qa = null) {
    // Store content for tab switching
    currentSummary = summary;
    currentQA = qa;
    currentMetadata = metadata;

    // Remove existing popup if any
    const existingPopup = document.getElementById('youtube-summary-popup');
    if (existingPopup) {
      existingPopup.remove();
    }

    // Create popup HTML
    const popup = document.createElement('div');
    popup.id = 'youtube-summary-popup';
    popup.innerHTML = `
      <div class="popup-overlay">
        <div class="popup-content">
          <div class="popup-header">
            <div class="video-info">
              <h2>${metadata.title}</h2>
              <p class="channel">${metadata.channel || 'Unknown Channel'}</p>
            </div>
            <div class="header-actions">
              <button class="copy-all-btn" title="Copier tout en Markdown">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>Copier tout</span>
              </button>
              <button class="close-btn">&times;</button>
            </div>
          </div>
          <div class="popup-tabs">
            <button class="tab-btn active" data-tab="summary">Résumé</button>
            <button class="tab-btn" data-tab="qa">Q&A</button>
          </div>
          <div class="popup-body">
            <div class="summary-content">
              <div class="markdown-preview"></div>
            </div>
            <div class="popup-actions">
              <button class="copy-btn">Copier</button>
              <button class="regenerate-btn">Régénérer</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Add to page
    document.body.appendChild(popup);

    // Initialize markdown preview immediately
    initializeMarkdownPreview(summary);

    // Add event listeners
    const closeBtn = popup.querySelector('.close-btn');
    const copyBtn = popup.querySelector('.copy-btn');
    const copyAllBtn = popup.querySelector('.copy-all-btn');
    const regenerateBtn = popup.querySelector('.regenerate-btn');
    const overlay = popup.querySelector('.popup-overlay');
    const tabBtns = popup.querySelectorAll('.tab-btn');

    closeBtn.addEventListener('click', () => popup.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) popup.remove();
    });

    // Copy all content (Summary + Q&A if available) in markdown format
    copyAllBtn.addEventListener('click', () => {
      let fullMarkdown = `# ${metadata.title}\n`;
      fullMarkdown += `**Channel:** ${metadata.channel || 'Unknown'}\n`;
      fullMarkdown += `**URL:** ${metadata.url}\n\n`;
      fullMarkdown += `---\n\n`;
      fullMarkdown += `## Résumé\n\n`;
      fullMarkdown += currentSummary || '_Pas de résumé disponible_';

      if (currentQA) {
        fullMarkdown += `\n\n---\n\n`;
        fullMarkdown += `## Q&A\n\n`;
        fullMarkdown += currentQA;
      }

      navigator.clipboard.writeText(fullMarkdown).then(() => {
        const span = copyAllBtn.querySelector('span');
        span.textContent = 'Copié!';
        setTimeout(() => span.textContent = 'Copier tout', 2000);
      });
    });

    // Tab switching
    tabBtns.forEach(btn => {
      btn.addEventListener('click', async () => {
        const tab = btn.dataset.tab;

        // Update active tab styling
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (tab === 'summary') {
          initializeMarkdownPreview(currentSummary);
        } else if (tab === 'qa') {
          if (currentQA) {
            initializeMarkdownPreview(currentQA);
          } else {
            // Generate Q&A if not already generated
            await generateQAContent();
          }
        }
      });
    });

    copyBtn.addEventListener('click', () => {
      const activeTab = popup.querySelector('.tab-btn.active').dataset.tab;
      const contentToCopy = activeTab === 'summary' ? currentSummary : currentQA;
      navigator.clipboard.writeText(contentToCopy || '').then(() => {
        copyBtn.textContent = 'Copié!';
        setTimeout(() => copyBtn.textContent = 'Copier', 2000);
      });
    });

    regenerateBtn.addEventListener('click', () => {
      const activeTab = popup.querySelector('.tab-btn.active').dataset.tab;
      if (activeTab === 'summary') {
        triggerSummary(true);
      } else {
        currentQA = null;
        generateQAContent();
      }
    });

    // Close on Escape key
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        popup.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  // Generate Q&A content
  async function generateQAContent() {
    const previewDiv = document.querySelector('.markdown-preview');
    if (previewDiv) {
      previewDiv.innerHTML = '<div class="qa-loading"><div class="loading-spinner"></div><p>Extraction des Q&A...</p></div>';
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'generateQA',
        transcript: transcriptData,
        title: currentMetadata.title,
        channel: currentMetadata.channel,
        url: currentMetadata.url
      });

      if (response && response.qa) {
        currentQA = response.qa;
        initializeMarkdownPreview(currentQA);
      } else {
        previewDiv.innerHTML = '<p class="qa-error">Impossible de générer les Q&A. Ce contenu ne semble pas être un format interview/webinar.</p>';
      }
    } catch (error) {
      console.error('YouTube Summary: Error generating Q&A:', error);
      previewDiv.innerHTML = '<p class="qa-error">Erreur lors de la génération des Q&A.</p>';
    }
  }

  // Current request ID for cancellation
  let currentRequestId = null;
  let loadingTimerInterval = null;

  // Estimate token count (roughly 4 chars per token for mixed content)
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  // Format token count for display
  function formatTokenCount(tokens) {
    if (tokens >= 1000) {
      return `~${(tokens / 1000).toFixed(1)}k`;
    }
    return `~${tokens}`;
  }

  // Show loading popup with progress stages
  function showLoadingPopup() {
    // Generate unique request ID
    currentRequestId = Date.now().toString();

    const popup = document.createElement('div');
    popup.id = 'youtube-summary-popup';
    popup.innerHTML = `
      <div class="popup-overlay">
        <div class="popup-content loading">
          <div class="popup-header">
            <h2>Génération du résumé</h2>
            <button class="close-btn">&times;</button>
          </div>
          <div class="popup-body">
            <div class="loading-progress">
              <div class="progress-step active" data-step="extract">
                <div class="step-icon">
                  <div class="loading-spinner-small"></div>
                </div>
                <div class="step-text">Extraction de la transcription...</div>
              </div>
              <div class="progress-step" data-step="api">
                <div class="step-icon">
                  <div class="step-dot"></div>
                </div>
                <div class="step-text">Envoi à l'API OpenAI</div>
              </div>
              <div class="progress-step" data-step="generate">
                <div class="step-icon">
                  <div class="step-dot"></div>
                </div>
                <div class="step-text">Génération du résumé AI</div>
              </div>
            </div>
            <div class="loading-stats">
              <div class="loading-timer">
                <span class="timer-value">0:00</span>
                <span class="timer-label">écoulé</span>
              </div>
              <div class="loading-tokens" style="display: none;">
                <span class="tokens-value">-</span>
                <span class="tokens-label">tokens</span>
              </div>
            </div>
            <p class="loading-hint">Les vidéos longues peuvent prendre plusieurs minutes...</p>
            <button class="cancel-btn">Annuler</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // Start timer
    const startTime = Date.now();
    const timerElement = popup.querySelector('.timer-value');
    loadingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }, 1000);

    // Close button
    const closeBtn = popup.querySelector('.close-btn');
    closeBtn.addEventListener('click', () => {
      cancelCurrentRequest();
      popup.remove();
    });

    // Cancel button
    const cancelBtn = popup.querySelector('.cancel-btn');
    cancelBtn.addEventListener('click', () => {
      cancelCurrentRequest();
      popup.remove();
    });

    return popup;
  }

  // Update loading progress step
  function updateLoadingStep(stepName) {
    const popup = document.getElementById('youtube-summary-popup');
    if (!popup) return;

    const steps = popup.querySelectorAll('.progress-step');
    let foundCurrent = false;

    steps.forEach(step => {
      const stepId = step.dataset.step;

      if (stepId === stepName) {
        // Current step - show spinner
        step.classList.add('active');
        step.classList.remove('completed');
        step.querySelector('.step-icon').innerHTML = '<div class="loading-spinner-small"></div>';
        foundCurrent = true;
      } else if (!foundCurrent) {
        // Previous steps - mark as completed
        step.classList.remove('active');
        step.classList.add('completed');
        step.querySelector('.step-icon').innerHTML = '<div class="step-check">✓</div>';
      } else {
        // Future steps - show dot
        step.classList.remove('active', 'completed');
        step.querySelector('.step-icon').innerHTML = '<div class="step-dot"></div>';
      }
    });
  }

  // Update token count display
  function updateTokenCount(transcript) {
    const popup = document.getElementById('youtube-summary-popup');
    if (!popup) return;

    const tokens = estimateTokens(transcript);
    const tokensContainer = popup.querySelector('.loading-tokens');
    const tokensValue = popup.querySelector('.tokens-value');

    if (tokensContainer && tokensValue) {
      tokensValue.textContent = formatTokenCount(tokens);
      tokensContainer.style.display = 'flex';
    }
  }

  // Cancel current request
  function cancelCurrentRequest() {
    if (loadingTimerInterval) {
      clearInterval(loadingTimerInterval);
      loadingTimerInterval = null;
    }
    if (currentRequestId) {
      chrome.runtime.sendMessage({
        action: 'cancelRequest',
        requestId: currentRequestId
      });
      currentRequestId = null;
    }
  }

  // Cleanup loading state
  function cleanupLoading() {
    if (loadingTimerInterval) {
      clearInterval(loadingTimerInterval);
      loadingTimerInterval = null;
    }
  }

  // Main function to trigger summary generation
  async function triggerSummary(force = false) {
    console.log('YouTube Summary: Triggering summary generation');

    // Check if we're on a video page
    if (!location.href.includes('/watch?v=')) {
      console.log('YouTube Summary: Not on a video page');
      return;
    }

    const loadingPopup = showLoadingPopup();
    const requestId = currentRequestId;

    try {
      // Step 1: Extract transcript
      updateLoadingStep('extract');
      if (!transcriptData || force) {
        transcriptData = await extractTranscript();
      }

      if (!transcriptData) {
        cleanupLoading();
        loadingPopup.remove();
        alert('No transcript available for this video. The video may not have captions enabled.');
        return;
      }

      // Show token count after extraction
      updateTokenCount(transcriptData);

      // Get video metadata
      const metadata = getVideoMetadata();

      // Step 2: Send to API
      updateLoadingStep('api');

      // Small delay to show the step transition
      await new Promise(resolve => setTimeout(resolve, 300));

      // Step 3: Generate summary
      updateLoadingStep('generate');

      // Send to background script for AI processing
      const response = await chrome.runtime.sendMessage({
        action: 'generateSummary',
        transcript: transcriptData,
        title: metadata.title,
        channel: metadata.channel,
        url: metadata.url,
        requestId: requestId
      });

      cleanupLoading();
      loadingPopup.remove();

      if (response && response.cancelled) {
        // Request was cancelled, do nothing
        return;
      }

      if (response && response.summary) {
        showSummaryPopup(response.summary, metadata);
      } else if (response && response.error) {
        showErrorPopup(response.error);
      } else {
        showErrorPopup('Failed to generate summary. Please check your OpenAI API key configuration.');
      }

    } catch (error) {
      console.error('YouTube Summary: Error generating summary:', error);
      cleanupLoading();
      loadingPopup.remove();
      showErrorPopup(error.message);
    }
  }

  // Show error popup instead of alert
  function showErrorPopup(errorMessage) {
    const popup = document.createElement('div');
    popup.id = 'youtube-summary-popup';
    popup.innerHTML = `
      <div class="popup-overlay">
        <div class="popup-content error-popup">
          <div class="popup-header">
            <h2>Erreur</h2>
            <button class="close-btn">&times;</button>
          </div>
          <div class="popup-body">
            <div class="error-icon">⚠️</div>
            <p class="error-message">${errorMessage}</p>
            <button class="retry-btn">Réessayer</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    const closeBtn = popup.querySelector('.close-btn');
    closeBtn.addEventListener('click', () => popup.remove());

    const retryBtn = popup.querySelector('.retry-btn');
    retryBtn.addEventListener('click', () => {
      popup.remove();
      triggerSummary(true);
    });

    const overlay = popup.querySelector('.popup-overlay');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) popup.remove();
    });
  }

  // Create floating action button
  function createSummaryButton() {
    // Only show on video pages
    if (!location.href.includes('/watch?v=')) {
      const existingBtn = document.getElementById('yt-summary-fab');
      if (existingBtn) existingBtn.remove();
      return;
    }

    // Check if button already exists
    if (document.getElementById('yt-summary-fab')) {
      return;
    }

    const button = document.createElement('button');
    button.id = 'yt-summary-fab';
    button.className = 'yt-summary-fab';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="none"/>
      </svg>
      <span>Résumer</span>
    `;

    button.addEventListener('click', () => {
      console.log('YouTube Summary: FAB clicked');
      triggerSummary();
    });

    document.body.appendChild(button);
    console.log('YouTube Summary: FAB added to page');
  }

  // Listen for URL changes (YouTube SPA navigation)
  const observer = new MutationObserver(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      transcriptData = null; // Reset transcript data for new video
      console.log('YouTube Summary: Video changed');
      // Recreate button for new page
      setTimeout(createSummaryButton, 500);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'triggerSummary') {
      triggerSummary();
    }
    return true;
  });

  // Initialize button on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createSummaryButton);
  } else {
    createSummaryButton();
  }

  console.log('YouTube Summary: Content script initialized');
})();