# Installe Miroir Téléphone pour l'utilisateur courant (sans droits administrateur) :
# copie dans %LOCALAPPDATA%\Programs et raccourcis Menu Démarrer + Bureau.
# Usage : powershell -ExecutionPolicy Bypass -File install-windows.ps1 [-Exe .\MiroirTelephone-windows-x64.exe]
param([string]$Exe = ".\MiroirTelephone-windows-x64.exe")
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Exe)) { throw "Exécutable introuvable : $Exe" }
$dest = Join-Path $env:LOCALAPPDATA "Programs\MiroirTelephone"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$target = Join-Path $dest "MiroirTelephone.exe"
Copy-Item $Exe $target -Force
Unblock-File $target   # retire la marque « téléchargé depuis Internet »

$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Miroir Téléphone.lnk"))
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $dest
  $lnk.Description = "Afficher, capturer et filmer un téléphone (expérimental)"
  $lnk.Save()
}
Write-Host "OK : installé dans $dest (Menu Démarrer et Bureau : « Miroir Téléphone »)"
