const READER_EPUB_OVERRIDES = `
.paragraph-preview .epub-fragment-page {
  max-height: 100%;
  box-sizing: border-box;
}
.paragraph-preview .epub-fragment,
.paragraph-preview .epub-fragment * {
  box-sizing: border-box;
}
.paragraph-preview .epub-fragment h1,
.paragraph-preview .epub-fragment h2,
.paragraph-preview .epub-fragment h3 {
  margin-top: 0.35em !important;
  margin-bottom: 0.55em !important;
  line-height: 1.25 !important;
}
.paragraph-preview .epub-fragment p {
  margin-top: 0.22em !important;
  margin-bottom: 0.22em !important;
  line-height: 1.38 !important;
}
.paragraph-preview .epub-fragment .shuming,
.paragraph-preview .epub-fragment .juzhong3 {
  padding-top: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0.8em !important;
}
.paragraph-preview .epub-fragment .roundsolid,
.paragraph-preview .epub-fragment .solidtb,
.paragraph-preview .epub-fragment .solidorange {
  margin: 0.45em 0 !important;
  padding: 0.35em 1.25em !important;
  border-radius: 12px !important;
}
.paragraph-preview .epub-fragment .roundsolid p,
.paragraph-preview .epub-fragment .solidtb p,
.paragraph-preview .epub-fragment .solidorange p {
  margin-top: 0.12em !important;
  margin-bottom: 0.12em !important;
  line-height: 1.32 !important;
}
.paragraph-preview .epub-fragment .chubanshe {
  position: static !important;
  bottom: auto !important;
  left: auto !important;
  width: auto !important;
  margin: 1.2em 0 0 !important;
}
.paragraph-preview .epub-fragment img {
  max-height: calc(100vh - 340px) !important;
  object-fit: contain;
}
`;

const state = {
  books: [],
  chapters: [],
  paragraphs: [],
  previewParagraphs: [],
  bookId: null,
  chapterIndex: 0,
  paragraphIndex: 0,
  previewChapterIndex: 0,
  previewParagraphIndex: 0,
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+0%",
  volume: "+0%",
  loadingAudio: false,
  pendingAutoplay: false,
  audioReady: false,
  libraryCollapsed: false,
  chapterPopoverOpen: false,
  chapterPopoverBookId: null,
  chapterAnchorRect: null,
  sentences: [],
  playbackSentences: [],
  sentenceTimings: [],
  activeSentenceIndex: 0,
  playbackSentenceIndex: 0,
  searchQuery: "",
  prefetchedNext: false,
  overlayRunning: false,
  lastPlayerStateSync: 0,
  pollingPlayerCommand: false,
  pendingStartPlaybackCommand: false,
  epubCss: "",
};

const el = {
  shell: document.querySelector(".shell"),
  chapterPopover: document.querySelector("#chapterPopover"),
  toggleLibrary: document.querySelector("#toggleLibrary"),
  refreshBooks: document.querySelector("#refreshBooks"),
  fileInput: document.querySelector("#fileInput"),
  pathForm: document.querySelector("#pathForm"),
  pathInput: document.querySelector("#pathInput"),
  bookList: document.querySelector("#bookList"),
  statusText: document.querySelector("#statusText"),
  bookTitle: document.querySelector("#bookTitle"),
  chapterTitle: document.querySelector("#chapterTitle"),
  voiceSelect: document.querySelector("#voiceSelect"),
  rateInput: document.querySelector("#rateInput"),
  overlayToggle: document.querySelector("#overlayToggle"),
  epubStyle: document.querySelector("#epubStyle"),
  chapterList: document.querySelector("#chapterList"),
  paragraphMeta: document.querySelector("#paragraphMeta"),
  paragraphPreview: document.querySelector("#paragraphPreview"),
  backToCurrentPage: document.querySelector("#backToCurrentPage"),
  audio: document.querySelector("#audio"),
  seekBar: document.querySelector("#seekBar"),
  currentTime: document.querySelector("#currentTime"),
  durationTime: document.querySelector("#durationTime"),
  prevChapter: document.querySelector("#prevChapter"),
  prevParagraph: document.querySelector("#prevParagraph"),
  playPause: document.querySelector("#playPause"),
  nextParagraph: document.querySelector("#nextParagraph"),
  nextChapter: document.querySelector("#nextChapter"),
};

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.detail || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new Error(message);
  }
  return res.json();
}

function setStatus(text) {
  el.statusText.textContent = text;
}

