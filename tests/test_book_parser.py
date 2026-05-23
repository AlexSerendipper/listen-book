import unittest

from app.backend.book_parser import chunk_chapter, parse_md, parse_txt


class BookParserTests(unittest.TestCase):
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
        self.assertTrue(all(len(chunk.text) <= 900 for chunk in chunks))


if __name__ == "__main__":
    unittest.main()
