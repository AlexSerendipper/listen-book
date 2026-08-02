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
  text-align: left !important;
}
.paragraph-preview .epub-fragment blockquote p,
.paragraph-preview .epub-fragment li,
.paragraph-preview .epub-fragment .fnote,
.paragraph-preview .epub-fragment .footnote,
.paragraph-preview .epub-fragment .footnote-content {
  text-align: left !important;
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
  margin: 0.45em 2px !important;
  padding: 0.35em 1.25em !important;
  border-radius: 12px !important;
  border-left-color: transparent !important;
  position: relative;
}
.paragraph-preview .epub-fragment .roundsolid::before,
.paragraph-preview .epub-fragment .solidtb::before,
.paragraph-preview .epub-fragment .solidorange::before {
  content: "";
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 1px;
  background: #c53908;
  pointer-events: none;
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
const VISUAL_PAGE_EDGE_BLEED = 8;

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
  visualPageIndex: 0,
  visualPageCount: 1,
  visualPageKey: "",
  pendingVisualPage: "first",
  paginationSizeKey: "",
  chapterPageCounts: new Map(),
  chapterStartPages: new Map(),
  paragraphStartPages: new Map(),
  totalVisualPages: 0,
  paragraphsByChapter: new Map(),
  renderedSentencesByParagraph: new Map(),
  paginationRequestId: 0,
  paginationResizeTimer: null,
  paginationResizeObserver: null,
  pendingPaginationViewState: null,
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "+0%",
  volume: "+0%",
  loadingAudio: false,
  pendingAutoplay: false,
  audioReady: false,
  audioLoadRequestId: 0,
  cancelPendingAudioLoad: null,
  playbackSwitchCount: 0,
  libraryCollapsed: true,
  hasPlaybackPosition: false,
  progressSaveTimer: null,
  chapterPopoverOpen: false,
  chapterPopoverBookId: null,
  chapterAnchorRect: null,
  sentences: [],
  playbackSentences: [],
  sentenceTimings: [],
  activeSentenceIndex: 0,
  playbackSentenceIndex: 0,
  playbackVisualPageIndex: 0,
  sentenceClickRequestId: 0,
  sentenceClickGuard: null,
  lastSentenceClickGuard: null,
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
  library: document.querySelector(".library"),
  libraryBackdrop: document.querySelector("#libraryBackdrop"),
  openLibrary: document.querySelector("#openLibrary"),
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
          <button
            class="book-item ${book.id === state.bookId ? "active" : ""}"
            data-action="open"
            title="${escapeHtml(book.title || book.file_path)}"
          >
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
  const visualPageKey = `${state.bookId || ""}:${state.previewChapterIndex}`;

  if (state.visualPageKey !== visualPageKey) {
    state.visualPageKey = visualPageKey;
    state.visualPageIndex = 0;
  }

  el.bookTitle.textContent = book?.title || "未选择书籍";
  el.chapterTitle.textContent = chapter?.title || "章节会显示在这里";
  renderChapter(state.previewParagraphs);
  updateVisualPagination();
  const recentSentenceClick = state.lastSentenceClickGuard;
  if (
    recentSentenceClick?.requestId === state.sentenceClickRequestId &&
    recentSentenceClick.expiresAt > Date.now()
  ) {
    restoreSentenceClickPage(recentSentenceClick);
  }
  updateParagraphMeta();
  updateBackToCurrentPageButton();
  updatePlayButton();
  renderBooks();
  renderChapters();
  renderPanels();
}

function renderChapter(paragraphs) {
  state.renderedSentencesByParagraph = new Map();
  el.paragraphPreview.classList.add("epub-mode");
  el.paragraphPreview.innerHTML = '<div class="visual-page-flow"></div>';
  const flow = getVisualPageFlow();
  if (!paragraphs.length) {
    flow.textContent = "当前章节暂无内容。";
    state.sentences = [];
    bindSentenceClicks();
    return;
  }
  paragraphs.forEach((paragraph) => {
    flow.append(createRenderedParagraph(paragraph));
  });
  stabilizeSentencePageBreaks(el.paragraphPreview);
  state.sentences = state.renderedSentencesByParagraph.get(state.paragraphIndex) || [];
  prepareRenderedSentences();
  refreshRenderedSentenceClasses();
  bindSentenceClicks();
}

function createRenderedParagraph(paragraph, measurement = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "chapter-paragraph";
  wrapper.dataset.paragraphIndex = String(paragraph.paragraph_index);
  let sentences = [];
  if (paragraph.html) {
    wrapper.innerHTML = paragraph.html;
    const pieces = collectEpubSentencePieces(wrapper);
    sentences = pieces.map((piece) => piece.sentence);
    wrapChapterSentencePieces(pieces, paragraph.paragraph_index, measurement);
  } else {
    sentences = splitSentences(paragraph.text || "");
    wrapper.innerHTML = sentences
      .map(
        (sentence, index) =>
          `<span class="sentence" data-paragraph-index="${paragraph.paragraph_index}" data-index="${index}">${escapeHtml(sentence.text)}</span>`,
      )
      .join("");
  }
  if (!measurement) {
    state.renderedSentencesByParagraph.set(paragraph.paragraph_index, sentences);
  }
  return wrapper;
}

