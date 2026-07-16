# Save an image pasted into chat (which reaches Claude as pixels, not a file)
# from the Windows clipboard to disk, so it can be passed to snapgen `--files`.
# Usage: powershell -STA -NoProfile -File save-clip.ps1 <out.png>
param([Parameter(Mandatory = $true)][string]$Out)
$img = Get-Clipboard -Format Image
if ($img) {
  $img.Save($Out)
  Write-Output ("saved {0}x{1} -> {2}" -f $img.Width, $img.Height, $Out)
} else {
  Write-Output 'no image in clipboard'
  exit 1
}
