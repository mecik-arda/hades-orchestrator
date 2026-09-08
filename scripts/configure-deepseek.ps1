param(
  [Parameter(Mandatory = $true)]
  [string]$DeepSeekApiKey
)

$variables = @{
  ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
  ANTHROPIC_AUTH_TOKEN = $DeepSeekApiKey
  ANTHROPIC_MODEL = "deepseek-v4-pro[1m]"
  ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-v4-pro[1m]"
  ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-v4-pro[1m]"
  ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-v4-flash"
  CLAUDE_CODE_SUBAGENT_MODEL = "deepseek-v4-flash"
  CLAUDE_CODE_EFFORT_LEVEL = "high"
  ENABLE_TOOL_SEARCH = "false"
}

foreach ($entry in $variables.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "User")
  Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
}

Write-Output "DeepSeek Claude Code ortamı kullanıcı düzeyinde yapılandırıldı."
