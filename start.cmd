@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "AIWB_PORT=4317"
if not "%PORT%"=="" set "AIWB_PORT=%PORT%"
set "AIWB_URL=http://127.0.0.1:%AIWB_PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没有找到 Node.js，请先安装 Node 18 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem 已经在运行就直接打开浏览器，不重复起服务
netstat -ano | findstr /R /C:"127.0.0.1:%AIWB_PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo   AI Workbench 已经在运行，正在打开浏览器...
  echo   %AIWB_URL%
  echo.
  start "" "%AIWB_URL%"
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo   AI Workbench 正在启动...
echo   界面地址   %AIWB_URL%
echo   关闭本窗口即退出工作台（Ctrl+C 也可以）。
echo.

rem 服务就绪后自动打开浏览器
start "" /b node "tools\open-when-ready.mjs" "%AIWB_URL%"

node "server\index.mjs"
if errorlevel 1 (
  echo.
  echo   [!] 工作台异常退出，上面是错误信息。
  pause
)
