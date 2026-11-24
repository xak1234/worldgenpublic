param(
    [string]$DataDir = ''
)

$RepoRootDir = if ($env:WORLDGEN_ROOT) { $env:WORLDGEN_ROOT } else { Split-Path -Parent $PSScriptRoot }
if (-not $DataDir) { $DataDir = if ($env:WORLDGEN_DATA_DIR) { [IO.Path]::Combine($RepoRootDir, $env:WORLDGEN_DATA_DIR) } else { Join-Path $RepoRootDir 'data' } }

$ErrorActionPreference = 'Stop'

# Load every world
$worldFiles = Get-ChildItem (Join-Path $DataDir 'world-*.json') -File
$worldsById = @{}
$worldStats = @()

foreach ($wf in $worldFiles) {
    try {
        $j = Get-Content $wf.FullName -Raw | ConvertFrom-Json -Depth 100
    } catch {
        Write-Output "[WORLD-PARSE-FAIL] $($wf.Name): $($_.Exception.Message)"
        continue
    }
    $wid = if ($j.id) { [string]$j.id } else { ($wf.BaseName -replace '^world-','') }
    $worldsById[$wid] = $j

    $npcs = @($j.npcs)
    $locs = @($j.locations)
    $tl   = @($j.timeline)

    $validNpcIds = @{}
    $dupNpcIds   = @{}
    foreach ($n in $npcs) {
        if (-not $n.id) { continue }
        if ($validNpcIds.ContainsKey($n.id)) { $dupNpcIds[$n.id] = $true }
        $validNpcIds[$n.id] = $true
    }
    $validLocIds = @{}
    $dupLocIds   = @{}
    foreach ($l in $locs) {
        if (-not $l.id) { continue }
        if ($validLocIds.ContainsKey($l.id)) { $dupLocIds[$l.id] = $true }
        $validLocIds[$l.id] = $true
    }

    $npcMissingName = 0; $npcMissingId = 0
    $orphanHome = 0; $orphanWork = 0; $orphanFreq = 0
    $orphanRel = 0
    foreach ($n in $npcs) {
        if (-not $n.id)   { $npcMissingId   += 1 }
        if (-not $n.name) { $npcMissingName += 1 }
        if ($n.homeLocationId -and -not $validLocIds[$n.homeLocationId]) { $orphanHome += 1 }
        if ($n.workLocationId -and -not $validLocIds[$n.workLocationId]) { $orphanWork += 1 }
        foreach ($f in @($n.frequentedLocations)) {
            if ($f -and -not $validLocIds[$f]) { $orphanFreq += 1 }
        }
        foreach ($r in @($n.relationships)) {
            $tid = $r.npcId; if (-not $tid) { $tid = $r.targetNpcId }; if (-not $tid) { $tid = $r.targetId }
            if ($tid -and -not $validNpcIds[$tid]) { $orphanRel += 1 }
        }
    }

    $orphanConn = 0; $nonReciprocal = 0; $orphanRegular = 0
    foreach ($l in $locs) {
        foreach ($c in @($l.connectedTo)) {
            if (-not $c) { continue }
            if (-not $validLocIds[$c]) { $orphanConn += 1; continue }
            $other = $locs | Where-Object { $_.id -eq $c } | Select-Object -First 1
            if ($other -and -not (@($other.connectedTo) -contains $l.id)) { $nonReciprocal += 1 }
        }
        foreach ($g in @($l.regulars)) {
            if ($g -and -not $validNpcIds[$g]) { $orphanRegular += 1 }
        }
    }

    $orphanTimelineNpc = 0; $orphanTimelineLoc = 0
    foreach ($e in $tl) {
        if ($e.locationId -and -not $validLocIds[$e.locationId]) { $orphanTimelineLoc += 1 }
        foreach ($p in @($e.affectedNpcIds)) {
            if ($p -and -not $validNpcIds[$p]) { $orphanTimelineNpc += 1 }
        }
        foreach ($p in @($e.participants)) {
            if ($p -and -not $validNpcIds[$p]) { $orphanTimelineNpc += 1 }
        }
    }

    $components = 0
    if ($locs.Count -gt 0) {
        $seen = @{}
        foreach ($l in $locs) {
            if ($seen[$l.id]) { continue }
            $components += 1
            $stack = New-Object System.Collections.Stack
            $stack.Push($l.id)
            while ($stack.Count -gt 0) {
                $cur = $stack.Pop()
                if ($seen[$cur]) { continue }
                $seen[$cur] = $true
                $node = $locs | Where-Object { $_.id -eq $cur } | Select-Object -First 1
                if ($node) {
                    foreach ($nb in @($node.connectedTo)) {
                        if (-not $nb) { continue }
                        if ($validLocIds[$nb] -and -not $seen[$nb]) { $stack.Push($nb) }
                    }
                }
            }
        }
    }

    $worldStats += [PSCustomObject]@{
        File             = $wf.Name
        WorldId          = $wid
        NPCs             = $npcs.Count
        Locations        = $locs.Count
        Timeline         = $tl.Count
        DupNpcIds        = $dupNpcIds.Count
        DupLocIds        = $dupLocIds.Count
        NpcMissingId     = $npcMissingId
        NpcMissingName   = $npcMissingName
        OrphanHome       = $orphanHome
        OrphanWork       = $orphanWork
        OrphanFreq       = $orphanFreq
        OrphanRel        = $orphanRel
        OrphanConn       = $orphanConn
        NonReciprocal    = $nonReciprocal
        OrphanRegular    = $orphanRegular
        OrphanTLNpc      = $orphanTimelineNpc
        OrphanTLLoc      = $orphanTimelineLoc
        Components       = $components
    }
}