function wrapChapterSentencePieces(pieces, paragraphIndex, measurement = false) {
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
      span.className = "sentence";
      span.dataset.paragraphIndex = String(paragraphIndex);
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
  el.library.setAttribute("aria-hidden", String(state.libraryCollapsed));
  el.library.inert = state.libraryCollapsed;
  el.libraryBackdrop.hidden = state.libraryCollapsed;
  el.openLibrary.setAttribute("aria-expanded", String(!state.libraryCollapsed));
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

function setLibraryCollapsed(collapsed) {
  state.libraryCollapsed = collapsed;
  renderPanels();
}

function closeChapterPopover() {
  if (!state.chapterPopoverOpen) return false;
  state.chapterPopoverOpen = false;
  renderPanels();
  return true;
}

function updateBackToCurrentPageButton() {
  el.backToCurrentPage.disabled = !state.bookId || !state.hasPlaybackPosition || isCurrentPlaybackVisible();
}

function prepareRenderedSentences() {
  const isRenderingPlaybackChapter = state.previewChapterIndex === state.chapterIndex;
  if (isRenderingPlaybackChapter) {
    applySentenceTimings();
    state.playbackSentences = state.sentences.map((sentence) => ({ ...sentence }));
  }
  state.activeSentenceIndex = isRenderingPlaybackChapter
    ? Math.min(state.playbackSentenceIndex, Math.max(0, state.sentences.length - 1))
    : Math.min(state.activeSentenceIndex, Math.max(0, state.sentences.length - 1));
}

function sentenceClasses(sentence, index) {
  const interactive = sentence.timingIndex !== undefined || !isPreviewCurrentPage();
  const classes = ["sentence", interactive ? "timed" : "untimed"];
  if (index === state.activeSentenceIndex && sentence.timingIndex !== undefined && isPreviewCurrentPage()) classes.push("active");
  return classes.join(" ");
}

function bindSentenceClicks() {
  document.querySelectorAll(".sentence").forEach((node) => {
    node.onclick = null;
    node.onpointerdown = null;
    const paragraphIndex = Number(node.dataset.paragraphIndex);
    const paragraph = state.previewParagraphs[paragraphIndex];
    if (isAudioParagraph(paragraph)) {
      let pointerStart = null;
      node.onpointerdown = (event) => {
        if (event.button !== 0) return;
        const flow = getVisualPageFlow();
        if (!flow) return;
        pointerStart = {
          visualPageIndex: getActualVisualPage(flow),
        };
      };
      node.onclick = (event) => {
        event.preventDefault();
        const flow = getVisualPageFlow();
        const clickedVisualPage = pointerStart?.visualPageIndex ??
          (flow ? getActualVisualPage(flow) : state.visualPageIndex);
        const requestId = ++state.sentenceClickRequestId;
        const guard = {
          requestId,
          bookId: state.bookId,
          chapterIndex: state.previewChapterIndex,
          paragraphIndex,
          sentenceIndex: Number(node.dataset.index),
          visualPageIndex: clickedVisualPage,
          expiresAt: Date.now() + 8000,
        };
        pointerStart = null;
        state.sentenceClickGuard = guard;
        state.lastSentenceClickGuard = guard;
        restoreSentenceClickPage(guard);
        playFromSentence(paragraphIndex, guard.sentenceIndex, clickedVisualPage)
          .catch((error) => setStatus(`播放失败：${error.message}`))
          .finally(() => {
            if (state.sentenceClickGuard?.requestId !== requestId) return;
            restoreSentenceClickPage(guard);
            window.setTimeout(() => {
              if (state.sentenceClickGuard?.requestId === requestId) {
                state.sentenceClickGuard = null;
              }
            }, 8000);
          });
      };
    }
  });
}

function refreshRenderedSentenceTimings() {
  applySentenceTimings();
  state.playbackSentences = state.sentences.map((sentence) => ({ ...sentence }));
  state.renderedSentencesByParagraph.set(state.paragraphIndex, state.sentences);
  refreshRenderedSentenceClasses();
  bindSentenceClicks();
}

function refreshRenderedSentenceClasses() {
  el.paragraphPreview.querySelectorAll(".sentence").forEach((node) => {
    const paragraphIndex = Number(node.dataset.paragraphIndex);
    const index = Number(node.dataset.index);
    const keepTogether = node.classList.contains("sentence-keep-together");
    const sentence = state.renderedSentencesByParagraph.get(paragraphIndex)?.[index];
    const classes = ["sentence"];
    if (isAudioParagraph(state.previewParagraphs[paragraphIndex])) classes.push("timed");
    if (
      paragraphIndex === state.paragraphIndex &&
      index === state.activeSentenceIndex &&
      sentence?.timingIndex !== undefined
    ) {
      classes.push("active");
    }
    node.className = classes.join(" ");
    if (keepTogether) node.classList.add("sentence-keep-together");
  });
}

function getTotalPages() {
  return (
    state.totalVisualPages ||
    state.chapters.reduce((sum, chapter) => sum + Number(chapter.paragraph_count || 0), 0)
  );
}

function getChapterStartPage(chapterIndex) {
  if (state.chapterStartPages.has(chapterIndex)) {
    return state.chapterStartPages.get(chapterIndex);
  }
  return (
    state.chapters
      .filter((chapter) => chapter.chapter_index < chapterIndex)
      .reduce((sum, chapter) => sum + Number(chapter.paragraph_count || 0), 0) + 1
  );
}

function getCurrentPageNumber() {
  return getPageNumber(
    state.chapterIndex,
    state.paragraphIndex,
    getParagraphStartPage(state.chapterIndex, state.paragraphIndex),
  );
}

function getParagraphStartPage(chapterIndex, paragraphIndex) {
  return state.paragraphStartPages.get(`${chapterIndex}:${paragraphIndex}`) || 0;
}

function getChapterParagraphsForPageRange(chapterIndex) {
  if (chapterIndex === state.chapterIndex) return state.paragraphs;
  if (chapterIndex === state.previewChapterIndex) return state.previewParagraphs;
  return getCachedChapterParagraphs(chapterIndex) || [];
}

function getParagraphEndPage(chapterIndex, paragraphIndex) {
  const startPage = getParagraphStartPage(chapterIndex, paragraphIndex);
  const paragraphs = getChapterParagraphsForPageRange(chapterIndex);
  for (let index = paragraphIndex + 1; index < paragraphs.length; index += 1) {
    const key = `${chapterIndex}:${index}`;
    if (state.paragraphStartPages.has(key)) {
      return Math.max(startPage + 1, state.paragraphStartPages.get(key));
    }
  }
  const chapterPageCount = state.chapterPageCounts.get(chapterIndex) || state.visualPageCount || 1;
  return Math.max(startPage + 1, chapterPageCount);
}

function getPageNumber(chapterIndex, _paragraphIndex, visualPageIndex = state.visualPageIndex) {
  return getChapterStartPage(chapterIndex) + visualPageIndex;
}

function updateParagraphMeta(
  currentPage = getPageNumber(
    state.previewChapterIndex,
    state.previewParagraphIndex,
    state.visualPageIndex,
  ),
  totalPages = getTotalPages(),
) {
  if (!totalPages) {
    el.paragraphMeta.textContent = "第 0 页 / 共 0 页";
    return;
  }
  el.paragraphMeta.textContent = `第 ${currentPage} 页 / 共 ${totalPages} 页`;
}

function getVisualPageFlow() {
  return el.paragraphPreview.querySelector(".visual-page-flow");
}

function getVisualPageStep(flow) {
  const gap = Number.parseFloat(getComputedStyle(flow).columnGap) || 0;
  return flow.clientWidth + gap;
}

function getVisualPageFromRect(rect, flow) {
  const flowRect = flow.getBoundingClientRect();
  return Math.max(
    0,
    Math.floor((rect.left - flowRect.left + flow.scrollLeft) / getVisualPageStep(flow)),
  );
}

function getActualVisualPage(flow) {
  return Math.max(
    0,
    Math.round((flow.scrollLeft + VISUAL_PAGE_EDGE_BLEED) / getVisualPageStep(flow)),
  );
}

function getPointerVisualPage(element, flow, event) {
  const flowRect = flow.getBoundingClientRect();
  const rects = [...element.getClientRects()].filter((rect) => rect.width && rect.height);
  const hitRect = rects.find(
    (rect) =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom,
  );
  const visibleRect = rects.find(
    (rect) =>
      rect.right > flowRect.left &&
      rect.left < flowRect.right &&
      rect.bottom > flowRect.top &&
      rect.top < flowRect.bottom,
  );
  const clickedRect = hitRect || visibleRect;
  return clickedRect
    ? getVisualPageFromRect(clickedRect, flow)
    : getActualVisualPage(flow);
}

function getActiveSentenceClickGuard() {
  const guard = state.sentenceClickGuard;
  return guard?.requestId === state.sentenceClickRequestId ? guard : null;
}

function restoreSentenceClickPage(guard) {
  if (
    guard.requestId !== state.sentenceClickRequestId ||
    state.bookId !== guard.bookId ||
    state.previewChapterIndex !== guard.chapterIndex
  ) {
    return;
  }
  const flow = getVisualPageFlow();
  if (!flow) return;
  const pageLimit = Math.max(0, state.visualPageCount - 1);
  state.visualPageIndex = Math.min(Math.max(0, guard.visualPageIndex), pageLimit);
  applyVisualPagePosition();
  const node = flow.querySelector(
    `.sentence[data-paragraph-index="${guard.paragraphIndex}"][data-index="${guard.sentenceIndex}"]`,
  );
  if (
    node &&
    state.chapterIndex === guard.chapterIndex &&
    state.paragraphIndex === guard.paragraphIndex &&
    state.playbackSentenceIndex === guard.sentenceIndex &&
    getInlineVisualPages(node, flow).includes(state.visualPageIndex)
  ) {
    state.playbackVisualPageIndex = state.visualPageIndex;
  }
  updateBackToCurrentPageButton();
}

function updateVisualPagination() {
  const flow = getVisualPageFlow();
  if (!flow || !flow.clientWidth) {
    state.visualPageCount = 1;
    state.visualPageIndex = 0;
    return;
  }
  flow.style.columnWidth = `${flow.clientWidth}px`;
  const step = getVisualPageStep(flow);
  const measuredPageCount = Math.max(1, Math.ceil((flow.scrollWidth + step - flow.clientWidth) / step));
  state.visualPageCount = measuredPageCount;
  if (state.pendingVisualPage === "last") {
    state.visualPageIndex = state.visualPageCount - 1;
  } else {
    state.visualPageIndex = Math.min(state.visualPageIndex, state.visualPageCount - 1);
  }
  state.pendingVisualPage = "first";
  applyVisualPagePosition();
}

function applyVisualPagePosition() {
  const flow = getVisualPageFlow();
  if (!flow) return;
  flow.scrollLeft = Math.max(0, state.visualPageIndex * getVisualPageStep(flow) - VISUAL_PAGE_EDGE_BLEED);
  state.visualPageIndex = getActualVisualPage(flow);
  updateParagraphMeta();
  updateBackToCurrentPageButton();
  scheduleProgressSave();
}

function getPaginationSizeKey() {
  return `${state.bookId || ""}:${el.paragraphPreview.clientWidth}x${el.paragraphPreview.clientHeight}`;
}

function getCachedChapterParagraphs(chapterIndex) {
  return state.paragraphsByChapter.get(chapterIndex);
}

async function waitForParagraphImages(container) {
  const images = [...container.querySelectorAll("img")];
  await Promise.all(
    images.map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }),
  );
}

