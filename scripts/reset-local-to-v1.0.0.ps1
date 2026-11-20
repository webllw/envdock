# 将本机 EnvDock 应用本体重置为 v1.0.0，保留已安装的运行时、版本与配置。
# 用法：在 PowerShell 中直接运行本脚本；路径按本机实际安装位置调整。
param(
    [string]$Root = 'D:\env\EnvDock',
    [string]$Zip = 'D:\workbuddy\DEV-ENV\envdock\release\EnvDock-1.0.0-app.zip',
    [string]$ShaFile = 'D:\workbuddy\DEV-ENV\envdock\release\EnvDock-1.0.0-app.zip.sha256'
)

$ErrorActionPreference = 'Stop'

$appDir = Join-Path $Root 'app'
$updatesDir = Join-Path $Root 'updates'
$versionFile = Join-Path $Root 'version.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path -LiteralPath $Zip)) {
    throw "升级包不存在：$Zip"
}
if (-not (Test-Path -LiteralPath $Root)) {
    throw "安装目录不存在：$Root"
}

# 校验包完整性，避免用损坏的包覆盖应用本体
$expected = ((Get-Content -LiteralPath $ShaFile -TotalCount 1) -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw "校验值不匹配：期望 $expected，实际 $actual"
}
Write-Host "升级包校验通过。"

# 进程未退出时 app 与 updates 目录会被句柄锁定，替换必然失败
$procs = Get-Process -Name 'EnvDock' -ErrorAction SilentlyContinue
if ($procs) {
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 3
    Write-Host "已结束 $($procs.Count) 个 EnvDock 进程。"
}

# 旧 app 改名保留而非删除：替换失败时可将其改回，应用仍可用
if (Test-Path -LiteralPath $appDir) {
    $appBackup = Join-Path $Root "app.bak-$stamp"
    Rename-Item -LiteralPath $appDir -NewName (Split-Path $appBackup -Leaf)
    Write-Host "旧应用本体已备份：$appBackup"
}

Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
$tmp = Join-Path $env:TEMP "envdock-reset-$stamp"
try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)
    $sourceApp = Join-Path $tmp 'app'
    if (-not (Test-Path -LiteralPath $sourceApp)) {
        throw "升级包内缺少 app 目录：$sourceApp"
    }
    Move-Item -LiteralPath $sourceApp -Destination $appDir
    Write-Host "应用本体已替换为 v1.0.0。"
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 升级残留（staging、download 缓存、history）改名让路；确认无误后可手动删除
if (Test-Path -LiteralPath $updatesDir) {
    $updatesBackup = Join-Path $Root "updates.bak-$stamp"
    Rename-Item -LiteralPath $updatesDir -NewName (Split-Path $updatesBackup -Leaf)
    Write-Host "升级残留已移出：$updatesBackup"
}

# 删除版本状态，下次启动按 app 的 package.json（1.0.0）重建，
# 避免 pendingVersion 残留触发“版本不一致”提示
if (Test-Path -LiteralPath $versionFile) {
    $versionBackup = Join-Path $Root "version.json.bak-$stamp"
    Rename-Item -LiteralPath $versionFile -NewName (Split-Path $versionBackup -Leaf)
    Write-Host "版本状态已移出：$versionBackup"
}

Write-Host "完成。启动 EnvDock，确认标题显示 v1.0.0。"
