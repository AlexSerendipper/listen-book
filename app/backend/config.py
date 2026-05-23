from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = APP_DIR / "data"
CACHE_DIR = APP_DIR / "cache"
AUDIO_CACHE_DIR = CACHE_DIR / "audio"
LOG_DIR = APP_DIR / "logs"
FRONTEND_DIR = APP_DIR / "frontend"
DB_PATH = DATA_DIR / "app.sqlite"

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_RATE = "+0%"
DEFAULT_VOLUME = "+0%"

SUPPORTED_FORMATS = {".txt", ".md", ".epub"}
CHINESE_VOICES = [
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunyangNeural",
]


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
