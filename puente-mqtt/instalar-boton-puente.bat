@echo off
chcp 65001 >nul
title Instalar el boton "Iniciar puente"
cd /d "%~dp0"
echo.
echo  Instalacion del boton "Iniciar puente" (OPEN SOURCE PARIZ)
echo  ----------------------------------------------------------
if not exist "%~dp0puente-mqtt.py" (
  echo  ERROR: falta puente-mqtt.py en esta carpeta.
  goto fin
)
if not exist "%~dp0lanzar-puente.vbs" (
  echo  ERROR: falta lanzar-puente.vbs en esta carpeta.
  goto fin
)
where python >nul 2>nul || where py >nul 2>nul || (
  echo  AVISO: no se encontro Python. Instalalo desde python.org y marca "Add Python to PATH".
)
reg add "HKCU\Software\Classes\puentepariz" /ve /d "URL:Puente OPEN SOURCE PARIZ" /f >nul
reg add "HKCU\Software\Classes\puentepariz" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\puentepariz\shell\open\command" /ve /d "\"%SystemRoot%\System32\wscript.exe\" \"%~dp0lanzar-puente.vbs\" \"%%1\"" /f >nul
if errorlevel 1 (
  echo  ERROR: no se pudo escribir el registro de Windows.
  goto fin
)
echo.
echo  Listo. Ya podes usar el boton "Iniciar puente" del portal.
echo  - No muevas esta carpeta. Si la movés, ejecuta este archivo de nuevo.
echo  - La primera vez, el navegador pregunta si abre "Puente OPEN SOURCE PARIZ": toca Abrir.
echo  - Para cerrar el puente: detener-puente.bat
echo  - Para desinstalar el boton: desinstalar-boton-puente.bat
:fin
echo.
pause
