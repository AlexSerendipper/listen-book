from pathlib import Path

from playwright.sync_api import Route, sync_playwright


BASE_URL = "http://127.0.0.1:8766/app/"
SCREENSHOT = Path(r"C:\Users\alexzhong\.codex\visualizations\2026\08\02\019fc125-e748-7602-af9b-ad325e72f3db\desktop-chapter-popover.png")


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
    elif url.endswith("/api/books/test-book/chapters"):
        route.fulfill(
            json=[
                {"chapter_index": 0, "title": "第一章", "paragraph_count": 1},
                {"chapter_index": 1, "title": "第二章", "paragraph_count": 1},
            ]
        )
    elif "/api/books/test-book/paragraphs" in url:
        route.fulfill(
            json=[
                {
                    "chapter_index": 0,
                    "paragraph_index": 0,
                    "text": "用于目录跳转测试的正文。",
                    "text_hash": "test",
                    "html": None,
                    "is_audio": 0,
                }
            ]
        )
    elif url.endswith("/api/books"):
        route.fulfill(json=[])
    elif url.endswith("/api/overlay/status"):
        route.fulfill(json={"running": False})
    elif url.endswith("/api/player/command"):
        route.fulfill(json={"command": None})
    else:
        route.fulfill(json={})


with sync_playwright() as playwright:
    browser_path = next(
        path
        for path in (
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        )
        if path.exists()
    )
    browser = playwright.chromium.launch(headless=True, executable_path=str(browser_path))
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.route("**/api/**", handle_api)
    page.goto(BASE_URL, wait_until="networkidle")
    page.evaluate(
        """() => {
          state.bookId = "test-book";
          state.books = [{ id: "test-book", title: "目录浮层测试", file_format: "epub" }];
          state.chapters = [
            { chapter_index: 0, title: "第一章", paragraph_count: 1 },
            { chapter_index: 1, title: "第二章", paragraph_count: 1 },
          ];
          renderBooks();
        }"""
    )

    page.locator("#openLibrary").click()
    page.locator('[data-action="chapters"]').click()
    popover = page.locator("#chapterPopover")
    assert popover.is_visible()
    layers = page.evaluate(
        """() => ({
          popover: Number(getComputedStyle(el.chapterPopover).zIndex),
          library: Number(getComputedStyle(el.library).zIndex),
          backdrop: Number(getComputedStyle(el.libraryBackdrop).zIndex),
        })"""
    )
    assert layers["popover"] > layers["library"] > layers["backdrop"], layers
    first_chapter = popover.locator(".chapter-item").first
    assert first_chapter.evaluate(
        """node => {
          const rect = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(rect.left + 10, rect.top + 10));
        }"""
    )
    page.screenshot(path=str(SCREENSHOT))

    page.locator(".brand .eyebrow").click()
    assert not popover.is_visible()
    assert page.locator("#libraryPanel").get_attribute("aria-hidden") == "false"

    page.locator('[data-action="chapters"]').click()
    page.locator("#libraryBackdrop").click(position={"x": 1000, "y": 400})
    assert not popover.is_visible()
    assert page.locator("#libraryPanel").get_attribute("aria-hidden") == "false"

    page.locator('[data-action="chapters"]').click()
    popover.locator(".chapter-item").first.click()
    assert not popover.is_visible()
    assert page.locator("#libraryPanel").get_attribute("aria-hidden") == "false"
    assert not console_errors, console_errors
    browser.close()
