# Frame AI Video

Frame 是一个本地 AI 短视频生成工作流：用户输入一句提示词，系统用 Codex 拆分分镜提示词，通过 ComfyUI 生成关键帧，再用 FFmpeg 合成视频。

项目默认适合本地单机运行。数据、上传图、关键帧、视频和缓存都保存在 `./data` 目录。

## 功能概览

- 创作台：输入提示词、比例、时长、风格、运动方式，生成分镜计划。
- 工作台：查看任务状态、分镜提示词、关键帧、生成日志，支持单帧重生成。
- 多参考图：可上传多张参考图作为主体和风格参考。
- ComfyUI 生图：通过 ComfyUI HTTP API 生成真实关键帧。
- FFmpeg 合成：把关键帧合成为 mp4 视频。
- 本地缓存：关键帧和视频按参数缓存，避免重复生成。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| Web | Next.js 15, React 18 |
| 数据库 | SQLite, better-sqlite3 |
| 图像生成 | ComfyUI |
| 分镜规划 | Codex CLI，可缺省走 fallback |
| 视频合成 | FFmpeg, ffmpeg-static |
| 存储 | 本地 `data/` 目录 |

## 环境要求

- Node.js 20+，推荐 Node.js 22。
- npm。
- Git，用于安装 ComfyUI。
- Python 3.12，用于 ComfyUI。脚本会优先使用 `uv` 创建 Python 环境；没有 `uv` 时会退回系统 Python。
- 可选：NVIDIA GPU + CUDA。没有 GPU 时 ComfyUI 会自动以 `--cpu` 启动，但生成会很慢。
- 可选：Codex CLI。没有配置时仍可使用内置 fallback 分镜。

## 快速初始化

Windows PowerShell：

```powershell
npm install
Copy-Item .env.example .env.local
npm run init-db
```

macOS / Linux：

```bash
npm install
cp .env.example .env.local
npm run init-db
```

## 配置 ComfyUI

项目可以直接把 ComfyUI 安装到 `vendor/ComfyUI`：

```bash
npm run comfyui:install
```

安装完成后，需要放置 checkpoint 模型到：

```text
vendor/ComfyUI/models/checkpoints/
```

也可以用脚本下载模型：

```bash
npm run comfyui:model -- "模型下载地址" "模型文件名.safetensors"
```

例如下载完成后，在 `.env.local` 里指定：

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_DIR=./vendor/ComfyUI
COMFYUI_HOST=127.0.0.1
COMFYUI_PORT=8188
COMFYUI_CKPT=DreamShaper_8_pruned.safetensors
```

如果你已有外部 ComfyUI，只需要把 `COMFYUI_URL` 指向它，并确保模型在 ComfyUI 的 checkpoint 列表中可见：

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_CKPT=你的模型.safetensors
```

启动 ComfyUI：

```bash
npm run comfyui:start
```

启动时脚本会检测 CUDA。没有 CUDA 时会自动追加 `--cpu`，能跑但会慢。CPU-only 机器建议使用 SD 1.5 级别的轻量模型，不建议跑 7GB 以上 SDXL 大模型。

## 关键环境变量

复制 `.env.example` 到 `.env.local` 后，按需调整：

```env
DATA_DIR=./data

COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_DIR=./vendor/ComfyUI
COMFYUI_HOST=127.0.0.1
COMFYUI_PORT=8188
COMFYUI_CKPT=DreamShaper_8_pruned.safetensors
COMFYUI_WORKFLOW=

COMFYUI_STEPS=10
COMFYUI_CFG=7
COMFYUI_SAMPLER=euler
COMFYUI_HISTORY_TIMEOUT_MS=1800000
COMFYUI_FRAME_CONCURRENCY=1
COMFYUI_FRAME_RETRIES=2
COMFYUI_RETRY_DELAY_MS=10000
COMFYUI_CONSISTENCY_MODE=previous
COMFYUI_IMG2IMG_DENOISE=0.62

CODEX_BIN=codex
CODEX_MODEL=

FFMPEG_BIN=
RIFE_ENABLED=false
NEXT_PUBLIC_APP_NAME=Frame
```

说明：

- `COMFYUI_CKPT`：指定使用哪个 checkpoint。必须和 ComfyUI checkpoint 列表里的文件名一致。
- `COMFYUI_FRAME_CONCURRENCY`：CPU 机器建议 `1`；GPU 显存足够时可以逐步调高。
- `COMFYUI_CONSISTENCY_MODE`：`previous` 表示后一帧以上一帧作为参考，更连续但首帧错了会带偏后续帧；`anchor` 表示始终参考首帧。
- `COMFYUI_IMG2IMG_DENOISE`：越低越像参考图，越高越自由。常用范围 `0.45` 到 `0.75`。
- `COMFYUI_WORKFLOW`：可指定自定义 ComfyUI workflow JSON。留空使用内置简化工作流。
- `FFMPEG_BIN`：留空时使用 `ffmpeg-static` 或 PATH 中的 `ffmpeg`。

## 自定义 ComfyUI 工作流

如果配置 `COMFYUI_WORKFLOW=./workflows/xxx.json`，工作流中需要包含这些节点类型，项目会自动注入参数：

- `CheckpointLoaderSimple`：使用 `COMFYUI_CKPT` 指定模型。
- `CLIPTextEncode`：注入正向和负向提示词。负向节点建议在 `_meta.title` 里包含 `negative`。
- `KSampler` 或 `KSamplerAdvanced`：注入 seed。
- `EmptyLatentImage`：注入 width / height。
- `SaveImage`：保存输出图。

如果工作流不符合这些约定，任务可能可以提交，但 ComfyUI 不会按预期生成。

