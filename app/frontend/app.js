const state = {
  books: [],
  chapters: [],
  paragraphs: [],
  bookId: null,
  chapterIndex: 0,
  paragraphIndex: 0,
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
  sentenceTimings: [],
  activeSentenceIndex: 0,
  searchQuery: "",
  prefetchedNext: false,
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
  chapterList: document.querySelector("#chapterList"),
  paragraphMeta: document.querySelector("#paragraphMeta"),
  paragraphPreview: document.querySelector("#paragraphPreview"),
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
        <button class="chapter-item ${chapter.chapter_index === state.chapterIndex ? "active" : ""}" data-index="${chapter.chapter_index}">
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
      jumpToChapter(Number(button.dataset.index));
    });
  });
}

function renderCurrent() {
  const book = state.books.find((item) => item.id === state.bookId);
  const chapter = state.chapters.find((item) => item.chapter_index === state.chapterIndex);
  const paragraph = state.paragraphs[state.paragraphIndex];
  const currentPage = getCurrentPageNumber();
  const totalPages = getTotalPages();

  el.bookTitle.textContent = book?.title || "未选择书籍";
  el.chapterTitle.textContent = chapter?.title || "章节会显示在这里";
  el.paragraphMeta.textContent = totalPages ? `第 ${currentPage} 页 / 共 ${totalPages} 页` : "第 0 页 / 共 0 页";
  renderParagraph(paragraph?.text || "当前章节暂无内容。");
  updatePlayButton();
  renderBooks();
  renderChapters();
  renderPanels();
}

