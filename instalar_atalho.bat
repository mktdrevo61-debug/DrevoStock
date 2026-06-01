@echo off
title Instalar Atalho Drevo
echo ==============================================
echo INSTALANDO ATALHO NA AREA DE TRABALHO...
echo ==============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$WshShell = New-Object -ComObject WScript.Shell; $Desktop = [System.Environment]::GetFolderPath('Desktop'); $Shortcut = $WshShell.CreateShortcut(\"$Desktop\Separacao de Pecas Drevo.lnk\"); $Shortcut.TargetPath = '%~dp0Executar Servidor.bat'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.IconLocation = '%~dp0public\icon.ico'; $Shortcut.Save();"
echo.
echo ==============================================
echo Concluido! O atalho "Separacao de Pecas Drevo" com o icone
echo da empresa foi criado com sucesso na sua Area de Trabalho.
echo ==============================================
echo.
pause
