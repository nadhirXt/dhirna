<#
.SYNOPSIS
    Dhirna Emergency Kill & Recovery Script (Windows).
.DESCRIPTION
    Removes Dhirna autostart registry keys, terminates all dhirna-desktop.exe
    processes, removes the watchdog lockfile, and optionally restores Windows hosts and DNS settings.
.EXAMPLE
    pwsh -File .\scripts\kill.ps1
    pwsh -File .\scripts\kill.ps1 -RestoreDns
    pwsh -File .\scripts\kill.ps1 -DryRun
#>
param(
    [switch]$DryRun,
    [switch]$RestoreDns
)

$ErrorActionPreference = "Continue"

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    if ($DryRun) {
        Write-Host "[dry-run] $Label"
    } else {
        & $Action
    }
}

Write-Host "[1/4] Suppression des clés de démarrage automatique Dhirna..."
Invoke-Step "Suppression clé Run DhirnaGuardian et réinitialisation NoRemove=0" {
    reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "DhirnaGuardian" /f 2>$null | Out-Null
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Dhirna" /v "NoRemove" /t REG_DWORD /d 0 /f 2>$null | Out-Null
}

Write-Host "[2/4] Arrêt forcé des processus dhirna-desktop.exe..."
Invoke-Step "Stop-Process -Name dhirna-desktop -Force" {
    Stop-Process -Name "dhirna-desktop" -Force -ErrorAction SilentlyContinue
}
Invoke-Step "taskkill /F /IM dhirna-desktop.exe /T" {
    taskkill /F /IM "dhirna-desktop.exe" /T 2>$null | Out-Null
}

Write-Host "[3/4] Suppression du verrou watchdog local..."
$watchdogPath = Join-Path $env:APPDATA "Dhirna\dhirna_watchdog.json"
if (Test-Path $watchdogPath) {
    Invoke-Step "Remove-Item $watchdogPath" {
        Remove-Item -Path $watchdogPath -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "[4/4] Vérification du fichier hosts et du DNS Windows..."
$hostsPath = "C:\Windows\System32\drivers\etc\hosts"
if (Test-Path $hostsPath) {
    $raw = Get-Content -Path $hostsPath -Raw -ErrorAction SilentlyContinue
    if ($raw -match "# Dhirna (BEGIN|Shield SafeSearch BEGIN)") {
        if ($RestoreDns) {
            Invoke-Step "Nettoyage des blocs Dhirna dans $hostsPath et réinitialisation DNS DHCP" {
                $lines = Get-Content -Path $hostsPath
                $out = New-Object System.Collections.Generic.List[string]
                $skip = $false
                foreach ($line in $lines) {
                    $t = $line.Trim()
                    if ($t -eq "# Dhirna BEGIN" -or $t -eq "# Dhirna Shield SafeSearch BEGIN") { $skip = $true; continue }
                    if ($t -eq "# Dhirna END" -or $t -eq "# Dhirna Shield SafeSearch END") { $skip = $false; continue }
                    if (-not $skip) { $out.Add($line) }
                }
                Set-Content -Path $hostsPath -Value $out -Encoding ASCII
                Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {
                    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue
                }
                ipconfig /flushdns | Out-Null
            }
            Write-Host "    hosts et DNS Windows restaurés."
        } else {
            Write-Host "    Note : des blocs Dhirna existent dans $hostsPath. Relancez en administrateur avec -RestoreDns."
        }
    } else {
        Write-Host "    Aucun bloc résiduel dans $hostsPath."
    }
}

Write-Host "Dhirna arrêté proprement. Pour redémarrer sans blocage : dhirna-desktop.exe --safe-mode"
