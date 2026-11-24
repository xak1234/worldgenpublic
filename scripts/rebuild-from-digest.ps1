<#
.SYNOPSIS
  Rebuild a WorldGen world from its canonical-source digest, using the canonical-roster
  NPC generation fix in scripts/build-world.ts.

.DESCRIPTION
  This script fixes worlds whose build invented generic NPCs (Marvin Crell, Lottie Ryan,
  Marge Pemberton, etc) instead of using the canonical source characters (Larry Cotton,
  Duke, Lacerda, etc). It works by:

    1. Reading world.sourceDocuments[].digest (the structured whole-story digest)
    2. Saving it as a clean .txt file in public/uploads/ with a "use ONLY these" header
    3. Deleting the old (wrong-NPC) world
    4. Triggering a fresh build via POST /api/worlds/build with the canonical source
    5. Polling the build job until completion

  After the build, cast-rematch runs automatically and matches canonical characters to
  TMDB actors (Andrew Robinson, Doug Bradley, Johnny Depp, etc).

.PARAMETER WorldId
  The world id to rebuild (e.g. 'build_b7c2123f-...'). Use -List to find ids.

.PARAMETER List
  List all source-grounded worlds with their digest status, then exit.

.PARAMETER All
  Rebuild ALL source-grounded worlds with digests. Confirms first.

.PARAMETER Provider
  LLM provider for the rebuild. Default 'deepseek' (handles horror/adult/film content).

.PARAMETER Model
  Specific model. Default 'deepseek-v4-flash'.

.PARAMETER Npcs
  NPC count. Default 15.

.PARAMETER NoWait
  Kick the build and return immediately. Default is to poll until completion.

.PARAMETER ServerUrl
  WorldGen base URL. Default http://127.0.0.1:3002.

.EXAMPLE
  .\rebuild-from-digest.ps1 -List
  .\rebuild-from-digest.ps1 -WorldId build_b7c2123f-0a18-4ca3-b7a2-237414082377
  .\rebuild-from-digest.ps1 -WorldId build_xxx -Npcs 20 -Provider deepseek
#>

[CmdletBinding(DefaultParameterSetName='Single')]
param(
  [Parameter(ParameterSetName='Single', Position=0)]
  [string]$WorldId,
  [Parameter(ParameterSetName='List')]
  [switch]$List,
  [Parameter(ParameterSetName='All')]
  [switch]$All,
  [string]$Provider = 'deepseek',
  [string]$Model = 'deepseek-v4-flash',
  [int]$Npcs = 15,
  [int]$Locations = 8,
  [int]$TimelineEvents = 10,
  [switch]$NoWait,
  [string]$ServerUrl = 'http://127.0.0.1:3002',
  [string]$RepoRoot = $(if ($env:WORLDGEN_ROOT) { $env:WORLDGEN_ROOT } else { Split-Path -Parent $PSScriptRoot })
)

$ErrorActionPreference = 'Stop'

# ───────────────────────────────────────────────────────────────────────────
# Helpers
# ───────────────────────────────────────────────────────────────────────────
function Get-ApiKey {
  $envPath = Join-Path $RepoRoot '.env'
  if (Test-Path $envPath) {
    $line = Get-Content $envPath | Where-Object { $_ -match '^WORLDGEN_API_KEY=' }
    if ($line) { return ($line -replace '^WORLDGEN_API_KEY=','').Trim() }
  }
  return ''
}

function Get-Worlds {
  return (Invoke-RestMethod -Uri "$ServerUrl/api/worlds" -TimeoutSec 8).worlds
}

function Get-WorldDetail([string]$id) {
  return (Invoke-RestMethod -Uri "$ServerUrl/api/worlds/$id" -TimeoutSec 10).world
}

function Get-CanonicalCount([string]$digest) {
  if (-not $digest) { return 0 }
  $m = [Regex]::Match($digest, 'CHARACTERS:\s*(.+?)\s+(?:LOCATIONS|PLOT|THEMES|TONE|ENDING)\s*:', 'IgnoreCase,Singleline')
  if (-not $m.Success) { return 0 }
  $block = $m.Groups[1].Value
  $entries = [Regex]::Split($block, '(?:^|\s)-\s+(?=[A-Z])') | Where-Object { $_.Trim().Length -gt 8 }
  $count = 0
  foreach($e in $entries){
    if ($e -match '^([A-Z][^():]{1,60}?)\s*(?:\(([^)]+)\))?\s*:\s*.+$') { $count++ }
  }
  return $count
}

