# 本地听书

本项目是一个运行在个人电脑上的本地听书 Web App。它可以导入本地 `.txt`、`.md`、`.epub` 书籍，使用 `edge-tts` 生成中文朗读音频，并在本机保存书库、播放进度和音频缓存。

## 功能

- 本地导入 `.txt`、`.md`、`.epub`
- EPUB 按目录和阅读顺序解析章节
- 按当前阅读区域实际尺寸计算连续视觉页，显示整本书累计页码
- 使用 `edge-tts` 生成 mp3，并缓存已生成音频
- 播放、暂停、上一页、下一页、上一章、下一章
- 保存并恢复最近阅读位置
- 支持声音选择和倍速选择
- 当前句高亮，点击句子从对应位置播放
- 播放时根据当前高亮句子的可见性同步阅读页，避免音频段切换时误翻页
- 支持“回到当前页”，定位到当前高亮句子所在视觉页
- 播放到当前段音频约 70% 时静默预缓存下一段音频
- 支持书名搜索、目录弹出、删除书籍及对应缓存

## 阅读器行为

- 阅读区尺寸固定，正文区域内部不滚动；阅读下一屏内容通过翻页完成。
- 分页以当前阅读区域宽高、字体、EPUB 样式覆盖和图片尺寸为准，形成整章连续视觉页。
- 点击句子、加载语音、暂停、继续播放不应改变分页结果。
- 播放结束进入下一段音频时，不应立即强制跳到下一段起始页；页面应由当前高亮句子是否在当前可视页内决定是否翻页。
- 如果高亮句子已在当前页可见，“回到当前页”按钮应处于禁用态；点击该按钮时应回到高亮句子所在视觉页，而不是段落起始页。
- EPUB 图片、封面、扉页和圆角引文框等结构化内容应保持完整，不能被拆散或撑开阅读区域。

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

- `app.sqlite` 保存书库、章节、段落、阅读进度和音频缓存索引；视觉分页按当前浏览器布局在运行时计算，不持久化为固定页码
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

### 自动播放到下一句时回到上一页

曾出现过以下问题：用户点击当前页中的某句话开始播放，音频自然进入下一句时，阅读区偶发回到上一视觉页。该问题在书库展开/收起或窗口尺寸变化后更容易出现。

原因不是书籍导入数据错误，而是分页重算与播放进度回调之间的竞态：阅读区尺寸变化会异步重算整本书分页；旧实现可能在重算完成时重置当前高亮句，并让自动播放使用过期的分页映射选择前一视觉页。只等待分页完成或直接调用内部播放函数的自动化测试会绕过这个时序，因此必须使用真实句子点击并等待音频自然切句进行回归。

当前实现遵循以下保护规则：

- 目标句实际仍在当前阅读区可见时，不执行自动翻页。
- 分页重算后保留当前播放句和当前视觉页锚点。
- 同一段内自然播放到后续句子时，视觉页只能保持不变或向后续页移动，不能回到上一页。
- 用户在分页重算期间产生的新点击优先于旧的分页恢复回调。

此问题不需要重新导入书籍。升级代码后如浏览器仍表现为旧逻辑，先使用 `Ctrl+Shift+R` 强制刷新前端资源。正确的回归方式是：调整到原问题窗口尺寸，展开或收起书库；等待布局动画结束但不等待分页重算完成；真实点击目标句的上一句，以 1 倍速从句首自然播放到目标句。高亮句应正常前进且不重置到本段第一句，视觉页、实际列和横向滚动位置均不得向前回退。

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
docs/
  reader-requirements.md  阅读器分页、布局、播放跟随等长期产品约束
scripts/
  start_listen_book.ps1
  create_desktop_shortcut.ps1
tests/
```

## 注意

本项目不包含遥测、统计或额外业务网络请求。`edge-tts` 生成语音时会访问 Microsoft Edge TTS 服务。
