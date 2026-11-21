# 大肥鱼宠物套件 · Windows 一键安装（apply.mjs 的包装器）
#
# 用法（在仓库根目录，PowerShell 里）：
#   powershell -ExecutionPolicy Bypass -File .\install\apply.ps1
#   powershell -ExecutionPolicy Bypass -File .\install\apply.ps1 -DownloadAssets
#   powershell -ExecutionPolicy Bypass -File .\install\apply.ps1 -SkipInstall
#
# 真正的安装逻辑在 install\apply.mjs（跨平台、无第三方依赖），
# 这个脚本只负责：找到 node → 传参 → 启动。

param(
    [string]$ProfileDir = "",
    [string]$DshHome = "",
    [string]$DataDir = "",
    [string]$Assets = "",
    [switch]$DownloadAssets,
    [switch]$SkipInstall,
    [switch]$Force,
    [switch]$Json,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'apply.mjs'

if (-not (Test-Path $entry)) {
    Write-Host "找不到 $entry —— 请在克隆下来的仓库里运行。" -ForegroundColor Red
    exit 1
}

function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $home_ = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $runtimes = Join-Path $home_ 'dsh-runtimes'
    if (Test-Path $runtimes) {
        $found = $null
        Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $candidate = Join-Path $_.FullName 'dependencies\node\bin\node.exe'
            if (-not $found -and (Test-Path $candidate)) { $found = $candidate }
        }
        if ($found) { return $found }
    }
    return $null
}

$node = Find-Node
if (-not $node) {
    Write-Host "找不到 node.exe。装好 dsh 桌面版后重试，或用 -DshHome 指向你的 DSH_HOME。" -ForegroundColor Red
    exit 1
}

$argv = @($entry)
if ($ProfileDir) { $argv += @('--profile', $ProfileDir) }
if ($DshHome) { $argv += @('--dsh-home', $DshHome) }
if ($DataDir) { $argv += @('--data-dir', $DataDir) }
if ($Assets) { $argv += @('--assets', $Assets) }
if ($DownloadAssets) { $argv += '--download-assets' }
if ($SkipInstall) { $argv += '--skip-install' }
if ($Force) { $argv += '--force' }
if ($Json) { $argv += '--json' }
if ($DryRun) { $argv += '--dry-run' }

Write-Host "==> node: $node"
& $node @argv
exit $LASTEXITCODE
