@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === NOFINANCE: instalacao ===
where node >nul 2>&1 || (echo ERRO: Node nao encontrado. Instale o Node 22 ou mais novo. & pause & exit /b 1)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Vai abrir o arquivo .env no Bloco de Notas.
  echo Troque  postgres@  por  postgres:SUA_SENHA@  nas linhas DATABASE_URL e TEST_DATABASE_URL.
  echo Salve, FECHE o Bloco de Notas e a instalacao continua.
  pause
  notepad .env
)
echo.
echo Instalando dependencias...
call npm install --no-audit --no-fund || (echo ERRO no npm install & pause & exit /b 1)
echo.
echo Criando banco e tabelas...
call npm run migrate || (echo ERRO: confira a senha no .env e se o PostgreSQL esta rodando. & pause & exit /b 1)
echo.
echo Instalacao concluida. Para usar, clique duas vezes em iniciar.cmd
pause
