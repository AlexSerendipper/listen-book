# 本地听书

本项目是一个运行在个人电脑上的本地听书 Web App。它可以导入本地 `.txt`、`.md`、`.epub` 书籍，使用 `edge-tts` 生成中文朗读音频，并在本机保存书库、播放进度和音频缓存。

## 功能

- 本地导入 `.txt`、`.md`、`.epub`
- EPUB 按目录和阅读顺序解析章节
- 按固定页切分文本，显示整本书累计页码
- 使用 `edge-tts` 生成 mp3，并缓存已生成音频
- 播放、暂停、上一页、下一页、上一章、下一章
- 保存并恢复最近阅读位置
- 支持声音选择和倍速选择
- 当前句高亮，点击句子从对应位置播放
- 播放到当前页约 70% 时静默预缓存下一页
- 支持书名搜索、目录弹出、删除书籍及对应缓存

## 快速启动

推荐使用项目内快捷方式。

第一次创建快捷方式：

```powershell
cd D:\CodexProject\listen-book
powershell.exe -ExecutionPolicy Bypass -File .\scripts\create_desktop_shortcut.ps1
```

然后双击项目目录里的：

```text
本地听书.lnk
```

启动后会自动打开：

```text
http://127.0.0.1:8765
```

启动窗口需要保持打开。关闭启动窗口，或在启动窗口中按 Enter，会停止本地服务。

## 手动启动

如果不使用快捷方式，可以手动启动：

```powershell
cd D:\CodexProject\listen-book
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.backend.main:app --host 127.0.0.1 --port 8765
```

不要直接依赖系统里的 `python` 命令；在这台 Windows 环境中，`python` 可能指向 WindowsApps 占位程序。优先使用项目里的 `.\.venv\Scripts\python.exe`。

## 本地数据

以下数据只保存在本机，不会提交到 Git：

```text
app/data/app.sqlite
app/data/books/
app/cache/audio/
app/logs/
```

说明：

- `app.sqlite` 保存书库、章节、分页、进度和音频缓存索引
- `app/data/books/` 保存通过网页上传导入的书籍副本
- `app/cache/audio/` 保存生成过的 mp3
- `app/logs/` 保存本地服务日志

## 常见问题

### 启动命令失败

确认当前目录是：

```powershell
D:\CodexProject\listen-book
```

并使用：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.backend.main:app --host 127.0.0.1 --port 8765
```

### 提示端口 8765 被占用

说明本地服务可能已经在运行。可以直接打开：

```text
http://127.0.0.1:8765
```

如果不是本项目服务，关闭占用该端口的进程后再启动。

### 音频准备失败

常见原因：

- `edge-tts` 访问网络失败
- 旧缓存路径失效
- 当前声音或倍速对应的音频还未生成

后端会自动丢弃不存在的旧缓存记录，并重新生成当前项目路径下的音频缓存。

## 开发检查

```powershell
.\.venv\Scripts\python.exe -m compileall app tests
.\.venv\Scripts\python.exe -m unittest discover -s tests
node --check app\frontend\app.js
```

## 目录结构

```text
app/
  backend/   FastAPI 后端、SQLite、书籍解析、TTS 缓存
  frontend/  浏览器界面
  data/      本地数据库和上传书籍，Git 忽略
  cache/     本地音频缓存，Git 忽略
  logs/      本地服务日志，Git 忽略
scripts/
  start_listen_book.ps1
  create_desktop_shortcut.ps1
tests/
```

## 注意

本项目不包含遥测、统计或额外业务网络请求。`edge-tts` 生成语音时会访问 Microsoft Edge TTS 服务。
