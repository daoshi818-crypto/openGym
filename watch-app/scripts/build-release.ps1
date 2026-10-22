param([string]$Compiler = $env:BLUEOS_PACK)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$Compiler) {
    $Compiler = 'E:/BlueOSStudioAAAAAA/resources/app/extensions/blueos-debugger/node_modules/blueos-pack/bin/index.js'
}
if (!(Test-Path -LiteralPath $Compiler)) { throw 'Set BLUEOS_PACK to BlueOS Studio blueos-pack/bin/index.js.' }
Push-Location $project
try {
    $manifest = Get-Content 'src/manifest.json' -Raw | ConvertFrom-Json
    $targets = @('watch-square', 'watch-round')
    foreach ($targetDevice in $targets) {
        # cmd merges blueos-pack warnings into stdout; PowerShell otherwise promotes
        # native stderr warnings to terminating NativeCommandError under Stop mode.
        $buildOutput = & cmd.exe /d /c "node `"$Compiler`" release --device-type $targetDevice --force 2>&1"
        $buildOutput | ForEach-Object { Write-Output $_ }
        if ($LASTEXITCODE -ne 0 -or ($buildOutput -match '\[ERROR\]')) { throw "BlueOS compilation failed for $targetDevice." }
        & node (Join-Path $PSScriptRoot 'verify-layout.cjs') $targetDevice
        if ($LASTEXITCODE -ne 0) { throw "Compiled $targetDevice layout validation failed." }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $release = Join-Path $project 'releases'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    foreach ($targetDevice in $targets) {
        $file = Join-Path $project "dist/$targetDevice/release/$($manifest.package).release.$($manifest.versionName).rpk"
        $zip = [IO.Compression.ZipFile]::OpenRead($file)
        try {
            if (!$zip.GetEntry("$($manifest.package).vru") -or !$zip.GetEntry('META-INF/CERT')) { throw 'Not a BlueOS VRU package.' }
            $reader = [IO.StreamReader]::new($zip.GetEntry('manifest.json').Open())
            try { $packed = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
            if ($packed.versionName -ne $manifest.versionName -or $packed.versionCode -ne $manifest.versionCode -or $packed.name -ne $manifest.name) { throw 'Packaged manifest does not match source.' }
            if ($packed.deviceTypeList -notcontains $targetDevice) { throw "Package must target $targetDevice." }
        } finally { $zip.Dispose() }
        $suffix = if ($targetDevice -eq 'watch-square') { '' } else { '-round' }
        $target = Join-Path $release "opengym-watch$suffix-$($manifest.versionName).rpk"
        Copy-Item -LiteralPath $file -Destination $target -Force
        $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$target.sha256", "$digest`n", [Text.UTF8Encoding]::new($false))
        Write-Output "Release: $target"
        Write-Output "SHA256: $digest"
    }
} finally { Pop-Location }