function updateOverlayButton() {
  el.overlayToggle.textContent = state.overlayRunning ? "关闭悬浮窗" : "打开悬浮窗";
  el.overlayToggle.classList.toggle("active", state.overlayRunning);
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "00:00";
  const total = Math.max(0, Math.floor(value));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function loadVoices() {
  const data = await api("/api/voices");
  state.voice = data.default;
  el.voiceSelect.innerHTML = data.voices
    .map((voice) => `<option value="${voice}">${voice}</option>`)
    .join("");
  el.voiceSelect.value = state.voice;
  el.rateInput.value = data.rate;
}

async function loadBooks(autoRestore = false) {
  state.books = await api("/api/books");
  renderBooks();
  if (autoRestore && !state.bookId && state.books.length) {
    const recent = state.books.find((book) => book.progress_updated_at) || state.books[0];
    await selectBook(recent.id);
  }
}

function renderBooks() {
  const query = state.searchQuery.trim().toLowerCase();
  const books = query
    ? state.books.filter((book) => (book.title || book.file_path || "").toLowerCase().includes(query))
    : state.books;

  if (!books.length) {
    el.bookList.innerHTML = `<div class="book-item"><strong>书库为空</strong><span>导入 txt、md 或 epub 开始听书</span></div>`;
    return;
  }

  el.bookList.innerHTML = books
    .map(
      (book) => `
        <div class="book-row" data-id="${book.id}">
          <button class="book-item ${book.id === state.bookId ? "active" : ""}" data-action="open">
            <strong>${escapeHtml(book.title || book.file_path)}</strong>
          </button>
          <div class="book-meta">
            <span>${book.file_format} · ${book.progress_updated_at ? "有进度" : "未开始"}</span>
            <button class="book-action delete-book" data-action="delete" type="button">删除</button>
            <button class="book-action" data-action="chapters" type="button">目录 &gt;</button>
          </div>
        </div>
      `,
    )
    .join("");

  document.querySelectorAll(".book-row").forEach((row) => {
    const bookId = row.dataset.id;
    row.querySelector('[data-action="open"]').addEventListener("click", () => selectBook(bookId));
    row.querySelector('[data-action="chapters"]').addEventListener("click", (event) => {
      event.stopPropagation();
      openBookChapters(bookId, event.currentTarget);
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", (event) => {
      event.stopPropagation();
      deleteBook(bookId);
    });
  });
}

function renderChapters() {
  el.chapterList.innerHTML = state.chapters
    .map((chapter) => {
      const startPage = getChapterStartPage(chapter.chapter_index);
      return `
        <button class="chapter-item ${chapter.chapter_index === state.previewChapterIndex ? "active" : ""}" data-index="${chapter.chapter_index}">
          <strong>${escapeHtml(chapter.title || `第 ${chapter.chapter_index + 1} 章`)}</strong>
          <span>第 ${startPage} 页起</span>
        </button>
      `;
    })
    .join("");

  document.querySelectorAll(".chapter-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.chapterPopoverOpen = false;
      renderPanels();
      previewJumpToChapter(Number(button.dataset.index));
    });
  });
}

function renderCurrent() {
  const book = state.books.find((item) => item.id === state.bookId);
  const chapter = state.chapters.find((item) => item.chapter_index === state.previewChapterIndex);
  const paragraph = state.previewParagraphs[state.previewParagraphIndex];
  const currentPage = getPageNumber(state.previewChapterIndex, state.previewParagraphIndex);
  const totalPages = getTotalPages();

  el.bookTitle.textContent = book?.title || "未选择书籍";
  el.chapterTitle.textContent = chapter?.title || "章节会显示在这里";
  el.paragraphMeta.textContent = totalPages ? `第 ${currentPage} 页 / 共 ${totalPages} 页` : "第 0 页 / 共 0 页";
  renderParagraph(paragraph || { text: "当前章节暂无内容。", html: null });
  el.backToCurrentPage.disabled = isPreviewCurrentPage();
  updatePlayButton();
  renderBooks();
  renderChapters();
  renderPanels();
}

function updatePlayButton(forcePlaying = null) {
  if (state.loadingAudio) {
    el.playPause.textContent = "正在准备...";
    el.playPause.disabled = true;
    return;
  }
  el.playPause.disabled = !state.bookId;
  if (typeof forcePlaying === "boolean") {
    el.playPause.textContent = forcePlaying ? "暂停" : "播放";
    return;
  }
  el.playPause.textContent = el.audio.paused ? "播放" : "暂停";
}

function renderPanels() {
  el.shell.classList.toggle("library-collapsed", state.libraryCollapsed);
  el.chapterPopover.hidden = !state.chapterPopoverOpen;
  if (state.chapterPopoverOpen && state.chapterAnchorRect) {
    const left = Math.max(12, Math.min(state.chapterAnchorRect.right + 8, window.innerWidth - 440));
    const top = Math.max(12, Math.min(state.chapterAnchorRect.top, window.innerHeight - 660));
    el.chapterPopover.style.left = `${left}px`;
    el.chapterPopover.style.top = `${top}px`;
  }
  el.toggleLibrary.textContent = state.libraryCollapsed ? "›" : "‹";
  el.toggleLibrary.title = state.libraryCollapsed ? "展开书库" : "收起书库";
  el.toggleLibrary.setAttribute("aria-label", el.toggleLibrary.title);
}

function renderParagraph(paragraph) {
  const text = typeof paragraph === "string" ? paragraph : paragraph?.text || "";
  const html = typeof paragraph === "string" ? null : paragraph?.html;
  if (html) {
    renderEpubParagraph(html, text);
  } else {
    renderPlainParagraph(text);
  }
  bindSentenceClicks();
}

