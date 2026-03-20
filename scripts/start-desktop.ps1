Write-Host "Starting WinCMux desktop (Electron)"
Push-Location "$PSScriptRoot\.."
try {
  npm --workspace @wincmux/desktop run dev
}
finally {
  Pop-Location
}