function createPaginationMeasurer() {
  const rect = el.paragraphPreview.getBoundingClientRect();
  const measurer = document.createElement("div");
  measurer.className = "paragraph-preview pagination-measurer";
  measurer.style.width = `${rect.width}px`;
  measurer.style.height = `${rect.height}px`;
  document.body.appendChild(measurer);
  return measurer;
}

async function measureChapterPagination(measurer, paragraphs) {
  renderChapterForMeasurement(measurer, paragraphs);
  await waitForParagraphImages(measurer);
  const flow = measurer.querySelector(".visual-page-flow");
  if (!flow?.clientWidth) return { pageCount: 1, paragraphStarts: new Map() };
  flow.style.columnWidth = `${flow.clientWidth}px`;
  stabilizeSentencePageBreaks(measurer);
  const step = getVisualPageStep(flow);
  const pageCount = Math.max(1, Math.ceil((flow.scrollWidth + step - flow.clientWidth) / step));
  const paragraphStarts = new Map(
    [...flow.querySelectorAll(".chapter-paragraph")].map((paragraph) => [
      Number(paragraph.dataset.paragraphIndex),
      getElementVisualPage(paragraph, flow),
    ]),
  );
  return { pageCount, paragraphStarts };
}

async function buildBookPagination() {
  const requestId = ++state.paginationRequestId;
  const bookId = state.bookId;
  const sizeKey = getPaginationSizeKey();
  if (!bookId || !el.paragraphPreview.clientWidth || !el.paragraphPreview.clientHeight) return;

  setStatus("正在计算分页");
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  const chapterParagraphEntries = await Promise.all(
    state.chapters.map(async (chapter) => {
      const paragraphs =
        getCachedChapterParagraphs(chapter.chapter_index) ||
        (await api(`/api/books/${bookId}/paragraphs?chapter_index=${chapter.chapter_index}`));
      return [chapter.chapter_index, paragraphs];
    }),
  );
  if (requestId !== state.paginationRequestId || bookId !== state.bookId) return;

  const paragraphsByChapter = new Map(chapterParagraphEntries);
  const chapterPageCounts = new Map();
  const chapterStartPages = new Map();
  const paragraphStartPages = new Map();
  const measurer = createPaginationMeasurer();
  let totalPages = 0;
  try {
    for (const chapter of state.chapters) {
      chapterStartPages.set(chapter.chapter_index, totalPages + 1);
      const paragraphs = paragraphsByChapter.get(chapter.chapter_index) || [];
      const measured = await measureChapterPagination(measurer, paragraphs);
      chapterPageCounts.set(chapter.chapter_index, measured.pageCount);
      for (const [paragraphIndex, pageIndex] of measured.paragraphStarts) {
        paragraphStartPages.set(`${chapter.chapter_index}:${paragraphIndex}`, pageIndex);
      }
      totalPages += measured.pageCount;
    }
  } finally {
    measurer.remove();
  }
  if (requestId !== state.paginationRequestId || bookId !== state.bookId) return;

  state.paragraphsByChapter = paragraphsByChapter;
  state.chapterPageCounts = chapterPageCounts;
  state.chapterStartPages = chapterStartPages;
  state.paragraphStartPages = paragraphStartPages;
  state.totalVisualPages = totalPages;
  state.paginationSizeKey = sizeKey;
}