function renderPlainParagraph(text) {
  state.sentences = splitSentences(text);
  prepareRenderedSentences();
  el.paragraphPreview.classList.remove("epub-mode");
  el.paragraphPreview.innerHTML = state.sentences
    .map((sentence, index) => sentenceSpanHtml(sentence, index))
    .join("");
}

function renderEpubParagraph(html, fallbackText) {
  el.paragraphPreview.classList.add("epub-mode");
  el.paragraphPreview.innerHTML = html;
  const pieces = collectEpubSentencePieces(el.paragraphPreview);
  if (!pieces.length) {
    state.sentences = fallbackText ? splitSentences(fallbackText) : [];
    prepareRenderedSentences();
    return;
  }
  state.sentences = pieces.map((piece) => piece.sentence);
  prepareRenderedSentences();
  wrapEpubSentencePieces(pieces);
}

function prepareRenderedSentences() {
  if (isPreviewCurrentPage()) {
    applySentenceTimings();
    state.playbackSentences = state.sentences.map((sentence) => ({ ...sentence }));
  }
  state.activeSentenceIndex = isPreviewCurrentPage()
    ? Math.min(state.playbackSentenceIndex, Math.max(0, state.sentences.length - 1))
    : Math.min(state.activeSentenceIndex, Math.max(0, state.sentences.length - 1));
}

function sentenceSpanHtml(sentence, index) {
  const interactive = sentence.timingIndex !== undefined || !isPreviewCurrentPage();
  const classes = ["sentence", interactive ? "timed" : "untimed"];
  if (index === state.activeSentenceIndex && sentence.timingIndex !== undefined && isPreviewCurrentPage()) classes.push("active");
  return `<span class="${classes.join(" ")}" data-index="${index}">${escapeHtml(sentence.text)}</span>`;
}

function sentenceClasses(sentence, index) {
  const interactive = sentence.timingIndex !== undefined || !isPreviewCurrentPage();
  const classes = ["sentence", interactive ? "timed" : "untimed"];
  if (index === state.activeSentenceIndex && sentence.timingIndex !== undefined && isPreviewCurrentPage()) classes.push("active");
  return classes.join(" ");
}

function bindSentenceClicks() {
  document.querySelectorAll(".sentence").forEach((node) => {
    if (node.classList.contains("timed")) {
      node.addEventListener("click", () => playFromSentence(Number(node.dataset.index)));
    }
  });
}

function getTotalPages() {
  return state.chapters.reduce((sum, chapter) => sum + Number(chapter.paragraph_count || 0), 0);
}

function getChapterStartPage(chapterIndex) {
  return (
    state.chapters
      .filter((chapter) => chapter.chapter_index < chapterIndex)
      .reduce((sum, chapter) => sum + Number(chapter.paragraph_count || 0), 0) + 1
  );
}

function getCurrentPageNumber() {
  return getPageNumber(state.chapterIndex, state.paragraphIndex);
}

function getPageNumber(chapterIndex, paragraphIndex) {
  return getChapterStartPage(chapterIndex) + paragraphIndex;
}

function isPreviewCurrentPage() {
  return state.previewChapterIndex === state.chapterIndex && state.previewParagraphIndex === state.paragraphIndex;
}

function splitSentences(text) {
  const matches = String(text).match(/[^。！？；!?;]+[。！？；!?;]?\s*/g) || [String(text)];
  const sentences = [];
  let offset = 0;
  for (const match of matches) {
    const start = offset;
    offset += match.length;
    if (match.trim()) {
      sentences.push({ text: match, start, end: offset });
    }
  }
  return sentences.length ? sentences : [{ text, start: 0, end: String(text).length }];
}

function collectEpubSentencePieces(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  const pieces = [];
  let offset = 0;
  for (const node of textNodes) {
    const text = node.nodeValue;
    const matches = [...text.matchAll(/[^。！？；!?;]+[。！？；!?;]?\s*/g)];
    if (!matches.length) {
      offset += text.length;
      continue;
    }
    for (const match of matches) {
      const value = match[0];
      const start = match.index || 0;
      const end = start + value.length;
      if (!value.trim()) continue;
      const sentence = { text: value, start: offset + start, end: offset + end };
      pieces.push({ node, start, end, sentence, index: pieces.length });
    }
    offset += text.length;
  }
  return pieces;
}

function wrapEpubSentencePieces(pieces) {
  const byNode = new Map();
  pieces.forEach((piece) => {
    if (!byNode.has(piece.node)) byNode.set(piece.node, []);
    byNode.get(piece.node).push(piece);
  });

  byNode.forEach((nodePieces, node) => {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    nodePieces.forEach((piece) => {
      if (piece.start > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, piece.start)));
      }
      const span = document.createElement("span");
      span.className = sentenceClasses(state.sentences[piece.index], piece.index);
      span.dataset.index = String(piece.index);
      span.textContent = text.slice(piece.start, piece.end);
      fragment.append(span);
      cursor = piece.end;
    });
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(fragment, node);
  });
}

