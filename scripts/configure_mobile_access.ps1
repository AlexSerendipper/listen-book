param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backupDirectory = Join-Path $projectRoot 'app\data\tailscale-serve-backups'
$mobileTarget = 'http://127.0.0.1:8765/mobile/'
$apiTarget = 'http://127.0.0.1:8765/api/mobile/'

function Invoke-Tailscale {
    param([string[]]$Arguments)
    & tailscale @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale $($Arguments -join ' ') 失败，退出码 $LASTEXITCODE"
    }
}

function Remove-MobileMappings {
    Invoke-Tailscale @('serve', '--https=443', '--set-path=/mobile/', 'off')
    Invoke-Tailscale @('serve', '--https=443', '--set-path=/api/mobile/', 'off')
}

function Test-MobileOnlyConfig {
    param(
        [object]$Config,
        [switch]$RequireBoth
    )
    if ($Config.PSObject.Properties.Count -eq 0) { return -not $RequireBoth }
    $topLevel = @($Config.PSObject.Properties.Name)
    if (@($topLevel | Where-Object { $_ -notin @('TCP', 'Web') }).Count -gt 0) { return $false }
    $tcpEntries = @($Config.TCP.PSObject.Properties)
    if ($tcpEntries.Count -ne 1 -or $tcpEntries[0].Name -ne '443' -or -not $tcpEntries[0].Value.HTTPS) {
        return $false
    }
    $webEntries = @($Config.Web.PSObject.Properties)
    if ($webEntries.Count -ne 1) { return $false }
    $handlers = @($webEntries[0].Value.Handlers.PSObject.Properties)
    if ($RequireBoth -and $handlers.Count -ne 2) { return $false }
    if (-not $RequireBoth -and $handlers.Count -gt 2) { return $false }
    foreach ($handler in $handlers) {
        if ($handler.Name -eq '/mobile/' -and $handler.Value.Proxy -eq $mobileTarget) { continue }
        if ($handler.Name -eq '/api/mobile/' -and $handler.Value.Proxy -eq $apiTarget) { continue }
        return $false
    }
    if ($RequireBoth) {
        return @($handlers.Name) -contains '/mobile/' -and @($handlers.Name) -contains '/api/mobile/'
    }
    return $true
}

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    throw '未找到 tailscale CLI。请先安装并登录 Tailscale。'
}

if ($Remove) {
    Remove-MobileMappings
    Write-Host '已仅移除 Listen Book 的 /mobile/ 与 /api/mobile/ Serve 映射。'
    exit 0
}

$versionText = (& tailscale version 2>&1 | Out-String)
$savedErrorPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$helpText = (& tailscale serve --help 2>&1 | Out-String)
$ErrorActionPreference = $savedErrorPreference
if ($helpText -notmatch '--set-path') {
    throw '当前 Tailscale 版本不能安全表达路径白名单；未修改 Serve 配置。'
}

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/api/mobile/health' -TimeoutSec 4
} catch {
    throw 'Listen Book 移动服务尚未在 127.0.0.1:8765 启动；未修改 Serve 配置。'
}
if ($health.StatusCode -ne 200) {
    throw "移动服务健康检查失败（HTTP $($health.StatusCode)）；未修改 Serve 配置。"
}

$before = (& tailscale serve status --json | Out-String).Trim()
if (-not $before) { $before = '{}' }
$beforeObject = $before | ConvertFrom-Json
if (-not (Test-MobileOnlyConfig -Config $beforeObject)) {
    throw '检测到本产品之外的 Tailscale Serve 配置。为避免覆盖无关规则，本脚本已停止。'
}

New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$snapshotPath = Join-Path $backupDirectory "serve-before-mobile-$stamp.json"
$before | Set-Content -LiteralPath $snapshotPath -Encoding UTF8

try {
    Invoke-Tailscale @('serve', '--yes', '--bg', '--https=443', '--set-path=/mobile/', $mobileTarget)
    Invoke-Tailscale @('serve', '--yes', '--bg', '--https=443', '--set-path=/api/mobile/', $apiTarget)

    $after = (& tailscale serve status --json | Out-String).Trim()
    $afterObject = $after | ConvertFrom-Json
    if (-not (Test-MobileOnlyConfig -Config $afterObject -RequireBoth)) {
        throw 'Serve 结果不是两个精确的移动路径映射。'
    }

    $tailscaleStatus = (& tailscale status --json | ConvertFrom-Json)
    $dnsName = [string]$tailscaleStatus.Self.DNSName
    if (-not $dnsName) { throw '无法确定本机 Tailnet DNS 名称。' }
    $baseUrl = "https://$($dnsName.TrimEnd('.'))"

    $proxyHeaders = @{
        'X-Forwarded-Proto' = 'https'
        'X-Forwarded-For' = '100.64.0.2'
    }
    $localMobileProbe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/mobile/' -Headers $proxyHeaders -TimeoutSec 6
    $localHealthProbe = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/api/mobile/health' -Headers $proxyHeaders -TimeoutSec 6
    if ($localMobileProbe.StatusCode -ne 200 -or $localHealthProbe.StatusCode -ne 200) {
        throw '移动页面或健康检查未通过本机代理边界验证。'
    }
    foreach ($blockedPath in @('/', '/app/', '/api/books', '/api/player/state', '/api/overlay/status', '/mobile-admin/')) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765$blockedPath" -Headers $proxyHeaders -TimeoutSec 6
            if ($response.StatusCode -lt 400) {
                throw "安全验证失败：代理边界意外开放 $blockedPath"
            }
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -ge 400) { continue }
            if ($_.Exception.Message -like '安全验证失败*') { throw }
            throw
        }
    }

    $pingResult = (& tailscale ping --c 1 $dnsName 2>&1 | Out-String)
    if ($pingResult -match 'is local Tailscale IP') {
        Write-Warning '本机不能通过自己的 Tailnet HTTPS 地址做远端探测；请在 iPhone 上完成负向访问验收。'
    } else {
        $mobileProbe = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/mobile/" -TimeoutSec 10
        $healthProbe = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/mobile/health" -TimeoutSec 10
        if ($mobileProbe.StatusCode -ne 200 -or $healthProbe.StatusCode -ne 200) {
            throw '移动页面或移动健康检查无法通过 Tailnet HTTPS 访问。'
        }
    }

    Write-Host "Tailscale $($versionText.Split([Environment]::NewLine)[0]) 移动白名单配置完成。"
    Write-Host "iPhone 地址：$baseUrl/mobile/"
    Write-Host "本机配对管理：http://127.0.0.1:8765/mobile-admin/"
    Write-Host "配置快照：$snapshotPath"
    Write-Host "撤销命令：powershell.exe -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
} catch {
    try { Remove-MobileMappings } catch { Write-Warning '自动回滚移动映射失败，请人工检查 tailscale serve status。' }
    throw
}