function schedulePaginationRebuild(viewState = null) {
  if (viewState) {
    state.pendingPaginationViewState = viewState;
  }
  window.clearTimeout(state.paginationResizeTimer);
  state.paginationResizeTimer = window.setTimeout(async () => {
    const pendingViewState = state.pendingPaginationViewState;
    state.pendingPaginationViewState = null;
    if (
      !state.bookId ||
      !state.paginationSizeKey ||
      getPaginationSizeKey() === state.paginationSizeKey
    ) {
      return;
    }
    const visualPageAnchor = pendingViewState?.anchor || captureVisualPageAnchor();
    const fallbackVisualPage = pendingViewState?.visualPageIndex ?? state.visualPageIndex;
    const wasShowingPlayback =
      pendingViewState?.wasShowingPlayback ?? isPreviewCurrentPage();
    const sentenceClickRequestId = state.sentenceClickRequestId;
    resetBookPagination({ preserveVisualState: true });
    try {
      await buildBookPagination();
      state.paragraphs = getCachedChapterParagraphs(state.chapterIndex) || state.paragraphs;
      state.previewParagraphs =
        getCachedChapterParagraphs(state.previewChapterIndex) || state.previewParagraphs;
      renderCurrent();
      const latestSentenceClick = state.lastSentenceClickGuard;
      if (latestSentenceClick?.requestId > sentenceClickRequestId) {
        restoreSentenceClickPage(latestSentenceClick);
      } else {
        restoreVisualPageAnchor(visualPageAnchor, fallbackVisualPage);
      }
      if (wasShowingPlayback) {
        state.playbackVisualPageIndex = state.visualPageIndex;
        refreshRenderedSentenceTimings();
      }
      updateBackToCurrentPageButton();
      setStatus("就绪");
    } catch (error) {
      setStatus(`分页失败：${error.message}`);
    }
  }, 180);
}

function resetBookPagination({ preserveVisualState = false } = {}) {
  state.paginationRequestId += 1;
  state.paginationSizeKey = "";
  state.chapterPageCounts = new Map();
  state.chapterStartPages = new Map();
  state.paragraphStartPages = new Map();
  state.totalVisualPages = 0;
  state.paragraphsByChapter = new Map();
  if (!preserveVisualState) {
    state.visualPageIndex = 0;
    state.visualPageCount = 1;
    state.visualPageKey = "";
    state.pendingVisualPage = "first";
  }
}

function isPreviewCurrentPage() {
  return isCurrentPlaybackVisible();
}

function isPlaybackParagraphVisible() {
  if (state.previewChapterIndex !== state.chapterIndex) return false;
  const startPage = getParagraphStartPage(state.chapterIndex, state.paragraphIndex);
  const endPage = getParagraphEndPage(state.chapterIndex, state.paragraphIndex);
  return state.visualPageIndex >= startPage && state.visualPageIndex < endPage;
}

function getPlaybackSentenceNode(index = state.playbackSentenceIndex) {
  if (state.previewChapterIndex !== state.chapterIndex) return null;
  return el.paragraphPreview.querySelector(
    `.sentence[data-paragraph-index="${state.paragraphIndex}"][data-index="${index}"]`,
  );
}

function isCurrentPlaybackVisible() {
  const flow = getVisualPageFlow();
  const node = getPlaybackSentenceNode();
  if (flow && node) {
    return isElementVisibleInCurrentPage(node, flow);
  }
  return isPlaybackParagraphVisible();
}

