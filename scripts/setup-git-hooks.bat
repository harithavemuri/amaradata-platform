@echo off
REM Setup script for Git hooks on Windows
REM Run this to enable the pre-commit/post-commit hooks

echo ========================================
echo   Git Hooks Setup
echo ========================================
echo.

cd /d "%~dp0\.."

REM Check if .git directory exists
if not exist ".git" (
    echo Error: Not a git repository!
    echo Please run this from the project root.
    exit /b 1
)

REM Create hooks directory if it doesn't exist
if not exist ".git\hooks" (
    mkdir ".git\hooks"
)

echo Installing pre-commit/post-commit hooks...

REM Git for Windows ships with Git Bash (sh.exe), which runs the same
REM shebang-based hooks as macOS/Linux — no separate PowerShell hooks
REM needed, so this installs the same templates setup-git-hooks.sh does.
copy /Y "scripts\pre-commit.template" ".git\hooks\pre-commit" >nul
if errorlevel 1 (
    echo Error: Could not create pre-commit hook
    exit /b 1
)
copy /Y "scripts\post-commit.template" ".git\hooks\post-commit" >nul
if errorlevel 1 (
    echo Error: Could not create post-commit hook
    exit /b 1
)

echo.
echo ========================================
echo   Git Hooks Setup Complete!
echo ========================================
echo.
echo pre-commit: does nothing (intentional no-op).
echo The full test suite gates real deploys via 'npm run deploy' instead —
echo see scripts\pre-commit.template for why it moved out of this hook.
echo.
echo post-commit: runs 'npm run sync-tenant-fixes' best-effort, after the
echo commit has already landed — never blocks or delays committing.
echo.
echo To bypass a hook (not recommended):
echo   git commit --no-verify
echo.

pause
