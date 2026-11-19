param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '../assets/icon-terminal.ico')
)

Add-Type -AssemblyName System.Drawing

function New-SmallIconFrame([int]$size) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $background = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 21, 31, 45))
  $outline = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 67, 91, 118), [Math]::Max(1, $size / 16))
  $prompt = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 65, 227, 132), [Math]::Max(2, $size / 8))
  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $stream = [System.IO.MemoryStream]::new()
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $inset = [Math]::Max(0.5, $size / 32)
    $edge = $size - 2 * $inset
    $radius = [Math]::Max(2, $size / 5)
    $diameter = 2 * $radius
    $shape.AddArc($inset, $inset, $diameter, $diameter, 180, 90)
    $shape.AddArc($inset + $edge - $diameter, $inset, $diameter, $diameter, 270, 90)
    $shape.AddArc($inset + $edge - $diameter, $inset + $edge - $diameter, $diameter, $diameter, 0, 90)
    $shape.AddArc($inset, $inset + $edge - $diameter, $diameter, $diameter, 90, 90)
    $shape.CloseFigure()
    $graphics.FillPath($background, $shape)
    $graphics.DrawPath($outline, $shape)

    $prompt.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $prompt.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $prompt.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawLines($prompt, [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($size * 0.30, $size * 0.33),
      [System.Drawing.PointF]::new($size * 0.51, $size * 0.50),
      [System.Drawing.PointF]::new($size * 0.30, $size * 0.67)
    ))
    $graphics.DrawLine($prompt, $size * 0.53, $size * 0.68, $size * 0.75, $size * 0.68)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
    $shape.Dispose()
    $prompt.Dispose()
    $outline.Dispose()
    $background.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$source = Join-Path $PSScriptRoot '../assets/icon-terminal.png'
$frames = @(
  @{ Size = 16; Bytes = (New-SmallIconFrame 16) },
  @{ Size = 20; Bytes = (New-SmallIconFrame 20) },
  @{ Size = 24; Bytes = (New-SmallIconFrame 24) },
  @{ Size = 32; Bytes = (New-SmallIconFrame 32) },
  @{ Size = 48; Bytes = (New-SmallIconFrame 48) },
  @{ Size = 256; Bytes = [System.IO.File]::ReadAllBytes($source) }
)
$output = [System.IO.File]::Create($OutputPath)
$writer = [System.IO.BinaryWriter]::new($output)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($frame in $frames) {
    $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$frame.Bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $frame.Bytes.Length
  }
  foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
} finally {
  $writer.Dispose()
}
Write-Output "Built $OutputPath with $($frames.Count) icon sizes"