function syncPreviewToPlaybackParagraph({ preserveVisiblePage = false } = {}) {
  const wasPreviewingPlaybackChapter = state.previewChapterIndex === state.chapterIndex;
  state.previewChapterIndex = state.chapterIndex;
  state.previewParagraphIndex = state.paragraphIndex;
  state.previewParagraphs = state.paragraphs;
  state.visualPageKey = `${state.bookId || ""}:${state.chapterIndex}`;
  if (preserveVisiblePage && wasPreviewingPlaybackChapter && isPlaybackParagraphVisible()) {
    state.playbackVisualPageIndex = state.visualPageIndex;
    return;
  }
  state.visualPageIndex = getParagraphStartPage(state.chapterIndex, state.paragraphIndex);
  state.playbackVisualPageIndex = state.visualPageIndex;
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

function renderChapterForMeasurement(container, paragraphs) {
  container.classList.add("epub-mode");
  container.innerHTML = '<div class="visual-page-flow"></div>';
  const flow = container.querySelector(".visual-page-flow");
  paragraphs.forEach((paragraph) => {
    flow.append(createRenderedParagraph(paragraph, true));
  });
  stabilizeSentencePageBreaks(container);
}

function getElementVisualPage(element, flow) {
  const flowRect = flow.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return Math.max(0, Math.floor((rect.left - flowRect.left + flow.scrollLeft) / getVisualPageStep(flow)));
}

function getInlineVisualPages(element, flow) {
  const rects = [...element.getClientRects()].filter((item) => item.width && item.height);
  if (!rects.length) rects.push(element.getBoundingClientRect());
  return [...new Set(rects.map((rect) => getVisualPageFromRect(rect, flow)))];
}

function getInlineVisualPage(element, flow, preferredPage = null) {
  const pages = getInlineVisualPages(element, flow);
  return preferredPage !== null && pages.includes(preferredPage) ? preferredPage : pages[0];
}

function captureVisualPageAnchor() {
  const flow = getVisualPageFlow();
  if (!flow) return null;
  for (const node of flow.querySelectorAll(".sentence")) {
    const pages = getInlineVisualPages(node, flow);
    const pageOffset = pages.indexOf(state.visualPageIndex);
    if (pageOffset >= 0) {
      return {
        paragraphIndex: Number(node.dataset.paragraphIndex),
        sentenceIndex: Number(node.dataset.index),
        pageOffset,
      };
    }
  }
  for (const node of flow.querySelectorAll(".chapter-paragraph")) {
    const startPage = getElementVisualPage(node, flow);
    const rect = node.getBoundingClientRect();
    const pageSpan = Math.max(1, Math.ceil(rect.width / getVisualPageStep(flow)));
    if (state.visualPageIndex >= startPage && state.visualPageIndex < startPage + pageSpan) {
      return {
        paragraphIndex: Number(node.dataset.paragraphIndex),
        sentenceIndex: null,
        pageOffset: state.visualPageIndex - startPage,
      };
    }
  }
  return null;
}

function restoreVisualPageAnchor(anchor, fallbackPage = 0) {
  const flow = getVisualPageFlow();
  if (!flow) return;
  const pageLimit = Math.max(0, state.visualPageCount - 1);
  let page = Math.min(Math.max(0, fallbackPage), pageLimit);
  if (anchor) {
    const node = anchor.sentenceIndex === null || anchor.sentenceIndex === undefined
      ? flow.querySelector(`.chapter-paragraph[data-paragraph-index="${anchor.paragraphIndex}"]`)
      : flow.querySelector(
        `.sentence[data-paragraph-index="${anchor.paragraphIndex}"][data-index="${anchor.sentenceIndex}"]`,
      );
    if (node && anchor.sentenceIndex !== null && anchor.sentenceIndex !== undefined) {
      const pages = getInlineVisualPages(node, flow);
      page = pages[Math.min(anchor.pageOffset, pages.length - 1)] ?? page;
    } else if (node) {
      page = getElementVisualPage(node, flow) + anchor.pageOffset;
    }
  }
  state.visualPageIndex = Math.min(Math.max(0, page), pageLimit);
  applyVisualPagePosition();
}

function isElementVisibleInCurrentPage(element, flow) {
  const flowRect = flow.getBoundingClientRect();
  const rects = [...element.getClientRects()].filter((rect) => rect.width && rect.height);
  if (!rects.length) rects.push(element.getBoundingClientRect());
  return rects.some(
    (rect) =>
      rect.right > flowRect.left &&
      rect.left < flowRect.right &&
      rect.bottom > flowRect.top &&
      rect.top < flowRect.bottom,
  );
}

function syncPreviewToSentencePage(
  index,
  preferredPage = state.visualPageIndex,
  followPreview = true,
  preventBackward = false,
) {
  if (state.previewChapterIndex !== state.chapterIndex) return;
  const flow = getVisualPageFlow();
  if (!flow) return;
  const node = getPlaybackSentenceNode(index);
  if (!node) return;
  if (followPreview && isElementVisibleInCurrentPage(node, flow)) {
    state.playbackVisualPageIndex = state.visualPageIndex;
    updateBackToCurrentPageButton();
    return;
  }
  const clickGuard = getActiveSentenceClickGuard();
  if (
    clickGuard &&
    clickGuard.chapterIndex === state.chapterIndex &&
    clickGuard.paragraphIndex === state.paragraphIndex &&
    clickGuard.sentenceIndex === index
  ) {
    preferredPage = clickGuard.visualPageIndex;
    followPreview = true;
  }
  const pageLimit = Math.max(0, state.visualPageCount - 1);
  const pages = getInlineVisualPages(node, flow).map((page) => Math.min(page, pageLimit));
  const preferred = Math.min(Math.max(0, preferredPage), pageLimit);
  const previousPlaybackPage = Math.min(
    Math.max(0, state.playbackVisualPageIndex),
    pageLimit,
  );
  let page = pages.find((item) => item > previousPlaybackPage) ?? pages.at(-1) ?? 0;
  if (pages.includes(preferred)) {
    page = preferred;
  } else if (pages.includes(previousPlaybackPage)) {
    page = previousPlaybackPage;
  }
  if (preventBackward) {
    page = Math.max(page, getActualVisualPage(flow));
  }
  state.playbackVisualPageIndex = page;
  if (followPreview && page !== state.visualPageIndex) {
    state.visualPageIndex = page;
    applyVisualPagePosition();
  }
  updateBackToCurrentPageButton();
}

function stabilizeSentencePageBreaks(container) {
  const flow = container.querySelector(".visual-page-flow");
  if (!flow?.clientWidth) return;
  flow.style.columnWidth = `${flow.clientWidth}px`;
  container.querySelectorAll(".sentence").forEach((sentence) => {
    sentence.classList.remove("sentence-keep-together");
  });
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const flowRect = flow.getBoundingClientRect();
    const step = getVisualPageStep(flow);
    for (const sentence of container.querySelectorAll(".sentence:not(.sentence-keep-together)")) {
      const rects = [...sentence.getClientRects()];
      const pages = new Set(
        rects.map((rect) => Math.floor((rect.left - flowRect.left + flow.scrollLeft) / step)),
      );
      if (pages.size <= 1) continue;
      const clone = sentence.cloneNode(true);
      clone.className = "sentence sentence-width-probe";
      container.appendChild(clone);
      const naturalWidth = clone.getBoundingClientRect().width;
      clone.remove();
      if (naturalWidth <= flow.clientWidth) {
        sentence.classList.add("sentence-keep-together");
        changed = true;
      }
    }
    if (!changed) break;
  }
}

async function playFromSentence(paragraphIndex, index, clickedVisualPage = state.visualPageIndex) {
  const switchingParagraph =
    state.previewChapterIndex !== state.chapterIndex || paragraphIndex !== state.paragraphIndex;
  if (switchingParagraph) {
    const switched = await switchPlaybackToPreviewPage(paragraphIndex);
    if (!switched) return;
  }
  state.sentences = state.renderedSentencesByParagraph.get(paragraphIndex) || state.sentences;
  const sentence = state.sentences[index];
  const timing = state.sentenceTimings.find((item) => item.sentence_index === sentence?.timingIndex);
  const textLength = state.sentences.at(-1)?.end || 1;
  if (!sentence || !el.audio.duration) return;
  state.playbackSentenceIndex = index;
  state.activeSentenceIndex = index;
  if (timing) {
    el.audio.currentTime = timing.start_ms / 1000;
  } else if (switchingParagraph) {
    el.audio.currentTime = (sentence.start / textLength) * el.audio.duration;
  } else {
    return;
  }
  highlightSentence(index, clickedVisualPage, true);
  updatePlayButton(true);
  try {
    await el.audio.play();
  } catch (error) {
    updatePlayButton(false);
    alert(`播放失败：${error.message}`);
  }
  updatePlayButton();
}

