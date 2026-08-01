# 本地听书

本项目是一个运行在个人电脑上的本地听书 Web App。它可以导入本地 `.txt`、`.md`、`.epub` 书籍，使用 `edge-tts` 生成中文朗读音频，并在本机保存书库、播放进度和音频缓存。

## 功能

- 本地导入 `.txt`、`.md`、`.epub`
- EPUB 按目录和阅读顺序解析章节
- 按当前阅读区域实际尺寸计算连续视觉页，显示整本书累计页码
- 使用 `edge-tts` 生成 mp3，并缓存已生成音频
- 播放、暂停、上一页、下一页、上一章、下一章
- 保存并恢复最近阅读位置
- 独立保存最后阅读内容锚点与最后播放位置，重新打开时先恢复阅读页
- 支持声音选择和倍速选择
- 当前句高亮，点击句子从对应位置播放
- 播放时根据当前高亮句子的可见性同步阅读页，避免音频段切换时误翻页
- 支持“回到当前页”，定位到当前高亮句子所在视觉页
- 播放到当前段音频约 70% 时静默预缓存下一段音频
- 支持书名搜索、目录弹出、删除书籍及对应缓存
- 书库默认为关闭的悬浮抽屉，打开和关闭不改变正文尺寸或分页

## 阅读器行为

- 阅读区尺寸固定，正文区域内部不滚动；阅读下一屏内容通过翻页完成。
- 分页以当前阅读区域宽高、字体、EPUB 样式覆盖和图片尺寸为准，形成整章连续视觉页。
- 点击句子、加载语音、暂停、继续播放不应改变分页结果。
- 播放结束进入下一段音频时，不应立即强制跳到下一段起始页；页面应由当前高亮句子是否在当前可视页内决定是否翻页。
- “回到当前页”以最后播放句所在视觉页为目标；仅当当前浏览页已包含该句时禁用，同段落内翻到其他视觉页也应启用。
- 点击“回到当前页”重新渲染播放章节时，当前播放句的定时映射和高亮状态必须保持。
- 暂停后仍保留最后播放页。尚未播放过的书以最后阅读内容锚点作为恢复位置。
- 书库默认关闭，通过书名左侧的书本图标打开并悬浮在正文上方；打开、关闭、遮罩点击和 `Esc` 关闭均不改变阅读区尺寸，也不触发分页重算或影响播放。
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

## Mobile PWA（M0）

Mobile PWA 是独立的离线文字阅读模块，不包含朗读、音频下载或播放设置同步。Windows 仍是主书库。

当前 M0 已支持：

- iPhone 主屏 PWA 内短码配对和单设备凭证
- 本机配对管理页查看和撤销已登记 iPhone
- Tailnet 内浏览电脑书库并下载 EPUB 正文与图片
- 飞行模式启动、阅读、翻页和本地进度恢复
- 左滑或点击正文右半屏进入下一页，右滑或点击正文左半屏返回上一页
- 长按选择文字；长按、拖动、链接和图片不会误触翻页
- 适配手机宽度的 EPUB 流式排版，不复用桌面固定宽度或视觉页码
- 默认只显示“主书名＋版本”的单开手风琴书库；展开后显示作者、格式、离线状态和操作按钮
- 手机标题显示“主书名＋版本”，作者从 EPUB 元数据读取；原始完整标题仍保留在电脑数据库
- 按 iPhone 端实际翻页时间倒序排列，未读书随后按书名排序
- 手机阅读器 `Aa` 菜单内执行单本`电脑进度 → 手机`或`手机进度 → 电脑`

跨设备只覆盖文字阅读位置，不修改电脑端音频播放位置、声音、倍速或音量。电脑端主动推送、全量同步、覆盖预览和撤销仍属于后续完整 MVP。

服务启动后，本机配对管理页位于：

```text
http://127.0.0.1:8765/mobile-admin/
```

首次配置 Tailnet 私有 HTTPS：

```powershell
cd D:\CodexProject\listen-book
powershell.exe -ExecutionPolicy Bypass -File .\scripts\configure_mobile_access.ps1
```

脚本只允许 `/mobile/` 和 `/api/mobile/`，不会启用 Funnel 或暴露整个 `8765` 端口；如果检测到既有 Serve 规则、移动服务未启动或桌面路由可从 Tailnet 访问，会停止或回滚本产品映射。撤销本产品映射：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\configure_mobile_access.ps1 -Remove
```

在 iPhone Safari 打开脚本输出的 `/mobile/` 私有 HTTPS 地址，添加到主屏幕，再从主屏幕打开。短码只能在主屏 PWA 中提交。

基本使用流程：

1. 在电脑打开 `http://127.0.0.1:8765/mobile-admin/`，生成一次性短码并确认 iPhone。
2. iPhone 从主屏幕打开 PWA，刷新电脑书库。
3. 点击书名展开详情，点击`下载`；完成后留在列表，按钮变为`继续阅读`。
4. 阅读时使用左右滑动或正文左右半屏短按翻页；右上角 `Aa` 提供字号和单本进度同步。
5. 从电脑拉取进度时，先在电脑阅读并保存位置，再让 iPhone PWA 保持前台，打开同一本书并点击`电脑进度 → 手机`。

