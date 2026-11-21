# 给 AI 助手的安装指令

用户说「帮我安装 https://github.com/wescien/dsh-lucien-pet」时，照这份做完即可。
全部步骤幂等，重复执行不会写重复配置；每改一个文件前安装器都会先备份。

## 0. 判断能不能装

| 检查 | 命令 | 通过条件 |
|---|---|---|
| dsh 桌面版 | `test -d "$HOME/.dsh/profiles"`（Windows：`Test-Path "$env:USERPROFILE\.dsh\profiles"`） | 目录存在 |
| node | `node --version` 或 `~/.dsh/dsh-runtimes/*/dependencies/node/bin/node --version` | ≥ 20 |
| 平台 | — | Windows / macOS / Linux 都行 |

`~/.dsh` 若不是默认位置，用 `--dsh-home` 指过去。

## 1. 克隆

```bash
git clone --depth 1 https://github.com/wescien/dsh-lucien-pet.git
cd dsh-lucien-pet
```

没有 git 的机器，用 tar 包代替（Windows 自带 `tar`，macOS/Linux 也有）：

```powershell
curl -L -o dsh-lucien-pet.tar.gz https://codeload.github.com/wescien/dsh-lucien-pet/tar.gz/refs/heads/main
mkdir dsh-lucien-pet && tar -xzf dsh-lucien-pet.tar.gz -C dsh-lucien-pet --strip-components=1
```

## 2. 安装（一条命令）

```bash
node install/apply.mjs --download-assets --json
```

- `--download-assets`：顺带下载 407 MB 表情素材包（322 张 GIF），装完离线也能用
- `--json`：输出机器可读结果，用 `ok` 字段判断成败
- Windows 上 `node` 不在 PATH 时，用 `~/.dsh/dsh-runtimes/<runtime>/dependencies/node/bin/node.exe` 调同一个脚本
- 想先看会改什么：加 `--dry-run`
- 只想装插件不装素材：去掉 `--download-assets`

脚本做的事：
1. 往 `$DSH_HOME/profiles/<profile>/package.json` 登记两个插件（`link:` 指向克隆下来的目录）并追加进 `dsh.profile.bundles`
2. 往同目录 `cordis.patch.yml` 追加作者调好的配置（pet-chatter 38 项 + stickers 桌宠 233px），**已有的 id 跳过**
3. 在 profile 目录跑 `pnpm install`（自动找 dsh 自带的 pnpm）
4. 有 `--download-assets` 时把素材解压到 `$DSH_HOME/nekowhale-stickers/`

## 3. 验证（跑脚本，别靠眼看）

```bash
node install/verify.mjs
```

它会按 AGENTS.md 第 2 节逐条核对（版本 / 38 个配置键 / 音色 / 233px / 已登记 / 322 张），
输出 6 行 ✅/❌ 和一行总结，全过 exit 0，有失败 exit 1 并给出该查哪个文件。

要转述给用户，加 `--json` 拿结构化结果；**把这段输出原样贴出来**，比「装好了」可信。

剩下第 7 条（重启后右下角有桌宠、聊完一轮冒气泡出声）脚本查不到，告诉用户：**完全退出 dsh 再打开**（只刷新网页不够），然后自己看。

**第 6 条（表情素材）失败不算安装失败**：素材包在 GitHub Releases 上，国内网络常下不动，安装器此时会打警告但 `ok` 仍是 `true`。插件照样能用 —— 表情会在用到时从 `kiriyuki.com` 按需拉取（国内可访问）。告诉用户「先这样用，网络好时再补」，补法：`node install/apply.mjs --download-assets`。

注意：`github.com`、`raw.githubusercontent.com` 在国内的可达性时好时坏，但**不需要 VPN**；`npm` 源慢可换镜像。安装只需要：能 clone 到 GitHub、能拉到 npm 依赖。

## 4. 装完长什么样

- 右下角一只 233px 高的大肥鱼，会跟着聊天气泡冒吐槽、打字机特效、用 `zh-CN-XiaoyiNeural` 念出来，称呼用户「老大」
- 插件面板里能搜 322 张表情、生成「大肥鱼想 / 举牌 / 葱卷 / 上联 / 下联 / 大肥鱼抱」模板

## 5. 出问题怎么办

| 现象 | 处理 |
|---|---|
| `找不到 DSH_HOME` | 加 `--dsh-home <你的 .dsh 路径>` |
| `profiles 下有多个目录` | 加 `--profile <profile 名>` |
| `没找到 pnpm` | 进 profile 目录手动 `pnpm install`，再重跑安装器 |
| 重启后没桌宠 | 确认 profile 的 `dsh.profile.bundles` 里有这两个包名；看 dsh 日志里有没有 `nekowhale-stickers` |
| 表情图片不显示 | 检查 `$DSH_HOME/nekowhale-stickers/packs` 是否有 322 张；没有就补 `--download-assets` |
| 气泡不出现 | 配置里 `enabled` 应为 `true`；气泡对「刚结束的一轮对话」触发，先聊两句 |

## 6. 不要做的事

- **不要改** `pet-chatter/`、`dsh-nekowhale-stickers/` 里的源码 —— 用户要的是原样体验
- 不要删除 profile 里原有的其他 `- id:` 条目，安装器只追加、不删除
- 不要把 `node_modules/` 提交回仓库

## 7. 撤销

profile 目录里有形如 `package.json.bak-20261121-213000`、`cordis.patch.yml.bak-20261121-213000` 的备份：
覆盖回去 → 再跑一次 `pnpm install` → 重启 dsh。
