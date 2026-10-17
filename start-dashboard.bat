@echo off
chcp 65001 >nul
rem Facade Stone Dashboard launcher (Windows)
cd /d "%~dp0"

if not exist "server.py" goto notextracted
if not exist "data\elements.json" goto notextracted

set "PY="
py -3 --version >nul 2>nul && set "PY=py -3"
if not defined PY python --version >nul 2>nul && set "PY=python"
if not defined PY python3 --version >nul 2>nul && set "PY=python3"
if not defined PY goto nopython

echo Starting the dashboard with %PY% ...
%PY% server.py --open %*
echo.
echo The server stopped. Read the message above.
pause
exit /b

:notextracted
echo ERROR: server.py or the data folder is not here.
echo You are probably running this file from inside the ZIP.
echo Right-click the ZIP ^> Extract All, then open the extracted folder and run start-dashboard.bat again.
echo.
echo ไม่พบไฟล์: น่าจะเปิดจากในไฟล์ ZIP โดยตรง ให้คลิกขวาที่ ZIP ^> Extract All แล้วเปิด start-dashboard.bat จากโฟลเดอร์ที่แตกแล้ว
pause
exit /b 1

:nopython
echo ERROR: Python 3 is not installed (or not on PATH).
echo Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run this file again.
echo.
echo ไม่พบ Python: ติดตั้งจาก https://www.python.org/downloads/ และติ๊ก "Add python.exe to PATH" แล้วเปิดไฟล์นี้อีกครั้ง
start "" https://www.python.org/downloads/
pause
exit /b 1
