@echo off
chcp 65001 >nul
title Puente MQTT - OPEN SOURCE PARIZ
cd /d "%~dp0"
where python >nul 2>nul && (python puente-mqtt.py %* & goto fin)
where py >nul 2>nul && (py -3 puente-mqtt.py %* & goto fin)
echo No se encontro Python. Instalalo desde python.org y marca "Add Python to PATH".
:fin
pause
