@echo off
chcp 65001 > nul
title 이거돼? — GitHub 자동 배포

cd C:\Users\vh132\Downloads\igodae

echo [Git] 변경된 파일:
git status --short
echo.

set /p COMMIT_MSG="커밋 메시지 입력 (엔터 = 자동 메시지): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=chore: auto deploy

git add -A
git commit -m "%COMMIT_MSG%"
git push origin main
if %errorlevel% neq 0 ( echo [오류] git push 실패 & pause & exit /b 1 )

echo.
echo   GitHub   : https://github.com/Igodae/igodae
echo   배포 URL : https://wine-beta.vercel.app
echo.
pause