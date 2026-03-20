param(
  [string]$PipeName = "\\.\\pipe\\wincmux-rpc"
)

Write-Host "Starting WinCMux core (pipe: $PipeName)"
Push-Location "$PSScriptRoot\.."
try {
  npm --workspace @wincmux/core run dev
}
finally {
  Pop-Location
}
