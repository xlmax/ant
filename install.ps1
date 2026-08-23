$ErrorActionPreference = "Stop"

# Репозиторий GitHub в формате owner/repo.
$repo = "xlmax/ant"

# Для старых версий PowerShell (5.1) GitHub требует TLS 1.2.
if ([Net.ServicePointManager]::SecurityProtocol -notmatch "Tls12") {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm не найден. Установите Node.js (>= 20.12)."
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
if (-not $release.tag_name) {
    throw "Не удалось определить последний релиз для $repo."
}

$version = $release.tag_name -replace '^v', ''
$url = "https://github.com/$repo/releases/download/$($release.tag_name)/ant-$version.tgz"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ant-" + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
    Write-Host "Устанавливаю ant $version ..."
    $tgz = Join-Path $tmp "ant.tgz"
    Invoke-WebRequest -Uri $url -OutFile $tgz
    npm install -g $tgz
    Write-Host "Готово. Запустите: ant"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
