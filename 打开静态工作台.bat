@echo off
setlocal
if not exist "%~dp0WebDeck.html" (
  echo WebDeck.html is missing. Run the static workbench build BAT first.
  pause
  exit /b 1
)
start "" "%~dp0WebDeck.html"
