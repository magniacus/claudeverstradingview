# Envoie le contenu d'un fichier texte (UTF-8, HTML Telegram) sur Telegram.
# Usage : powershell -NoProfile -ExecutionPolicy Bypass -File scripts\send_telegram.ps1 -Path <fichier>
# Identifiants : variables d'environnement utilisateur TELEGRAM_TOKEN / TELEGRAM_CHAT_ID.
# Les messages de plus de 4000 caractères sont découpés entre deux paragraphes (limite Telegram : 4096).

param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$token = $env:TELEGRAM_TOKEN; if (-not $token) { $token = [Environment]::GetEnvironmentVariable('TELEGRAM_TOKEN', 'User') }
$chat  = $env:TELEGRAM_CHAT_ID; if (-not $chat) { $chat = [Environment]::GetEnvironmentVariable('TELEGRAM_CHAT_ID', 'User') }
if (-not $token -or -not $chat) { throw 'Variables TELEGRAM_TOKEN et TELEGRAM_CHAT_ID requises' }

$text = [IO.File]::ReadAllText((Resolve-Path $Path), [Text.Encoding]::UTF8).Trim()
if (-not $text) { throw "Fichier vide : $Path" }

# Découpage par paragraphes (lignes vides) en morceaux <= 4000 caractères
$max = 4000
$chunks = New-Object System.Collections.Generic.List[string]
$current = ''
foreach ($para in ($text -split "(\r?\n){2,}" | Where-Object { $_.Trim() })) {
  $candidate = if ($current) { "$current`n`n$para" } else { $para }
  if ($candidate.Length -le $max) { $current = $candidate; continue }
  if ($current) { $chunks.Add($current) }
  while ($para.Length -gt $max) { $chunks.Add($para.Substring(0, $max)); $para = $para.Substring($max) }
  $current = $para
}
if ($current) { $chunks.Add($current) }

$i = 0
foreach ($chunk in $chunks) {
  $i++
  $body = @{ chat_id = $chat; text = $chunk; parse_mode = 'HTML'; disable_web_page_preview = $true } | ConvertTo-Json -Compress
  $r = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  if (-not $r.ok) { throw "Envoi Telegram échoué (morceau $i/$($chunks.Count))" }
  "Morceau $i/$($chunks.Count) envoyé (message_id $($r.result.message_id), $($chunk.Length) caractères)"
}
