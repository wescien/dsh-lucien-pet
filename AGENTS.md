# 给 AI 助手的安装指令

用户如果说「帮我安装 https://github.com/wescien/dsh-lucien-pet，要一样的大肥鱼」，按本文件执行。**「一样」不是一个形容词，下面第 2 节是可逐条核对的验收标准**，装完请对照它自检，并把结果报给用户。

需要用户机器上**已安装 DeepSeek Harness（dsh）**。没有 dsh 就先告诉用户去装 dsh，本仓库装不了。

## 1. 一条命令

```bash
git clone --depth 1 https://github.com/wescien/dsh-lucien-pet.git
cd dsh-lucien-pet
node install/apply.mjs --download-assets --json
```

- 没有 `git`：`curl -L https://codeload.github.com/wescien/dsh-lucien-pet/tar.gz/refs/heads/main -o repo.tgz && tar -xzf repo.tgz --strip-components=1 && rm repo.tgz`
- 没有 `node`：用 dsh 自带的那份（Windows PowerShell / bash 都能用通配符展开）
  `"$HOME/.dsh/dsh-runtimes/"*/dependencies/node/bin/node.exe install/apply.mjs --download-assets --json`
- 装完让用户**完全退出 dsh 再打开**，只刷新网页不够。

## 2. 「一样的大肥鱼」= 这 7 条，逐条可查

装完跑 `node install/verify.mjs` 自动核对前 6 条（全过 exit 0，`--json` 给结构化结果）。

| # | 标准 | 怎么查 |
|---|---|---|
| 1 | 两个插件版本是 `pet-chatter 0.8.4` + `dsh-nekowhale-stickers 1.1.1` | 两个子目录 `package.json` 的 `version` |
| 2 | 气泡配置 **38 个键**，不是默认值 | `cordis.patch.yml` 里 `id: pet-chatter` 那段 `config` 下的键数 = 38 |
| 3 | 声音是 `zh-CN-XiaoyiNeural`，语速 +8%、音调 +15Hz、音量 0.9 | 同上，看 `voice` / `rate` / `pitch` / `volume` |
| 4 | 桌宠高度 **233px**，打字机式冒泡 | `id: nekowhale-stickers` 那段有 `petHeight: 233` |
| 5 | profile 里两个插件都登记了（依赖 2 项 + bundles 2 项） | profile 的 `package.json` |
| 6 | 表情 **322 张**离线可用（约 407 MB） | `packs/**/*.gif` 计数 = 322（`verify.mjs` 会数） |
| 7 | 重启后右下角有桌宠，聊完一轮冒气泡并出声 | **只能人看**，脚本查不到 |

不要求一致的：气泡**内容**（取决于用户自己聊什么）、dsh 版本（版本差太多可能忽略某些配置项）。

## 3. 不要做

- 不要改 `pet-chatter/` 与 `dsh-nekowhale-stickers/` 里的任何文件（下游要求原样）。
- 不要把 `node_modules` 提交进仓库。
- 不要手动改 profile 的 `package.json`，安装器已处理且自带 `.bak-<时间戳>` 备份。

## 4. 出问题

详见 [`install/agent-install.md`](install/agent-install.md) 的排错表（node 找不到、pnpm 找不到、解压失败、端口被占）。撤销：用安装器打印的备份覆盖回去，再在 profile 目录跑一次 `pnpm install`。
