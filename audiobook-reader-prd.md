# 本地听书工具产品文档

## 1. 产品定位

本产品是一个运行在用户电脑上的本地听书工具，用于导入本地书籍文件，生成自然中文朗读音频，并记录每本书的听书进度。

产品第一版形态为本地 Web App：

- 后端运行在用户电脑本地
- 前端通过浏览器访问本地地址
- 书籍文件、音频缓存、阅读进度均保存在用户电脑本地
- 不作为在线网站或多人服务

推荐启动方式：

```text
启动本地程序 -> 自动或手动打开 http://localhost:{port} -> 使用网页界面听书
```

## 2. 目标用户

目标用户是希望在个人电脑上听本地电子书的用户。

用户典型需求：

- 本地书籍主要是 `epub`、`md`、`txt`
- 希望朗读声音自然、适合长时间听书
- 希望关闭程序后，下次打开还能从上次停止的位置继续
- 希望音频生成后可以复用，避免重复等待
- 希望操作简单，像一个本地听书播放器

## 3. 技术结论

第一版使用以下方案：

```text
本地 Web App + Python 后端 + 浏览器前端 + edge-tts + SQLite + 本地音频缓存
```

核心组件：

- 书籍解析：Python
- TTS：`edge-tts`
- 默认中文声音：`zh-CN-XiaoxiaoNeural`
- 音频格式：`mp3`
- 播放器：浏览器 `<audio>` 或前端音频播放器
- 数据库：SQLite
- 缓存目录：本地文件系统

TTS 层需要设计为可替换模块，后续可替换为 Azure Speech、Kokoro、CosyVoice、IndexTTS 或其他引擎。

## 4. MVP 功能范围

### 4.1 书籍导入

支持导入以下格式：

- `.txt`
- `.md`
- `.epub`

导入后应完成：

- 识别书名
- 识别文件格式
- 生成唯一 `book_id`
- 解析章节
- 保存书籍元数据
- 建立或更新本地书库记录

### 4.2 章节解析

不同格式解析规则：

- `txt`：按标题规则、空行或文本长度切分章节
- `md`：按 Markdown 标题切分章节
- `epub`：读取目录结构和正文 HTML，提取纯文本章节

章节解析结果应保存为：

```text
book_id
chapter_index
chapter_title
chapter_text
```

### 4.3 文本切块

不要整章一次性生成音频。章节正文需要切成适合 TTS 的文本块。

推荐规则：

- 优先按自然段切分
- 单个文本块建议 100 到 500 个中文字符
- 太短的段落可以合并
- 太长的段落按中文标点继续拆分
- 优先在 `。`、`！`、`？`、`；` 后切分
- 保留原文标点，以获得更自然的停顿

切块结果应包含：

```text
book_id
chapter_index
paragraph_index
text
text_hash
```

### 4.4 TTS 生成

使用 `edge-tts` 生成音频。

默认配置：

```text
voice = zh-CN-XiaoxiaoNeural
rate = +0%
volume = +0%
format = mp3
```

需要支持用户配置：

- 声音
- 语速
- 音量

推荐中文声音：

```text
zh-CN-XiaoxiaoNeural
zh-CN-YunxiNeural
zh-CN-YunjianNeural
zh-CN-XiaoyiNeural
zh-CN-YunyangNeural
```

### 4.5 音频缓存

必须实现本地音频缓存。

缓存命中条件：

```text
book_id
chapter_index
paragraph_index
voice
rate
volume
text_hash
```

如果缓存存在，直接播放缓存音频。

如果缓存不存在，调用 TTS 生成音频，写入缓存后播放。

缓存路径建议：

```text
cache/audio/{book_id}/{chapter_index}/{paragraph_index}_{voice}_{rate}_{volume}_{text_hash}.mp3
```

### 4.6 播放控制

第一版至少支持：

- 播放
- 暂停
- 继续
- 上一段
- 下一段
- 上一章
- 下一章
- 显示当前章节
- 显示当前段落
- 显示当前播放进度

播放行为：

- 当前段落播放完成后，自动进入下一段
- 当前章节播放完成后，自动进入下一章
- 下一段音频可提前生成，减少等待

### 4.7 进度保存和恢复

必须支持每本书独立记录进度。

进度粒度：

```text
book_id
chapter_index
paragraph_index
audio_position_ms
voice
rate
volume
updated_at
```

保存时机：

- 用户暂停时
- 用户切换章节时
- 用户切换段落时
- 当前段落播放结束时
- 程序退出或页面关闭前
- 播放过程中每 5 到 10 秒自动保存一次