## 开发启动

方式一：分别启动。

```bash
npm run comfyui:start
npm run dev
```

打开：

```text
http://localhost:3000
```

方式二：同时启动 ComfyUI 和 Next.js。

```bash
npm run dev:comfyui
```

健康检查：

```text
http://localhost:3000/api/health
```

健康接口会返回 FFmpeg、ComfyUI、Codex、RIFE 和统计信息。重点确认：

- `comfyui.reachable` 为 `true`
- `comfyui.modelReady` 为 `true`
- `comfyui.checkpoints` 包含你配置的 `COMFYUI_CKPT`

## 常用命令

```bash
npm run dev              # 开发模式启动 Next.js
npm run build            # 构建生产包
npm run start            # 生产模式启动 Next.js
npm run typecheck        # TypeScript 类型检查
npm run init-db          # 初始化数据库并检查环境
npm run comfyui:install  # 安装 ComfyUI 到 vendor/ComfyUI
npm run comfyui:model    # 下载 checkpoint
npm run comfyui:start    # 启动 ComfyUI
npm run dev:comfyui      # 同时启动 ComfyUI 和 Next.js
```

## 生产部署

### 1. 准备服务器

建议：

- Node.js 20+。
- Python 3.12。
- 足够磁盘空间。模型、关键帧、缓存和视频都会占用空间。
- 如果需要较快生成，建议 NVIDIA GPU 环境。

### 2. 拉取代码并安装依赖

```bash
git clone <your-repo-url> ai-video
cd ai-video
npm ci
cp .env.example .env.local
npm run init-db
```

### 3. 安装并配置 ComfyUI

```bash
npm run comfyui:install
npm run comfyui:model -- "模型下载地址" "模型文件名.safetensors"
```

编辑 `.env.local`：

```env
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_CKPT=模型文件名.safetensors
```

先启动 ComfyUI：

```bash
npm run comfyui:start
```

### 4. 构建并启动 Web 服务

```bash
npm run build
npm run start
```

默认监听：

```text
http://localhost:3000
```

### 5. 常驻运行

生产环境建议用进程管理器分别守护两个进程：

```bash
npm run comfyui:start
npm run start
```

例如使用 PM2：

```bash
pm2 start "npm run comfyui:start" --name frame-comfyui
pm2 start "npm run start" --name frame-web
pm2 save
```

Windows 可以用 NSSM、任务计划程序，或直接在受控终端里长期运行两个命令。

### 6. 反向代理

如果放到 Nginx / Caddy 后面，至少代理 Web 服务的 `3000` 端口。ComfyUI 建议只监听内网或本机地址，不直接暴露到公网。

如果使用 SSE 进度流，需要关闭代理缓冲或确保流式响应不被缓存。相关接口：

```text
/api/video-tasks/:taskId/stream
```

## 数据目录

默认数据目录是 `./data`：

```text
data/
  frame.db                 SQLite 数据库
  uploads/                 用户上传参考图
  storage/<taskId>/        关键帧、缩略图、视频、封面
  cache/                   关键帧和视频缓存
  *.log                    本地启动日志
```

生产环境需要备份 `data/`。如果删除 `data/cache/`，不会影响任务数据库，但会失去缓存复用能力。

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/video-plans` | 生成分镜计划 |
| `POST` | `/api/video-tasks` | 创建生成任务 |
| `GET` | `/api/video-tasks` | 任务列表 |
| `GET` | `/api/video-tasks/:id` | 任务详情 |
| `PATCH` | `/api/video-tasks/:id` | 重试任务 |
| `DELETE` | `/api/video-tasks/:id` | 取消任务 |
| `POST` | `/api/video-tasks/:id/compose` | 重新合成视频 |
| `GET` | `/api/video-tasks/:id/stream` | SSE 任务进度 |
| `POST` | `/api/video-tasks/:id/keyframes/:frameId/regenerate` | 重生成单帧 |
| `POST` | `/api/uploads` | 上传参考图 |
| `GET` | `/api/files/...` | 访问图片和视频文件 |
| `GET` | `/api/health` | 健康检查 |

## 排查问题

### ComfyUI 未配置或不可访问

检查：

```bash
npm run comfyui:start
```

然后访问：

```text
http://127.0.0.1:8188
http://localhost:3000/api/health
```

确认 `.env.local` 里有：

```env
COMFYUI_URL=http://127.0.0.1:8188
```

### checkpoint 找不到

确认模型文件存在：

```text
vendor/ComfyUI/models/checkpoints/你的模型.safetensors
```

并且 `.env.local` 中的 `COMFYUI_CKPT` 与文件名完全一致。

### CPU 生成很慢

这是正常现象。CPU-only 机器建议：

```env
COMFYUI_FRAME_CONCURRENCY=1
COMFYUI_STEPS=8
```

同时使用 SD 1.5 级别模型和 512 / 768 分辨率。SDXL 大模型在 CPU 上会非常慢。

### 生成内容和中文提示词不匹配

SD 1.5 / DreamShaper 对中文理解有限。项目已在送入 ComfyUI 前补英文视觉锚点，但复杂提示词仍建议：

- 主体用明确名词。
- 避免一句话塞太多抽象要求。
- 如果主体非常具体，上传参考图。
- 第一帧不对时不要继续合成，应该重生成首帧或重新创建任务。

### 视频过渡抖动或黑场

当前合成器使用稳定静态段 + `xfade` 交叉溶解。修改合成逻辑后，需要重新合成任务：

```text
POST /api/video-tasks/:id/compose
```

或在工作台点击“重新合成”。如果浏览器仍播放旧视频，强制刷新页面或清除浏览器缓存。

## License

MIT