async function playFromSentence(index) {
  const wasPreviewingOtherPage = !isPreviewCurrentPage();
  if (wasPreviewingOtherPage) {
    await switchPlaybackToPreviewPage();
  }
  const sentence = state.sentences[index];
  const timing = state.sentenceTimings.find((item) => item.sentence_index === sentence?.timingIndex);
  const textLength = state.sentences.at(-1)?.end || 1;
  if (!sentence || !el.audio.duration) return;
  state.playbackSentenceIndex = index;
  state.activeSentenceIndex = index;
  if (timing) {
    el.audio.currentTime = timing.start_ms / 1000;
  } else if (wasPreviewingOtherPage) {
    el.audio.currentTime = (sentence.start / textLength) * el.audio.duration;
  } else {
    return;
  }
  highlightSentence(index);
  updatePlayButton(true);
  try {
    await el.audio.play();
  } catch (error) {
    updatePlayButton(false);
    alert(`播放失败：${error.message}`);
  }
  updatePlayButton();
}

async function switchPlaybackToPreviewPage() {
  await saveProgress();
  state.chapterIndex = state.previewChapterIndex;
  state.paragraphIndex = state.previewParagraphIndex;
  state.paragraphs = state.previewParagraphs;
  state.activeSentenceIndex = 0;
  await loadAudio(0, false);
  await saveProgress();
}

function highlightSentence(index) {
  state.playbackSentenceIndex = index;
  if (!isPreviewCurrentPage()) return;
  state.activeSentenceIndex = index;
  document.querySelectorAll(".sentence").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.index) === index);
  });
}

async function selectBook(bookId) {
  state.bookId = bookId;
  state.chapterPopoverOpen = false;
  setStatus("正在读取进度");
  const [chapters, progress] = await Promise.all([
    api(`/api/books/${bookId}/chapters`),
    api(`/api/books/${bookId}/progress`),
  ]);
  state.chapters = chapters;
  state.voice = progress.voice || state.voice;
  state.rate = progress.rate || state.rate;
  state.volume = progress.volume || state.volume;
  state.chapterIndex = progress.chapter_index || 0;
  state.paragraphIndex = progress.paragraph_index || 0;
  state.previewChapterIndex = state.chapterIndex;
  state.previewParagraphIndex = state.paragraphIndex;
  syncSettings();
  await loadEpubCss(bookId);
  await loadParagraphs(state.chapterIndex, true);
  await loadAudio(progress.audio_position_ms || 0);
  setStatus("就绪");
}

async function loadEpubCss(bookId) {
  try {
    const data = await api(`/api/books/${bookId}/epub-css`);
    state.epubCss = data.css || "";
    el.epubStyle.textContent = `${state.epubCss}\n${READER_EPUB_OVERRIDES}`;
  } catch {
    state.epubCss = "";
    el.epubStyle.textContent = READER_EPUB_OVERRIDES;
  }
}

async function loadParagraphs(chapterIndex, syncPreview = true) {
  state.paragraphs = await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapterIndex}`);
  state.chapterIndex = chapterIndex;
  if (state.paragraphIndex >= state.paragraphs.length) {
    state.paragraphIndex = 0;
  }
  if (syncPreview) {
    state.previewChapterIndex = state.chapterIndex;
    state.previewParagraphIndex = state.paragraphIndex;
    state.previewParagraphs = state.paragraphs;
  }
  renderCurrent();
}

async function loadPreviewParagraphs(chapterIndex) {
  state.previewParagraphs = await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapterIndex}`);
  state.previewChapterIndex = chapterIndex;
  if (state.previewParagraphIndex >= state.previewParagraphs.length) {
    state.previewParagraphIndex = 0;
  }
  renderCurrent();
}

async function loadAudio(positionMs = 0, autoplay = false) {
  if (!state.bookId || !state.paragraphs[state.paragraphIndex]) return;
  if (!isAudioParagraph(state.paragraphs[state.paragraphIndex])) {
    const moved = await moveToNextAudioPage(state.paragraphIndex + 1);
    if (!moved) return;
  }
  state.loadingAudio = true;
  state.pendingAutoplay = autoplay;
  state.audioReady = false;
  state.activeSentenceIndex = 0;
  state.playbackSentenceIndex = 0;
  state.sentenceTimings = [];
  state.playbackSentences = [];
  state.prefetchedNext = false;
  setStatus("正在准备音频");
  updatePlayButton();
  const params = new URLSearchParams({
    chapter_index: state.chapterIndex,
    paragraph_index: state.paragraphIndex,
    voice: state.voice,
    rate: state.rate,
    volume: state.volume,
    cache_bust: Date.now(),
  });
  el.audio.src = `/api/books/${state.bookId}/audio?${params.toString()}`;
  el.audio.load();
  renderCurrent();
  return new Promise((resolve, reject) => {
    el.audio.onloadedmetadata = async () => {
      el.audio.currentTime = Math.min(positionMs / 1000, el.audio.duration || 0);
      await loadSentenceTimings();
      updateProgress();
      state.audioReady = true;
      state.loadingAudio = false;
      setStatus("就绪");
      updatePlayButton();
      syncPlayerState(true);
      if (state.pendingStartPlaybackCommand) {
        state.pendingStartPlaybackCommand = false;
        try {
          await el.audio.play();
        } catch {
          // Browser autoplay policy may require a user gesture on the page.
        }
        updatePlayButton();
        syncPlayerState(true);
      }
      if (state.pendingAutoplay) {
        state.pendingAutoplay = false;
        try {
          await el.audio.play();
        } catch (error) {
          alert(`播放失败：${error.message}`);
        }
        updatePlayButton();
        syncPlayerState(true);
      }
      resolve();
    };
    el.audio.onerror = () => {
      state.loadingAudio = false;
      state.pendingAutoplay = false;
      state.audioReady = false;
      setStatus("音频准备失败");
      updatePlayButton();
      syncPlayerState(true);
      alert("音频准备失败，请稍后重试。");
      reject(new Error("音频准备失败"));
    };
  });
}

