<#
.SYNOPSIS
  Opretter (eller fjerner) en planlagt Windows-opgave, der henter nye
  tilbudsaviser automatisk.

.DESCRIPTION
  Kæderne udgiver ikke deres aviser på samme ugedag – Netto, Lidl og REMA 1000
  skifter typisk mandag/torsdag, andre midt i ugen. Derfor køres opdateringen
  dagligt frem for ugentligt. Kørslen er idempotent: kun tilbud, databasen ikke
  har set før, bliver indsat, så en ekstra kørsel koster ingenting.

  Opgaven kører som den aktuelle bruger og kræver ikke administrator.

.EXAMPLE
  .\scripts\schedule-windows.ps1                 # opret, kører dagligt kl. 07:00
  .\scripts\schedule-windows.ps1 -Time 18:30     # andet tidspunkt
  .\scripts\schedule-windows.ps1 -Status         # vis status og sidste kørsel
  .\scripts\schedule-windows.ps1 -Remove         # fjern opgaven igen
#>

[CmdletBinding()]
param(
    [string]$Time = "07:00",
    [string]$TaskName = "Madplan - hent tilbudsaviser",
    [switch]$Remove,
    [switch]$Status,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$UpdateScript = Join-Path $ProjectDir "src\update.js"

function Get-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        throw "node blev ikke fundet i PATH. Installér Node.js, eller kør scriptet fra en shell hvor 'node' virker."
    }
    return $cmd.Source
}

# ── Fjern ────────────────────────────────────────────────────────────────────
if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Opgaven '$TaskName' findes ikke."
    } else {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Opgaven '$TaskName' er fjernet."
    }
    return
}

# ── Status ───────────────────────────────────────────────────────────────────
if ($Status) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host "Ikke oprettet. Kør scriptet uden parametre for at oprette den."
    } else {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Opgave      : $TaskName"
        Write-Host "Tilstand    : $($existing.State)"
        Write-Host "Sidste kørsel: $($info.LastRunTime)  (resultat $($info.LastTaskResult))"
        Write-Host "Næste kørsel : $($info.NextRunTime)"
    }

    $logFile = Join-Path $ProjectDir "logs\update.log"
    if (Test-Path $logFile) {
        Write-Host ""
        Write-Host "Seneste linjer fra logs\update.log:"
        # Loggen skrives i UTF-8; uden -Encoding læser PowerShell 5.1 den som
        # ANSI, og æ/ø/å bliver til volapyk.
        Get-Content $logFile -Tail 12 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
    }
    return
}

# ── Kør nu ───────────────────────────────────────────────────────────────────
if ($RunNow) {
    $node = Get-NodePath
    Write-Host "Kører opdatering nu..."
    & $node $UpdateScript
    return
}

# ── Opret ────────────────────────────────────────────────────────────────────
if (-not (Test-Path $UpdateScript)) {
    throw "Kunne ikke finde $UpdateScript"
}

$node = Get-NodePath

$action = New-ScheduledTaskAction -Execute $node `
                                  -Argument "`"$UpdateScript`" --quiet" `
                                  -WorkingDirectory $ProjectDir

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# StartWhenAvailable indhenter en kørsel, der blev sprunget over, fordi
# maskinen var slukket – ellers ville en uges tilbud kunne gå tabt.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                                        -LogonType Interactive `
                                        -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
                       -Action $action `
                       -Trigger $trigger `
                       -Settings $settings `
                       -Principal $principal `
                       -Description "Henter danske supermarkeders tilbudsaviser og opdaterer madplan-databasen." `
                       -Force | Out-Null

Write-Host "Oprettet: '$TaskName'"
Write-Host "  Kører   : dagligt kl. $Time"
Write-Host "  Node    : $node"
Write-Host "  Mappe   : $ProjectDir"
Write-Host "  Log     : logs\update.log"
Write-Host ""
Write-Host "Status  :  .\scripts\schedule-windows.ps1 -Status"
Write-Host "Kør nu  :  .\scripts\schedule-windows.ps1 -RunNow"
Write-Host "Fjern   :  .\scripts\schedule-windows.ps1 -Remove"
