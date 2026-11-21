# 大肥鱼宠物套件 · pet-chatter + nekowhale-stickers

两个 DeepSeek Harness（dsh）插件的完整源码仓库：

| 目录 | 插件 | 版本 | 说明 |
|---|---|---|---|
| [`pet-chatter/`](pet-chatter/) | **大肥鱼吐槽气泡** | 0.8.4 | 大肥鱼会瞄一眼你刚聊完的那一轮，在桌宠右上角冒个气泡，说一句带细节的短评 / 鬼点子 / 温柔吐槽，并用你选的音色念出来 |
| [`dsh-nekowhale-stickers/`](dsh-nekowhale-stickers/) | **大肥鱼表情包** | 1.1.1 | 表情包知识、搜索与本地 meme 模板（大肥鱼想 / 举牌 / 葱卷 / 上联 / 下联 / 大肥鱼抱） |

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

## 安装

两个插件都通过 dsh 的 bundle 补丁机制挂载。把目录放进插件目录后启用即可：

```powershell
# 吐槽气泡
dsh plugin add .\pet-chatter
# 表情包
dsh plugin add .\dsh-nekowhale-stickers
```

`node_modules/` 未纳入版本库，拉下来后按各自的 `package.json` 装依赖（`pnpm install`）。

## 许可与来源

- `pet-chatter/`：本地自用插件（`private: true`）。
- `dsh-nekowhale-stickers/`：原作者 **Loping151**，上游 <https://github.com/Loping151/dsh-nekowhale-stickers>，
  许可为 **Apache-2.0 AND CC-BY-NC-4.0**（代码 Apache-2.0，素材 CC-BY-NC-4.0 非商用）。
  本仓库只是完整备份，版权与许可声明见其内部的 `LICENSE`、`NOTICE`、`LICENSE-ASSETS`。
