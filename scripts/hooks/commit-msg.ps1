# DeepSeek Harness Desktop - git commit-msg guard (Conventional Commits)
$ErrorActionPreference = "Stop"
$msg = Get-Content $args[0] -Raw
if ($msg -notmatch "^(feat|fix|docs|chore|refactor|test|build|ci|perf|revert)(\([a-z0-9_-]+\))?!?:\s.+") {
  Write-Host "commit-msg guard: use Conventional Commits, e.g. 'feat(shell): add dsh manager'" -ForegroundColor Red
  exit 1
}
exit 0
