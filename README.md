# 大肥鱼宠物套件 · pet-chatter + nekowhale-stickers

两个 DeepSeek Harness（dsh）插件的完整源码仓库：

| 目录 | 插件 | 版本 | 说明 |
|---|---|---|---|
| [`pet-chatter/`](pet-chatter/) | **大肥鱼吐槽气泡** | 0.8.4 | 大肥鱼会瞄一眼你刚聊完的那一轮，在桌宠右上角冒个气泡，说一句带细节的短评 / 鬼点子 / 温柔吐槽，并用你选的音色念出来 |
| [`dsh-nekowhale-stickers/`](dsh-nekowhale-stickers/) | **大肥鱼表情包** | 1.1.1 | 表情包知识、搜索与本地 meme 模板（大肥鱼想 / 举牌 / 葱卷 / 上联 / 下联 / 大肥鱼抱） |

## 🤖 一句话安装（把仓库地址丢给 AI 助手）

> 「帮我安装 https://github.com/wescien/dsh-lucien-pet ，要和我一样的大肥鱼体验」

AI 助手照 [`install/agent-install.md`](install/agent-install.md) 做完就行，核心只有一条命令：

```bash
git clone --depth 1 https://github.com/wescien/dsh-lucien-pet.git
cd dsh-lucien-pet
node install/apply.mjs --download-assets --json
```

装完**完全退出 dsh 再打开**，右下角就是那只 233px 的大肥鱼，38 项气泡参数、音色、桌宠特效与作者那台一致。

| 参数 | 作用 |
|---|---|
| `--download-assets` | 顺带下载 407 MB 表情素材包（322 张 GIF），之后断网也能用 |
| `--json` | 输出机器可读结果（`ok` 字段判断成败） |
| `--dry-run` | 只打印将要做的改动 |
| `--profile` / `--dsh-home` | profile 或 `.dsh` 不在默认位置时指定 |
| `--skip-install` | 不跑 `pnpm install` |

安装器幂等、先备份后修改；只追加配置，不删你原有的条目。

## 目录结构

```
.
├── pet-chatter/                 # 大肥鱼吐槽气泡（@local/pet-chatter）
│   ├── index.js                 # Host 半：会话事件 → 气泡闸门 → 队列 → HTTP 路由
│   ├── client.js                # 浏览器半：气泡渲染、特效、聊天面板
│   ├── tts.js                   # 语音适配（Edge 神经语音 / 系统语音兜底）
│   ├── lib/{pure,reactions}.js  # 纯函数与本地语音反应池
│   ├── assets/                  # 提示音、预览图和 200+ 条随包反应 MP3
│   ├── tools/                   # 验收 / 冒烟 / 压力 / 语音自测脚本
│   └── cordis.patch.yml         # bundle 补丁
└── dsh-nekowhale-stickers/      # 大肥鱼表情包（npm: dsh-nekowhale-stickers）
    ├── lib/                     # core（抓取/搜索/同步）、meme（模板/文字/GIF/水印）
    ├── meta/, locale/, skills/  # 表情清单、文案、技能说明
    └── client/ui/               # 面板与字体资源
```

## 安装（复刻作者那台的一模一样体验）

两个插件都通过 dsh 的 bundle 补丁机制挂载。**光装插件只得到默认设置**，作者调过的那 38 个气泡参数、音色、桌宠高度都在 `install/profile.patch.yml` 里 —— 下面这条路会连配置一起装上。

### 一键（Windows）

```powershell
git clone https://github.com/wescien/dsh-lucien-pet.git
cd dsh-lucien-pet
powershell -ExecutionPolicy Bypass -File .\install\apply.ps1
```

脚本会先备份、再改三处、最后装依赖，重复执行安全：

1. `~/.dsh/profiles/desktop/package.json`：登记两个本地插件依赖
2. 同文件的 `dsh.profile.bundles`：追加两个插件
3. `~/.dsh/profiles/desktop/cordis.patch.yml`：追加作者的完整配置
4. 在 profile 目录跑 `pnpm install`

装完**完全退出 dsh 再打开**（只刷新网页不够）。

### 手动

```powershell
# 1. 依赖
cd pet-chatter; pnpm install; cd ..
cd dsh-nekowhale-stickers; pnpm install; cd ..

# 2. 两个目录都挂进 profile（任一方式）
dsh plugin add .\pet-chatter
dsh plugin add .\dsh-nekowhale-stickers
# 或者手动编辑 profile 的 package.json：dependencies 写 link: 路径，
# dsh.profile.bundles 里追加包名

# 3. 把 install/profile.patch.yml 的内容追加到
#    ~/.dsh/profiles/desktop/cordis.patch.yml 末尾

# 4. 在 profile 目录执行 pnpm install，然后重启 dsh
```

### 装完哪些东西是一样的

| 项目 | 是否一致 | 说明 |
|---|---|---|
| 插件版本 | ✅ | pet-chatter 0.8.4 + stickers 1.1.1，锁定在仓库里 |
| 气泡行为 | ✅ | 38 项参数全量拷贝：频率 often、每次间隔 1 分钟、每小时上限 8 |
| 人设与称呼 | ✅ | 称呼「老大」、性格 balance、口头风格「爱用颜文字，爱讲笑话」 |
| 音色 | ✅ | `zh-CN-XiaoyiNeural`，语速 +8%，音调 +15Hz，音量 0.9 |
| 桌宠与特效 | ✅ | 桌宠高度 233px、打字机特效、原生气泡、点击/拖拽反应概率 |
| 表情包全集 | ✅ 可选离线 | 加 `--download-assets` 会拉 [离线素材包](https://github.com/wescien/dsh-lucien-pet/releases/tag/assets-v1009)（322 张 GIF / 407 MB）；不加则使用时从 `kiriyuki.com` 按需同步 |
| 语音发声 | ⚠️ 需联网 | Edge 神经语音是微软在线服务，断网会自动降级成系统语音 |
| 气泡内容 | ❌ 不会一样 | 气泡是对你当轮对话的实时短评，内容取决于你聊了什么 |
| dsh 版本 | ❌ 需自备 | 本配置在 dsh 0.2.x 上验证；版本差异可能导致配置项被忽略 |

`node_modules/` 未纳入版本库，`pnpm-lock.yaml` 已锁定到具体版本（`pnpm install --frozen-lockfile` 可完全复现）。

## 表情素材离线包

Release：[assets-v1009](https://github.com/wescien/dsh-lucien-pet/releases/tag/assets-v1009)（407 MB）

内容：`packs/` 322 张 GIF（「大肥鱼」286 张 +「大肥鱼和GPT娘」36 张）、`manifest.json`、`manifest.etag`，对应 kiriyuki.com 表情清单 version 1009（2026-10-23）。

手动用法：解压到 `~/.dsh/nekowhale-stickers/`（Windows：`%USERPROFILE%\.dsh\nekowhale-stickers\`），插件会直接读本地文件，不再联网。

素材许可 **CC-BY-NC-4.0**：不可商用、必须署名。作者 B 站「可以叫我云大人」（<https://space.bilibili.com/103739>），来源 <https://kiriyuki.com>。

## 许可与来源

- `pet-chatter/`：本地自用插件（`private: true`）。
- `dsh-nekowhale-stickers/`：原作者 **Loping151**，上游 <https://github.com/Loping151/dsh-nekowhale-stickers>，
  许可为 **Apache-2.0 AND CC-BY-NC-4.0**（代码 Apache-2.0，素材 CC-BY-NC-4.0 非商用）。
  本仓库只是完整备份，版权与许可声明见其内部的 `LICENSE`、`NOTICE`、`LICENSE-ASSETS`。
