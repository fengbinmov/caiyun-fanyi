# 生成扩展图标 media/icon.png（128x128）
# 设计：圆角深蓝底 + 淡色经纬线（暗示地球/全球）+ 居中的白色「译」字
Add-Type -AssemblyName System.Drawing

$size = 128
$outDir = Join-Path $PSScriptRoot '..\media'
$outPath = Join-Path $outDir 'icon.png'

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角矩形
$radius = 28
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($size - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($size - $radius * 2, $size - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $size - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()

$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 17, 119, 187),
  [System.Drawing.Color]::FromArgb(255, 8, 58, 96),
  45
)
$g.FillPath($bg, $path)
$g.SetClip($path)

# 经纬线：淡淡的白色，暗示地球
$grid = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 255, 255, 255), 2)
$g.DrawEllipse($grid, 8, 8, 112, 112)
$g.DrawEllipse($grid, 40, 8, 48, 112)   # 经线（竖椭圆）
$g.DrawEllipse($grid, 8, 40, 112, 48)   # 纬线（横椭圆）
$g.DrawLine($grid, 8, 64, 120, 64)      # 赤道

# 「译」字
$font = New-Object System.Drawing.Font(
  'Microsoft YaHei',
  62,
  [System.Drawing.FontStyle]::Bold,
  [System.Drawing.GraphicsUnit]::Pixel
)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$textRect = New-Object System.Drawing.RectangleF(0, 2, $size, $size)
$g.DrawString('译', $font, $white, $textRect, $format)

$g.Dispose()
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "已生成 $outPath"
