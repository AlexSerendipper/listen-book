import unittest

from bs4 import BeautifulSoup

from app.backend.book_parser import (
    Chapter,
    _content_blocks,
    _fragment_for_block,
    _non_empty_chapters,
    _sanitize_style_attr,
    _scope_epub_css,
    chunk_paragraphs,
    chunk_chapter,
    epub_metadata_author,
    Paragraph,
    parse_md,
    parse_txt,
)


class BookParserTests(unittest.TestCase):
    def test_epub_author_prefers_author_role_and_deduplicates(self) -> None:
        authors = epub_metadata_author([
            ("本杰明·格雷厄姆", {"{opf}role": "aut"}),
            ("本杰明·格雷厄姆", {"{opf}role": "aut"}),
            ("某译者", {"{opf}role": "trl"}),
        ])

        self.assertEqual(authors, "本杰明·格雷厄姆")

    def test_parse_md_uses_headings(self) -> None:
        chapters = parse_md("# 第一章\n正文一\n\n## 第二章\n正文二")
        self.assertEqual([chapter.title for chapter in chapters], ["第一章", "第二章"])

    def test_parse_txt_detects_chapter_titles(self) -> None:
        chapters = parse_txt("第一章 开始\n这是一段正文。\n\n第二章 继续\n这是另一段正文。")
        self.assertEqual(len(chapters), 2)
        self.assertEqual(chapters[0].title, "第一章 开始")

    def test_chunk_chapter_splits_long_text(self) -> None:
        text = "。".join([f"这是第{i}句内容" for i in range(120)]) + "。"
        chunks = chunk_chapter(text, min_len=100, max_len=220)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(chunk.text_hash for chunk in chunks))
        self.assertTrue(all(len(chunk.text) <= 220 for chunk in chunks))

    def test_default_chunk_size_is_suitable_for_listening(self) -> None:
        text = "。".join([f"这是一段用于听书的长文本内容{i}" for i in range(260)]) + "。"
        chunks = chunk_chapter(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk.text) <= 620 for chunk in chunks))

    def test_epub_css_is_scoped_to_reader(self) -> None:
        css = "body { margin: 0; } .callout { border: 1px solid #777; } @import url(http://example.com/a.css);"
        scoped = _scope_epub_css(css)

        self.assertIn(".paragraph-preview .epub-fragment", scoped)
        self.assertIn("border: 1px solid #777", scoped)
        self.assertNotIn("@import", scoped)

    def test_epub_style_attr_filters_remote_urls(self) -> None:
        style = "border: 1px solid #777; background-image: url(http://example.com/a.png); position: fixed"

        self.assertEqual(_sanitize_style_attr(style), "border: 1px solid #777")

    def test_epub_fragment_keeps_styled_container(self) -> None:
        soup = BeautifulSoup(
            '<body><div class="callout"><p class="title">查理·芒格</p><p>如果你想获得你要的东西。</p></div></body>',
            "html.parser",
        )
        block = soup.find_all("p")[1]

        fragment = _fragment_for_block(soup, block, soup.body)

        self.assertIn('class="epub-fragment"', fragment)
        self.assertIn('class="callout"', fragment)
        self.assertIn("如果你想获得你要的东西。", fragment)
        self.assertNotIn("查理·芒格", fragment)

    def test_epub_structural_container_stays_one_fragment(self) -> None:
        soup = BeautifulSoup(
            '<body><div class="roundsolid"><p><b>Benjamin Franklin</b></p><p>The closest thing to reliving a life.</p></div></body>',
            "html.parser",
        )
        blocks = _content_blocks(soup.body)

        self.assertEqual(len(blocks), 1)
        fragment = _fragment_for_block(soup, blocks[0], soup.body)
        self.assertEqual(fragment.count('class="roundsolid"'), 1)
        self.assertIn("Benjamin Franklin", fragment)
        self.assertIn("The closest thing", fragment)

    def test_epub_blockquote_does_not_duplicate_child_paragraph(self) -> None:
        soup = BeautifulSoup(
            "<body><blockquote><p>Quoted paragraph.</p></blockquote><p>Next paragraph.</p></body>",
            "html.parser",
        )
        blocks = _content_blocks(soup.body)

        self.assertEqual([block.name for block in blocks], ["blockquote", "p"])
        self.assertEqual([block.get_text(" ", strip=True) for block in blocks], ["Quoted paragraph.", "Next paragraph."])

    def test_epub_plain_paragraphs_stay_separate_blocks(self) -> None:
        soup = BeautifulSoup("<body><p>First paragraph.</p><p>Second paragraph.</p></body>", "html.parser")
        blocks = _content_blocks(soup.body)

        self.assertEqual([block.get_text(" ", strip=True) for block in blocks], ["First paragraph.", "Second paragraph."])

    def test_epub_image_only_chapter_is_kept_as_visual_content(self) -> None:
        chapter = Chapter(
            title="Cover",
            text="",
            paragraphs=[
                Paragraph(text="", text_hash="cover", html="<img src='/cover.jpg'>", is_audio=False),
            ],
        )

        chapters = _non_empty_chapters([chapter])

        self.assertEqual(chapters, [chapter])
        self.assertFalse(chapters[0].paragraphs[0].is_audio)

    def test_epub_paragraphs_are_compacted_like_pages(self) -> None:
        raw = [
            Paragraph(text="第一段。" * 20, text_hash="a", html="<p>第一段。</p>"),
            Paragraph(text="第二段。" * 20, text_hash="b", html="<p>第二段。</p>"),
            Paragraph(text="", text_hash="img", html="<img src='/a.jpg'>", is_audio=False),
        ]

        chunks = chunk_paragraphs(raw, min_len=100, max_len=900)

        self.assertEqual(len(chunks), 2)
        self.assertTrue(chunks[0].is_audio)
        self.assertFalse(chunks[1].is_audio)
        self.assertIn("第一段", chunks[0].html)
        self.assertIn("第二段", chunks[0].html)
        self.assertIn("<img", chunks[1].html)

    def test_epub_short_front_matter_stays_separate_from_long_intro(self) -> None:
        raw = [
            Paragraph(text="Title", text_hash="title", html="<p>Title</p>", is_audio=False),
            Paragraph(text="Subtitle", text_hash="subtitle", html="<p>Subtitle</p>", is_audio=False),
            Paragraph(text="Author", text_hash="author", html="<p>Author</p>", is_audio=False),
            Paragraph(text="Intro sentence. " * 35, text_hash="intro", html="<p>Intro sentence.</p>"),
        ]

        chunks = chunk_paragraphs(raw, min_len=100, max_len=900)

        self.assertEqual(len(chunks), 2)
        self.assertFalse(chunks[0].is_audio)
        self.assertTrue(chunks[1].is_audio)
        self.assertIn("Title", chunks[0].text)
        self.assertIn("Intro sentence", chunks[1].text)

    def test_epub_short_label_stays_with_following_quote(self) -> None:
        raw = [
            Paragraph(text="Benjamin Franklin", text_hash="name", html="<p><b>Benjamin Franklin</b></p>", is_audio=False),
            Paragraph(
                text="The closest thing to reliving a life is remembering it and writing it down.",
                text_hash="quote",
                html="<p>The closest thing to reliving a life is remembering it and writing it down.</p>",
            ),
        ]

        chunks = chunk_paragraphs(raw, min_len=100, max_len=900)

        self.assertEqual(len(chunks), 1)
        self.assertTrue(chunks[0].is_audio)
        self.assertIn("Benjamin Franklin", chunks[0].text)
        self.assertIn("reliving a life", chunks[0].text)


if __name__ == "__main__":
    unittest.main()
