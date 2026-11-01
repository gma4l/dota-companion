@echo off
rem Публикация статической версии на GitHub Pages (ветка gh-pages).
rem Запускать из корня репозитория:  scripts\deploy-pages.cmd

cd /d "%~dp0.."

echo [1/2] Сборка web\vendor\dota-core.js
call node_modules\.bin\esbuild.cmd core\browser.js --bundle --format=iife --global-name=DotaCore --outfile=web\vendor\dota-core.js --minify
if errorlevel 1 exit /b 1

echo [2/2] Отправка web\ в ветку gh-pages
git subtree push --prefix web origin gh-pages
if errorlevel 1 (
  echo.
  echo Если ветка уже существует и разошлась — перезапиши её:
  echo   git push origin --delete gh-pages
  echo   scripts\deploy-pages.cmd
  exit /b 1
)

echo.
echo Готово. Включи Pages: Settings -^> Pages -^> Deploy from a branch -^> gh-pages / root