恢复逻辑：

```text
用户打开书籍
-> 生成或识别 book_id
-> 查询 reading_progress
-> 如果存在历史进度，恢复到 chapter_index + paragraph_index + audio_position_ms
-> 如果不存在历史进度，从第一章第一段开始
```

## 5. book_id 生成规则

第一版推荐：

```text
book_id = hash(file_path + file_size + file_mtime)
```

后续增强可升级为：

```text
book_id = hash(file_content_sample + file_size)
```

这样可以在文件移动位置后仍尽量识别为同一本书。

## 6. 数据库设计

使用 SQLite。

### 6.1 books

```sql
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  title TEXT,
  author TEXT,
  file_format TEXT NOT NULL,
  file_size INTEGER,
  file_mtime INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 6.2 chapters

```sql
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id)
);
```

### 6.3 paragraphs

```sql
CREATE TABLE paragraphs (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id)
);
```

### 6.4 reading_progress

```sql
CREATE TABLE reading_progress (
  book_id TEXT PRIMARY KEY,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  audio_position_ms INTEGER NOT NULL DEFAULT 0,
  voice TEXT NOT NULL,
  rate TEXT NOT NULL,
  volume TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(book_id) REFERENCES books(id)
);
```

### 6.5 audio_cache

```sql
CREATE TABLE audio_cache (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  paragraph_index INTEGER NOT NULL,
  voice TEXT NOT NULL,
  rate TEXT NOT NULL,
  volume TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
```

## 7. 本地目录结构

建议目录：

```text
app/
  backend/
  frontend/
  data/
    app.sqlite
  cache/
    audio/
  logs/
```

## 8. 核心播放流程

```text
打开应用
-> 显示本地书库
-> 用户选择或导入书籍
-> 解析书籍
-> 查询历史进度
-> 定位到目标章节和段落
-> 检查当前段落音频缓存
-> 缓存存在：播放缓存音频
-> 缓存不存在：调用 edge-tts 生成 mp3
-> 播放音频
-> 定期保存 audio_position_ms
-> 段落结束后进入下一段
```

## 9. 前端界面要求

第一版界面应包含：

- 书库列表
- 导入书籍按钮
- 当前书名
- 当前章节标题
- 章节列表
- 当前段落预览
- 播放/暂停按钮
- 上一段/下一段按钮
- 上一章/下一章按钮
- 播放进度条
- 声音选择
- 语速设置
- 音量设置

不需要做营销页。打开应用后应直接进入书库或播放器界面。

## 10. 后端 API 建议

可以提供以下接口：

```text
GET  /api/books
POST /api/books/import
GET  /api/books/{book_id}
GET  /api/books/{book_id}/chapters
GET  /api/books/{book_id}/progress
POST /api/books/{book_id}/progress
GET  /api/books/{book_id}/audio?chapter_index=&paragraph_index=&voice=&rate=&volume=
GET  /api/voices
```

音频接口逻辑：

```text
检查缓存
-> 有缓存则返回 mp3
-> 无缓存则生成 mp3
-> 写入 audio_cache
-> 返回 mp3
```

## 11. 验收标准

MVP 完成时必须满足：

- 可以导入 `.txt`、`.md`、`.epub`
- 可以解析出章节和段落
- 可以用 `zh-CN-XiaoxiaoNeural` 朗读中文文本
- 可以播放、暂停、继续
- 可以上一段、下一段、上一章、下一章
- 可以保存每本书的听书进度
- 关闭应用后重新打开同一本书，可以从上次停止位置继续
- 已生成过的段落音频再次播放时不会重新生成
- 音频缓存、数据库和书籍进度均保存在本地

## 12. 实现注意事项

- 全部文本处理统一使用 UTF-8
- 不要把整本书一次性发给 TTS
- 不要把整章一次性发给 TTS
- 不要每次播放都重新生成音频
- 进度不要只记录章节，必须记录到段落和音频毫秒位置
- TTS 调用建议使用 Python API，不要依赖 shell 管道传中文文本
- TTS 层必须保持可替换
- 文件路径和缓存路径要避免非法字符
- 不要加入遥测、统计或额外网络请求
- 不要保存任何密钥或凭据

## 13. 后续增强

后续版本可增加：

- 多声音试听
- 书签
- 最近播放
- 全文搜索
- 下一章预生成
- 离线 TTS 引擎
- Azure Speech 正式 API
- 按角色分配不同声音
- 导出章节音频
- 打包为 Tauri 或 Electron 桌面 App
