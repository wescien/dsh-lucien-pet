# 一键把「大肥鱼吐槽气泡 + 大肥鱼表情包」装进你的 dsh profile
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .\install\apply.ps1
#
# 可选参数：
#   -ProfileDir  你的 dsh profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop
#   -RepoDir     这个仓库的根目录，默认脚本所在目录的上一级
#   -SkipInstall 只改配置、不跑 pnpm install
#
# 这个脚本只做四件事，而且每改一个文件前都会先备份：
#   1. 往 profile/package.json 的 dependencies 里登记两个本地插件（link: 指向本仓库）
#   2. 往 dsh.profile.bundles 里追加这两个插件
#   3. 往 profile/cordis.patch.yml 末尾追加 install/profile.patch.yml 里的配置
#   4. 在 profile 目录跑 pnpm install，把依赖装上
# 已经登记过的条目会跳过，可以重复执行。

param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop"),
    [string]$RepoDir = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ── 定位仓库 ──────────────────────────────────────────────────────────────
if (-not $RepoDir) {
    $RepoDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$RepoDir = (Resolve-Path $RepoDir).Path
$petDir = Join-Path $RepoDir "pet-chatter"
$stickerDir = Join-Path $RepoDir "dsh-nekowhale-stickers"
$patchTpl = Join-Path $RepoDir "install\profile.patch.yml"

foreach ($p in @($petDir, $stickerDir, $patchTpl)) {
    if (-not (Test-Path $p)) { throw "找不到 $p —— 请把 -RepoDir 指向仓库根目录" }
}
if (-not (Test-Path $ProfileDir)) { throw "找不到 profile 目录：$ProfileDir" }

$ProfileDir = (Resolve-Path $ProfileDir).Path
$pkgPath = Join-Path $ProfileDir "package.json"
$patchPath = Join-Path $ProfileDir "cordis.patch.yml"
foreach ($p in @($pkgPath, $patchPath)) {
    if (-not (Test-Path $p)) { throw "profile 里缺少 $p —— 这个目录不像 dsh profile" }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Write-Step "仓库：$RepoDir"
Write-Step "profile：$ProfileDir"

# ── 1+2. package.json ─────────────────────────────────────────────────────
Write-Step "改 package.json（依赖 + bundles）"
Copy-Item $pkgPath "$pkgPath.bak-$stamp" -Force
$raw = [System.IO.File]::ReadAllText($pkgPath)
$pkg = $raw | ConvertFrom-Json

$slash = $RepoDir -replace '\\', '/'
$wantDeps = [ordered]@{
    "@local/pet-chatter"        = "link:$slash/pet-chatter"
    "dsh-nekowhale-stickers"    = "link:$slash/dsh-nekowhale-stickers"
}
if (-not $pkg.dependencies) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
foreach ($k in $wantDeps.Keys) {
    $old = $pkg.dependencies.PSObject.Properties[$k]
    if ($old) {
        if ($old.Value -ne $wantDeps[$k]) {
            Write-Warn2 "依赖 $k 原为 $($old.Value)，改写成本仓库"
            $old.Value = $wantDeps[$k]
        } else { Write-Ok "依赖 $k 已登记" }
    } else {
        $pkg.dependencies | Add-Member -NotePropertyName $k -NotePropertyValue $wantDeps[$k] -Force
        Write-Ok "登记依赖 $k -> $($wantDeps[$k])"
    }
}

if (-not $pkg.dsh) { throw "package.json 里没有 dsh 字段，不像是 dsh profile" }
$bundles = @($pkg.dsh.profile.bundles)
foreach ($b in @("@local/pet-chatter", "dsh-nekowhale-stickers")) {
    if ($bundles -contains $b) { Write-Ok "bundles 已含 $b" }
    else { $bundles += $b; Write-Ok "bundles 追加 $b" }
}
$pkg.dsh.profile.bundles = $bundles

$json = $pkg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($pkgPath, $json, $utf8NoBom)
$null = [System.IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json   # 写坏了会在这里抛错
Write-Ok "package.json 已写回（备份 $([System.IO.Path]::GetFileName("$pkgPath.bak-$stamp"))）"

# ── 3. cordis.patch.yml ───────────────────────────────────────────────────
Write-Step "改 cordis.patch.yml（配置）"
Copy-Item $patchPath "$patchPath.bak-$stamp" -Force
$patch = [System.IO.File]::ReadAllText($patchPath)
$added = @()
if ($patch -match '(?m)^\s*-\s*id:\s*pet-chatter\s*$') {
    Write-Ok "pet-chatter 配置已存在，跳过"
} else { $added += "pet-chatter" }
if ($patch -match '(?m)^\s*-\s*id:\s*nekowhale-stickers\s*$') {
    Write-Ok "nekowhale-stickers 配置已存在，跳过"
} else { $added += "nekowhale-stickers" }

if ($added.Count -gt 0) {
    $tpl = [System.IO.File]::ReadAllText($patchTpl)
    $header = "`n# ── 大肥鱼（由 install/apply.ps1 于 $stamp 追加）──`n"
    [System.IO.File]::WriteAllText($patchPath, $patch + $header + $tpl + "`n", $utf8NoBom)
    Write-Ok "已追加：$($added -join '、')（备份 $([System.IO.Path]::GetFileName("$patchPath.bak-$stamp"))）"
} else {
    Write-Ok "配置无需改动"
}

# ── 4. pnpm install ───────────────────────────────────────────────────────
if ($SkipInstall) {
    Write-Warn2 "已跳过 pnpm install，记得自己进 profile 目录跑一次 pnpm install"
} else {
    Write-Step "装依赖（pnpm install）"
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    $nodeExe = $null; $pnpmJs = $null
    if ($pnpmCmd) {
        $pnpmExe = $pnpmCmd.Source
    } else {
        $hits = @(Get-ChildItem (Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs") -ErrorAction SilentlyContinue)
        if ($hits.Count -gt 0) {
            $pnpmJs = $hits[0].FullName
            $cand = Join-Path (Split-Path (Split-Path (Split-Path $pnpmJs))) "node\bin\node.exe"
            if (Test-Path $cand) { $nodeExe = $cand }
        }
    }

    Push-Location $ProfileDir
    try {
        if ($pnpmCmd) {
            & $pnpmExe install
        } elseif ($pnpmJs -and $nodeExe) {
            & $nodeExe $pnpmJs install
        } else {
            Write-Warn2 "没找到 pnpm。请先装 Node 20+ 和 pnpm，再在这个目录跑：pnpm install"
        }
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
            Write-Warn2 "pnpm install 退出码 $LASTEXITCODE，请检查上面的报错"
        }
    } finally { Pop-Location }
}

Write-Step "完成"
Write-Host @"
下一步：
  1. 完全退出桌面版 dsh 再打开（只刷新网页不够，插件要重新加载）
  2. 打开任意对话，看右下角有没有大肥鱼桌宠
  3. 表情包第一次用会边用边从 kiriyuki.com 拉图；
     想一次性拉齐 322 张，把 cordis.patch.yml 里 nekowhale-stickers 的
     autoSync: startup 那行取消注释，再重启一次

想撤销：把 package.json.bak-$stamp / cordis.patch.yml.bak-$stamp 覆盖回去，
再跑一次 pnpm install。
"@ -ForegroundColor White
