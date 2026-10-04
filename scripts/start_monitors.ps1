# Démarre le NASDAQ Level Monitor et le FBO Monitor en arrière-plan (utilisé par la tâche Windows « NASDAQ Monitor »).
# Les identifiants Telegram viennent des variables d'environnement utilisateur TELEGRAM_TOKEN / TELEGRAM_CHAT_ID.
# Logs : <projet>\nasdaq_monitor.log, fbo_monitor.log (+ .err.log)

$wd = Split-Path -Parent $PSScriptRoot
$monitors = 'nasdaq_monitor', 'fbo_monitor'

# Charge les variables depuis le profil utilisateur (au cas où le processus parent ne les a pas)
foreach ($v in 'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID') {
  if (-not (Get-Item "Env:$v" -ErrorAction SilentlyContinue)) {
    Set-Item "Env:$v" ([Environment]::GetEnvironmentVariable($v, 'User'))
  }
}

# Arrête uniquement les monitors déjà lancés (jamais les autres processus Node, ex. serveur MCP)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $cl = $_.CommandLine; $monitors | Where-Object { $cl -like "*$_.js*" } } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

foreach ($n in $monitors) {
  Start-Process -FilePath 'node' -ArgumentList "scripts/$n.js" -WorkingDirectory $wd -WindowStyle Hidden `
    -RedirectStandardOutput "$wd\$n.log" -RedirectStandardError "$wd\$n.err.log"
}
