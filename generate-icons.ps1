Add-Type -AssemblyName System.Drawing
$src = "C:\Users\Lenovo\Desktop\logo.png"
$dst = "C:\Users\Lenovo\saher-apk\android\app\src\main\res"
$webDst = "C:\Users\Lenovo\saher-apk\www\icons"

# Load source image
$srcImg = [System.Drawing.Image]::FromFile($src)

function ResizeAndSave($img, $size, $outPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# Android mipmap sizes
@(
    @{dpi="mdpi"; size=48},
    @{dpi="hdpi"; size=72},
    @{dpi="xhdpi"; size=96},
    @{dpi="xxhdpi"; size=144},
    @{dpi="xxxhdpi"; size=192}
) | ForEach-Object {
    $dir = "$dst\mipmap-$($_.dpi)"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }
    # Regular icon
    ResizeAndSave $srcImg $_.size "$dir\ic_launcher.png"
    # Round icon (same for now)
    ResizeAndSave $srcImg $_.size "$dir\ic_launcher_round.png"
    # Foreground for adaptive icon (66% safe zone)
    $fgSize = [math]::Floor($_.size * 0.66)
    $pad = [math]::Floor(($_.size - $fgSize) / 2)
    $fgBmp = New-Object System.Drawing.Bitmap($_.size, $_.size)
    $fgG = [System.Drawing.Graphics]::FromImage($fgBmp)
    $fgG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $fgG.Clear([System.Drawing.Color]::Transparent)
    $fgG.DrawImage($srcImg, $pad, $pad, $fgSize, $fgSize)
    $fgG.Dispose()
    $fgBmp.Save("$dir\ic_launcher_foreground.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $fgBmp.Dispose()
}

# Web/PWA icons
if (-not (Test-Path $webDst)) { New-Item -ItemType Directory $webDst | Out-Null }
@(48, 96, 192, 512) | ForEach-Object {
    ResizeAndSave $srcImg $_ "$webDst\icon-$_.png"
}
# Maskable icons (with safe zone padding)
@(192, 512) | ForEach-Object {
    $size = $_
    $fgSize = [math]::Floor($size * 0.66)
    $pad = [math]::Floor(($size - $fgSize) / 2)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    # Background color (using theme color)
    $g.Clear([System.Drawing.Color]::FromArgb(0x6B, 0x1D, 0x2F))
    $g.DrawImage($srcImg, $pad, $pad, $fgSize, $fgSize)
    $g.Dispose()
    $bmp.Save("$webDst\icon-maskable-$size.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$srcImg.Dispose()
Write-Host "All icons generated successfully"