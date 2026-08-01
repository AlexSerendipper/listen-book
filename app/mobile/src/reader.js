import { getRecord, markBookRead, saveLocalProgress } from "./db.js?v=8";
import { createTextAnchor } from "./anchor.js?v=8";

const ASSET_CACHE = "listen-book-assets-v1";

export function createReader(elements) {
  let book;
  let packageData;
  let chapterIndex = 0;
  let pageIndex = 0;
  let pageCount = 1;
  let saveTimer;
  let blobUrls = [];
  let touchStart = null;

  function releaseBlobs() {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls = [];
  }

  async function hydrateImages() {
    const cache = await caches.open(ASSET_CACHE);
    const images = elements.content.querySelectorAll("img[data-mobile-asset]");
    await Promise.all(Array.from(images, async (image) => {
      const resourceId = image.dataset.mobileAsset;
      const response = await cache.match(`/mobile/offline-assets/${book.content_hash}/${resourceId}`);
      if (!response) {
        image.replaceWith(Object.assign(document.createElement("p"), { textContent: "图片资源缺失" }));
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      blobUrls.push(url);
      image.addEventListener("load", () => requestAnimationFrame(updatePager), { once: true });
      image.src = url;
      await Promise.race([
        image.decode().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }));
  }

  function updatePager() {
    pageCount = Math.max(1, Math.ceil(elements.content.scrollWidth / elements.pages.clientWidth));
    pageIndex = Math.min(pageIndex, pageCount - 1);
    elements.pages.scrollLeft = pageIndex * elements.pages.clientWidth;
    const position = `第 ${chapterIndex + 1}/${packageData.chapters.length} 章 · ${pageIndex + 1}/${pageCount} 页`;
    elements.indicator.textContent = position;
    elements.chapter.textContent = `${packageData.chapters[chapterIndex].title} · ${position}`;
    elements.previous.disabled = chapterIndex === 0 && pageIndex === 0;
    elements.next.disabled = chapterIndex === packageData.chapters.length - 1 && pageIndex === pageCount - 1;
  }

  function paragraphAtPage() {
    const left = pageIndex * elements.pages.clientWidth;
    const paragraphs = Array.from(elements.content.querySelectorAll(".paragraph"));
    return paragraphs.find((node) => node.offsetLeft >= left - 4) || paragraphs.at(-1);
  }

  async function savePosition() {
    clearTimeout(saveTimer);
    const node = paragraphAtPage();
    const chapter = packageData.chapters[chapterIndex];
    const paragraphIndex = Number(node?.dataset.paragraphIndex || 0);
    const paragraph = chapter.paragraphs.find((item) => item.paragraph_index === paragraphIndex);
    await saveLocalProgress(await createTextAnchor(book.content_hash, chapterIndex, paragraph));
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => savePosition().catch(() => undefined), 1000);
  }

  async function renderChapter(targetChapter, targetParagraph = null) {
    releaseBlobs();
    chapterIndex = Math.max(0, Math.min(targetChapter, packageData.chapters.length - 1));
    const chapter = packageData.chapters[chapterIndex];
    elements.chapter.textContent = `${chapter.title} · 分页中…`;
    elements.indicator.textContent = "分页中…";
    elements.previous.disabled = true;
    elements.next.disabled = true;
    elements.content.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = chapter.title;
    elements.content.append(heading);
    for (const paragraph of chapter.paragraphs) {
      const wrapper = document.createElement("div");
      wrapper.className = "paragraph";
      wrapper.dataset.paragraphIndex = String(paragraph.paragraph_index);
      if (paragraph.html) {
        wrapper.innerHTML = paragraph.html.replace(
          /src=(['"])asset:\/\/([^'"]+)\1/g,
          (_match, _quote, resourceId) => `data-mobile-asset="${resourceId}" alt=""`,
        );
      } else {
        wrapper.textContent = paragraph.text;
      }
      elements.content.append(wrapper);
    }
    elements.content.style.columnWidth = `${elements.pages.clientWidth}px`;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    pageIndex = 0;
    updatePager();
    const restoreTarget = () => {
      if (targetParagraph === null) return;
      const node = elements.content.querySelector(`[data-paragraph-index="${targetParagraph}"]`);
      if (node) pageIndex = Math.max(0, Math.floor(node.offsetLeft / elements.pages.clientWidth));
      updatePager();
    };
    restoreTarget();
    await hydrateImages();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    updatePager();
    restoreTarget();
  }

  async function openBook(targetBook) {
    book = targetBook;
    packageData = await getRecord("packages", book.content_hash);
    if (!packageData) throw new Error("离线解析包缺失，请重新下载");
    const progress = await getRecord("progress", book.content_hash);
    elements.title.textContent = book.title;
    elements.view.hidden = false;
    await renderChapter(
      progress?.anchor?.chapter_index || 0,
      progress?.anchor?.paragraph_index ?? null,
    );
  }

  async function next() {
    let moved = false;
    if (pageIndex + 1 < pageCount) {
      pageIndex += 1;
      updatePager();
      moved = true;
    } else if (chapterIndex + 1 < packageData.chapters.length) {
      await savePosition();
      await renderChapter(chapterIndex + 1);
      moved = true;
    }
    if (moved) await markBookRead(book.content_hash);
    scheduleSave();
  }

  async function previous() {
    let moved = false;
    if (pageIndex > 0) {
      pageIndex -= 1;
      updatePager();
      moved = true;
    } else if (chapterIndex > 0) {
      await savePosition();
      await renderChapter(chapterIndex - 1);
      pageIndex = pageCount - 1;
      updatePager();
      moved = true;
    }
    if (moved) await markBookRead(book.content_hash);
    scheduleSave();
  }

  async function close() {
    if (book) await savePosition();
    releaseBlobs();
    elements.view.hidden = true;
  }

  async function relayout() {
    const node = paragraphAtPage();
    await renderChapter(chapterIndex, Number(node?.dataset.paragraphIndex || 0));
  }

  window.addEventListener("resize", () => relayout().catch(() => undefined));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && book) savePosition().catch(() => undefined);
  });
  elements.previous.addEventListener("click", () => previous());
  elements.next.addEventListener("click", () => next());
  elements.pages.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    touchStart = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      startedAt: performance.now(),
    };
  }, { passive: true });
  elements.pages.addEventListener("touchend", (event) => {
    if (!touchStart || event.changedTouches.length !== 1) return;
    const endTouch = event.changedTouches[0];
    const start = touchStart;
    const deltaX = endTouch.clientX - start.x;
    const deltaY = endTouch.clientY - start.y;
    const duration = performance.now() - start.startedAt;
    touchStart = null;
    if (Math.abs(deltaX) >= 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
      if (deltaX < 0) next();
      else previous();
      return;
    }
    if (duration > 350 || Math.hypot(deltaX, deltaY) > 12) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (event.target instanceof Element && event.target.closest(
      "a, button, input, textarea, select, label, [contenteditable='true'], img, picture, video, audio, iframe",
    )) return;
    const bounds = elements.pages.getBoundingClientRect();
    if (endTouch.clientX < bounds.left || endTouch.clientX > bounds.right) return;
    if (endTouch.clientX < bounds.left + bounds.width / 2) previous();
    else next();
  }, { passive: true });
  elements.pages.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });

  return { openBook, close, relayout, savePosition, get contentHash() { return book?.content_hash; } };
}
