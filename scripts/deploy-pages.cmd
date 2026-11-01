@echo off
setlocal
cd /d "%~dp0.."

set "GIT=git"
where git >nul 2>nul || set "GIT=C:\Program Files\Git\cmd\git.exe"

echo [1/3] Building web\vendor\dota-core.js
call "node_modules\.bin\esbuild.cmd" core\browser.js --bundle --format=iife --global-name=DotaCore --outfile=web\vendor\dota-core.js --minify
if errorlevel 1 exit /b 1

echo [2/3] Checking remote origin
"%GIT%" remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo No remote "origin". Add it first:
  echo   git remote add origin https://github.com/USER/REPO.git
  exit /b 1
)

echo [3/3] Publishing web\ to branch gh-pages
"%GIT%" subtree push --prefix web origin gh-pages
if errorlevel 1 (
  echo.
  echo If gh-pages already exists and diverged, recreate it:
  echo   git push origin --delete gh-pages
  echo   scripts\deploy-pages.cmd
  exit /b 1
)

echo.
echo Done. Enable Pages: Settings, Pages, Deploy from a branch, gh-pages / root
