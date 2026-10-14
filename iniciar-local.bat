@echo off
cd /d "%~dp0"
echo Abriendo la app en http://localhost:5500  (cierra esta ventana para detenerla)
start "" http://localhost:5500/index.html
python -m http.server 5500 || py -m http.server 5500
pause