# ───────────────────────────────────────────────────────────────────────────
# Modes
# ───────────────────────────────────────────────────────────────────────────
if ($List) {
  Write-Host "`n  Source-grounded worlds (digest = whole-story structured reference):`n" -ForegroundColor Cyan
  $worlds = Get-Worlds
  $rows = @()
  foreach($w in $worlds) {
    $d = Get-WorldDetail $w.id
    $docs = $d.sourceDocuments
    if (-not $docs -or $docs.Count -eq 0) { continue }
    $last = $docs[-1]
    $digestLen = if ($last.digest) { $last.digest.Length } else { 0 }
    $rosterCount = Get-CanonicalCount $last.digest
    $rows += [PSCustomObject]@{
      id = $w.id
      concept = ($w.concept.Substring(0,[Math]::Min(50,$w.concept.Length)))
      npcs = $w.npcCount
      digest = $digestLen
      roster = $rosterCount
    }
  }
  $rows | Sort-Object roster -Descending | Format-Table id,concept,npcs,digest,roster -AutoSize
  Write-Host "  Run with -WorldId <id> to rebuild a specific world, or -All for everything."
  return
}

# Resolve list of worlds to rebuild
$targets = @()
if ($All) {
  $worlds = Get-Worlds
  foreach($w in $worlds) {
    $d = Get-WorldDetail $w.id
    if ($d.sourceDocuments -and $d.sourceDocuments[-1].digest) { $targets += $w.id }
  }
  Write-Host "  Found $($targets.Count) source-grounded worlds with digests."
  $confirm = Read-Host "  Rebuild ALL of them? This deletes the current versions. [y/N]"
  if ($confirm -ne 'y') { Write-Host "  Aborted."; return }
}
elseif ($WorldId) {
  $targets = @($WorldId)
}
else {
  Write-Host "  Usage: -List | -WorldId <id> | -All" -ForegroundColor Yellow
  Write-Host "  Run with -List to see available worlds."
  return
}

$apiKey = Get-ApiKey
$headers = if ($apiKey) { @{ 'X-API-Key' = $apiKey } } else { @{} }

