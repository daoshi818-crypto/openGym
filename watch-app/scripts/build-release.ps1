param([string]$Compiler = $env:BLUEOS_PACK)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$Compiler) {
    $Compiler = 'E:/BlueOSStudioAAAAAA/resources/app/extensions/blueos-debugger/node_modules/blueos-pack/bin/index.js'
}
if (!(Test-Path -LiteralPath $Compiler)) { throw 'Set BLUEOS_PACK to BlueOS Studio blueos-pack/bin/index.js.' }
Push-Location $project
try {
    $buildOutput = & node $Compiler release --device-type watch-round 2>&1
    $buildOutput | ForEach-Object { Write-Output $_ }
    if ($LASTEXITCODE -ne 0 -or ($buildOutput -match '\[ERROR\]')) { throw 'BlueOS compilation failed.' }
    $manifest = Get-Content 'src/manifest.json' -Raw | ConvertFrom-Json
    $file = Join-Path $project "dist/watch-round/release/$($manifest.package).release.$($manifest.versionName).rpk"
    $zip = [IO.Compression.ZipFile]::OpenRead($file)
    try {
        if (!$zip.GetEntry("$($manifest.package).vru") -or !$zip.GetEntry('META-INF/CERT')) { throw 'Not a BlueOS VRU package.' }
        $reader = [IO.StreamReader]::new($zip.GetEntry('manifest.json').Open())
        try { $packed = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($packed.versionName -ne $manifest.versionName -or $packed.versionCode -ne $manifest.versionCode -or $packed.name -ne $manifest.name) { throw 'Packaged manifest does not match source.' }
    } finally { $zip.Dispose() }
    $release = Join-Path $project 'releases'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    $target = Join-Path $release "opengym-watch-$($manifest.versionName).rpk"
    Copy-Item -LiteralPath $file -Destination $target -Force
    $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$target.sha256", "$digest`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Release: $target"
    Write-Output "SHA256: $digest"
} finally { Pop-Location }
