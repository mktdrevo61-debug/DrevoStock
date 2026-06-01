@echo off
title Separacao de Pecas Drevo - Servidor
echo ==============================================
echo INICIANDO O SISTEMA DE SEPARACAO DREVO...
echo ==============================================
echo.
echo O seu navegador vai abrir automaticamente.
echo Por favor, NAO FECHE ESTA JANELA PRETA enquanto estiver usando o app!
echo.
cd /d "%~dp0"
start http://localhost:5173
npm run dev -- --host --force
