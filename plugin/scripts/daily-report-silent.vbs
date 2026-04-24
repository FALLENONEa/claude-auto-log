Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """node"" ""%~dp0daily-report.js""", 0, False
