// Why this exists, in one sentence: a café whose phones stopped connecting after a second
// router was installed, where the address on screen was correct and the page simply never
// loaded — and nobody on site could tell why.
//
// The most likely cause of exactly that: Windows meets an unfamiliar network, files it as
// "Public" by default, and the station's firewall rule — scoped to "Private" by an installer
// that ran on the old network — stops applying. Nothing in the app changed, no setting was
// touched, and the station goes on serving happily to nobody.
//
// Diagnosing that needed someone in the café to run a script. This is the same check, made by
// the station itself, so the panel can say it out loud.

// Windows firewall profiles are a set; a rule scoped to "Private, Domain" applies on both.
// The station's own installer writes "Any", which covers everything — but older installs (and
// this project's earlier "cafe radio.exe" rules) are Private-only, which is the whole problem.
function ruleCovers(ruleProfile, category) {
  const profile = String(ruleProfile || '')
  const kind = String(category || '')
  if (!kind) return false
  if (profile === 'Any' || profile === '') return true
  // `DomainAuthenticated` is the category name; the firewall calls the same thing `Domain`.
  if (kind === 'DomainAuthenticated') return /\bDomain\b/.test(profile)
  // Word boundaries, not substrings: 'Public' must not be found inside another profile name,
  // and a comma-separated list has to match member by member.
  return new RegExp(`\\b${kind}\\b`).test(profile)
}

// `profiles`: [{ name, category, interfaceAlias }] — the networks this PC is actually on.
// `rules`:    [{ displayName, profile, enabled, action }] — the station's inbound rules.
//
// Returns one verdict per network, plus a summary the caller can act on without re-deriving
// it. Says nothing when it has nothing to say: no data means no verdict, never a false alarm.
function assessFirewall({ profiles = [], rules = [] } = {}) {
  const allowing = rules.filter(rule =>
    (rule.enabled === undefined || rule.enabled === true || rule.enabled === 'True') &&
    (rule.action === undefined || rule.action === 'Allow'))

  const networks = profiles.map(profile => {
    const covering = allowing.find(rule => ruleCovers(rule.profile, profile.category))
    return {
      name: profile.name || profile.interfaceAlias || 'ağ',
      category: profile.category || null,
      covered: Boolean(covering),
      rule: covering ? covering.displayName : null
    }
  })

  const blocked = networks.filter(network => !network.covered)
  return {
    checked: networks.length > 0,
    networks,
    blocked,
    // Only a real problem: at least one live network on which nothing lets phones in.
    problem: networks.length > 0 && blocked.length > 0,
    // Written for the operator, who needs to know what to DO — the category is the thing
    // they can change in one click, and it is where the fix usually is.
    message: blocked.length
      ? `"${blocked[0].name}" ağı ${blocked[0].category === 'Public' ? '"Genel"' : `"${blocked[0].category}"`} olarak işaretli ve bu ağı kapsayan bir güvenlik duvarı izni yok — telefonlar bağlanamaz. Windows ağ ayarlarından bu ağı "Özel" yapın.`
      : null
  }
}

// Asking Windows costs about 2.5 seconds of PowerShell startup, so this is run rarely and
// never on a path anything waits for. Strings, not the numeric enums PowerShell would emit
// by default: the numbers are stable in practice but the names are what the logic above is
// written against, and what a reader can check.
function readWindowsNetworkPosture({ execFile = require('child_process').execFile } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = [
    "$p = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } |",
    "  ForEach-Object { @{ name = [string]$_.Name; category = [string]$_.NetworkCategory; interfaceAlias = [string]$_.InterfaceAlias } };",
    "$r = Get-NetFirewallRule -Direction Inbound -EA SilentlyContinue |",
    "  Where-Object { $_.DisplayName -match 'Rovli|Cafe Radio' } |",
    "  ForEach-Object { @{ displayName = [string]$_.DisplayName; profile = [string]$_.Profile; enabled = ($_.Enabled -eq 'True'); action = [string]$_.Action } };",
    "ConvertTo-Json @{ profiles = @($p); rules = @($r) } -Depth 4 -Compress"
  ].join(' ')

  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Any failure means no verdict. A machine that will not answer is not evidence of a
        // misconfigured firewall, and guessing would put a false alarm on the panel.
        if (error) return resolve(null)
        try {
          const parsed = JSON.parse(String(stdout))
          resolve(assessFirewall({ profiles: parsed.profiles || [], rules: parsed.rules || [] }))
        } catch { resolve(null) }
      })
  })
}

module.exports = { assessFirewall, ruleCovers, readWindowsNetworkPosture }
