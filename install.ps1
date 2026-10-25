# aihub-code installer for Windows 10/11.
#
#   irm https://raw.githubusercontent.com/marceljurgiel/aihub-code/main/install.ps1 | iex
#
# Installs aihub-code without administrator rights, in its own Python
# environment: uv (Python 3.12), aihub-code and the AIhub engine it builds on
# (needs git), plus an `aihub-code` command. It reads your AIhub settings
# (%USERPROFILE%\.aihub) and never touches them. Re-running it updates.
#
# Optional, set first:
#   $env:AIHUB_CODE_HOME   = "<dir>"                default: %LOCALAPPDATA%\AIhubCode
#   $env:AIHUB_CODE_SOURCE = "<zip url or path>"    install from somewhere else
#   $env:AIHUB_CODE_REF    = "<branch or tag>"      default: main

function Install-AIhubCode {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $Repo = "marceljurgiel/aihub-code"
    $Ref = if ($env:AIHUB_CODE_REF) { $env:AIHUB_CODE_REF } else { "main" }
    $Source = if ($env:AIHUB_CODE_SOURCE) { $env:AIHUB_CODE_SOURCE } else { "https://github.com/$Repo/archive/refs/heads/$Ref.zip" }
    $InstallerUrl = "https://raw.githubusercontent.com/$Repo/main/install.ps1"
    $CodeHome = if ($env:AIHUB_CODE_HOME) { $env:AIHUB_CODE_HOME } else { Join-Path $env:LOCALAPPDATA "AIhubCode" }
    $Py = Join-Path $CodeHome ".venv\Scripts\python.exe"

    function Step($t) { Write-Host ""; Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $t }
    function Ok($t) { Write-Host "  + " -ForegroundColor Green -NoNewline; Write-Host $t }
    function Warn($t) { Write-Host "  ! " -ForegroundColor Yellow -NoNewline; Write-Host $t }
    function Run {
        # Native tools write progress to stderr; only the exit code means failure.
        $ErrorActionPreference = "Continue"
        $exe, $rest = $args
        & $exe @rest 2>&1 | ForEach-Object { "$_" } | Out-Null
        return $LASTEXITCODE -eq 0
    }

    Write-Host "aihub-code installer " -NoNewline; Write-Host "- a coding agent for local and cloud models" -ForegroundColor DarkGray

    # 1. The source
    Step "Downloading aihub-code"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required (the AIhub engine is installed from GitHub)" }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("aihub-code-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp "src.zip"
        if (Test-Path $Source) { Copy-Item $Source $zip } else { Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $zip }
        Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "x") -Force
        $src = Get-ChildItem (Join-Path $tmp "x") -Directory | Select-Object -First 1
        if (-not $src -or -not (Test-Path (Join-Path $src.FullName "pyproject.toml"))) {
            throw "the download does not look like aihub-code: $Source"
        }
        # Update: move the old install aside first (nothing changes if that
        # fails), keep its Python environment and launcher.
        if (Test-Path $CodeHome) {
            $old = "$CodeHome.old-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
            try { Rename-Item -Path $CodeHome -NewName (Split-Path $old -Leaf) -ErrorAction Stop }
            catch { throw "aihub-code is in use. Close it, then run the installer again. Nothing was changed." }
            foreach ($keep in @(".venv", "bin")) {
                $from = Join-Path $old $keep
                if (Test-Path $from) { Move-Item $from (Join-Path $src.FullName $keep) }
            }
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $CodeHome) | Out-Null
        Move-Item $src.FullName $CodeHome
        Get-ChildItem (Split-Path $CodeHome) -Directory -Filter ((Split-Path $CodeHome -Leaf) + ".old-*") |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
    $version = (Select-String -Path (Join-Path $CodeHome "pyproject.toml") -Pattern '^version\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
    Ok "aihub-code $version -> $CodeHome"

    # 2. Python environment (uv brings its own Python)
    Step "Python environment"
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if (-not $uv) { $uv = Join-Path $HOME ".local\bin\uv.exe" }
    if (-not (Test-Path $uv)) {
        $env:UV_NO_MODIFY_PATH = "1"
        $ErrorActionPreference = "Continue"
        & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" *>&1 | Out-Null
        $ErrorActionPreference = "Stop"
        $uv = Join-Path $HOME ".local\bin\uv.exe"
        if (-not (Test-Path $uv)) { throw "could not install uv" }
        Ok "uv installed"
    }
    if (-not (Test-Path $Py)) {
        if (-not (Run $uv venv -q --python 3.12 (Join-Path $CodeHome ".venv"))) { throw "could not create the Python environment" }
    }
    if (-not (Run $uv pip install -q --python $Py -e $CodeHome)) { throw "could not install aihub-code and the AIhub engine" }
    Ok ("aihub-code " + (& $Py -c "import aihub_code; print(aihub_code.__version__)") + ", AIhub engine " + (& $Py -c "import aihub; print(aihub.__version__)"))

    # 3. Launcher
    Step "Launcher"
    $binDir = Join-Path $CodeHome "bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $cmd = @"
@echo off
rem aihub-code launcher (written by install.ps1). Re-run the installer to update.
setlocal
set "AIHUB_CODE_HOME=$CodeHome"
if /i "%~1"=="update" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm $InstallerUrl | iex"
  exit /b %errorlevel%
)
"%AIHUB_CODE_HOME%\.venv\Scripts\aihub-code.exe" %*
exit /b %errorlevel%
"@
    $launcher = Join-Path $binDir "aihub-code.cmd"
    if (Test-Path $launcher) { Remove-Item -Force $launcher }
    Set-Content -Path $launcher -Value $cmd -Encoding Ascii
    Ok $launcher

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    if (($userPath -split ";") -notcontains $binDir) {
        [Environment]::SetEnvironmentVariable("Path", ($binDir + ";" + $userPath).TrimEnd(";"), "User")
        Ok "added $binDir to your PATH"
    }
    if (($env:Path -split ";") -notcontains $binDir) { $env:Path = "$binDir;$env:Path" }

    Write-Host ""
    Write-Host "aihub-code $version is installed." -ForegroundColor Green
    Write-Host "  In a project folder: aihub-code -p `"your task`"   (update later with 'aihub-code update')"
}

try {
    Install-AIhubCode
} catch {
    Write-Host ""
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
}
