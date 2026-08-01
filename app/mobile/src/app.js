import { connectForeground, downloadBook, fetchCatalog, pairDevice, pullProgress, pushProgress, refreshOfflineBook } from "./api.js?v=8";
import { allRecords, getDevice, openDatabase, refreshOfflineMetadata } from "./db.js?v=8";
import { createReader } from "./reader.js?v=8";

const elements = {
  pairView: document.querySelector("#pairView"),
  pairForm: document.querySelector("#pairForm"),
  pairCode: document.querySelector("#pairCode"),
  pairStatus: document.querySelector("#pairStatus"),
  libraryView: document.querySelector("#libraryView"),
  bookList: document.querySelector("#bookList"),
  emptyLibrary: document.querySelector("#emptyLibrary"),
  refresh: document.querySelector("#refreshButton"),
  badge: document.querySelector("#connectionBadge"),
  storage: document.querySelector("#storageNote"),
  readerView: document.querySelector("#readerView"),
  readerTitle: document.querySelector("#readerTitle"),
  chapterTitle: document.querySelector("#chapterTitle"),
  readerPages: document.querySelector("#readerPages"),
  readerContent: document.querySelector("#readerContent"),
  pageIndicator: document.querySelector("#pageIndicator"),
  previousPage: document.querySelector("#previousPage"),
  nextPage: document.querySelector("#nextPage"),
  readerMenu: document.querySelector("#readerMenu"),
  syncStatus: document.querySelector("#syncStatus"),
};

const reader = createReader({
  view: elements.readerView,
  title: elements.readerTitle,
  chapter: elements.chapterTitle,
  pages: elements.readerPages,
  content: elements.readerContent,
  indicator: elements.pageIndicator,
  previous: elements.previousPage,
  next: elements.nextPage,
});

let connectionEpoch = null;
let onlineCatalog = [];

function setOnline(online) {
  elements.badge.textContent = online ? "电脑已连接" : "离线可读";
  elements.badge.classList.toggle("online", online);
}

async function renderStorage() {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  const used = ((estimate.usage || 0) / 1024 / 1024).toFixed(1);
  const quota = ((estimate.quota || 0) / 1024 / 1024).toFixed(0);
  elements.storage.textContent = `本机已用 ${used} MiB · 浏览器配额约 ${quota} MiB`;
}

function compareBooks(left, right) {
  const leftRead = left.last_read_at ? Date.parse(left.last_read_at) : 0;
  const rightRead = right.last_read_at ? Date.parse(right.last_read_at) : 0;
  if (leftRead || rightRead) {
    if (!leftRead) return 1;
    if (!rightRead) return -1;
    if (leftRead !== rightRead) return rightRead - leftRead;
  }
  return String(left.title || "").localeCompare(String(right.title || ""), "zh-CN");
}

async function renderLibrary(expandedHash = null) {
  const offline = await allRecords("books");
  const offlineMap = new Map(offline.map((book) => [book.content_hash, book]));
  const combined = [...offline];
  for (const remote of onlineCatalog) {
    if (remote.content_hash && !offlineMap.has(remote.content_hash)) combined.push(remote);
  }
  combined.sort(compareBooks);
  elements.bookList.replaceChildren();
  elements.emptyLibrary.hidden = combined.length > 0;
  for (const book of combined) {
    const isOffline = book.offline_status === "offline";
    const card = document.createElement("article");
    card.className = `book-card${isOffline ? " offline" : ""}`;
    const panelId = `book-details-${book.content_hash}`;
    const summary = document.createElement("button");
    summary.className = "book-summary";
    summary.type = "button";
    summary.setAttribute("aria-controls", panelId);
    const title = document.createElement("span");
    title.className = "book-title";
    title.textContent = book.title;
    const disclosure = document.createElement("span");
    disclosure.className = "book-disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    disclosure.textContent = "+";
    summary.append(title, disclosure);
    const details = document.createElement("div");
    details.className = "book-details";
    details.id = panelId;
    const facts = document.createElement("dl");
    facts.className = "book-facts";
    for (const [label, value] of [
      ["作者", book.author || "未知作者"],
      ["格式", String(book.format || "EPUB").toUpperCase()],
      ["状态", isOffline ? "已离线" : "电脑书库"],
    ]) {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      facts.append(term, description);
    }
    const status = document.createElement("p");
    status.className = "book-status";
    const action = document.createElement("button");
    action.className = `book-action${isOffline ? " secondary" : ""}`;
    action.textContent = isOffline ? "继续阅读" : "下载";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        if (isOffline) {
          const currentBook = await refreshOfflineBook(book, (message) => { status.textContent = message; });
          await reader.openBook(currentBook);
        } else {
          await downloadBook(book.content_hash, (message) => { status.textContent = message; });
          await renderLibrary(book.content_hash);
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        action.disabled = false;
      }
    });
    details.append(facts, action, status);
    const expanded = expandedHash === book.content_hash;
    details.hidden = !expanded;
    card.classList.toggle("expanded", expanded);
    summary.setAttribute("aria-expanded", String(expanded));
    disclosure.textContent = expanded ? "−" : "+";
    summary.addEventListener("click", () => {
      const shouldExpand = details.hidden;
      for (const openCard of elements.bookList.querySelectorAll(".book-card.expanded")) {
        openCard.classList.remove("expanded");
        openCard.querySelector(".book-details").hidden = true;
        openCard.querySelector(".book-summary").setAttribute("aria-expanded", "false");
        openCard.querySelector(".book-disclosure").textContent = "+";
      }
      if (shouldExpand) {
        details.hidden = false;
        card.classList.add("expanded");
        summary.setAttribute("aria-expanded", "true");
        disclosure.textContent = "−";
      }
    });
    card.append(summary, details);
    elements.bookList.append(card);
  }
  await renderStorage();
}

