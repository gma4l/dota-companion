@echo off
cd /d "%~dp0"

rem ── Проверка окружения ──────────────────────────────
setlocal

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Ошибка: node не найден. Установите Node.js с https://nodejs.org/ и перезапустите окно.
    pause
    exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% lss 18 (
    echo Ошибка: требуется Node.js >= 18 (тебе %NODE_MAJOR%). Обновите Node.js.
    pause
    exit /b 1
)

echo Node.js %NODE_MAJOR% найден.
echo.

rem ── Настройки Ollama ────────────────────────────────
rem Стандартный порт Ollama — 11434; сервер также проверит старый порт 11437
set OLLAMA_URL=http://127.0.0.1:11434
set COACH_MODEL=qwen3:8b
rem Параметры AI: подробный ответ при умеренном расходе ОЗУ
set COACH_KEEP_ALIVE=5m
set COACH_NUM_CTX=4096
set COACH_NUM_PREDICT=1200
set PORT=8080

echo Запуск Dota 2 Анализатора...
echo   Сайт: http://localhost:8080
echo   Ollama: %OLLAMA_URL%
echo   Модель: %COACH_MODEL%
echo.
node server.js

echo.
echo Сервер остановлен.
pause
