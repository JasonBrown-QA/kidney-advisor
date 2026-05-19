$csv = Import-Csv "C:\Users\jason.brown\OneDrive - Master Electronics\Desktop\AI Projects\Kidney Advisor\SmartBP.csv"
$culture = [Globalization.CultureInfo]::InvariantCulture
$bp = foreach ($row in $csv) {
  $d = $null
  try { $d = [DateTime]::ParseExact($row.Date, 'dd-MMM-yyyy hh:mm tt', $culture) } catch { continue }
  if (-not $d) { continue }
  $sys = 0; $dia = 0
  if (-not [int]::TryParse($row.'Systolic (mmHg)', [ref]$sys)) { continue }
  if (-not [int]::TryParse($row.'Diastolic (mmHg)', [ref]$dia)) { continue }
  if ($sys -le 0 -or $dia -le 0) { continue }
  $pulseN = 0
  $pulse = if ([int]::TryParse($row.'Pulse (BPM)', [ref]$pulseN) -and $pulseN -gt 0) { $pulseN } else { $null }
  $rawNotes = if ($null -ne $row.Notes) { [string]$row.Notes } else { '' }
  $tag = ''
  $notes = ''
  if ($rawNotes -match 'Tags:\s*([^\r\n]+)') { $tag = $Matches[1].Trim() }
  if ($rawNotes -match 'Notes:\s*([^\r\n]+)') { $notes = $Matches[1].Trim() }
  $combinedParts = @()
  if ($tag) { $combinedParts += $tag }
  if ($notes) { $combinedParts += $notes }
  $combined = if ($combinedParts.Count) { ($combinedParts -join ' - ') } else { '' }
  [PSCustomObject]@{
    id        = "bp_smartbp_" + $d.ToString('yyyyMMddHHmm')
    datetime  = $d.ToString('yyyy-MM-ddTHH:mm')
    systolic  = $sys
    diastolic = $dia
    pulse     = $pulse
    position  = 'seated'
    notes     = $combined
    source    = 'smartbp'
  }
}
$out = [PSCustomObject]@{ bp = @($bp) } | ConvertTo-Json -Depth 10
$path = "C:\Users\jason.brown\OneDrive - Master Electronics\Desktop\AI Projects\Kidney Advisor\bp-smartbp-import.local.json"
Set-Content -Path $path -Value $out -Encoding UTF8
"Wrote $($bp.Count) BP entries to $path"
"Date range: $(($bp | Select-Object -First 1).datetime) ... $(($bp | Select-Object -Last 1).datetime)"
"Sample entry:"
$bp | Select-Object -First 1 | ConvertTo-Json
