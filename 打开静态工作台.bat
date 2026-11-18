@echo off
setlocal
if not exist "%~dp0WebDeck.html" (
  echo WebDeck.html is missing. Run: npm install ^&^& npm run build:static
  pause
  exit /b 1
)
start "" "%~dp0WebDeck.html"
