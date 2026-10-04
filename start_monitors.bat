@echo off
cd /d C:\Users\vache\claudeverstradingview\claudeverstradingview
start "NASDAQ Monitor" /min cmd /c "node --use-system-ca scripts/nasdaq_monitor.js >> logs/nasdaq_monitor.log 2>&1"
start "FBO Monitor" /min cmd /c "node --use-system-ca scripts/fbo_monitor.js >> logs/fbo_monitor.log 2>&1"
