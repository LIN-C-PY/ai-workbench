@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没有找到 git，请先安装：https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo.
echo   === 1/4 提交全部改动 ===
git add -A
git commit -m "AI Workbench 开源首发"
if errorlevel 1 echo   （没有新改动，跳过提交）

echo.
echo   === 2/4 检查远程仓库 ===
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo.
  echo   还没有配置远程仓库。
  echo   先去 GitHub 新建一个空仓库（不要勾选 README / .gitignore / License），
  echo   然后把它页面上显示的地址粘贴到下面：
  echo.
  set /p REPO_URL=  GitHub 仓库地址: 
  if "!REPO_URL!"=="" (
    echo   没有输入地址，先退出。配置好之后重新双击本文件即可。
    pause
    exit /b 1
  )
  git remote add origin "!REPO_URL!"
)

echo.
echo   === 3/4 切到 main ===
git branch -M main

echo.
echo   === 4/4 推送到 GitHub ===
git push -u origin main
if errorlevel 1 (
  echo.
  echo   [!] 推送失败。常见原因：
  echo       1. 仓库地址写错 / 仓库已有内容
  echo       2. 没有登录 GitHub —— 再执行一次会弹出登录窗口
  echo.
  pause
  exit /b 1
)

echo.
echo   推送完成。
for /f "delims=" %%u in ('git remote get-url origin') do start "" "%%u"
echo.
pause
