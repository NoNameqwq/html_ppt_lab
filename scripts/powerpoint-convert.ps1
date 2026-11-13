param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (Get-Process -Name POWERPNT -ErrorAction SilentlyContinue) { throw 'WDS_POWERPOINT_RUNNING' }
$powerpoint = $null
$presentation = $null
try {
  $powerpoint = New-Object -ComObject PowerPoint.Application
  $powerpoint.AutomationSecurity = 3
  $presentation = $powerpoint.Presentations.Open([string]$request.source, -1, 0, 0)
  if ($presentation.Slides.Count -gt 300) { throw 'WDS_PPT_SLIDES_LIMIT' }
  if ($request.mode -eq 'faithful') {
    $ratio = $presentation.PageSetup.SlideWidth / $presentation.PageSetup.SlideHeight
    $pixelWidth = [int][Math]::Min(1920, 1080 * $ratio)
    $pixelHeight = [int]($pixelWidth / $ratio)
    $presentation.Export([string]$request.output, 'PNG', $pixelWidth, $pixelHeight)
    $result = @{ slides = $presentation.Slides.Count; mode = 'faithful' }
  } else {
    $presentation.SaveAs([string]$request.output, 24)
    $result = @{ slides = $presentation.Slides.Count; mode = 'editable' }
  }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.result -Encoding UTF8
} finally {
  if ($presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($powerpoint) {
    # Close only our document. A user may have opened another deck meanwhile.
    if ($powerpoint.Presentations.Count -eq 0) { $powerpoint.Quit() }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerpoint)
  }
  [GC]::Collect()
}