function isAudioParagraph(paragraph) {
  return Boolean(paragraph && Number(paragraph.is_audio ?? 1) === 1);
}

function findNextAudioParagraph(startIndex = 0) {
  for (let index = Math.max(0, startIndex); index < state.paragraphs.length; index += 1) {
    if (isAudioParagraph(state.paragraphs[index])) return index;
  }
  return null;
}

async function moveToNextAudioPage(startIndex = 0) {
  const sameChapterIndex = findNextAudioParagraph(startIndex);
  if (sameChapterIndex !== null) {
    state.paragraphIndex = sameChapterIndex;
    state.previewChapterIndex = state.chapterIndex;
    state.previewParagraphIndex = state.paragraphIndex;
    state.previewParagraphs = state.paragraphs;
    renderCurrent();
    return true;
  }

  const followingChapters = state.chapters.filter((chapter) => chapter.chapter_index > state.chapterIndex);
  for (const chapter of followingChapters) {
    const paragraphs = await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapter.chapter_index}`);
    const index = paragraphs.findIndex(isAudioParagraph);
    if (index >= 0) {
      state.chapterIndex = chapter.chapter_index;
      state.paragraphs = paragraphs;
      state.paragraphIndex = index;
      state.previewChapterIndex = state.chapterIndex;
      state.previewParagraphIndex = state.paragraphIndex;
      state.previewParagraphs = state.paragraphs;
      renderCurrent();
      return true;
    }
  }
  return false;
}

async function loadSentenceTimings() {
  if (!state.bookId) return;
  const params = new URLSearchParams({
    chapter_index: state.chapterIndex,
    paragraph_index: state.paragraphIndex,
    voice: state.voice,
    rate: state.rate,
    volume: state.volume,
  });
  try {
    state.sentenceTimings = await api(`/api/books/${state.bookId}/sentence-timings?${params.toString()}`);
    if (isPreviewCurrentPage()) {
      renderParagraph(state.paragraphs[state.paragraphIndex] || { text: "" });
    }
  } catch {
    state.sentenceTimings = [];
    if (isPreviewCurrentPage()) {
      renderParagraph(state.paragraphs[state.paragraphIndex] || { text: "" });
    }
  }
}

function applySentenceTimings() {
  state.sentences.forEach((sentence) => {
    delete sentence.timingIndex;
  });
  const used = new Set();
  for (const timing of state.sentenceTimings) {
    const timingText = normalizeSentenceText(timing.text);
    if (!timingText) continue;
    const matchIndex = state.sentences.findIndex((sentence, index) => {
      if (used.has(index) || sentence.timingIndex !== undefined) return false;
      const sentenceText = normalizeSentenceText(sentence.text);
      return sentenceText === timingText || sentenceText.includes(timingText) || timingText.includes(sentenceText);
    });
    if (matchIndex >= 0) {
      state.sentences[matchIndex].timingIndex = timing.sentence_index;
      used.add(matchIndex);
    }
  }
  const firstTimed = state.sentences.findIndex((sentence) => sentence.timingIndex !== undefined);
  state.activeSentenceIndex = firstTimed >= 0 ? firstTimed : 0;
}

function normalizeSentenceText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[，,：:、]/g, "")
    .trim();
}

async function reloadCurrentAudioWithSettings() {
  if (!state.bookId) return;
  const shouldPlay = !el.audio.paused;
  await saveProgress();
  await loadAudio(0, shouldPlay);
}

async function startPlayback() {
  if (!state.bookId || state.loadingAudio) return;
  if (!isAudioParagraph(state.paragraphs[state.paragraphIndex])) {
    const moved = await moveToNextAudioPage(state.paragraphIndex + 1);
    if (!moved) return;
  }
  if (!state.audioReady || !el.audio.src) {
    await loadAudio(Math.floor((el.audio.currentTime || 0) * 1000), true);
    return;
  }
  try {
    await el.audio.play();
  } catch (error) {
    alert(`播放失败：${error.message}`);
  }
  updatePlayButton();
}

async function togglePlayback() {
  if (!state.bookId || state.loadingAudio) return;
  if (el.audio.paused) {
    await startPlayback();
  } else {
    el.audio.pause();
    await saveProgress();
  }
  updatePlayButton();
  syncPlayerState(true);
}

function syncSettings() {
  el.voiceSelect.value = state.voice;
  el.rateInput.value = state.rate;
}

async function saveProgress() {
  if (!state.bookId) return;
  await fetch(`/api/books/${state.bookId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter_index: state.chapterIndex,
      paragraph_index: state.paragraphIndex,
      audio_position_ms: Math.floor((el.audio.currentTime || 0) * 1000),
      voice: state.voice,
      rate: state.rate,
      volume: state.volume,
    }),
    keepalive: true,
  });
}

