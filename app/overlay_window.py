import argparse
import json
import tkinter as tk
from tkinter import font
from urllib import error, request


class OverlayWindow:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.drag_start_x = 0
        self.drag_start_y = 0
        self.is_playing = False
        self.max_width = 980
        self.min_width = 360
        self.screen_margin_bottom = 72
        self.user_moved = False

        self.root = tk.Tk()
        self.root.title("Listen Book Overlay")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.9)
        self.root.configure(bg="#101410")

        self.current_font = font.Font(family="Microsoft YaHei UI", size=18, weight="bold")
        self.button_font = font.Font(family="Microsoft YaHei UI", size=10, weight="bold")

        self.shell = tk.Frame(self.root, bg="#101410")
        self.shell.pack(fill="both", expand=True)
        self.bind_drag(self.shell)

        self.caption_frame = tk.Frame(
            self.shell,
            bg="#1a211d",
            bd=0,
            highlightthickness=1,
            highlightbackground="#88b8aa",
        )
        self.caption_frame.pack(fill="both", expand=True, padx=10, pady=10)
        self.bind_drag(self.caption_frame)

        self.controls = tk.Frame(
            self.caption_frame,
            bg="#1a211d",
            bd=0,
            highlightthickness=0,
        )
        self.close_button = self.make_icon_button("x", self.close)
        self.close_button.pack(side="right", padx=(4, 0))
        self.play_button = self.make_icon_button(">", self.toggle_play)
        self.play_button.pack(side="right")
        self.controls.place_forget()

        self.current_label = tk.Label(
            self.caption_frame,
            text="等待播放...",
            fg="#f3efe6",
            bg="#1a211d",
            font=self.current_font,
            wraplength=self.max_width - 90,
            justify="center",
        )
        self.current_label.pack(fill="both", expand=True, padx=28, pady=18)
        self.bind_drag(self.current_label)

        self.root.bind("<Enter>", self.show_controls)
        self.root.bind("<Leave>", self.hide_controls)
        self.position_window(self.min_width, 96)
        self.poll_state()

    def make_icon_button(self, text: str, command) -> tk.Label:
        label = tk.Label(
            self.controls,
            text=text,
            fg="#9dd8cf",
            bg="#1a211d",
            font=self.button_font,
            width=2,
            height=1,
            padx=0,
            pady=0,
            bd=0,
            highlightthickness=0,
            cursor="hand2",
        )
        label.bind("<Button-1>", lambda _event: command())
        return label

    def bind_drag(self, widget: tk.Widget) -> None:
        widget.bind("<ButtonPress-1>", self.start_drag)
        widget.bind("<B1-Motion>", self.drag)

    def show_controls(self, _event: tk.Event | None = None) -> None:
        self.controls.place(relx=1.0, y=8, x=-8, anchor="ne")
        self.controls.lift()
        self.play_button.lift()
        self.close_button.lift()

    def hide_controls(self, _event: tk.Event | None = None) -> None:
        pointer_x = self.root.winfo_pointerx()
        pointer_y = self.root.winfo_pointery()
        root_x = self.root.winfo_rootx()
        root_y = self.root.winfo_rooty()
        if root_x <= pointer_x <= root_x + self.root.winfo_width() and root_y <= pointer_y <= root_y + self.root.winfo_height():
            return
        self.controls.place_forget()

    def position_window(self, width: int, height: int) -> None:
        if self.user_moved:
            self.root.geometry(f"{width}x{height}+{self.root.winfo_x()}+{self.root.winfo_y()}")
            return
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = max(0, int((screen_width - width) / 2))
        y = max(0, screen_height - height - self.screen_margin_bottom)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

    def resize_to_content(self) -> None:
        self.root.update_idletasks()
        text = self.current_label.cget("text")
        text_width = min(self.max_width - 80, max(self.min_width - 80, self.current_font.measure(text)))
        width = min(self.max_width, max(self.min_width, text_width + 90))
        self.current_label.configure(wraplength=width - 90)
        self.root.update_idletasks()
        height = max(82, self.shell.winfo_reqheight())
        self.position_window(width, height)

    def start_drag(self, event: tk.Event) -> None:
        self.drag_start_x = event.x_root - self.root.winfo_x()
        self.drag_start_y = event.y_root - self.root.winfo_y()

    def drag(self, event: tk.Event) -> None:
        self.user_moved = True
        x = event.x_root - self.drag_start_x
        y = event.y_root - self.drag_start_y
        self.root.geometry(f"+{x}+{y}")

    def request_json(self, method: str, path: str, payload: dict | None = None) -> dict:
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        with request.urlopen(req, timeout=1.5) as response:
            return json.loads(response.read().decode("utf-8"))

    def poll_state(self) -> None:
        try:
            state = self.request_json("GET", "/api/player/state")
            self.render_state(state)
        except (OSError, error.URLError, TimeoutError, json.JSONDecodeError):
            self.render_text("等待本地服务...", False)
        self.root.after(400, self.poll_state)

    def render_state(self, state: dict) -> None:
        current = str(state.get("current_sentence") or "").strip()
        self.is_playing = bool(state.get("is_playing"))
        self.render_text(current or "等待播放...", self.is_playing)

    def render_text(self, text: str, is_playing: bool) -> None:
        if self.current_label.cget("text") != text:
            self.current_label.configure(text=text)
            self.resize_to_content()
        self.play_button.configure(text="||" if is_playing else ">")

    def toggle_play(self) -> None:
        try:
            self.request_json("POST", "/api/player/command", {"command": "toggle_play"})
        except (OSError, error.URLError, TimeoutError, json.JSONDecodeError):
            self.render_text("等待本地服务...", False)

    def close(self) -> None:
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    OverlayWindow(args.base_url).run()


if __name__ == "__main__":
    main()
