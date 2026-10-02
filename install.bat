@echo off
REM ==============================================================================
REM Ollama Lite - Installer for Windows
REM Port of installer.sh: sets up Bun, llama-server (llama.cpp), project deps,
REM CLI wrapper, and user PATH so the project runs on Windows.
REM
REM Usage:
REM   install.bat
REM Run from an ordinary cmd.exe prompt (no admin rights required).
REM Requires Windows 10/11 (curl.exe and tar.exe ship inbox; PowerShell is
REM used as a fallback for download/extract and for the Bun installer).
REM ==============================================================================

setlocal EnableDelayedExpansion

REM ------------------------------------------------------------------------------
REM 0. Resolve locations
REM ------------------------------------------------------------------------------
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "OLLAMA_LITE_HOME=%USERPROFILE%\.ollama-lite"
set "OLLAMA_LITE_BIN=%OLLAMA_LITE_HOME%\bin"
set "BUN_BIN_DIR=%USERPROFILE%\.bun\bin"

echo.
echo =======================================================
echo             Ollama Lite Installation Script
echo                 (Windows ^| install.bat)
echo =======================================================
echo.

REM ------------------------------------------------------------------------------
REM 1. Detect architecture (Windows is the OS; only arch varies)
REM ------------------------------------------------------------------------------
set "ARCH_NAME="
REM PROCESSOR_ARCHITEW6432 is only defined under WOW64 (32-bit cmd on 64-bit
REM Windows) and holds the real OS architecture; prefer it when present.
if /i "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH_NAME=x64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH_NAME=arm64"
if not defined ARCH_NAME (
  if /i "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "ARCH_NAME=x64"
  if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH_NAME=arm64"
)

if not defined ARCH_NAME (
  echo [ERROR] Unsupported architecture: %PROCESSOR_ARCHITECTURE% ^(32-bit Windows has no llama.cpp prebuilt binaries^)
  exit /b 1
)

echo [INFO] Detected Platform: windows-%ARCH_NAME%

REM ------------------------------------------------------------------------------
REM 2. Check / Install Bun
REM ------------------------------------------------------------------------------
echo [INFO] Checking for Bun runtime...

set "BUN_FOUND="
where bun >nul 2>nul
if %ERRORLEVEL%==0 set "BUN_FOUND=1"

if not defined BUN_FOUND (
  if exist "%BUN_BIN_DIR%\bun.exe" (
    set "PATH=%BUN_BIN_DIR%;%PATH%"
    where bun >nul 2>nul
    if !ERRORLEVEL!==0 set "BUN_FOUND=1"
  )
)

