@echo off
chcp 65001 >nul
reg delete "HKCU\Software\Classes\puentepariz" /f >nul 2>nul
echo Boton "Iniciar puente" desinstalado.
pause
