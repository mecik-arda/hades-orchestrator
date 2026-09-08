$environmentNames = @(
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "ENABLE_TOOL_SEARCH"
)

foreach ($environmentName in $environmentNames) {
  $environmentValue = [Environment]::GetEnvironmentVariable($environmentName, "User")
  if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
    Set-Item -Path "Env:$environmentName" -Value $environmentValue
  }
}

if ([string]::IsNullOrWhiteSpace($env:ANTHROPIC_AUTH_TOKEN)) {
  throw "ANTHROPIC_AUTH_TOKEN kullanıcı ortamında tanımlı değil."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
& codex --model "gpt-5.6-sol" --cd $projectRoot