if defined BUN_FOUND (
  for /f "delims=" %%V in ('bun --version 2^>nul') do set "BUN_VERSION=%%V"
  for /f "delims=" %%P in ('where bun 2^>nul') do set "BUN_PATH=%%P"
  echo [OK] Found Bun v!BUN_VERSION! at !BUN_PATH!
) else (
  echo [WARN] Bun not found in PATH. Installing Bun...
  where powershell >nul 2>nul
  if %ERRORLEVEL% neq 0 (
    echo [ERROR] PowerShell is required to install Bun on Windows.
    echo         Install Bun manually from https://bun.sh and re-run install.bat.
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
  if %ERRORLEVEL% neq 0 (
    echo [ERROR] Bun installer script failed.
    exit /b 1
  )
  if exist "%BUN_BIN_DIR%\bun.exe" set "PATH=%BUN_BIN_DIR%;%PATH%"
  where bun >nul 2>nul
  if %ERRORLEVEL% neq 0 (
    echo [ERROR] Bun installation finished but 'bun' was not found.
    echo         Check %BUN_BIN_DIR%\bun.exe and your PATH, then re-run install.bat.
    exit /b 1
  )
  for /f "delims=" %%V in ('bun --version 2^>nul') do set "BUN_VERSION=%%V"
  echo [OK] Bun installed successfully: !BUN_VERSION!
)

REM ------------------------------------------------------------------------------
REM 3. Check / Install llama-server (llama.cpp)
REM ------------------------------------------------------------------------------
echo [INFO] Checking for llama-server backend...

set "LLAMA_SERVER_PATH="

REM 3a. Already on PATH? (where honours PATHEXT, so .exe is found)
for /f "delims=" %%P in ('where llama-server.exe 2^>nul') do (
  if not defined LLAMA_SERVER_PATH set "LLAMA_SERVER_PATH=%%P"
)
if not defined LLAMA_SERVER_PATH (
  for /f "delims=" %%P in ('where llama-server 2^>nul') do (
    if not defined LLAMA_SERVER_PATH set "LLAMA_SERVER_PATH=%%P"
  )
)

REM 3b. Well-known locations (Ollama for Windows, previous installs).
if not defined LLAMA_SERVER_PATH (
  for %%C in (
    "%OLLAMA_LITE_BIN%\llama-server.exe"
    "%USERPROFILE%\.local\bin\llama-server.exe"
    "%ProgramFiles%\Ollama\llama-server.exe"
    "%ProgramFiles%\llama.cpp\llama-server.exe"
    "%LocalAppData%\Programs\Ollama\llama-server.exe"
  ) do (
    if not defined LLAMA_SERVER_PATH (
      if exist %%C set "LLAMA_SERVER_PATH=%%~C"
    )
  )
)

if defined LLAMA_SERVER_PATH (
  echo [OK] Found llama-server at: !LLAMA_SERVER_PATH!
) else (
  echo [WARN] llama-server not found on system.
  echo [INFO] Downloading prebuilt llama.cpp release for windows-!ARCH_NAME! ^(CPU^)...

  if not exist "%OLLAMA_LITE_BIN%" mkdir "%OLLAMA_LITE_BIN%"
  set "TMP_DIR=%TEMP%\ollama-lite-%RANDOM%%RANDOM%"
  if exist "!TMP_DIR!" rmdir /s /q "!TMP_DIR!"
  mkdir "!TMP_DIR!"

  REM Resolve the nightly release tag (bXXXX). NOTE: stable v-tags ship NO
  REM binaries - only nightly b-tags carry bin-win-*.zip assets - so the
  REM /releases/latest redirect (a v-tag) is useless here. The stable
  REM release publishes a nightly-tag.txt pointer to its paired nightly.
  set "RELEASE_TAG="
  where curl.exe >nul 2>nul
  if !ERRORLEVEL!==0 (
    curl.exe -fsSL "https://github.com/ggml-org/llama.cpp/releases/latest/download/nightly-tag.txt" -o "!TMP_DIR!\nightly-tag.txt" 2>nul
    if exist "!TMP_DIR!\nightly-tag.txt" (
      for /f "usebackq delims=" %%T in ("!TMP_DIR!\nightly-tag.txt") do (
        if not defined RELEASE_TAG set "RELEASE_TAG=%%T"
      )
    )
  )
  if not defined RELEASE_TAG (
    echo [INFO] nightly-tag.txt unavailable, querying GitHub API for latest nightly...
    where curl.exe >nul 2>nul
    if !ERRORLEVEL!==0 (
      for /f "tokens=2 delims=:," %%T in ('curl.exe -s "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20" 2^>NUL ^| findstr "tag_name"') do (
        set "RAW=%%T"
        set "RAW=!RAW: =!"
        set RAW=!RAW:"=!
        if not defined RELEASE_TAG (
          echo !RAW! | findstr /r /c:"^b[0-9][0-9]*" >nul
          if !ERRORLEVEL!==0 set "RELEASE_TAG=!RAW!"
        )
      )
    )
  )
  if not defined RELEASE_TAG (
    echo [INFO] Trying /releases/latest redirect as last resort...
    where curl.exe >nul 2>nul
    if !ERRORLEVEL!==0 (
      for /f "delims=" %%U in ('curl.exe -sIL -o NUL -w "%%{url_effective}" https://github.com/ggml-org/llama.cpp/releases/latest 2^>NUL') do set "EFFECTIVE_URL=%%U"
      if defined EFFECTIVE_URL (
        REM Tag is the text after the last "/" of the redirect URL.
        call :LastPathSegment "!EFFECTIVE_URL!" RELEASE_TAG
        if "!RELEASE_TAG!"=="latest" set "RELEASE_TAG="
      )
    )
  )

  if not defined RELEASE_TAG (
    echo [WARN] Could not determine latest llama.cpp release tag.
    echo        Install llama.cpp or Ollama for Windows manually, then re-run install.bat.
    echo        See https://github.com/ggml-org/llama.cpp/releases
  ) else (
    echo [INFO] Latest llama.cpp nightly: !RELEASE_TAG!
    set "DOWNLOAD_URL=https://github.com/ggml-org/llama.cpp/releases/download/!RELEASE_TAG!/llama-!RELEASE_TAG!-bin-win-cpu-!ARCH_NAME!.zip"
    echo [INFO] Downloading from: !DOWNLOAD_URL!
    set "ZIP_FILE=!TMP_DIR!\llama.zip"
    set "DL_OK="
    where curl.exe >nul 2>nul
    if !ERRORLEVEL!==0 (
      curl.exe -fSL "!DOWNLOAD_URL!" -o "!ZIP_FILE!"
      if !ERRORLEVEL!==0 set "DL_OK=1"
    )
    if not defined DL_OK (
      echo [INFO] curl failed, retrying with PowerShell...
      powershell -NoProfile -Command "Invoke-WebRequest -Uri '!DOWNLOAD_URL!' -OutFile '!ZIP_FILE!'"
      if !ERRORLEVEL!==0 set "DL_OK=1"
    )
    if not defined DL_OK (
      echo [WARN] Automatic download of llama-server failed. Install llama.cpp or Ollama manually.
    ) else (
      REM Extract: prefer inbox tar (bsdtar handles .zip), fall back to Expand-Archive.
      set "EXTRACTED="
      where tar.exe >nul 2>nul
      if !ERRORLEVEL!==0 (
        tar.exe -xf "!ZIP_FILE!" -C "!TMP_DIR!"
        if !ERRORLEVEL!==0 set "EXTRACTED=1"
      )
      if not defined EXTRACTED (
        powershell -NoProfile -Command "Expand-Archive -Path '!ZIP_FILE!' -DestinationPath '!TMP_DIR!\unzipped' -Force"
        if !ERRORLEVEL!==0 (
          set "EXTRACTED=1"
          set "TMP_DIR=!TMP_DIR!\unzipped"
        )
      )
      if not defined EXTRACTED (
        echo [WARN] Could not extract llama.cpp archive.
      ) else (
        set "SERVER_FILE="
        for /f "delims=" %%F in ('dir /b /s "!TMP_DIR!\llama-server.exe" 2^>nul') do (
          if not defined SERVER_FILE set "SERVER_FILE=%%F"
        )
        if not defined SERVER_FILE (
          echo [WARN] Could not locate 'llama-server.exe' inside extracted archive.
        ) else (
          for %%D in ("!SERVER_FILE!") do set "EXTRACTED_DIR=%%~dpD"
          REM Copy the server plus companion DLLs/runtime files.
          xcopy "!EXTRACTED_DIR!*" "%OLLAMA_LITE_BIN%\" /E /I /Y /Q
          set "LLAMA_SERVER_PATH=%OLLAMA_LITE_BIN%\llama-server.exe"
          echo [OK] llama-server and shared runtime libraries installed to %OLLAMA_LITE_BIN%
        )
      )
    )
  )

  REM Best-effort temp cleanup (keep going even if locked).
  REM NOTE: `if exist` takes no wildcards, so guard on the variable instead.
  if defined TMP_DIR (
    set "CLEAN_DIR=!TMP_DIR!"
    REM If we descended into \unzipped, clean the parent.
    echo !CLEAN_DIR! | findstr /i /c:"unzipped" >nul && for %%P in ("!CLEAN_DIR!\..") do set "CLEAN_DIR=%%~fP"
    if exist "!CLEAN_DIR!" rmdir /s /q "!CLEAN_DIR!" 2>nul
  )
  if not defined LLAMA_SERVER_PATH (
    echo [WARN] Continuing without llama-server. Cloud models still work; local GGUF inference needs llama-server.exe.
  )
)

REM ------------------------------------------------------------------------------
REM 4. Install project dependencies and prepare directories
REM ------------------------------------------------------------------------------
echo [INFO] Installing project dependencies with Bun...
cd /d "%SCRIPT_DIR%"
call bun install
if %ERRORLEVEL% neq 0 (
  echo [ERROR] 'bun install' failed.
  exit /b 1
)

if not exist "%OLLAMA_LITE_HOME%\models\manifests" mkdir "%OLLAMA_LITE_HOME%\models\manifests"
if not exist "%OLLAMA_LITE_HOME%\models\blobs" mkdir "%OLLAMA_LITE_HOME%\models\blobs"
if not exist "%OLLAMA_LITE_HOME%\runtime" mkdir "%OLLAMA_LITE_HOME%\runtime"
if not exist "%OLLAMA_LITE_BIN%" mkdir "%OLLAMA_LITE_BIN%"

REM Repo-local Windows launcher so `bin\ollama-lite.bat <args>` works without install.
REM (The committed `bin/ollama-lite` bash script stays untouched for Unix.)
(
  echo @echo off
  echo REM Local launcher - no install required. Forwards to Bun entrypoint.
  echo set "ROOT=%%~dp0.."
  echo where bun ^>nul 2^>nul
  echo if errorlevel 1 ^(
  echo   if exist "%%USERPROFILE%%\.bun\bin\bun.exe" set "PATH=%%USERPROFILE%%\.bun\bin;%%PATH%%"
  echo ^)
  echo bun "%%ROOT%%\src\index.ts" %%*
) > "%SCRIPT_DIR%\bin\ollama-lite.bat"

REM ------------------------------------------------------------------------------
REM 5. Install CLI wrapper
REM ------------------------------------------------------------------------------
echo [INFO] Setting up 'ollama-lite' CLI executable...

if exist "%OLLAMA_LITE_BIN%\ollama-lite.bat" del "%OLLAMA_LITE_BIN%\ollama-lite.bat"
if exist "%BUN_BIN_DIR%\ollama-lite.bat" del "%BUN_BIN_DIR%\ollama-lite.bat"

REM Wrapper hard-codes the project dir captured at install time.
(
  echo @echo off
  echo REM Generated by install.bat - forwards to the Ollama Lite Bun entrypoint.
  echo set "PROJECT_DIR=%SCRIPT_DIR%"
  echo where bun ^>nul 2^>nul
  echo if errorlevel 1 ^(
  echo   if exist "%%USERPROFILE%%\.bun\bin\bun.exe" set "PATH=%%USERPROFILE%%\.bun\bin;%%PATH%%"
  echo ^)
  echo bun "%%PROJECT_DIR%%\src\index.ts" %%*
) > "%OLLAMA_LITE_BIN%\ollama-lite.bat"

REM Also drop a copy next to Bun when that dir exists, mirroring installer.sh.
if exist "%BUN_BIN_DIR%" (
  copy /y "%OLLAMA_LITE_BIN%\ollama-lite.bat" "%BUN_BIN_DIR%\ollama-lite.bat" >nul
)

REM ------------------------------------------------------------------------------
REM 6. Ensure PATH configuration
REM ------------------------------------------------------------------------------
REM Current session first so verification below works immediately.
echo %PATH% | findstr /i /c:"%OLLAMA_LITE_BIN%" >nul
if %ERRORLEVEL% neq 0 set "PATH=%OLLAMA_LITE_BIN%;%PATH%"
echo %PATH% | findstr /i /c:"%BUN_BIN_DIR%" >nul
if %ERRORLEVEL% neq 0 (
  if exist "%BUN_BIN_DIR%" set "PATH=%BUN_BIN_DIR%;%PATH%"
)

REM Persist for future terminals via setx (user-level, no admin needed).
REM setx truncates very long PATH values, so only update when our dirs are missing.
set "NEEDS_PATH_UPDATE="
echo %PATH% | findstr /i /c:"ollama-lite" >nul
if %ERRORLEVEL% neq 0 set "NEEDS_PATH_UPDATE=1"

if defined NEEDS_PATH_UPDATE (
  echo [INFO] Adding %OLLAMA_LITE_BIN% to user PATH with setx...
  REM Query the stored user PATH (not the merged session PATH) to avoid doubling system entries.
  set "REG_PATH="
  for /f "tokens=2*" %%A in ('reg query HKCU\Environment /v Path 2^>nul ^| findstr /i /c:"Path"') do set "REG_PATH=%%B"
  if not defined REG_PATH set "REG_PATH=%PATH%"
  echo !REG_PATH! | findstr /i /c:"%OLLAMA_LITE_BIN%" >nul
  if !ERRORLEVEL! neq 0 (
    set "NEW_PATH=%OLLAMA_LITE_BIN%;!REG_PATH!"
    echo !NEW_PATH! | findstr /i /c:"%BUN_BIN_DIR%" >nul
    if !ERRORLEVEL! neq 0 (
      if exist "%BUN_BIN_DIR%" set "NEW_PATH=%BUN_BIN_DIR%;!NEW_PATH!"
    )
    setx Path "!NEW_PATH!" >nul
    if !ERRORLEVEL!==0 (
      echo [INFO] User PATH updated. Open a NEW terminal to pick it up.
    ) else (
      echo [WARN] setx failed (PATH may exceed its length limit).
      echo        Add this manually: %OLLAMA_LITE_BIN%
    )
  )
) else (
  echo [INFO] PATH already contains ollama-lite entry.
)

REM ------------------------------------------------------------------------------
REM 7. Verification
REM ------------------------------------------------------------------------------
echo [INFO] Verifying installation...

set "CLI_VER=v0.1.0"
where ollama-lite >nul 2>nul
if %ERRORLEVEL%==0 (
  for /f "delims=" %%V in ('ollama-lite version 2^>nul') do set "CLI_VER=%%V"
  echo [SUCCESS] Ollama Lite is installed and ready ^(!CLI_VER!^)!
) else (
  echo [WARN] 'ollama-lite' not yet on PATH for this shell; wrapper is at %OLLAMA_LITE_BIN%\ollama-lite.bat
  echo        Open a NEW terminal, or run: set "PATH=%OLLAMA_LITE_BIN%;%%PATH%%"
)

echo.
echo =======================================================
echo              Installation Completed!
echo =======================================================
echo.
echo Quick Start Commands:
echo   ollama-lite run llama3.2:1b             # Run Hugging Face model
echo   ollama-lite run ollama:deepseek-r1:8b   # Run official Ollama model
echo   ollama-lite import-ollama                 # Import existing ~/.ollama models
echo   ollama-lite pull smollm:135m              # Download model
echo   ollama-lite list                        # List installed models
echo   ollama-lite serve                       # Start HTTP API server (11434)
echo   ollama-lite serve end                   # Stop HTTP API server
echo   ollama-lite benchmark llama3.2:1b       # Run inference benchmark
echo.
echo If 'ollama-lite' is not recognized, open a NEW terminal
echo ^(setx changes apply only to new shells^).
echo.
endlocal
exit /b 0

REM ------------------------------------------------------------------------------
REM Helper: extract last "/"-separated segment of a URL into %2.
REM Usage: call :LastPathSegment "https://.../tag/b12345" OUTVAR
REM ------------------------------------------------------------------------------
:LastPathSegment
REM %1 = URL, %2 = output var name. Takes substring after final "/".
set "_str=%~1"
set "_str=%_str:/= %"
set "_last="
for %%S in (%_str%) do set "_last=%%S"
set "%2=%_last%"
exit /b 0
