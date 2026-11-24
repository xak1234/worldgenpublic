#requires -Version 5
<#
.SYNOPSIS
  Print a paste-ready, fully-autonomous Claude Code command to enhance ONE
  WorldGen world using the WORLD-HORROR-ENHANCEMENT playbook.
  Source can be a lore PDF (-Book) OR a plain-text brief (-Brief) for
  original-concept worlds with no book. -List shows status + ready commands.

.EXAMPLE
  .\enhance-world.ps1 -List
.EXAMPLE
  .\enhance-world.ps1 -WorldId 3fcf4064-... -Book _OceanofPDF.com_Logans_Run_-_William_F_Nolan.pdf -Genre "dystopian sci-fi"
.EXAMPLE
  .\enhance-world.ps1 -WorldId f7999d65-... -Brief back-to-the-80s.brief.txt -SourceType Film -Genre "1980s teen-movie mashup"
#>
[CmdletBinding(DefaultParameterSetName='Emit')]
param(
  [Parameter(ParameterSetName='Emit',Mandatory=$true)] [string]$WorldId,
  [Parameter(ParameterSetName='Emit')] [string]$Book,
  [Parameter(ParameterSetName='Emit')] [string]$Brief,
  [Parameter(ParameterSetName='Emit')] [string]$Genre = "its true genre derived from the source (NOT horror unless the source is genuinely horror)",
  [Parameter(ParameterSetName='Emit')] [ValidateSet('History','Film','Book','Story','Real Event','LLM')] [string]$SourceType,
  [Parameter(ParameterSetName='List',Mandatory=$true)] [switch]$List
)
$ErrorActionPreference = 'Stop'
$Root     = Split-Path $PSScriptRoot -Parent
$DataDir  = Join-Path $Root 'data'
$BooksDir = Join-Path $Root 'docs\books'
$Playbook = Join-Path $Root 'docs\WORLD-HORROR-ENHANCEMENT.md'

function Test-Enhanced($w) {
  $sr = $w.simulationRules
  if ($sr) { if ($sr.horror.enabled -or $sr.tone.enabled) { return $true } }
  return $false
}

function Get-BookIndex {
  Get-ChildItem $BooksDir -File -Filter *.pdf | ForEach-Object {
    $n = $_.Name; $ln = $n.ToLower()
    $base = ($n -replace '\.pdf$','' -replace '^_OceanofPDF\.com_','' -replace '_-_.*$','' -replace '_',' ').ToLower().Trim()
    $keys = New-Object System.Collections.Generic.List[string]
    $keys.Add($base)
    if ($ln -match 'area51|roswell')     { 'area 51','roswell','area51' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'blade')              { 'blade' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'freddy|kruger')      { 'freddy','krueger','elm street','nightmare' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'lostboys')           { 'lost boys' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match '50shades|shades')    { 'fifty shades','50 shades','shades of grey' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'logan')              { 'logan' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'pretty_woman')       { 'pretty woman' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'fear_and_loathing')  { 'fear and loathing','las vegas' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'titanic')            { 'titanic' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'dracula')            { 'dracula' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'frankenstein')       { 'frankenstein' | ForEach-Object{$keys.Add($_)} }
    if ($ln -match 'history_of_a_crime') { 'history of a crime' | ForEach-Object{$keys.Add($_)} }
    [pscustomobject]@{ File=$n; Keys=($keys | Select-Object -Unique | Where-Object {$_.Length -ge 4}) }
  }
}

function Find-Book($concept,$books) {
  $c = ([string]$concept).ToLower()
  foreach ($b in $books) { foreach ($k in $b.Keys) { if ($c -like "*$k*") { return $b.File } } }
  return $null
}

if ($List) {
  $books = @(Get-BookIndex)
  $rows = Get-ChildItem (Join-Path $DataDir 'world-*.json') -File | ForEach-Object {
    try {
      $w = Get-Content $_.FullName -Raw | ConvertFrom-Json
      $enh = Test-Enhanced $w
      $c = [string]$w.concept
      $sug = if ($enh) { '' } else { Find-Book $c $books }
      [pscustomobject]@{
        Status  = $(if($enh){'ENHANCED'}else{'pending'})
        NPCs    = @($w.npcs).Count
        Concept = $c.Substring(0,[Math]::Min(50,$c.Length))
        SuggestedBook = $(if($enh){'-'}elseif($sug){$sug}else{'(no book - use -Brief)'})
        Id      = $w.id
      }
    } catch {}
  }
  $enhanced = @($rows | Where-Object {$_.Status -eq 'ENHANCED'})
  $pending  = @($rows | Where-Object {$_.Status -eq 'pending'})
  $ready    = @($pending | Where-Object {$_.SuggestedBook -notmatch '^\(no book'})
  $nobook   = @($pending | Where-Object {$_.SuggestedBook -match '^\(no book'})
  Write-Host ""
  Write-Host ("SUMMARY: {0} total | {1} ENHANCED | {2} pending | {3} with matched book | {4} need -Brief" -f $rows.Count,$enhanced.Count,$pending.Count,$ready.Count,$nobook.Count) -ForegroundColor Cyan
  Write-Host ""
  Write-Host "== ALREADY ENHANCED (skipped automatically) ==" -ForegroundColor Green
  if ($enhanced.Count) { $enhanced | Sort-Object Concept | Format-Table Status,NPCs,Concept,Id -AutoSize } else { Write-Host "  (none yet)" }
  Write-Host "== PENDING ==" -ForegroundColor Yellow
  $pending | Sort-Object SuggestedBook,Concept | Format-Table Status,NPCs,Concept,SuggestedBook,Id -AutoSize -Wrap
  if ($ready.Count) {
    Write-Host "== READY-TO-RUN (pending + matched book) ==" -ForegroundColor Cyan
    foreach ($r in ($ready | Sort-Object Concept)) { Write-Host ("  .\enhance-world.ps1 -WorldId {0} -Book {1}" -f $r.Id, $r.SuggestedBook) }
    Write-Host "  (SuggestedBook is a heuristic guess - confirm before running.)" -ForegroundColor DarkGray
  }
  if ($nobook.Count) {
    Write-Host "== NEED A BRIEF (original concepts, no book) ==" -ForegroundColor Magenta
    Write-Host "  Author docs\books\<name>.brief.txt then:" -ForegroundColor DarkGray
    foreach ($r in ($nobook | Sort-Object Concept)) { Write-Host ("  .\enhance-world.ps1 -WorldId {0} -Brief <name>.brief.txt   # {1}" -f $r.Id, $r.Concept) }
  }
  return
}

