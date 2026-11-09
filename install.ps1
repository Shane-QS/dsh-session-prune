# install.ps1 —— 把 dsh-session-prune 装进 DSH Desktop（仅 Windows）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1            # 安装 / 升级（幂等）
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun    # 只打印计划
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall # 卸载
#
# 做的事只有两件：
#   1. 把本目录复制到 %USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-session-prune
#   2. 在 %USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml 末尾加一段带标记的 insert
# 不碰 DSH 的安装目录，改前自动备份 cordis.patch.yml。

[CmdletBinding()]
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$Profile = 'desktop',
    [switch]$Uninstall,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$BEGIN = '# >>> dsh-session-prune (managed by install.ps1) >>>'
$END   = '# <<< dsh-session-prune <<<'

function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host "    $msg" }
function Ok($msg) { Write-Host "[ok] $msg" -ForegroundColor Green }
function Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }

if ($env:OS -ne 'Windows_NT') { Fail '这个插件只支持 Windows（install.ps1 只处理 Windows 的路径与补丁）' }

$repo = $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$targetDir = Join-Path $profileDir 'node_modules\dsh-session-prune'

if (-not (Test-Path $profileDir)) { Fail "找不到 DSH 的 profile 目录：$profileDir（DSH Desktop 至少启动过一次吗？）" }
if (-not (Test-Path $patchFile)) { Fail "找不到补丁层：$patchFile" }

$block = @(
    $BEGIN
    '# 会话行「⋯」菜单里的「删除会话」：Host 侧挂 /session-prune/api/delete，浏览器侧注入菜单项。'
    '# 卸载：跑 install.ps1 -Uninstall，或手动删掉本段并重启 DSH。'
    '- insert:'
    '    - id: session-prune'
    "      name: 'dsh-session-prune'"
    '      inject: [webServer]'
    $END
)

function Read-Lines([string]$path) {
    return @([IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8))
}

function Write-Lines([string]$path, [string[]]$lines) {
    [IO.File]::WriteAllLines($path, $lines, (New-Object Text.UTF8Encoding($false)))
}

# 去掉现有标记块，返回剩下的行
function Strip-Block([string[]]$lines) {
    $out = New-Object System.Collections.Generic.List[string]
    $inside = $false
    foreach ($line in $lines) {
        if ($line.Trim() -eq $BEGIN) { $inside = $true; continue }
        if ($line.Trim() -eq $END)   { $inside = $false; continue }
        if (-not $inside) { $out.Add($line) }
    }
    return , $out.ToArray()
}

Step "DSH profile: $profileDir"

if ($Uninstall) {
    Step '卸载'
    if ($DryRun) {
        Info "会删除：$targetDir"
        Info "会从 cordis.patch.yml 移除标了 >>> dsh-session-prune 的那一段"
        Ok 'DryRun，未做任何改动'
        exit 0
    }
    if (Test-Path $targetDir) {
        Remove-Item $targetDir -Recurse -Force
        Ok "已删除 $targetDir"
    } else {
        Info '插件目录本来就不在，跳过'
    }
    $lines = Read-Lines $patchFile
    $stripped = Strip-Block $lines
    $trimmed = New-Object System.Collections.Generic.List[string]
    $trimmed.AddRange([string[]]$stripped)
    while ($trimmed.Count -gt 0 -and $trimmed[$trimmed.Count - 1].Trim() -eq '') { $trimmed.RemoveAt($trimmed.Count - 1) }
    if ($trimmed.Count -ne $lines.Count) {
        Copy-Item $patchFile "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
        Write-Lines $patchFile $trimmed.ToArray()
        Ok '已从 cordis.patch.yml 移除插件段'
    } else {
        Info 'cordis.patch.yml 里没有插件段，跳过'
    }
    Ok '卸载完成。重启 DSH Desktop 后菜单里就没有「删除会话」了。'
    exit 0
}

Step '复制插件文件'
if ($DryRun) {
    Info "会复制 $repo -> $targetDir"
} else {
    if (Test-Path $targetDir) {
        $existing = Get-Item $targetDir -Force
        if ($existing.LinkType) {
            Info "$targetDir 是指向工作区的链接（由 pnpm link: 管理），跳过复制"
            $skipCopy = $true
        } else {
            Remove-Item $targetDir -Recurse -Force
        }
    }
    if (-not $skipCopy) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    foreach ($item in @('package.json', 'cordis.patch.yml', 'client.js', 'lib')) {
        $source = Join-Path $repo $item
        if (-not (Test-Path $source)) { Fail "仓库里缺文件：$source" }
        Copy-Item $source (Join-Path $targetDir $item) -Recurse -Force
    }
    Ok "已安装到 $targetDir"
    }
}

Step '写补丁层'
# 如果插件已经作为依赖/bundle 注册（`dsh plugin add` / pnpm link / 插件页启用），
# 再往 cordis.patch.yml 写同样的 insert 会造成 duplicate loader entry id 而启用失败。
$profileManifest = Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$declaredAsDep = $profileManifest.dependencies.PSObject.Properties.Name -contains 'dsh-session-prune'
$declaredAsBundle = @($profileManifest.dsh.profile.bundles) -contains 'dsh-session-prune'
if ($declaredAsDep -or $declaredAsBundle) {
    Info '插件已作为依赖/bundle 注册，跳过写补丁层（避免 duplicate loader entry id）'
    Info '如果需要刷新，请重启 DSH。'
    exit 0
}

$lines = Read-Lines $patchFile
$stripped = Strip-Block $lines
$next = New-Object System.Collections.Generic.List[string]
$next.AddRange([string[]]$stripped)
while ($next.Count -gt 0 -and $next[$next.Count - 1].Trim() -eq '') { $next.RemoveAt($next.Count - 1) }
if ($next.Count -gt 0) { $next.Add('') }
$next.AddRange([string[]]$block)

if ($DryRun) {
    Info "会在 $patchFile 末尾写入 $($block.Count) 行（先移除旧的同名段）"
    Ok 'DryRun，未做任何改动'
    exit 0
}

Copy-Item $patchFile "$patchFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
Write-Lines $patchFile $next.ToArray()
Ok '已写入 cordis.patch.yml'

Write-Host ''
Ok '安装完成'
Info '重启 DSH Desktop（托盘里退出再开）后，侧栏任意会话行的「⋯」菜单最后会多一条「删除会话」。'
Info '验证：Host 路由 POST /session-prune/api/delete（只接受本机回环请求）。'
