@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  if exist ".env.example" copy ".env.example" ".env" >nul
)
notepad ".env"