# Load every session
$sessionFiles = Get-ChildItem (Join-Path $DataDir 'session-*.json') -File
$sessionStats = @()

foreach ($sf in $sessionFiles) {
    try {
        $j = Get-Content $sf.FullName -Raw | ConvertFrom-Json -Depth 100
    } catch {
        Write-Output "[SESSION-PARSE-FAIL] $($sf.Name): $($_.Exception.Message)"
        continue
    }
    $sid = if ($j.id) { [string]$j.id } else { ($sf.BaseName -replace '^session-','') }
    $worldId = if ($j.worldId) { [string]$j.worldId } else { '' }
    $world = if ($worldId) { $worldsById[$worldId] } else { $null }

    $worldExists = $null -ne $world
    $orphanStateKeys = 0
    $missingStateForNpc = 0
    $orphanLocations = 0
    $orphanMemoryNpc = 0
    $orphanMemoryLoc = 0

    if ($worldExists) {
        $validNpcIds = @{}; foreach ($n in @($world.npcs)) { if ($n.id) { $validNpcIds[$n.id] = $true } }
        $validLocIds = @{}; foreach ($l in @($world.locations)) { if ($l.id) { $validLocIds[$l.id] = $true } }

        if ($j.npcStates) {
            $stateKeys = @($j.npcStates.PSObject.Properties.Name)
            foreach ($k in $stateKeys) {
                if (-not $validNpcIds[$k]) { $orphanStateKeys += 1 }
            }
            foreach ($id in $validNpcIds.Keys) {
                if (-not ($stateKeys -contains $id)) { $missingStateForNpc += 1 }
            }
            foreach ($p in $j.npcStates.PSObject.Properties) {
                $st = $p.Value
                if ($st.locationId -and -not $validLocIds[$st.locationId]) { $orphanLocations += 1 }
                foreach ($m in @($st.memories)) {
                    if ($m.locationId -and -not $validLocIds[$m.locationId]) { $orphanMemoryLoc += 1 }
                    foreach ($o in @($m.othersPresent)) {
                        if ($o -and -not $validNpcIds[$o]) { $orphanMemoryNpc += 1 }
                    }
                }
            }
        }

        if ($j.playerLocationId -and -not $validLocIds[$j.playerLocationId]) { $orphanLocations += 1 }
    }

    $sessionStats += [PSCustomObject]@{
        File              = $sf.Name
        SessionId         = $sid
        WorldId           = $worldId
        WorldExists       = $worldExists
        SizeKB            = [math]::Round($sf.Length / 1024, 0)
        OrphanStateKeys   = $orphanStateKeys
        MissingStateForNpc= $missingStateForNpc
        OrphanLocations   = $orphanLocations
        OrphanMemoryNpc   = $orphanMemoryNpc
        OrphanMemoryLoc   = $orphanMemoryLoc
    }
}

