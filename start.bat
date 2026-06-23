@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 serve.py --open maker
) else (
  python serve.py --open maker
)
pause