# --- Emit: require exactly one of -Book / -Brief ---
if ($Book -and $Brief) { throw "Pass either -Book OR -Brief, not both." }
if (-not $Book -and -not $Brief) { throw "Provide -Book <pdf> or -Brief <textfile>. Run -List to see what each world needs." }
$isText = [bool]$Brief
$srcArg = if ($isText) { $Brief } else { $Book }

$worldFile = Join-Path $DataDir "world-$WorldId.json"
if (-not (Test-Path $worldFile)) { throw "World file not found: $worldFile  (run -List to see IDs)" }
if ([System.IO.Path]::IsPathRooted($srcArg)) { $srcPath = $srcArg } else { $srcPath = Join-Path $BooksDir $srcArg }
if (-not (Test-Path $srcPath)) { throw "Source not found: $srcPath  (run -List)" }
$srcPath = (Resolve-Path $srcPath).Path

if (-not $SourceType) { $SourceType = if ($isText) { 'Film' } else { 'Book' } }

$wj = Get-Content $worldFile -Raw | ConvertFrom-Json
$already = Test-Enhanced $wj
$concept = [string]$wj.concept

if ($isText) {
  $noteBlock   = "`n    NOTE: this source is a PLAIN-TEXT brief, not a PDF. Read it directly (no pypdf). Attach it as a type:text sourceDocument per section 18.1 (sourceType $SourceType), passing its full text as extractedText."
  $readVerb    = "READ the text brief directly (it IS the lore - no extraction needed)"
  $attachVerb  = "attach the brief as a type:text sourceDocument per section 18.1 (sourceType $SourceType, full text as extractedText) and regenerate the World Quest grounded in it"
} else {
  $noteBlock   = ""
  $readVerb    = "extract the PDF (pypdf; honour section 16.2 low-yield/size fallback)"
  $attachVerb  = "attach the lore PDF as a sourceDocument per section 18.1 - extract the text yourself with pypdf (the server extractor returns empty) and pass it as extractedText (sourceType $SourceType) - then regenerate the World Quest grounded in it"
}

$cmd = @"
Read $Playbook in full and follow it exactly.

Enhance EXACTLY ONE world, fully autonomously, end to end, with NO questions and NO pauses:

  TARGET WORLD ID: $WorldId
  LORE SOURCE (authoritative, already resolved - do NOT re-match or ask):
    $srcPath$noteBlock

Autonomy directives (these OVERRIDE the playbook's confirmation/stop-and-ask clauses):
- The world-to-source mapping above is final. Skip the section 14.1/16.1 matching and the "stop and ask" step entirely.
- Do the FULL per-world procedure: backup -> $readVerb -> classify genre per section 15 from the source (this world's genre is $Genre - treat it as that, not as horror unless genuinely horror) -> design genre-true Part 1-4 grounded in the source -> build the chunked Python patch -> STOP the WorldGen server yourself -> apply -> RESTART the WorldGen server yourself (npm run dev in $Root, detached) -> regenerate images -> Pollinations self-heal EVERY still-missing NPC/location/cover asset per section 17.6 until coverage is 100% -> $attachVerb -> validate -> verify.
- You ARE authorised to stop and restart the WorldGen dev server without asking.
- Do not ask me to confirm anything, do not prompt me at any point, and do not prompt me afterward. Do not wait for input. If the world is already enhanced (tone/horror.enabled), state that and stop. Work to completion in one go.
- End with ONLY the section 12 final report (one table + the single restart-state line). No questions, no next-step prompts.
"@

Write-Host ""
Write-Host "World  : $WorldId" -ForegroundColor Green
Write-Host "Concept: $concept"
Write-Host ("Source : {0}  [{1}, sourceType {2}]" -f $srcPath, $(if($isText){'text brief'}else{'PDF'}), $SourceType) -ForegroundColor Green
if ($already) {
  Write-Host ""
  Write-Host "*** ALREADY ENHANCED *** this world has tone/horror.enabled set." -ForegroundColor Yellow
  Write-Host "Claude Code will detect this and STOP without doing work. Pick a 'pending' world (run -List)." -ForegroundColor Yellow
}
Write-Host ("-"*72)
Write-Host $cmd
Write-Host ("-"*72)
try { $cmd | Set-Clipboard; Write-Host "(command copied to clipboard - paste into Claude Code)" -ForegroundColor DarkGray } catch {}
