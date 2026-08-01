import threading
import time
import uuid

from fastapi import HTTPException


class ForegroundRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, tuple[str, float]] = {}

    def connect(self, device_id: str) -> str:
        epoch = str(uuid.uuid4())
        with self._lock:
            self._sessions[device_id] = (epoch, time.monotonic())
        return epoch

    def heartbeat(self, device_id: str, epoch: str) -> bool:
        with self._lock:
            current = self._sessions.get(device_id)
            if not current or current[0] != epoch:
                return False
            self._sessions[device_id] = (epoch, time.monotonic())
        return True

    def disconnect(self, device_id: str, epoch: str) -> None:
        with self._lock:
            if self._sessions.get(device_id, (None,))[0] == epoch:
                self._sessions.pop(device_id, None)

    def require(self, device_id: str, epoch: str) -> None:
        with self._lock:
            current = self._sessions.get(device_id)
        if not current or current[0] != epoch or time.monotonic() - current[1] > 15:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "mobile_not_foreground",
                    "message": "请先在手机上打开应用",
                    "retryable": True,
                },
            )


foreground_registry = ForegroundRegistry()
