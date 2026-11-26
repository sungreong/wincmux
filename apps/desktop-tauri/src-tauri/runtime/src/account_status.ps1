$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$email = $null
if ($env:WINCMUX_PROBE_TOOL -eq 'claude') {
    $raw = claude auth status --json 2>$null
    $connected = $LASTEXITCODE -eq 0
    if ($connected) {
        $status = $raw | ConvertFrom-Json
        $connected = $status.loggedIn -ne $false
        $email = $status.email
    }
} else {
    $ErrorActionPreference = 'Continue'
    codex login status *> $null
    $connected = $LASTEXITCODE -eq 0
    if ($connected) {
        $dir = $env:CODEX_HOME
        if (!$dir) { $dir = Join-Path $env:USERPROFILE '.codex' }
        try {
            $jwt = (Get-Content -Raw -LiteralPath (Join-Path $dir 'auth.json') -ErrorAction Stop | ConvertFrom-Json).tokens.id_token
            $body = $jwt.Split('.')[1].Replace('-','+').Replace('_','/')
            $bytes = [Convert]::FromBase64String($body.PadRight([int]([Math]::Ceiling($body.Length / 4) * 4),'='))
            $email = ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json).email
        } catch { $email = $null }
    }
}
@{ authenticated = $connected; email = $email } | ConvertTo-Json -Compress
