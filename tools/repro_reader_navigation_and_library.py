from pathlib import Path

from playwright.sync_api import Route, sync_playwright


BASE_URL = "http://127.0.0.1:8766/app/"
SAVED_PROGRESS = []


def handle_api(route: Route) -> None:
    url = route.request.url
    if url.endswith("/api/voices"):
        route.fulfill(
            json={
                "default": "zh-CN-XiaoxiaoNeural",
                "voices": ["zh-CN-XiaoxiaoNeural"],
                "rate": "+0%",
                "volume": "+0%",
            }
        )
    elif url.endswith("/api/books"):
        route.fulfill(json=[])
    elif url.endswith("/api/overlay/status"):
        route.fulfill(json={"running": False})
    elif url.endswith("/api/player/command"):
        route.fulfill(json={"command": None})
    elif url.endswith("/progress") and route.request.method == "POST":
        SAVED_PROGRESS.append(route.request.post_data_json)
        route.fulfill(json=route.request.post_data_json)
    else:
        route.fulfill(json={})


def snapshot(page):
    return page.evaluate(
        """() => ({
          sizeKey: getPaginationSizeKey(),
          requestId: state.paginationRequestId,
          visualPageIndex: state.visualPageIndex,
          width: el.paragraphPreview.getBoundingClientRect().width,
          height: el.paragraphPreview.getBoundingClientRect().height,
        })"""
    )


with sync_playwright() as playwright:
    browser_path = next(
        path
        for path in (
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        )
        if path.exists()
    )
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=str(browser_path),
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.route("**/api/**", handle_api)
    page.goto(BASE_URL, wait_until="networkidle")

    assert page.locator("#openLibrary").is_visible()
    assert page.locator(".title-row > #openLibrary > svg").count() == 1
    assert page.locator("#libraryPanel").get_attribute("aria-hidden") == "true"

    page.evaluate(
        """() => {
          const text = Array.from({ length: 180 }, (_, index) => `第${index + 1}句用于分页回归。`).join("");
          const paragraph = { paragraph_index: 0, text, html: null, is_audio: 1 };
          state.bookId = "browser-test";
          state.books = [{ id: "browser-test", title: "Browser Test", file_format: "txt" }];
          state.chapters = [{ chapter_index: 0, title: "Chapter", paragraph_count: 1 }];
          state.paragraphs = [paragraph];
          state.previewParagraphs = [paragraph];
          state.paragraphsByChapter = new Map([[0, [paragraph]]]);
          state.chapterPageCounts = new Map([[0, 20]]);
          state.chapterStartPages = new Map([[0, 1]]);
          state.paragraphStartPages = new Map([["0:0", 0]]);
          state.totalVisualPages = 20;
          state.chapterIndex = 0;
          state.paragraphIndex = 0;
          state.previewChapterIndex = 0;
          state.previewParagraphIndex = 0;
          state.visualPageKey = "";
          state.visualPageIndex = 0;
          state.hasPlaybackPosition = true;
          renderCurrent();
          const flow = getVisualPageFlow();
          const target = [...flow.querySelectorAll('.sentence')].find((node) => {
            const page = getInlineVisualPages(node, flow)[0];
            return page > 0 && page < state.visualPageCount - 1;
          });
          if (!target) throw new Error('未找到中间视觉页的测试句子');
          const targetIndex = Number(target.dataset.index);
          const targetPage = getInlineVisualPages(target, flow)[0];
          state.sentenceTimings = [{ sentence_index: 0, start_ms: 0, text: target.textContent }];
          state.playbackSentenceIndex = targetIndex;
          state.activeSentenceIndex = targetIndex;
          state.playbackVisualPageIndex = targetPage;
          state.visualPageIndex = targetPage;
          window.__testPlaybackSentenceIndex = targetIndex;
          refreshRenderedSentenceTimings();
          applyVisualPagePosition();
          state.paginationSizeKey = getPaginationSizeKey();
        }"""
    )
    page.wait_for_timeout(500)

    assert page.locator("#backToCurrentPage").is_disabled()
    page.locator("#nextParagraph").click()
    assert page.locator("#backToCurrentPage").is_enabled()
    page.wait_for_timeout(500)
    assert SAVED_PROGRESS
    assert SAVED_PROGRESS[-1]["reading_chapter_index"] == 0
    assert SAVED_PROGRESS[-1]["reading_paragraph_index"] == 0
    assert SAVED_PROGRESS[-1]["reading_sentence_index"] is not None
    page.locator("#backToCurrentPage").click()
    assert page.locator("#backToCurrentPage").is_disabled()
    active_sentence_index = page.locator(".sentence.active").get_attribute("data-index")
    expected_sentence_index = page.evaluate("String(window.__testPlaybackSentenceIndex)")
    assert active_sentence_index == expected_sentence_index

    before = snapshot(page)
    page.locator("#openLibrary").click()
    page.wait_for_timeout(300)
    opened = snapshot(page)
    assert page.locator("#libraryPanel").get_attribute("aria-hidden") == "false"
    assert page.locator("#openLibrary").get_attribute("aria-expanded") == "true"
    assert opened == before, (before, opened)

    page.locator("#libraryBackdrop").click(position={"x": 1000, "y": 400})
    page.wait_for_timeout(300)
    assert page.locator("#openLibrary").is_visible()
    assert snapshot(page) == before

    page.locator("#openLibrary").click()
    page.keyboard.press("Escape")
    assert page.locator("#openLibrary").is_visible()
    assert snapshot(page) == before
    assert not console_errors, console_errors

    browser.close()