async function switchPlaybackToPreviewPage(paragraphIndex = state.previewParagraphIndex) {
  state.playbackSwitchCount += 1;
  if (!el.audio.paused) {
    el.audio.pause();
  }
  try {
    await saveProgress();
    state.chapterIndex = state.previewChapterIndex;
    state.paragraphIndex = paragraphIndex;
    state.previewParagraphIndex = paragraphIndex;
    state.paragraphs = state.previewParagraphs;
    state.activeSentenceIndex = 0;
    const loaded = await loadAudio(0, false, { syncSentenceOnLoad: false });
    if (!loaded) return false;
    await saveProgress();
    return true;
  } finally {
    state.playbackSwitchCount = Math.max(0, state.playbackSwitchCount - 1);
  }
}

function highlightSentence(index, preferredPage = state.visualPageIndex, forceFollow = false) {
  const previousSentenceIndex = state.playbackSentenceIndex;
  const wasFollowingPlayback = isCurrentPlaybackVisible();
  state.playbackSentenceIndex = index;
  state.activeSentenceIndex = index;
  document.querySelectorAll(".sentence").forEach((node) => {
    node.classList.toggle(
      "active",
      state.previewChapterIndex === state.chapterIndex &&
        Number(node.dataset.paragraphIndex) === state.paragraphIndex &&
      Number(node.dataset.index) === index,
    );
  });
  syncPreviewToSentencePage(
    index,
    preferredPage,
    forceFollow || wasFollowingPlayback,
    !forceFollow && index > previousSentenceIndex,
  );
}

async function selectBook(bookId) {
  if (state.bookId && state.bookId !== bookId) {
    window.clearTimeout(state.progressSaveTimer);
    await saveProgress();
  }
  resetBookPagination();
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
  state.hasPlaybackPosition = Boolean(progress.has_playback_position);
  state.chapterIndex = progress.chapter_index || 0;
  state.paragraphIndex = progress.paragraph_index || 0;
  state.previewChapterIndex = state.chapterIndex;
  state.previewParagraphIndex = state.paragraphIndex;
  syncSettings();
  await loadEpubCss(bookId);
  await buildBookPagination();
  state.visualPageKey = `${bookId}:${state.chapterIndex}`;
  state.visualPageIndex = getParagraphStartPage(state.chapterIndex, state.paragraphIndex);
  state.playbackVisualPageIndex = state.visualPageIndex;
  await loadParagraphs(state.chapterIndex, true);
  await loadAudio(progress.audio_position_ms || 0);
  restoreReadingPosition({
    chapterIndex: progress.reading_chapter_index ?? state.chapterIndex,
    paragraphIndex: progress.reading_paragraph_index ?? state.paragraphIndex,
    sentenceIndex: progress.reading_sentence_index ?? null,
    pageOffset: progress.reading_page_offset ?? 0,
  });
  setStatus("就绪");
}

function restoreReadingPosition(anchor) {
  const chapterExists = state.chapters.some((chapter) => chapter.chapter_index === anchor.chapterIndex);
  const chapterIndex = chapterExists ? anchor.chapterIndex : state.chapterIndex;
  const paragraphs = getCachedChapterParagraphs(chapterIndex) || state.paragraphs;
  const paragraphIndex = Math.min(
    Math.max(0, anchor.paragraphIndex),
    Math.max(0, paragraphs.length - 1),
  );
  state.previewChapterIndex = chapterIndex;
  state.previewParagraphIndex = paragraphIndex;
  state.previewParagraphs = paragraphs;
  state.pendingVisualPage = "first";
  renderCurrent();
  restoreVisualPageAnchor(
    {
      paragraphIndex,
      sentenceIndex: anchor.sentenceIndex,
      pageOffset: Math.max(0, anchor.pageOffset),
    },
    getParagraphStartPage(chapterIndex, paragraphIndex),
  );
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
  state.paragraphs =
    getCachedChapterParagraphs(chapterIndex) ||
    (await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapterIndex}`));
  state.chapterIndex = chapterIndex;
  if (state.paragraphIndex >= state.paragraphs.length) {
    state.paragraphIndex = 0;
  }
  if (syncPreview) {
    syncPreviewToPlaybackParagraph();
  }
  renderCurrent();
}

async function loadPreviewParagraphs(chapterIndex) {
  state.previewParagraphs =
    getCachedChapterParagraphs(chapterIndex) ||
    (await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapterIndex}`));
  state.previewChapterIndex = chapterIndex;
  if (state.previewParagraphIndex >= state.previewParagraphs.length) {
    state.previewParagraphIndex = 0;
  }
  renderCurrent();
}

async function loadAudio(positionMs = 0, autoplay = false, options = {}) {
  if (!state.bookId || !state.paragraphs[state.paragraphIndex]) return;
  if (!isAudioParagraph(state.paragraphs[state.paragraphIndex])) {
    const moved = await moveToNextAudioPage(state.paragraphIndex + 1, {
      syncPreview: options.syncPreviewOnAutoSkip !== false,
    });
    if (!moved) return;
  }
  const requestId = ++state.audioLoadRequestId;
  state.cancelPendingAudioLoad?.();
  state.cancelPendingAudioLoad = null;
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
  const audioSrc = `/api/books/${state.bookId}/audio?${params.toString()}`;
  renderCurrent();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (el.audio.onloadedmetadata === handleLoadedMetadata) {
        el.audio.onloadedmetadata = null;
      }
      if (el.audio.onerror === handleError) {
        el.audio.onerror = null;
      }
      if (state.cancelPendingAudioLoad === cancel) {
        state.cancelPendingAudioLoad = null;
      }
    };
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(loaded);
    };
    const cancel = () => finish(false);
    const handleLoadedMetadata = async () => {
      if (requestId !== state.audioLoadRequestId) {
        finish(false);
        return;
      }
      el.audio.currentTime = Math.min(positionMs / 1000, el.audio.duration || 0);
      const timingsLoaded = await loadSentenceTimings(requestId);
      if (!timingsLoaded || requestId !== state.audioLoadRequestId) {
        finish(false);
        return;
      }
      state.audioReady = true;
      state.loadingAudio = false;
      updateProgress({ syncSentence: options.syncSentenceOnLoad !== false });
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
      finish(true);
    };
    const handleError = () => {
      if (requestId !== state.audioLoadRequestId) {
        finish(false);
        return;
      }
      state.loadingAudio = false;
      state.pendingAutoplay = false;
      state.audioReady = false;
      setStatus("音频准备失败");
      updatePlayButton();
      syncPlayerState(true);
      alert("音频准备失败，请稍后重试。");
      settled = true;
      cleanup();
      reject(new Error("音频准备失败"));
    };
    state.cancelPendingAudioLoad = cancel;
    el.audio.onloadedmetadata = handleLoadedMetadata;
    el.audio.onerror = handleError;
    el.audio.src = audioSrc;
    el.audio.load();
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

