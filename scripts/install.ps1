# OMP Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1))) -Binary -Ref omp-cn-v17.2.12

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = if ($env:OMP_REPO) { $env:OMP_REPO } else { "yequ172672/oh-my-pi-cn" }
$Package = if ($env:OMP_PACKAGE) { $env:OMP_PACKAGE } else { "omp-cn" }
$DefaultRef = if ($env:OMP_REF) { $env:OMP_REF } else { "main" }
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$SourceDir = if ($env:OMP_SOURCE_DIR) { $env:OMP_SOURCE_DIR } else { "$env:LOCALAPPDATA\omp-cn\source" }
$BinaryName = "omp-windows-x64.exe"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new. ConvertFrom-Json -AsHashtable
            # requires PowerShell 6+; build the hashtable manually so Windows
            # PowerShell 5.1 merges instead of clobbering existing settings.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $settings[$prop.Name] = $prop.Value
                    }
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "No bash shell found - OMP will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Or set a custom path in:" -ForegroundColor Cyan
            Write-Host "    $settingsFile" -ForegroundColor Cyan
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Cyan
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Install-FromSource {
    param([string]$SourceRef)

    if (-not (Test-GitInstalled)) {
        throw "git is required for source installation"
    }

    $stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-install-" + [System.Guid]::NewGuid().ToString("N"))
    $cloneDir = Join-Path $stageRoot "repo"
    New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

    try {
        $repoUrl = "https://github.com/$Repo.git"
        $cloneOk = $false
        try {
            git clone --depth 1 --branch $SourceRef $repoUrl $cloneDir | Out-Null
            $cloneOk = ($LASTEXITCODE -eq 0)
        } catch {
            $cloneOk = $false
        }

        if (-not $cloneOk) {
            Remove-Item -Recurse -Force $cloneDir -ErrorAction SilentlyContinue
            git clone $repoUrl $cloneDir | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to clone $repoUrl"
            }
            Push-Location $cloneDir
            try {
                git checkout $SourceRef | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to checkout $SourceRef"
                }
            } finally {
                Pop-Location
            }
        }

        # Pull LFS files
        if (Test-GitLfsInstalled) {
            Push-Location $cloneDir
            try {
                git lfs pull | Out-Null
            } finally {
                Pop-Location
            }
        }

        $stagedPackagePath = Join-Path $cloneDir "packages\coding-agent"
        if (-not (Test-Path $stagedPackagePath)) {
            throw "Expected package at $stagedPackagePath"
        }

        Push-Location $cloneDir
        try {
            $sourceCommit = (git rev-parse HEAD).Trim()
        } finally {
            Pop-Location
        }
        if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-fA-F]+$') {
            throw "Failed to resolve the source commit"
        }

        New-Item -ItemType Directory -Force -Path $SourceDir | Out-Null
        $sourceTarget = Join-Path $SourceDir $sourceCommit
        if (-not (Test-Path $sourceTarget)) {
            Move-Item -LiteralPath $cloneDir -Destination $sourceTarget
        }

        Write-Host "Installing workspace dependencies in $sourceTarget..."
        Push-Location $sourceTarget
        try {
            bun install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install source workspace dependencies"
            }
        } finally {
            Pop-Location
        }

        $packagePath = Join-Path $sourceTarget "packages\coding-agent"
        bun "--cwd=$packagePath" link
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to link coding-agent from $sourceTarget"
        }

        Write-Host ""
        Write-Host "[OK] Installed omp from source ref $SourceRef" -ForegroundColor Green
        Write-Host "Source checkout: $sourceTarget"
        Configure-BashShell
        Write-Host "Run 'omp' to get started!"
    } finally {
        Remove-Item -Recurse -Force $stageRoot -ErrorAction SilentlyContinue
    }
}

function Install-Package {
    Write-Host "Installing via bun..."
    bun install -g $Package
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install $Package from npm. Check network access and whether the requested version is published."
    }

    Write-Host ""
    Write-Host "[OK] Installed omp via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'omp' to get started!"
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref" -TimeoutSec 60
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 60
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"
    if ($Latest -match '^omp-cn-v(.+)$') {
        $ExpectedVersion = $Matches[1]
    } elseif ($Latest -match '^v(.+)$') {
        $ExpectedVersion = $Matches[1]
    } else {
        throw "Unsupported release tag format: $Latest"
    }
    if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Unsupported stable release version in tag: $Latest"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $asset = $Release.assets | Where-Object { $_.name -eq $BinaryName } | Select-Object -First 1
    if (-not $asset -or -not $asset.browser_download_url) {
        throw "Release $Latest does not contain the required asset $BinaryName"
    }
    $checksumAsset = $Release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
    if (-not $checksumAsset -or -not $checksumAsset.browser_download_url) {
        throw "Release $Latest does not contain SHA256SUMS.txt"
    }

    # Download and validate beside the destination, then atomically replace the
    # installed command. A failed update must preserve the previous executable.
    $BinaryUrl = $asset.browser_download_url
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "omp.exe"
    $TempPath = Join-Path $InstallDir (".omp-download-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
    $ChecksumPath = Join-Path $InstallDir (".omp-checksums-" + [System.Guid]::NewGuid().ToString("N") + ".txt")
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $TempPath -TimeoutSec 900
        Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $ChecksumPath -TimeoutSec 60
        $escapedBinaryName = [Regex]::Escape($BinaryName)
        $checksumLine = Get-Content -LiteralPath $ChecksumPath | Where-Object {
            $_ -match "^([0-9a-fA-F]{64})\s+\*?$escapedBinaryName$"
        } | Select-Object -First 1
        if (-not $checksumLine) {
            throw "SHA256SUMS.txt does not contain $BinaryName"
        }
        $expectedSha = ([Regex]::Match($checksumLine, '^([0-9a-fA-F]{64})')).Groups[1].Value.ToLowerInvariant()
        $actualSha = (Get-FileHash -LiteralPath $TempPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSha -ne $expectedSha) {
            throw "SHA-256 verification failed for $BinaryName"
        }
        $smokeOutput = & $TempPath --version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Downloaded $BinaryName cannot start: $($smokeOutput -join [Environment]::NewLine)"
        }
        $reportedVersion = ($smokeOutput | Out-String).Trim()
        if ($reportedVersion -ne "omp/$ExpectedVersion") {
            throw "Downloaded $BinaryName reports '$reportedVersion', expected 'omp/$ExpectedVersion'"
        }
        [System.IO.File]::Move($TempPath, $OutPath, $true)
    } finally {
        Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ChecksumPath -Force -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    $sourceRef = if ($Ref) { $Ref } else { $DefaultRef }
    Install-FromSource $sourceRef
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available, otherwise binary
    if (Test-BunInstalled) {
        Assert-BunVersion $MinimumBunVersion
        Install-Package
    } else {
        try {
            Install-Binary
        } catch {
            Write-Host "[WARN] No usable release binary was found; falling back to the $Package npm package." -ForegroundColor Yellow
            Write-Host "       $($_.Exception.Message)" -ForegroundColor Yellow
            Install-Bun
            Assert-BunVersion $MinimumBunVersion
            Install-Package
        }
    }
}
