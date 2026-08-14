# DeepSeek Harness Desktop - git pre-commit guard
# Blocks: secrets, oversized files. PowerShell required.
$ErrorActionPreference = "Stop"
$root = git rev-parse --show-toplevel
$staged = git diff --cached --name-only
if (-not $staged) { exit 0 }

$secretPatterns = @(
  "(?i)api[_-]?key\s*[:=]",
  "(?i)sk-[A-Za-z0-9]{16,}",
  "(?i)deepseek[a-z0-9_-]*[_-]?key\s*[:=]",
  "(?i)token\s*[:=]\s*['""][A-Za-z0-9._-]{16,}",
  "(?i)secret\s*[:=]\s*['""][A-Za-z0-9._-]{16,}",
  "(?i)password\s*[:=]\s*['""][A-Za-z0-9._-]{8,}"
)
$blocked = @()
foreach ($file in $staged) {
  if (-not (Test-Path (Join-Path $root $file))) { continue }
  $len = (Get-Item (Join-Path $root $file)).Length
  if ($len -gt 5MB) { $blocked += "$file (size $len bytes > 5MB)" }
  if ($file -match "(?i)(\.env|credentials|\.pem$|\.key$|id_rsa|\.pfx$|\.p12$)") {
    $blocked += "$file (blocked file name)"
  }
  try {
    $content = Get-Content -Raw (Join-Path $root $file) -ErrorAction Stop
    foreach ($pat in $secretPatterns) {
      if ($content -match $pat) { $blocked += "$file (possible secret: $pat)"; break }
    }
  } catch { }
}
if ($blocked.Count -gt 0) {
  Write-Host "pre-commit guard rejected:" -ForegroundColor Red
  $blocked | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  Write-Host "Remove secrets/oversized files and re-stage."
  exit 1
}
exit 0