async function moveToNextAudioPage(startIndex = 0, options = {}) {
  const sameChapterIndex = findNextAudioParagraph(startIndex);
  if (sameChapterIndex !== null) {
    state.paragraphIndex = sameChapterIndex;
    if (options.syncPreview !== false) {
      syncPreviewToPlaybackParagraph();
      renderCurrent();
    }
    return true;
  }

  const followingChapters = state.chapters.filter((chapter) => chapter.chapter_index > state.chapterIndex);
  for (const chapter of followingChapters) {
    const paragraphs =
      getCachedChapterParagraphs(chapter.chapter_index) ||
      (await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapter.chapter_index}`));
    const index = paragraphs.findIndex(isAudioParagraph);
    if (index >= 0) {
      state.chapterIndex = chapter.chapter_index;
      state.paragraphs = paragraphs;
      state.paragraphIndex = index;
      syncPreviewToPlaybackParagraph();
      renderCurrent();
      return true;
    }
  }
  return false;
}

async function loadSentenceTimings(requestId = state.audioLoadRequestId) {
  if (!state.bookId) return false;
  const bookId = state.bookId;
  const chapterIndex = state.chapterIndex;
  const paragraphIndex = state.paragraphIndex;
  const params = new URLSearchParams({
    chapter_index: chapterIndex,
    paragraph_index: paragraphIndex,
    voice: state.voice,
    rate: state.rate,
    volume: state.volume,
  });
  try {
    const timings = await api(`/api/books/${bookId}/sentence-timings?${params.toString()}`);
    if (requestId !== state.audioLoadRequestId) return false;
    state.sentenceTimings = timings;
    if (state.previewChapterIndex === state.chapterIndex) {
      state.sentences = state.renderedSentencesByParagraph.get(state.paragraphIndex) || [];
      refreshRenderedSentenceTimings();
    }
    return true;
  } catch {
    if (requestId !== state.audioLoadRequestId) return false;
    state.sentenceTimings = [];
    if (state.previewChapterIndex === state.chapterIndex) {
      state.sentences = state.renderedSentencesByParagraph.get(state.paragraphIndex) || [];
      refreshRenderedSentenceTimings();
    }
    return true;
  }
}

function applySentenceTimings() {
  const previousActiveSentenceIndex = state.activeSentenceIndex;
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
  const playbackSentence = state.sentences[state.playbackSentenceIndex];
  const previousActiveSentence = state.sentences[previousActiveSentenceIndex];
  if (playbackSentence?.timingIndex !== undefined) {
    state.activeSentenceIndex = state.playbackSentenceIndex;
  } else if (previousActiveSentence?.timingIndex !== undefined) {
    state.activeSentenceIndex = previousActiveSentenceIndex;
  } else {
    state.activeSentenceIndex = firstTimed >= 0 ? firstTimed : 0;
  }
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
  const bookId = state.bookId;
  const readingAnchor = captureVisualPageAnchor();
  const readingChapterIndex = state.previewChapterIndex;
  const readingParagraphIndex = readingAnchor?.paragraphIndex ?? state.previewParagraphIndex;
  await fetch(`/api/books/${bookId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chapter_index: state.chapterIndex,
      paragraph_index: state.paragraphIndex,
      audio_position_ms: Math.floor((el.audio.currentTime || 0) * 1000),
      has_playback_position: state.hasPlaybackPosition,
      reading_chapter_index: readingChapterIndex,
      reading_paragraph_index: readingParagraphIndex,
      reading_sentence_index: readingAnchor?.sentenceIndex ?? null,
      reading_page_offset: readingAnchor?.pageOffset ?? 0,
      voice: state.voice,
      rate: state.rate,
      volume: state.volume,
    }),
    keepalive: true,
  });
}

