# run-tests.ps1 —— 跑两份自测（不需要装 DSH、不需要联网）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
#   ... -NodeExe "C:\Program Files\nodejs\node.exe"
#   ... -ElectronExe "D:\别的路径\DSH Desktop.exe"
#
# 运行时优先级：PATH 里的 node → DSH Desktop 自带的 Electron（ELECTRON_RUN_AS_NODE）。
# 判定不靠退出码（Electron 当 node 用时偶尔会带非零码），靠测试自己写的
# %TEMP%\dsh-session-prune-<name>.result.json。

[CmdletBinding()]
param(
    [string]$NodeExe = '',
    [string]$ElectronExe = 'D:\Deepseek_Harness\DSH Desktop\DSH Desktop.exe'
)

$ErrorActionPreference = 'Stop'
$tests = $PSScriptRoot
$temp = [IO.Path]::GetTempPath()

if ($NodeExe -eq '') {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $NodeExe = $nodeCmd.Source
    } elseif (-not (Test-Path $ElectronExe)) {
        Write-Host '找不到 node，也找不到 DSH Desktop。用 -NodeExe 或 -ElectronExe 指定一个。' -ForegroundColor Red
        exit 1
    }
}

Write-Host ("运行时：{0}" -f $(if ($NodeExe) { $NodeExe } else { "$ElectronExe (ELECTRON_RUN_AS_NODE)" })) -ForegroundColor DarkGray

$failures = 0
foreach ($test in @('host.test.mjs', 'client.test.mjs')) {
    $path = Join-Path $tests $test
    $name = $test -replace '\.test\.mjs$', ''
    $resultPath = Join-Path $temp "dsh-session-prune-$name.result.json"

    Write-Host "`n=== $test ===" -ForegroundColor Cyan
    if (-not (Test-Path $path)) {
        Write-Host "  缺测试文件：$path" -ForegroundColor Red
        $failures++
        continue
    }
    if (Test-Path $resultPath) { Remove-Item $resultPath -Force }

    $env:DSH_SELFTEST_RESULT = $resultPath
    if ($NodeExe) {
        & $NodeExe $path
    } else {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $ElectronExe --expose-internals $path
    }
    $env:DSH_SELFTEST_RESULT = ''

    # Electron 当 node 用时，调用会立即返回、测试还在后台跑，所以要等结果文件出现
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150 }
    if (Test-Path $resultPath) {
        $verdict = Get-Content $resultPath -Raw | ConvertFrom-Json
        if ($verdict.ok -eq $true) {
            Write-Host '   → 通过' -ForegroundColor Green
        } else {
            Write-Host ("   → 失败（{0} 项）" -f $verdict.failures) -ForegroundColor Red
            $failures++
        }
    } else {
        Write-Host '   → 失败：测试没有产出结果文件（看上面的报错）' -ForegroundColor Red
        $failures++
    }
}

Write-Host ''
if ($failures -eq 0) {
    Write-Host '全部通过' -ForegroundColor Green
} else {
    Write-Host ("{0} 个测试未通过" -f $failures) -ForegroundColor Red
}
exit $failures
