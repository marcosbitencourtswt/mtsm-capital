@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo NOFINANCE rodando. Teste no navegador: http://localhost:3333/api/v1/personal/dashboard
echo Para parar: feche esta janela.
call npm run dev
pause