function updatePlayButton() {
  if (state.loadingAudio) {
    el.playPause.textContent = "正在准备...";
    el.playPause.disabled = true;
    return;
  }
  el.playPause.disabled = !state.bookId;
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

function renderParagraph(text) {
  state.sentences = splitSentences(text);
  applySentenceTimings();
  state.activeSentenceIndex = Math.min(state.activeSentenceIndex, Math.max(0, state.sentences.length - 1));
  el.paragraphPreview.innerHTML = state.sentences
    .map(
      (sentence, index) => {
        const interactive = sentence.timingIndex !== undefined;
        const classes = ["sentence", interactive ? "timed" : "untimed"];
        if (index === state.activeSentenceIndex && interactive) classes.push("active");
        return `<span class="${classes.join(" ")}" data-index="${index}">${escapeHtml(sentence.text)}</span>`;
      },
    )
    .join("");

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
  return getChapterStartPage(state.chapterIndex) + state.paragraphIndex;
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

async function playFromSentence(index) {
  const sentence = state.sentences[index];
  const timing = state.sentenceTimings.find((item) => item.sentence_index === sentence?.timingIndex);
  const textLength = state.sentences.at(-1)?.end || 1;
  if (!sentence || !el.audio.duration) return;
  if (!timing) return;
  state.activeSentenceIndex = index;
  el.audio.currentTime = timing.start_ms / 1000;
  highlightSentence(index);
  try {
    await el.audio.play();
  } catch (error) {
    alert(`播放失败：${error.message}`);
  }
  updatePlayButton();
}

function highlightSentence(index) {
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
  syncSettings();
  await loadParagraphs(state.chapterIndex);
  await loadAudio(progress.audio_position_ms || 0);
  setStatus("就绪");
}

async function loadParagraphs(chapterIndex) {
  state.paragraphs = await api(`/api/books/${state.bookId}/paragraphs?chapter_index=${chapterIndex}`);
  state.chapterIndex = chapterIndex;
  if (state.paragraphIndex >= state.paragraphs.length) {
    state.paragraphIndex = 0;
  }
  renderCurrent();
}

async function loadAudio(positionMs = 0, autoplay = false) {
  if (!state.bookId || !state.paragraphs[state.paragraphIndex]) return;
  state.loadingAudio = true;
  state.pendingAutoplay = autoplay;
  state.audioReady = false;
  state.activeSentenceIndex = 0;
  state.sentenceTimings = [];
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
  el.audio.onloadedmetadata = async () => {
    el.audio.currentTime = Math.min(positionMs / 1000, el.audio.duration || 0);
    await loadSentenceTimings();
    updateProgress();
    state.audioReady = true;
    state.loadingAudio = false;
    setStatus("就绪");
    updatePlayButton();
    if (state.pendingAutoplay) {
      state.pendingAutoplay = false;
      try {
        await el.audio.play();
      } catch (error) {
        alert(`播放失败：${error.message}`);
      }
      updatePlayButton();
    }
  };
  el.audio.onerror = () => {
    state.loadingAudio = false;
    state.pendingAutoplay = false;
    state.audioReady = false;
    setStatus("音频准备失败");
    updatePlayButton();
    alert("音频准备失败，请稍后重试。");
  };
  renderCurrent();
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
    renderParagraph(state.paragraphs[state.paragraphIndex]?.text || "");
  } catch {
    state.sentenceTimings = [];
    renderParagraph(state.paragraphs[state.paragraphIndex]?.text || "");
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

async function jumpToChapter(index, autoplay = false) {
  if (index < 0 || index >= state.chapters.length) return;
  await saveProgress();
  state.paragraphIndex = 0;
  state.activeSentenceIndex = 0;
  await loadParagraphs(index);
  await loadAudio(0, autoplay);
  await saveProgress();
}

async function jumpToParagraph(index, autoplay = false) {
  if (index < 0) {
    await jumpToChapter(state.chapterIndex - 1, autoplay);
    state.paragraphIndex = Math.max(0, state.paragraphs.length - 1);
    await loadAudio(0, autoplay);
    return;
  }
  if (index >= state.paragraphs.length) {
    await jumpToChapter(state.chapterIndex + 1, autoplay);
    return;
  }
  await saveProgress();
  state.paragraphIndex = index;
  state.activeSentenceIndex = 0;
  renderCurrent();
  await loadAudio(0, autoplay);
  await saveProgress();
}

function updateProgress() {
  const duration = el.audio.duration || 0;
  const current = el.audio.currentTime || 0;
  el.currentTime.textContent = formatTime(current);
  el.durationTime.textContent = formatTime(duration);
  el.seekBar.value = duration ? Math.floor((current / duration) * 1000) : 0;
  updateSentenceHighlight(current, duration);
  maybePrefetchNextPage(current, duration);
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

function updateSentenceHighlight(current, duration) {
  if (!duration || !state.sentences.length) return;
  if (state.sentenceTimings.length) {
    const currentMs = current * 1000;
    const timingIndex = state.sentenceTimings.findIndex((timing, timingListIndex) => {
      const next = state.sentenceTimings[timingListIndex + 1];
      return currentMs >= timing.start_ms && (!next || currentMs < next.start_ms);
    });
    if (timingIndex >= 0) {
      const timing = state.sentenceTimings[timingIndex];
      const sentenceIndex = state.sentences.findIndex(
        (sentence) => sentence.timingIndex === timing.sentence_index,
      );
      if (sentenceIndex >= 0 && sentenceIndex !== state.activeSentenceIndex) {
        highlightSentence(sentenceIndex);
      }
    }
    return;
  }
  const textLength = state.sentences.at(-1)?.end || 1;
  const textPosition = (current / duration) * textLength;
  const index = state.sentences.findIndex(
    (sentence) => textPosition >= sentence.start && textPosition < sentence.end,
  );
  if (index >= 0 && index !== state.activeSentenceIndex) {
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
        <button class="chapter-item ${bookId === state.bookId && chapter.chapter_index === state.chapterIndex ? "active" : ""}" data-index="${chapter.chapter_index}">
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
      await jumpToChapter(Number(button.dataset.index));
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
    state.chapterIndex = 0;
    state.paragraphIndex = 0;
    state.sentences = [];
    state.sentenceTimings = [];
    state.audioReady = false;
    state.loadingAudio = false;
    state.pendingAutoplay = false;
    el.audio.removeAttribute("src");
    el.bookTitle.textContent = "未选择书籍";
    el.chapterTitle.textContent = "章节会显示在这里";
    el.paragraphMeta.textContent = "第 0 页 / 共 0 页";
    el.paragraphPreview.textContent = "导入书籍后，这里会显示当前段落文本。";
    updatePlayButton();
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

el.playPause.addEventListener("click", async () => {
  if (!state.bookId || state.loadingAudio) return;
  if (el.audio.paused) {
    await startPlayback();
  } else {
    el.audio.pause();
    await saveProgress();
  }
  updatePlayButton();
});
el.prevChapter.addEventListener("click", () => jumpToChapter(state.chapterIndex - 1));
el.nextChapter.addEventListener("click", () => jumpToChapter(state.chapterIndex + 1));
el.prevParagraph.addEventListener("click", () => jumpToParagraph(state.paragraphIndex - 1));
el.nextParagraph.addEventListener("click", () => jumpToParagraph(state.paragraphIndex + 1));
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
el.audio.addEventListener("play", updatePlayButton);
el.audio.addEventListener("pause", async () => {
  await saveProgress();
  updatePlayButton();
});
el.audio.addEventListener("ended", () => jumpToParagraph(state.paragraphIndex + 1, true));
window.addEventListener("beforeunload", saveProgress);
setInterval(saveProgress, 7000);

renderPanels();
loadVoices()
  .then(() => loadBooks(true))
  .catch((error) => setStatus(error.message));