Write-Output ''
Write-Output '==================== WORLDS ===================='
$worldStats | Sort-Object @{Expression={$_.OrphanRel + $_.OrphanTLNpc + $_.OrphanTLLoc + $_.OrphanConn + $_.OrphanFreq + $_.OrphanHome + $_.OrphanWork + $_.NonReciprocal + $_.OrphanRegular + $_.DupNpcIds + $_.DupLocIds + $_.NpcMissingId + $_.NpcMissingName + ($_.Components - 1)}; Descending=$true} `
  | Format-Table File, NPCs, Locations, OrphanRel, OrphanTLNpc, OrphanTLLoc, OrphanConn, OrphanFreq, OrphanHome, OrphanWork, OrphanRegular, NonReciprocal, Components, DupNpcIds, DupLocIds -AutoSize

Write-Output ''
Write-Output '==================== SESSIONS ===================='
$sessionStats | Sort-Object @{Expression={ if ($_.WorldExists) { 0 } else { 1000 } + $_.OrphanStateKeys + $_.OrphanLocations + $_.OrphanMemoryNpc + $_.OrphanMemoryLoc }; Descending=$true} `
  | Format-Table File, WorldExists, SizeKB, OrphanStateKeys, MissingStateForNpc, OrphanLocations, OrphanMemoryNpc, OrphanMemoryLoc -AutoSize

Write-Output ''
Write-Output '==================== AGGREGATE ===================='
[PSCustomObject]@{
    Worlds                  = $worldStats.Count
    Sessions                = $sessionStats.Count
    SessionsBoundToDeadWorld= ($sessionStats | Where-Object { -not $_.WorldExists }).Count
    TotalOrphanRel          = ($worldStats | Measure-Object OrphanRel       -Sum).Sum
    TotalOrphanTimelineNpc  = ($worldStats | Measure-Object OrphanTLNpc     -Sum).Sum
    TotalOrphanTimelineLoc  = ($worldStats | Measure-Object OrphanTLLoc     -Sum).Sum
    TotalOrphanConnections  = ($worldStats | Measure-Object OrphanConn      -Sum).Sum
    TotalOrphanFrequented   = ($worldStats | Measure-Object OrphanFreq      -Sum).Sum
    TotalOrphanHome         = ($worldStats | Measure-Object OrphanHome      -Sum).Sum
    TotalOrphanWork         = ($worldStats | Measure-Object OrphanWork      -Sum).Sum
    TotalOrphanRegulars     = ($worldStats | Measure-Object OrphanRegular   -Sum).Sum
    TotalNonReciprocalEdges = ($worldStats | Measure-Object NonReciprocal   -Sum).Sum
    TotalDisconnectedWorlds = ($worldStats | Where-Object { $_.Components -gt 1 }).Count
    TotalOrphanStateKeys    = ($sessionStats | Measure-Object OrphanStateKeys -Sum).Sum
    TotalMissingStates      = ($sessionStats | Measure-Object MissingStateForNpc -Sum).Sum
    TotalOrphanMemoryNpc    = ($sessionStats | Measure-Object OrphanMemoryNpc -Sum).Sum
    TotalOrphanMemoryLoc    = ($sessionStats | Measure-Object OrphanMemoryLoc -Sum).Sum
} | Format-List
