import unittest
from unittest.mock import patch

from app.backend import main


class OverlayApiTests(unittest.TestCase):
    def setUp(self) -> None:
        with main.PLAYER_STATE_LOCK:
            main.PLAYER_STATE.update(
                {
                    "book_title": "",
                    "chapter_title": "",
                    "page_label": "",
                    "current_sentence": "",
                    "next_sentence": "",
                    "is_playing": False,
                    "updated_at": 0.0,
                }
            )
        with main.PLAYER_COMMAND_LOCK:
            main.PLAYER_COMMAND = None

    def test_player_state_round_trip(self) -> None:
        state = main.update_player_state(
            {
                "book_title": "Book",
                "chapter_title": "Chapter",
                "page_label": "Page 1",
                "current_sentence": "Current sentence.",
                "next_sentence": "Next sentence.",
                "is_playing": True,
            }
        )

        self.assertEqual(state["book_title"], "Book")
        self.assertEqual(state["current_sentence"], "Current sentence.")
        self.assertTrue(state["is_playing"])
        self.assertGreater(state["updated_at"], 0)
        self.assertEqual(main.get_player_state()["next_sentence"], "Next sentence.")

    def test_player_command_is_read_once(self) -> None:
        main.update_player_state({"current_sentence": "Current sentence."})

        queued = main.send_player_command({"command": "toggle_play"})

        self.assertEqual(queued["command"], "toggle_play")
        self.assertEqual(main.get_player_command()["command"], "toggle_play")
        self.assertIsNone(main.get_player_command()["command"])

    def test_stale_player_command_opens_page_and_starts_playback(self) -> None:
        with patch("app.backend.main.webbrowser.open") as open_browser:
            queued = main.send_player_command({"command": "toggle_play"})

        open_browser.assert_called_once_with("http://127.0.0.1:8765/app/")
        self.assertEqual(queued["command"], "start_playback")
        self.assertEqual(main.get_player_command()["command"], "start_playback")


if __name__ == "__main__":
    unittest.main()
