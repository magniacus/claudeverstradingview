param([int]$Port = 9222)

# If CDP already available, nothing to do
try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    Write-Host "CDP already running at http://localhost:$Port"
    Write-Host $r.Content
    exit 0
} catch {}

$chromePaths = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Error "Chrome not found. Install Chrome or launch TradingView manually with --remote-debugging-port=$Port"
    exit 1
}

Write-Host "Killing Chrome and relaunching with CDP on port $Port..."
Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$userDataDir = "$env:TEMP\tv-chrome"
$url = "https://www.tradingview.com/chart/"
cmd /c start "" "$chrome" "--remote-debugging-port=$Port" "--user-data-dir=$userDataDir" "$url"

Write-Host "Waiting for CDP..."
$ready = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        Write-Host ""
        Write-Host "CDP ready at http://localhost:$Port"
        Write-Host $r.Content
        $ready = $true
        break
    } catch {
        Write-Host "Still waiting... ($i/20)"
    }
}

if (-not $ready) {
    Write-Error "CDP did not become available after timeout."
    exit 1
}
