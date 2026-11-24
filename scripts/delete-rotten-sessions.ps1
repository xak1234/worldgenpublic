param(
    [string]$DataDir = '',
    [switch]$DryRun
)

$RepoRootDir = if ($env:WORLDGEN_ROOT) { $env:WORLDGEN_ROOT } else { Split-Path -Parent $PSScriptRoot }
if (-not $DataDir) { $DataDir = if ($env:WORLDGEN_DATA_DIR) { [IO.Path]::Combine($RepoRootDir, $env:WORLDGEN_DATA_DIR) } else { Join-Path $RepoRootDir 'data' } }

$ErrorActionPreference = 'Stop'

# Reuse: index worlds by id for cross-ref check
$worldsById = @{}
foreach ($wf in Get-ChildItem (Join-Path $DataDir 'world-*.json') -File) {
    try {
        $j = Get-Content $wf.FullName -Raw | ConvertFrom-Json -Depth 100
        if ($j.id) { $worldsById[[string]$j.id] = $j }
    } catch { }
}

$toDelete = @()
$keep     = @()

foreach ($sf in Get-ChildItem (Join-Path $DataDir 'session-*.json') -File) {
    try {
        $j = Get-Content $sf.FullName -Raw | ConvertFrom-Json -Depth 100
    } catch {
        $toDelete += [PSCustomObject]@{ File=$sf; Reason='unparseable JSON' }
        continue
    }
    $worldId = if ($j.worldId) { [string]$j.worldId } else { '' }
    $world = if ($worldId) { $worldsById[$worldId] } else { $null }

    if (-not $world) {
        $toDelete += [PSCustomObject]@{ File=$sf; Reason='bound to missing world' }
        continue
    }

    $validNpcIds = @{}; foreach ($n in @($world.npcs)) { if ($n.id) { $validNpcIds[$n.id] = $true } }
    $validLocIds = @{}; foreach ($l in @($world.locations)) { if ($l.id) { $validLocIds[$l.id] = $true } }

    $orphanStateKeys = 0
    $orphanMemoryNpc = 0
    $orphanMemoryLoc = 0
    $orphanPlayerLoc = 0

    if ($j.npcStates) {
        foreach ($p in $j.npcStates.PSObject.Properties) {
            if (-not $validNpcIds[$p.Name]) { $orphanStateKeys += 1 }
            $st = $p.Value
            if ($st.locationId -and -not $validLocIds[$st.locationId]) { $orphanMemoryLoc += 1 }
            foreach ($m in @($st.memories)) {
                if ($m.locationId -and -not $validLocIds[$m.locationId]) { $orphanMemoryLoc += 1 }
                foreach ($o in @($m.othersPresent)) {
                    if ($o -and -not $validNpcIds[$o]) { $orphanMemoryNpc += 1 }
                }
            }
        }
    }
    if ($j.playerLocationId -and -not $validLocIds[$j.playerLocationId]) { $orphanPlayerLoc = 1 }

    $totalOrphans = $orphanStateKeys + $orphanMemoryNpc + $orphanMemoryLoc + $orphanPlayerLoc

    if ($totalOrphans -gt 0) {
        $toDelete += [PSCustomObject]@{
            File   = $sf
            Reason = "stateKeys=$orphanStateKeys memNpc=$orphanMemoryNpc memLoc=$orphanMemoryLoc playerLoc=$orphanPlayerLoc"
        }
    } else {
        $keep += $sf
    }
}

Write-Output ''
Write-Output "==================== DELETE PLAN ===================="
Write-Output "Will delete: $($toDelete.Count) sessions  |  Keep: $($keep.Count) sessions"
Write-Output ''
$totalSizeMB = 0
foreach ($d in $toDelete) {
    $sizeKB = [math]::Round($d.File.Length / 1024, 0)
    $totalSizeMB += $d.File.Length / 1MB
    "{0,8} KB  {1,-50} {2}" -f $sizeKB, $d.File.Name, $d.Reason
}
Write-Output ''
Write-Output ("Total size to delete: {0:N1} MB" -f $totalSizeMB)
Write-Output ''
if ($DryRun) {
    Write-Output '[DryRun] No files deleted.'
    return
}
$deleted = 0
foreach ($d in $toDelete) {
    Remove-Item -Path $d.File.FullName -Force
    $deleted += 1
}
Write-Output "Deleted $deleted session files."