async function jumpToChapter(index, autoplay = false, syncPreview = true) {
  if (index < 0 || index >= state.chapters.length) return;
  await saveProgress();
  state.paragraphIndex = 0;
  state.activeSentenceIndex = 0;
  await loadParagraphs(index, syncPreview);
  await loadAudio(0, autoplay);
  await saveProgress();
}

async function jumpToParagraph(index, autoplay = false) {
  const syncPreview = isPreviewCurrentPage();
  if (index < 0) {
    await jumpToChapter(state.chapterIndex - 1, autoplay, syncPreview);
    state.paragraphIndex = Math.max(0, state.paragraphs.length - 1);
    if (syncPreview) {
      state.previewChapterIndex = state.chapterIndex;
      state.previewParagraphIndex = state.paragraphIndex;
      state.previewParagraphs = state.paragraphs;
    }
    await loadAudio(0, autoplay);
    return;
  }
  if (index >= state.paragraphs.length) {
    await jumpToChapter(state.chapterIndex + 1, autoplay, syncPreview);
    return;
  }
  await saveProgress();
  state.paragraphIndex = index;
  state.activeSentenceIndex = 0;
  if (syncPreview) {
    state.previewChapterIndex = state.chapterIndex;
    state.previewParagraphIndex = state.paragraphIndex;
    state.previewParagraphs = state.paragraphs;
  }
  renderCurrent();
  await loadAudio(0, autoplay);
  await saveProgress();
}

async function previewJumpToParagraph(index) {
  if (!state.bookId) return;
  if (index < 0) {
    const previousChapter = [...state.chapters]
      .reverse()
      .find((chapter) => chapter.chapter_index < state.previewChapterIndex);
    if (!previousChapter) return;
    const paragraphs = await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${previousChapter.chapter_index}`);
    state.previewChapterIndex = previousChapter.chapter_index;
    state.previewParagraphs = paragraphs;
    state.previewParagraphIndex = Math.max(0, paragraphs.length - 1);
    renderCurrent();
    return;
  }
  if (index >= state.previewParagraphs.length) {
    const nextChapter = state.chapters.find((chapter) => chapter.chapter_index > state.previewChapterIndex);
    if (!nextChapter) return;
    state.previewParagraphIndex = 0;
    await loadPreviewParagraphs(nextChapter.chapter_index);
    return;
  }
  state.previewParagraphIndex = index;
  renderCurrent();
}

async function previewJumpToChapter(index) {
  if (!state.bookId || !state.chapters.some((chapter) => chapter.chapter_index === index)) return;
  state.previewParagraphIndex = 0;
  await loadPreviewParagraphs(index);
}

function backToCurrentPage() {
  state.previewChapterIndex = state.chapterIndex;
  state.previewParagraphIndex = state.paragraphIndex;
  state.previewParagraphs = state.paragraphs;
  renderCurrent();
}

function isEditingText(event) {
  const tagName = event.target?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || event.target?.isContentEditable;
}

function handleKeyboardShortcuts(event) {
  if (isEditingText(event) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    previewJumpToParagraph(state.previewParagraphIndex - 1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    previewJumpToParagraph(state.previewParagraphIndex + 1);
  } else if (event.key === " ") {
    event.preventDefault();
    togglePlayback();
  }
}

function updateProgress() {
  const duration = el.audio.duration || 0;
  const current = el.audio.currentTime || 0;
  el.currentTime.textContent = formatTime(current);
  el.durationTime.textContent = formatTime(duration);
  el.seekBar.value = duration ? Math.floor((current / duration) * 1000) : 0;
  updateSentenceHighlight(current, duration);
  maybePrefetchNextPage(current, duration);
  syncPlayerState();
}

function maybePrefetchNextPage(current, duration) {
  if (!duration || state.prefetchedNext || current / duration < 0.7) return;
  const next = getNextPageTarget();
  if (!next) return;
  state.prefetchedNext = true;
  fetch(`/api/books/${state.bookId}/prefetch-audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter_index: next.chapterIndex,
      paragraph_index: next.paragraphIndex,
      voice: state.voice,
      rate: state.rate,
      volume: state.volume,
    }),
  }).catch(() => {});
}

