@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*puente-mqtt.py*' -and $_.ProcessId -ne $PID -and $_.Name -match '^(pythonw?|pyw?)\.exe$' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'Puente detenido (proceso ' + $_.ProcessId + ')' }"
echo Listo.
pause