已登记设备也在配对管理页中显示。点击`撤销`后，手机仍可阅读既有离线书籍，但必须重新配对才能下载或同步。

PWA 更新后请从多任务界面彻底关闭并重新打开；顶部版本仍未变化时，保持联网等待约 5 秒后再关闭并打开一次。不要清除 Safari 网站数据，否则会删除手机离线书籍和本地进度。

## 本地数据

以下数据只保存在本机，不会提交到 Git：

```text
app/data/app.sqlite
app/data/books/
app/cache/audio/
app/logs/
```

说明：

- `app.sqlite` 保存书库、章节、段落、播放进度、阅读内容锚点和音频缓存索引；视觉分页按当前浏览器布局在运行时计算，不持久化为固定页码。阅读位置保存章节、段落、句子及页内偏移锚点，并在当前布局下重新定位
- `app/data/books/` 保存通过网页上传导入的书籍副本
- `app/cache/audio/` 保存生成过的 mp3
- `app/logs/` 保存本地服务日志
- iPhone 的离线书籍、设备凭证和文字进度保存在 PWA 的 IndexedDB 与 Cache Storage 中，不写入 Git

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

曾出现过以下问题：用户点击当前页中的某句话开始播放，音频自然进入下一句时，阅读区偶发回到上一视觉页。旧版书库展开/收起或窗口尺寸变化会改变阅读区尺寸，因此更容易触发。

原因不是书籍导入数据错误，而是分页重算与播放进度回调之间的竞态：阅读区尺寸变化会异步重算整本书分页；旧实现可能在重算完成时重置当前高亮句，并让自动播放使用过期的分页映射选择前一视觉页。只等待分页完成或直接调用内部播放函数的自动化测试会绕过这个时序，因此必须使用真实句子点击并等待音频自然切句进行回归。

当前实现遵循以下保护规则：

- 目标句实际仍在当前阅读区可见时，不执行自动翻页。
- 分页重算后保留当前播放句和当前视觉页锚点。
- 同一段内自然播放到后续句子时，视觉页只能保持不变或向后续页移动，不能回到上一页。
- 用户在分页重算期间产生的新点击优先于旧的分页恢复回调。

此问题不需要重新导入书籍。升级代码后如浏览器仍表现为旧逻辑，先使用 `Ctrl+Shift+R` 强制刷新前端资源。播放跟随竞态的正确回归方式是：调整窗口尺寸触发分页重算，不等待重算完成；真实点击目标句的上一句，以 1 倍速从句首自然播放到目标句。高亮句应正常前进且不重置到本段第一句，视觉页、实际列和横向滚动位置均不得向前回退。书库抽屉需单独回归：反复打开和关闭时，阅读区宽高、分页键、当前视觉页、播放句和横向滚动位置必须完全不变。

## 开发检查

```powershell
.\.venv\Scripts\python.exe -m compileall app tests
.\.venv\Scripts\python.exe -m unittest discover -s tests
node --check app\frontend\app.js
node tests\mobile_frontend\test_anchor.mjs
node tools\test_mobile_pwa_playwright.mjs
```

## 目录结构

```text
app/
  backend/   FastAPI 后端、SQLite、书籍解析、TTS 缓存
  frontend/  浏览器界面
  mobile/    iPhone PWA、离线阅读器、IndexedDB 和 Service Worker
  mobile_admin/  本机配对管理页
  data/      本地数据库和上传书籍，Git 忽略
  cache/     本地音频缓存，Git 忽略
  logs/      本地服务日志，Git 忽略
docs/
  reader-requirements.md  阅读器分页、布局、播放跟随等长期产品约束
  mobile-pwa-prd.md  Mobile PWA 产品范围、规则与验收标准
  mobile-pwa-technical-design.md  Mobile PWA 架构、协议、迁移与测试方案
scripts/
  start_listen_book.ps1
  create_desktop_shortcut.ps1
  configure_mobile_access.ps1
tests/
```

## 注意

本项目不包含遥测、统计或额外业务网络请求。`edge-tts` 生成语音时会访问 Microsoft Edge TTS 服务。
