@echo off
setlocal
pushd "%~dp0" || exit /b 1

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/
  goto :failed
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd is missing. Reinstall Node.js with npm enabled.
  goto :failed
)

call npm.cmd ls --depth=0 --include=dev >nul 2>nul
if errorlevel 1 (
  call npm.cmd ci --include=dev --no-audit --no-fund
  if errorlevel 1 goto :failed
)
if not exist "app\vendor\katex\katex.min.css" (
  node scripts\sync-vendor.mjs
  if errorlevel 1 goto :failed
)
call npm.cmd run build:static
if errorlevel 1 goto :failed
echo.
echo Built "%CD%\WebDeck.html"
popd
pause
exit /b 0

:failed
echo.
echo Static workbench build failed. See the message above.
popd
pause
exit /b 1