function getNextPageTarget() {
  if (!state.bookId) return null;
  if (state.paragraphIndex + 1 < state.paragraphs.length) {
    return { chapterIndex: state.chapterIndex, paragraphIndex: state.paragraphIndex + 1 };
  }
  const nextChapter = state.chapters.find((chapter) => chapter.chapter_index > state.chapterIndex);
  if (!nextChapter) return null;
  return { chapterIndex: nextChapter.chapter_index, paragraphIndex: 0 };
}

function getPlayerStatePayload() {
  const sentences = state.playbackSentences.length ? state.playbackSentences : state.sentences;
  const currentSentence = sentences[state.playbackSentenceIndex]?.text?.trim() || "";
  return {
    book_title: "",
    chapter_title: "",
    page_label: "",
    current_sentence: currentSentence,
    next_sentence: "",
    is_playing: Boolean(state.bookId && state.audioReady && !el.audio.paused),
  };
}

function syncPlayerState(force = false) {
  const now = Date.now();
  if (!force && now - state.lastPlayerStateSync < 300) return;
  state.lastPlayerStateSync = now;
  fetch("/api/player/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getPlayerStatePayload()),
    keepalive: true,
  }).catch(() => {});
}

async function refreshOverlayStatus() {
  try {
    const data = await api("/api/overlay/status");
    state.overlayRunning = Boolean(data.running);
    updateOverlayButton();
  } catch {
    state.overlayRunning = false;
    updateOverlayButton();
  }
}

async function toggleOverlay() {
  el.overlayToggle.disabled = true;
  try {
    const path = state.overlayRunning ? "/api/overlay/stop" : "/api/overlay/start";
    const data = await api(path, { method: "POST" });
    state.overlayRunning = Boolean(data.running);
    updateOverlayButton();
  } catch (error) {
    setStatus(`悬浮窗操作失败：${error.message}`);
  } finally {
    el.overlayToggle.disabled = false;
  }
}

async function pollPlayerCommand() {
  if (state.pollingPlayerCommand) return;
  state.pollingPlayerCommand = true;
  try {
    const data = await api("/api/player/command");
    if (data.command === "toggle_play") {
      await togglePlayback();
    } else if (data.command === "start_playback") {
      await startPlaybackFromCommand();
    }
  } catch {
    // The command channel is best-effort while the local service is running.
  } finally {
    state.pollingPlayerCommand = false;
  }
}

async function startPlaybackFromCommand() {
  if (!state.bookId || state.loadingAudio) {
    state.pendingStartPlaybackCommand = true;
    return;
  }
  state.pendingStartPlaybackCommand = false;
  if (el.audio.paused) {
    await startPlayback();
  }
}

function updateSentenceHighlight(current, duration) {
  const sentences = isPreviewCurrentPage() ? state.sentences : state.playbackSentences;
  if (!duration || !sentences.length) return;
  if (state.sentenceTimings.length) {
    const currentMs = current * 1000;
    const timingIndex = state.sentenceTimings.findIndex((timing, timingListIndex) => {
      const next = state.sentenceTimings[timingListIndex + 1];
      return currentMs >= timing.start_ms && (!next || currentMs < next.start_ms);
    });
    if (timingIndex >= 0) {
      const timing = state.sentenceTimings[timingIndex];
      const sentenceIndex = sentences.findIndex(
        (sentence) => sentence.timingIndex === timing.sentence_index,
      );
      if (sentenceIndex >= 0 && sentenceIndex !== state.playbackSentenceIndex) {
        highlightSentence(sentenceIndex);
      }
    }
    return;
  }
  const textLength = sentences.at(-1)?.end || 1;
  const textPosition = (current / duration) * textLength;
  const index = sentences.findIndex(
    (sentence) => textPosition >= sentence.start && textPosition < sentence.end,
  );
  if (index >= 0 && index !== state.playbackSentenceIndex) {
    highlightSentence(index);
  }
}

async function importUpload(file) {
  const formData = new FormData();
  formData.append("file", file);
  setStatus("正在导入书籍");
  const book = await api("/api/books/import", { method: "POST", body: formData });
  await loadBooks();
  await selectBook(book.id);
}

async function openBookChapters(bookId, anchor) {
  if (state.chapterPopoverOpen && state.chapterPopoverBookId === bookId) {
    state.chapterPopoverOpen = false;
    renderPanels();
    return;
  }
  const chapters = await api(`/api/books/${bookId}/chapters`);
  state.chapterPopoverBookId = bookId;
  state.chapterAnchorRect = anchor.getBoundingClientRect();
  state.chapterPopoverOpen = true;
  el.chapterList.innerHTML = chapters
    .map((chapter) => {
      const startPage = getChapterStartPageFor(chapters, chapter.chapter_index);
      return `
        <button class="chapter-item ${bookId === state.bookId && chapter.chapter_index === state.previewChapterIndex ? "active" : ""}" data-index="${chapter.chapter_index}">
          <strong>${escapeHtml(chapter.title || `第 ${chapter.chapter_index + 1} 章`)}</strong>
          <span>第 ${startPage} 页起</span>
        </button>
      `;
    })
    .join("");
  document.querySelectorAll(".chapter-item").forEach((button) => {
    button.addEventListener("click", async () => {
      if (state.bookId !== bookId) {
        await selectBook(bookId);
      }
      state.chapterPopoverOpen = false;
      await previewJumpToChapter(Number(button.dataset.index));
    });
  });
  renderPanels();
}