async function refreshCatalog() {
  elements.refresh.disabled = true;
  try {
    onlineCatalog = (await fetchCatalog()).books.filter((book) => book.availability === "available");
    await refreshOfflineMetadata(onlineCatalog);
    await renderLibrary();
  } catch (error) {
    elements.storage.textContent = `电脑书库暂不可达：${error.message}`;
    await renderLibrary();
  } finally {
    elements.refresh.disabled = false;
  }
}

async function enterLibrary(device) {
  elements.pairView.hidden = true;
  elements.libraryView.hidden = false;
  connectForeground(device, ({ online, connectionEpoch: epoch }) => {
    connectionEpoch = epoch;
    setOnline(online);
    if (online) refreshCatalog();
  });
  await renderLibrary();
}

elements.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = elements.pairForm.querySelector("button");
  button.disabled = true;
  try {
    const device = await pairDevice(elements.pairCode.value, (status) => {
      elements.pairStatus.textContent = status;
    });
    elements.pairStatus.textContent = "配对完成";
    await enterLibrary(device);
  } catch (error) {
    elements.pairStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.refresh.addEventListener("click", refreshCatalog);
document.querySelector("#closeReader").addEventListener("click", async () => {
  await reader.close();
  await renderLibrary();
});
document.querySelector("#readerMenuButton").addEventListener("click", () => {
  elements.readerMenu.hidden = !elements.readerMenu.hidden;
});
document.querySelector("#fontSmaller").addEventListener("click", async () => {
  const root = document.documentElement;
  const current = parseFloat(getComputedStyle(root).getPropertyValue("--reader-font-size"));
  root.style.setProperty("--reader-font-size", `${Math.max(16, current - 1)}px`);
  await reader.relayout();
});
document.querySelector("#fontLarger").addEventListener("click", async () => {
  const root = document.documentElement;
  const current = parseFloat(getComputedStyle(root).getPropertyValue("--reader-font-size"));
  root.style.setProperty("--reader-font-size", `${Math.min(30, current + 1)}px`);
  await reader.relayout();
});

document.querySelector("#pushProgress").addEventListener("click", async () => {
  elements.syncStatus.textContent = "正在以手机文字进度覆盖电脑…";
  try {
    if (!connectionEpoch) throw new Error("请保持应用在前台并连接电脑");
    await reader.savePosition();
    const result = await pushProgress(reader.contentHash, connectionEpoch);
    elements.syncStatus.textContent = result.status === "source_progress_missing" ? "跳过：手机没有有效进度" : "电脑文字进度已覆盖；播放设置未改变";
  } catch (error) {
    elements.syncStatus.textContent = error.message;
  }
});

document.querySelector("#pullProgress").addEventListener("click", async () => {
  elements.syncStatus.textContent = "正在以电脑文字进度覆盖手机…";
  try {
    if (!connectionEpoch) throw new Error("请保持应用在前台并连接电脑");
    const result = await pullProgress(reader.contentHash, connectionEpoch);
    if (result.status === "source_progress_missing") {
      elements.syncStatus.textContent = "跳过：电脑没有有效文字进度";
      return;
    }
    elements.syncStatus.textContent = "手机文字进度已覆盖";
    const book = (await allRecords("books")).find((item) => item.content_hash === reader.contentHash);
    if (book) await reader.openBook(book);
  } catch (error) {
    elements.syncStatus.textContent = error.message;
  }
});

async function start() {
  await openDatabase();
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/mobile/sw.js", {
      scope: "/mobile/",
      updateViaCache: "none",
    });
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => false);
  const device = await getDevice();
  if (device?.credential) await enterLibrary(device);
  else {
    elements.pairView.hidden = false;
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (!standalone) {
      elements.pairForm.querySelector("button").disabled = true;
      elements.pairCode.disabled = true;
      elements.pairStatus.textContent = "请先从 Safari 添加到主屏幕，再从主屏幕打开后输入短码。";
    }
  }
}

start().catch((error) => {
  elements.pairView.hidden = false;
  elements.pairStatus.textContent = `本地存储初始化失败：${error.message}`;
});
