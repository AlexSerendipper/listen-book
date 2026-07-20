const cdpPort = Number(process.argv[2] || 9223);
const viewportWidth = Number(process.argv[3] || 2048);
const viewportHeight = Number(process.argv[4] || 983);
const sampleDurationMs = Number(process.argv[5] || 12000);
const collapseWaitMs = Number(process.argv[6] || 3000);
const scenario = process.argv[7] || "click";
const targetPrefix = scenario.startsWith("auto") ? "大约在恺撒的年代" : "然而，令";
const nodeTargetUrl = `http://127.0.0.1:${cdpPort}`;

async function waitFor(condition, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms`);
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    this.socket.close();
  }
}

const targets = await waitFor(async () => {
  const response = await fetch(`${nodeTargetUrl}/json/list`);
  if (!response.ok) return null;
  const items = await response.json();
  return items.some((item) => item.type === "page") ? items : null;
});
const target = targets.find((item) => item.type === "page");
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: viewportWidth,
  height: viewportHeight,
  deviceScaleFactor: 1,
  mobile: false,
});

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Evaluation failed");
  }
  return result.result.value;
}

await evaluate(`location.href = "http://127.0.0.1:8765/app/?repro=${Date.now()}"`);
await waitFor(() => evaluate(`document.readyState === "complete"`));
await waitFor(() => evaluate(`document.querySelectorAll(".book-row").length > 0`));
await evaluate(`document.querySelector(".book-row [data-action='open']").click()`);
await waitFor(
  () => evaluate(`
    state.bookId &&
    state.audioReady &&
    !state.loadingAudio &&
    state.paginationSizeKey &&
    getPaginationSizeKey() === state.paginationSizeKey &&
    document.querySelectorAll(".sentence").length > 0
  `),
  60000,
);
await evaluate(`audio.pause()`);
const runtimeInfo = await evaluate(`(() => ({
  appScript: performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .find((name) => name.includes("/app.js")),
  innerWidth,
  innerHeight,
  devicePixelRatio,
}))()`);
console.log("RUNTIME", JSON.stringify(runtimeInfo));
if (!await evaluate(`[...document.querySelectorAll(".sentence")].some((item) =>
  item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
)`)) {
  await evaluate(`previewJumpToChapter(21)`);
  await waitFor(() => evaluate(`[...document.querySelectorAll(".sentence")].some((item) =>
    item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
  )`));
}

const targetInfo = await evaluate(`(() => {
  const node = [...document.querySelectorAll(".sentence")].find((item) =>
    item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
  );
  if (!node) return null;
  const flow = getVisualPageFlow();
  const pages = getInlineVisualPages(node, flow);
  state.visualPageIndex = pages[0];
  applyVisualPagePosition();
  const rect = node.getBoundingClientRect();
  return {
    text: node.textContent.trim(),
    paragraphIndex: Number(node.dataset.paragraphIndex),
    sentenceIndex: Number(node.dataset.index),
    pages,
    x: rect.left + Math.min(40, rect.width / 2),
    y: rect.top + rect.height / 2,
    meta: document.querySelector("#paragraphMeta").textContent,
  };
})()`);

if (!targetInfo) throw new Error("Target sentence was not found in the current chapter");
console.log("TARGET", JSON.stringify(targetInfo));

await evaluate(`state.libraryCollapsed || document.querySelector("#toggleLibrary").click()`);
await new Promise((resolve) => setTimeout(resolve, collapseWaitMs));
const clickInfo = await evaluate(`(() => {
  const target = [...document.querySelectorAll(".sentence")].find((item) =>
    item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
  );
  const paragraphIndex = Number(target.dataset.paragraphIndex);
  const sentenceIndex = Number(target.dataset.index);
  const node = ${JSON.stringify(scenario)} === "auto-click"
    ? document.querySelector(
        '.sentence[data-paragraph-index="' + paragraphIndex + '"][data-index="' + (sentenceIndex - 1) + '"]',
      )
    : target;
  const flow = getVisualPageFlow();
  const targetPages = getInlineVisualPages(target, flow);
  state.visualPageIndex = targetPages.at(-1);
  applyVisualPagePosition();
  const rect = node.getBoundingClientRect();
  return {
    text: node.textContent.trim(),
    pages: getInlineVisualPages(node, flow),
    x: rect.left + Math.min(40, rect.width / 2),
    y: rect.top + rect.height / 2,
    meta: document.querySelector("#paragraphMeta").textContent,
  };
})()`);
console.log("CLICK_TARGET", JSON.stringify(clickInfo));
await evaluate(`(() => {
  window.__reproEvents = [];
  const record = (type) => {
    const flow = getVisualPageFlow();
    window.__reproEvents.push({
      at: performance.now(),
      type,
      visualPageIndex: state.visualPageIndex,
      actualVisualPage: flow ? getActualVisualPage(flow) : null,
      scrollLeft: flow?.scrollLeft ?? null,
      sizeKey: getPaginationSizeKey(),
    });
  };
  const originalSchedulePaginationRebuild = schedulePaginationRebuild;
  schedulePaginationRebuild = function (...args) {
    record("schedulePaginationRebuild");
    return originalSchedulePaginationRebuild(...args);
  };
  const originalRenderCurrent = renderCurrent;
  renderCurrent = function (...args) {
    record("renderCurrent:before");
    const result = originalRenderCurrent(...args);
    record("renderCurrent:after");
    return result;
  };
  const originalApplyVisualPagePosition = applyVisualPagePosition;
  applyVisualPagePosition = function (...args) {
    record("applyVisualPagePosition:before");
    const result = originalApplyVisualPagePosition(...args);
    record("applyVisualPagePosition:after");
    return result;
  };
})()`);
if (scenario === "auto") {
  await evaluate(`(async () => {
    const target = [...document.querySelectorAll(".sentence")].find((item) =>
      item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
    );
    const paragraphIndex = Number(target.dataset.paragraphIndex);
    const sentenceIndex = Number(target.dataset.index);
    await playFromSentence(paragraphIndex, sentenceIndex - 1, state.visualPageIndex);
    audio.pause();
    const currentTarget = [...document.querySelectorAll(".sentence")].find((item) =>
      item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
    );
    const flow = getVisualPageFlow();
    state.visualPageIndex = getInlineVisualPages(currentTarget, flow).at(-1);
    applyVisualPagePosition();
    await audio.play();
  })()`);
}
const snapshotExpression = `(() => {
  const flow = getVisualPageFlow();
  const active = document.querySelector(".sentence.active");
  const target = [...document.querySelectorAll(".sentence")].find((item) =>
    item.textContent.trim().startsWith(${JSON.stringify(targetPrefix)})
  );
  const flowRect = flow?.getBoundingClientRect();
  const targetVisible = Boolean(target && flowRect && [...target.getClientRects()].some((rect) =>
    rect.right > flowRect.left && rect.left < flowRect.right &&
    rect.bottom > flowRect.top && rect.top < flowRect.bottom
  ));
  return {
    meta: document.querySelector("#paragraphMeta").textContent,
    visualPageIndex: state.visualPageIndex,
    actualVisualPage: flow ? getActualVisualPage(flow) : null,
    visualPageCount: state.visualPageCount,
    totalVisualPages: state.totalVisualPages,
    sizeKey: state.paginationSizeKey,
    currentSizeKey: getPaginationSizeKey(),
    scrollLeft: flow?.scrollLeft ?? null,
    pageStep: flow ? getVisualPageStep(flow) : null,
    paragraphIndex: state.paragraphIndex,
    playbackSentenceIndex: state.playbackSentenceIndex,
    activeSentenceIndex: state.activeSentenceIndex,
    audioTime: Math.floor((audio.currentTime || 0) * 2) / 2,
    loadingAudio: state.loadingAudio,
    guard: state.sentenceClickGuard && {
      paragraphIndex: state.sentenceClickGuard.paragraphIndex,
      sentenceIndex: state.sentenceClickGuard.sentenceIndex,
      visualPageIndex: state.sentenceClickGuard.visualPageIndex,
    },
    activeText: active?.textContent.trim().slice(0, 28) || "",
    targetPages: target && flow ? getInlineVisualPages(target, flow) : [],
    targetVisible,
  };
})()`;

console.log("BEFORE", JSON.stringify(await evaluate(snapshotExpression)));
if (scenario === "click" || scenario === "auto-click") {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: clickInfo.x,
    y: clickInfo.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: clickInfo.x,
    y: clickInfo.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

let previous = "";
const startedAt = Date.now();
while (Date.now() - startedAt < sampleDurationMs) {
  const snapshot = await evaluate(snapshotExpression);
  const serialized = JSON.stringify(snapshot);
  if (serialized !== previous) {
    console.log(String(Date.now() - startedAt).padStart(5), serialized);
    previous = serialized;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.log("EVENTS", JSON.stringify(await evaluate(`window.__reproEvents`)));
await evaluate(`audio.pause()`);
cdp.close();