async function deleteBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  const title = book?.title || "这本书";
  if (!confirm(`确定删除《${title}》吗？这会同时删除本地缓存音频。`)) return;
  const res = await fetch(`/api/books/${bookId}`, { method: "DELETE" });
  if (!res.ok) {
    setStatus("删除失败");
    return;
  }
  if (state.bookId === bookId) {
    state.bookId = null;
    state.chapters = [];
    state.paragraphs = [];
    state.previewParagraphs = [];
    state.chapterIndex = 0;
    state.paragraphIndex = 0;
    state.previewChapterIndex = 0;
    state.previewParagraphIndex = 0;
    state.sentences = [];
    state.playbackSentences = [];
    state.sentenceTimings = [];
    state.playbackSentenceIndex = 0;
    state.epubCss = "";
    el.epubStyle.textContent = "";
    state.audioReady = false;
    state.loadingAudio = false;
    state.pendingAutoplay = false;
    el.audio.removeAttribute("src");
    el.bookTitle.textContent = "未选择书籍";
    el.chapterTitle.textContent = "章节会显示在这里";
    el.paragraphMeta.textContent = "第 0 页 / 共 0 页";
    el.paragraphPreview.textContent = "导入书籍后，这里会显示当前段落文本。";
    updatePlayButton();
    syncPlayerState(true);
  }
  state.chapterPopoverOpen = false;
  await loadBooks(true);
  setStatus("已删除");
}

function getChapterStartPageFor(chapters, chapterIndex) {
  return (
    chapters
      .filter((chapter) => chapter.chapter_index < chapterIndex)
      .reduce((sum, chapter) => sum + Number(chapter.paragraph_count || 0), 0) + 1
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

el.refreshBooks.addEventListener("click", loadBooks);
el.toggleLibrary.addEventListener("click", () => {
  state.libraryCollapsed = !state.libraryCollapsed;
  renderPanels();
});
el.fileInput.addEventListener("change", async () => {
  if (el.fileInput.files[0]) {
    try {
      await importUpload(el.fileInput.files[0]);
    } catch (error) {
      setStatus(error.message);
    } finally {
      el.fileInput.value = "";
    }
  }
});
el.pathForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.searchQuery = el.pathInput.value;
  renderBooks();
});
el.pathInput.addEventListener("input", () => {
  state.searchQuery = el.pathInput.value;
  renderBooks();
});

el.overlayToggle.addEventListener("click", toggleOverlay);
el.playPause.addEventListener("click", togglePlayback);
el.prevChapter.addEventListener("click", () => previewJumpToChapter(state.previewChapterIndex - 1));
el.nextChapter.addEventListener("click", () => previewJumpToChapter(state.previewChapterIndex + 1));
el.prevParagraph.addEventListener("click", () => previewJumpToParagraph(state.previewParagraphIndex - 1));
el.nextParagraph.addEventListener("click", () => previewJumpToParagraph(state.previewParagraphIndex + 1));
el.backToCurrentPage.addEventListener("click", backToCurrentPage);
el.seekBar.addEventListener("input", () => {
  if (!el.audio.duration) return;
  el.audio.currentTime = (Number(el.seekBar.value) / 1000) * el.audio.duration;
});
el.voiceSelect.addEventListener("change", async () => {
  state.voice = el.voiceSelect.value;
  await reloadCurrentAudioWithSettings();
});
el.rateInput.addEventListener("change", async () => {
  state.rate = el.rateInput.value || "+0%";
  await reloadCurrentAudioWithSettings();
});
el.audio.addEventListener("timeupdate", updateProgress);
el.audio.addEventListener("play", () => {
  updatePlayButton();
  syncPlayerState(true);
});
el.audio.addEventListener("playing", () => {
  updatePlayButton(true);
  syncPlayerState(true);
});
el.audio.addEventListener("pause", async () => {
  await saveProgress();
  updatePlayButton();
  syncPlayerState(true);
});
el.audio.addEventListener("ended", () => jumpToParagraph(state.paragraphIndex + 1, true));
window.addEventListener("beforeunload", saveProgress);
window.addEventListener("keydown", handleKeyboardShortcuts);
setInterval(saveProgress, 7000);
setInterval(pollPlayerCommand, 500);
setInterval(refreshOverlayStatus, 3000);
setInterval(() => syncPlayerState(true), 2000);

renderPanels();
updateOverlayButton();
refreshOverlayStatus();
loadVoices()
  .then(() => loadBooks(true))
  .then(() => {
    if (state.pendingStartPlaybackCommand) {
      return startPlaybackFromCommand();
    }
  })
  .catch((error) => setStatus(error.message));
