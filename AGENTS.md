# 给 AI 助手的安装指令

用户如果只说「帮我安装 https://github.com/wescien/dsh-lucien-pet」或「要一样的大肥鱼」，按本文件执行，不要改插件源码。

## 一条命令

```bash
git clone --depth 1 https://github.com/wescien/dsh-lucien-pet.git
cd dsh-lucien-pet
node install/apply.mjs --download-assets --json
```

- 没有 `git`：`curl -L https://codeload.github.com/wescien/dsh-lucien-pet/tar.gz/refs/heads/main -o repo.tgz && tar -xzf repo.tgz --strip-components=1 && rm repo.tgz`
- 没有 `node`（Windows 常见）：用 dsh 自带的
  `"$HOME/.dsh/dsh-runtimes/"*/dependencies/node/bin/node.exe install/apply.mjs --download-assets --json`
- 装完让用户**完全退出 dsh 再打开**，只刷新网页不够。

## 必须做到

| 项 | 要求 |
|---|---|
| `--download-assets` | 必须加，否则只装骨架、没有 322 张表情 |
| 输出 | `--json` 结果里 `ok` 必须为 `true` |
| 素材数量 | `packs/**/*.gif` 应为 **322**（约 407 MB） |
| 配置 | `cordis.patch.yml` 里要有 `pet-chatter` 与 `nekowhale-stickers` 两段，`pet-chatter` 有 38 个键 |
| 重启 | 提醒用户重启 dsh |

## 不要做

- 不要改 `pet-chatter/` 与 `dsh-nekowhale-stickers/` 里的任何文件（用户要求原样）。
- 不要把 `node_modules` 提交进仓库。
- 不要为了「保险」手动改 profile 的 `package.json`，安装器已处理且自带备份。

## 出问题

详见 [`install/agent-install.md`](install/agent-install.md) 的排错表；撤销用安装器打印的 `.bak-<时间戳>` 备份覆盖回去，再在 profile 目录跑一次 `pnpm install`。
