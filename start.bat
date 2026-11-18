@echo off
setlocal
chcp 65001 >nul
title WebDeck Studio
pushd "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/
  pause
  popd
  exit /b 1
)
node scripts\start.mjs %*
set "WDS_EXIT=%ERRORLEVEL%"
if not "%WDS_EXIT%"=="0" pause
popd
exit /b %WDS_EXIT%
