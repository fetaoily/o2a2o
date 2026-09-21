# O2A2O (Windows)

## Install

From this folder, in PowerShell:

    powershell -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath

This copies `o2a2o.exe` into `%LOCALAPPDATA%\Programs\o2a2o` and, with
`-AddToPath`, appends that folder to your user PATH. No administrator
rights are required.

## Next steps

    o2a2o config init > o2a2o.yaml
    o2a2o serve --config o2a2o.yaml