function scheduleProgressSave() {
  if (!state.bookId) return;
  window.clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = window.setTimeout(() => {
    saveProgress().catch((error) => setStatus(`保存阅读进度失败：${error.message}`));
  }, 350);
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

async function jumpToParagraph(index, autoplay = false, options = {}) {
  const syncPreview = options.syncPreview !== false && isPreviewCurrentPage();
  if (index < 0) {
    await jumpToChapter(state.chapterIndex - 1, autoplay, syncPreview);
    state.paragraphIndex = Math.max(0, state.paragraphs.length - 1);
    if (syncPreview) {
      syncPreviewToPlaybackParagraph();
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
    syncPreviewToPlaybackParagraph({ preserveVisiblePage: true });
  }
  renderCurrent();
  await loadAudio(0, autoplay, {
    syncPreviewOnAutoSkip: options.syncPreview !== false,
  });
  await saveProgress();
}

async function handleAudioEnded() {
  if (state.loadingAudio || state.playbackSwitchCount || getActiveSentenceClickGuard()) return;
  await jumpToParagraph(state.paragraphIndex + 1, true, { syncPreview: false });
}

async function previewJumpToParagraph(index, visualTarget = "first") {
  if (!state.bookId) return;
  if (index < 0) {
    const previousChapter = [...state.chapters]
      .reverse()
      .find((chapter) => chapter.chapter_index < state.previewChapterIndex);
    if (!previousChapter) return;
    state.pendingVisualPage = visualTarget;
    const paragraphs =
      getCachedChapterParagraphs(previousChapter.chapter_index) ||
      (await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${previousChapter.chapter_index}`));
    state.previewChapterIndex = previousChapter.chapter_index;
    state.previewParagraphs = paragraphs;
    state.previewParagraphIndex = Math.max(0, paragraphs.length - 1);
    renderCurrent();
    return;
  }
  if (index >= state.previewParagraphs.length) {
    const nextChapter = state.chapters.find((chapter) => chapter.chapter_index > state.previewChapterIndex);
    if (!nextChapter) return;
    state.pendingVisualPage = visualTarget;
    state.previewParagraphIndex = 0;
    await loadPreviewParagraphs(nextChapter.chapter_index);
    return;
  }
  state.pendingVisualPage = visualTarget;
  state.previewParagraphIndex = index;
  renderCurrent();
}

async function previewMovePage(direction) {
  if (!state.bookId) return;
  if (direction < 0 && state.visualPageIndex > 0) {
    state.visualPageIndex -= 1;
    applyVisualPagePosition();
    return;
  }
  if (direction > 0 && state.visualPageIndex < state.visualPageCount - 1) {
    state.visualPageIndex += 1;
    applyVisualPagePosition();
    return;
  }
  const chapters = direction < 0 ? [...state.chapters].reverse() : state.chapters;
  const adjacentChapter = chapters.find((chapter) =>
    direction < 0
      ? chapter.chapter_index < state.previewChapterIndex
      : chapter.chapter_index > state.previewChapterIndex,
  );
  if (!adjacentChapter) return;
  state.pendingVisualPage = direction < 0 ? "last" : "first";
  state.previewParagraphIndex = 0;
  await loadPreviewParagraphs(adjacentChapter.chapter_index);
}

async function previewJumpToChapter(index) {
  if (!state.bookId || !state.chapters.some((chapter) => chapter.chapter_index === index)) return;
  state.pendingVisualPage = "first";
  state.previewParagraphIndex = 0;
  await loadPreviewParagraphs(index);
}

function backToCurrentPage() {
  state.pendingVisualPage = "first";
  state.previewChapterIndex = state.chapterIndex;
  state.previewParagraphIndex = state.paragraphIndex;
  state.previewParagraphs = state.paragraphs;
  state.visualPageKey = `${state.bookId || ""}:${state.chapterIndex}`;
  state.visualPageIndex = state.playbackVisualPageIndex;
  renderCurrent();
  const flow = getVisualPageFlow();
  const node = getPlaybackSentenceNode();
  if (flow && node) {
    state.visualPageIndex = Math.min(
      getInlineVisualPage(node, flow, state.playbackVisualPageIndex),
      Math.max(0, state.visualPageCount - 1),
    );
    state.playbackVisualPageIndex = state.visualPageIndex;
    applyVisualPagePosition();
    updateBackToCurrentPageButton();
  }
}

function isEditingText(event) {
  const tagName = event.target?.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || event.target?.isContentEditable;
}

function handleKeyboardShortcuts(event) {
  if (event.key === "Escape" && closeChapterPopover()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && !state.libraryCollapsed) {
    event.preventDefault();
    setLibraryCollapsed(true);
    return;
  }
  if (isEditingText(event) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    previewMovePage(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    previewMovePage(1);
  } else if (event.key === " ") {
    event.preventDefault();
    togglePlayback();
  }
}

function updateProgress(options = {}) {
  const duration = el.audio.duration || 0;
  const current = el.audio.currentTime || 0;
  el.currentTime.textContent = formatTime(current);
  el.durationTime.textContent = formatTime(duration);
  el.seekBar.value = duration ? Math.floor((current / duration) * 1000) : 0;
  if (state.loadingAudio || options.syncSentence === false) {
    syncPlayerState();
    return;
  }
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
  const clickGuard = getActiveSentenceClickGuard();
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
      if (
        clickGuard &&
        clickGuard.chapterIndex === state.chapterIndex &&
        clickGuard.paragraphIndex === state.paragraphIndex &&
        sentenceIndex !== clickGuard.sentenceIndex
      ) {
        return;
      }
      if (clickGuard?.sentenceIndex === sentenceIndex) {
        state.sentenceClickGuard = null;
      }
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
  if (
    clickGuard &&
    clickGuard.chapterIndex === state.chapterIndex &&
    clickGuard.paragraphIndex === state.paragraphIndex &&
    index !== clickGuard.sentenceIndex
  ) {
    return;
  }
  if (clickGuard?.sentenceIndex === index) {
    state.sentenceClickGuard = null;
  }
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
      const startPage =
        bookId === state.bookId
          ? getChapterStartPage(chapter.chapter_index)
          : getChapterStartPageFor(chapters, chapter.chapter_index);
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
    state.audioLoadRequestId += 1;
    state.cancelPendingAudioLoad?.();
    state.cancelPendingAudioLoad = null;
    state.playbackSwitchCount = 0;
    resetBookPagination();
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
    state.playbackVisualPageIndex = 0;
    state.hasPlaybackPosition = false;
    window.clearTimeout(state.progressSaveTimer);
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
el.toggleLibrary.addEventListener("click", () => setLibraryCollapsed(true));
el.openLibrary.addEventListener("click", () => setLibraryCollapsed(false));
el.libraryBackdrop.addEventListener("click", () => {
  if (!closeChapterPopover()) setLibraryCollapsed(true);
});
document.addEventListener("click", (event) => {
  if (!state.chapterPopoverOpen) return;
  if (el.chapterPopover.contains(event.target)) return;
  if (event.target instanceof Element && event.target.closest('[data-action="chapters"]')) return;
  closeChapterPopover();
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
el.prevParagraph.addEventListener("click", () => previewMovePage(-1));
el.nextParagraph.addEventListener("click", () => previewMovePage(1));
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
  state.hasPlaybackPosition = true;
  scheduleProgressSave();
  updateBackToCurrentPageButton();
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
el.audio.addEventListener("ended", handleAudioEnded);
window.addEventListener("beforeunload", saveProgress);
window.addEventListener("keydown", handleKeyboardShortcuts);
window.addEventListener("resize", () => schedulePaginationRebuild());
if ("ResizeObserver" in window) {
  state.paginationResizeObserver = new ResizeObserver(() => {
    if (state.bookId && state.paginationSizeKey) {
      schedulePaginationRebuild();
    }
  });
  state.paginationResizeObserver.observe(el.paragraphPreview);
}
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