# ───────────────────────────────────────────────────────────────────────────
# Per-world rebuild
# ───────────────────────────────────────────────────────────────────────────
foreach($wid in $targets) {
  Write-Host "`n  ┌─────────────────────────────────────────────────────────────" -ForegroundColor Cyan
  $d = Get-WorldDetail $wid
  $concept = $d.concept
  $sourceDoc = if ($d.sourceDocuments) { $d.sourceDocuments[-1] } else { $null }
  if (-not $sourceDoc -or -not $sourceDoc.digest) {
    Write-Host "  ✗ $wid ($concept): no digest available - skipping" -ForegroundColor Red
    continue
  }
  $digest = $sourceDoc.digest
  $rosterCount = Get-CanonicalCount $digest
  Write-Host "  │ $concept"
  Write-Host "  │ digest: $($digest.Length) chars, canonical roster: $rosterCount characters"

  if ($rosterCount -lt 3) {
    Write-Host "  │ WARN: only $rosterCount canonical characters parsed - rebuild will be mostly invented" -ForegroundColor Yellow
    $skip = Read-Host "  │ continue anyway? [y/N]"
    if ($skip -ne 'y') { continue }
  }

  # 1. Save digest as clean source .txt with authoritative header
  $cleanTitle = ($concept -replace '[^A-Za-z0-9_-]','_' -replace '_{2,}','_').Trim('_').Substring(0,[Math]::Min(40,$concept.Length))
  $stamp = "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())-$([guid]::NewGuid().ToString().Substring(0,8))"
  $rel = "uploads/$stamp-${cleanTitle}_Canonical_Digest.txt"
  $abs = Join-Path (Join-Path $RepoRoot 'public') $rel
  $header = @"
$concept - Canonical Structured Source Digest

This is the authoritative canonical reference for the world's characters, locations, and plot. Use ONLY characters and plot beats listed below. Do NOT invent generic characters - all NPCs must be from this digest.

=====================================


"@
  ($header + $digest) | Set-Content -Path $abs -Encoding UTF8 -NoNewline
  Write-Host "  │ wrote canonical source: $(Split-Path $abs -Leaf) ($((Get-Item $abs).Length) bytes)"

  # 2. Delete the bad world
  Write-Host "  │ deleting current world..." -NoNewline
  try {
    $delResp = Invoke-WebRequest -Uri "$ServerUrl/api/worlds/$wid" -Method DELETE -Headers $headers -TimeoutSec 15
    Write-Host " HTTP $($delResp.StatusCode)"
  } catch {
    Write-Host " FAIL: $($_.Exception.Message)" -ForegroundColor Red
    continue
  }

  # 3. Trigger fresh build
  $body = @{
    concept = $concept
    provider = $Provider
    model = $Model
    npcs = $Npcs
    locations = $Locations
    timelineEvents = $TimelineEvents
    sourceTextPath = "public/$rel"
    sourceTitle = "$cleanTitle - Canonical Digest"
    sourcePath = "public/$rel"
  } | ConvertTo-Json
  Write-Host "  │ kicking build (provider=$Provider model=$Model npcs=$Npcs)..."
  $buildResp = Invoke-RestMethod -Uri "$ServerUrl/api/worlds/build" -Method POST -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 30
  $jobId = $buildResp.jobId
  $newBuildId = $buildResp.buildId
  Write-Host "  │ jobId=$jobId  newWorldId=$newBuildId"

  if ($NoWait) {
    Write-Host "  └─ build started; check $ServerUrl/api/worlds/build/$jobId for progress"
    continue
  }

  # 4. Poll until completion
  Write-Host "  │ polling build (Ctrl-C to stop polling, build will continue server-side)..."
  $startTs = Get-Date
  $sawRoster = $false
  while ($true) {
    Start-Sleep -Seconds 8
    try {
      $j = Invoke-RestMethod -Uri "$ServerUrl/api/worlds/build/$jobId" -TimeoutSec 5
      $lastLog = ($j.logs | Select-Object -Last 1)
      $elapsed = [int]((Get-Date) - $startTs).TotalSeconds
      Write-Host "  │  [+${elapsed}s status=$($j.status)] $lastLog"
      if (-not $sawRoster) {
        $rosterLine = $j.logs | Where-Object { $_ -match 'Canonical roster parsed' } | Select-Object -First 1
        if ($rosterLine) {
          Write-Host "  │  ✓ $rosterLine" -ForegroundColor Green
          $sawRoster = $true
        }
      }
      if ($j.status -eq 'completed' -or $j.status -eq 'failed') {
        Write-Host "  │  === FINAL: $($j.status) ==="
        break
      }
    } catch {
      # Job 404 typically means completed and was reaped; check the world directly
      $wrld = Get-Worlds | Where-Object { $_.id -eq $newBuildId }
      if ($wrld) {
        Write-Host "  │  ✓ new world live: npcs=$($wrld.npcCount)"
        break
      }
      Write-Host "  │  poll err: $($_.Exception.Message)"
      Start-Sleep -Seconds 5
    }
  }

  # 5. Show resulting NPCs
  Start-Sleep -Seconds 3
  try {
    $newWorld = Get-WorldDetail $newBuildId
    Write-Host "  │"
    Write-Host "  │ NPCs in $newBuildId :"
    $newWorld.npcs | Select-Object -First 10 | ForEach-Object { Write-Host "  │   - $($_.name)" }
    if ($newWorld.npcs.Count -gt 10) { Write-Host "  │   ... +$($newWorld.npcs.Count - 10) more" }
    $tmdbMatches = if ($newWorld.images.portraitSources) {
      ($newWorld.images.portraitSources.PSObject.Properties | Where-Object { $_.Value.kind -eq 'tmdb' }).Count
    } else { 0 }
    Write-Host "  │ TMDB cast matches: $tmdbMatches"
  } catch {
    Write-Host "  │ couldn't fetch new world detail (cast-rematch may still be running)"
  }
  Write-Host "  └─────────────────────────────────────────────────────────────"
}

Write-Host "`n  Done.`n" -ForegroundColor Cyan
