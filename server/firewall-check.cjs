// This is a bounded audit of effective Windows rules, not a phone connectivity test.
// Unknown filters stay unknown: guessing here used to send operators changing the wrong
// network, or clear HTTP 8090 solely because an unrelated HTTPS permission existed.
const values = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).map(x => String(x).trim()).filter(Boolean)
const yes = value => value === true || String(value).toLowerCase() === 'true'
const no = value => value === false || String(value).toLowerCase() === 'false'
const any = value => values(value).some(x => x.toLowerCase() === 'any')
function ruleCovers(ruleProfile, category) {
  if (!category || !ruleProfile) return false
  const kind = category === 'DomainAuthenticated' ? 'Domain' : category
  return any(ruleProfile) || values(ruleProfile).some(x => x.toLowerCase() === kind.toLowerCase())
}
function portMatches(filter, port) {
  return any(filter) || values(filter).some(part => {
    if (/^\d+$/.test(part)) return Number(part) === port
    const range = /^(\d+)-(\d+)$/.exec(part)
    return range && port >= Number(range[1]) && port <= Number(range[2])
  })
}
function ipv4Number(value) {
  const octets = String(value ?? '').split('.')
  if (octets.length !== 4 || octets.some(x => !/^\d+$/.test(x) || Number(x) > 255)) return null
  return octets.reduce((n, x) => n * 256 + Number(x), 0)
}
function dottedNetmaskPrefix(value) {
  const mask = ipv4Number(value)
  if (mask == null) return null
  const bits = mask.toString(2).padStart(32, '0')
  const firstZero = bits.indexOf('0')
  if (firstZero >= 0 && bits.slice(firstZero).includes('1')) return null
  return firstZero < 0 ? 32 : firstZero
}
// Windows stores address filters as exact IPs, CIDR/netmasks, or inclusive ranges.
// Treating every slash/range as "unknown" made an effective Block rule look harmless on
// machines with the hardened Windows ruleset (which contains 0.0.0.0-126... ranges).
function addressMatches(filter, ip) {
  const target = ipv4Number(ip)
  if (target == null) return null
  let considered = false
  for (const raw of values(filter)) {
    const text = String(raw).trim()
    // IPv6 filters cannot match the IPv4 interface selected above; do not let their
    // unsupported syntax turn an otherwise definitive IPv4 result into "unknown".
    if (text.includes(':')) continue
    considered = true
    const exact = ipv4Number(text)
    if (exact != null) { if (exact === target) return true; continue }
    const cidr = /^(\d+\.\d+\.\d+\.\d+)(?:\/(\d+|\d+\.\d+\.\d+\.\d+))$/.exec(text)
    if (cidr) {
      const base = ipv4Number(cidr[1]); const rawPrefix = cidr[2]
      const prefix = rawPrefix.includes('.')
        ? dottedNetmaskPrefix(rawPrefix)
        : Number(rawPrefix)
      if (base == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
      if (((target >>> 0) & mask) === ((base >>> 0) & mask)) return true
      continue
    }
    const range = /^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$/.exec(text)
    if (range) {
      const low = ipv4Number(range[1]); const high = ipv4Number(range[2])
      if (low == null || high == null) return null
      if (target >= low && target <= high) return true
      continue
    }
    return null
  }
  return considered ? false : false
}
function matchRule(rule, network, port, program) {
  if (no(rule.enabled) || (rule.profile && !ruleCovers(rule.profile, network.category))) return false
  if (rule.protocol && !['tcp', '6', 'any', '256'].includes(String(rule.protocol).toLowerCase())) return false
  if (rule.localPort && !portMatches(rule.localPort, port)) return false
  if (rule.program && !any(rule.program) && String(rule.program).toLowerCase() !== String(program).toLowerCase()) return false
  if (rule.service && !any(rule.service)) return false
  if (rule.interfaceAlias && !any(rule.interfaceAlias) &&
      !values(rule.interfaceAlias).some(alias => alias.toLowerCase() === String(network.interfaceAlias || '').toLowerCase())) return false
  if (rule.localAddress && !any(rule.localAddress)) {
    const localMatch = addressMatches(rule.localAddress, network.ip)
    if (localMatch === null) return null
    if (!localMatch) return false
  }
  const required = ['profile', 'protocol', 'localPort', 'program', 'service', 'localAddress', 'remoteAddress', 'interfaceAlias', 'interfaceType', 'authentication']
  if (required.some(key => !values(rule[key]).length) || rule.enabled === undefined) return null
  if (!any(rule.interfaceType) || String(rule.authentication).toLowerCase() !== 'notrequired') return null
  if (any(rule.remoteAddress)) return 'any'
  if (values(rule.remoteAddress).every(x => x.toLowerCase() === 'localsubnet')) return 'subnet'
  const remoteMatch = addressMatches(rule.remoteAddress, network.ip)
  if (remoteMatch === null) return null
  if (!remoteMatch) return String(rule.action || '').toLowerCase() === 'block' ? false : null
  // A scoped Allow filter is deliberately left uncertain: it may be a narrow address that
  // happens to include this PC but exclude the customer's phone. A matching scoped Block,
  // however, is a definite obstacle and must win over an Allow found elsewhere.
  if (String(rule.action || '').toLowerCase() === 'block') return 'subnet'
  return null
}
function assessFirewall({ profiles = [], policies = [], rules = [], ports = [8090, 8443], program = process.execPath } = {}) {
  // ConvertTo-Json unwraps a one-element PowerShell array into a plain object. A café
  // normally has exactly one active profile and a short rule list, so treating the parsed
  // value as an array unconditionally made the live check throw and return `null` precisely
  // on the common machine. Normalize all three collections before inspecting them.
  const list = value => value == null ? [] : (Array.isArray(value) ? value : [value])
  profiles = list(profiles)
  policies = list(policies)
  rules = list(rules)
  const networks = profiles.map(network => {
    const category = network.category === 'DomainAuthenticated' ? 'Domain' : network.category
    const policy = policies.find(item => String(item.name).toLowerCase() === String(category).toLowerCase())
    const endpointResults = ports.map(port => {
      let status = 'unknown', matchedRule = null
      if (policy && no(policy.enabled)) status = 'firewall-disabled'
      else if (policy && yes(policy.enabled) && network.category) {
        const candidates = rules.map(rule => ({ rule, match: matchRule(rule, network, port, program) }))
        const blocked = candidates.find(x => String(x.rule.action || '').toLowerCase() === 'block' && x.match)
        const allow = candidates.find(x => String(x.rule.action || '').toLowerCase() === 'allow' && x.match === 'any')
        const subnet = candidates.find(x => String(x.rule.action || '').toLowerCase() === 'allow' && x.match === 'subnet')
        const uncertain = candidates.some(x => x.match === null)
        if (no(policy.allowInboundRules) || blocked) { status = 'blocked'; matchedRule = blocked?.rule.displayName || null }
        else if (uncertain) status = 'unknown'
        else if (allow) { status = 'permission-found'; matchedRule = allow.rule.displayName }
        else if (String(policy.defaultInboundAction).toLowerCase() === 'allow') status = 'default-allow'
        else if (subnet) { status = 'local-subnet-permission'; matchedRule = subnet.rule.displayName }
        else if (String(policy.defaultInboundAction).toLowerCase() === 'block') status = 'missing-permission'
      }
      return { port, status, rule: matchedRule }
    })
    const problem = endpointResults.some(x => ['blocked', 'missing-permission'].includes(x.status))
    const uncertain = endpointResults.some(x => x.status === 'unknown')
    return { name: network.name || network.interfaceAlias || 'ağ', category: network.category || null,
      covered: uncertain ? null : !problem, rule: endpointResults.find(x => x.rule)?.rule || null,
      ports: endpointResults, problem, uncertain }
  })
  const blocked = networks.filter(x => x.problem)
  const uncertain = !networks.length || networks.some(x => x.uncertain)
  const scoped = networks.some(x => x.ports.some(p => p.status === 'local-subnet-permission'))
  return { checked: networks.length > 0, connectivityVerified: false, networks, blocked,
    noRulesAtAll: !rules.some(x => String(x.action || '').toLowerCase() === 'allow' && !no(x.enabled)),
    problem: blocked.length > 0, uncertain,
    message: blocked.length
      ? `Windows kural denetimi: ${blocked.map(x => `${x.name} (${x.ports.filter(p => ['blocked', 'missing-permission'].includes(p.status)).map(p => p.port).join(', ')})`).join('; ')} için engel veya eksik izin bulundu. Etkin kural ayrıntılarını ve telefondan erişimi kontrol edin.`
      : uncertain ? 'Windows kural kapsamı tam doğrulanamadı; telefondan ağ erişimi ayrıca sınanmalı.'
        : scoped ? 'Windows izni yerel alt ağ ile sınırlı; diğer router ağından erişim ayrıca doğrulanmalı.'
          : null }
}

function readWindowsNetworkPosture({ execFile = require('child_process').execFile, ports = [8090, 8443], program = process.execPath } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  // Read the effective store and associated filters, including rules with other names.
  // Get-NetFirewallPortFilter plus five sibling filter cmdlets takes roughly 30 seconds on
  // a normal Windows install (hundreds of rules). The desktop check used to time out before
  // it had an answer. HNetCfg.FwPolicy2 exposes the same effective rules in one COM snapshot;
  // it is both available on supported Windows versions and fast enough for the five-second
  // post-boot check. A query failure invalidates the snapshot instead of turning missing data
  // into a denial.
  const script = `
    $ErrorActionPreference = 'Stop';
    $p = @(Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | ForEach-Object {
      $n = $_; $ips = @(Get-NetIPAddress -InterfaceIndex $n.InterfaceIndex -AddressFamily IPv4);
      foreach ($ip in $ips) { @{ name=[string]$n.Name; category=[string]$n.NetworkCategory; interfaceAlias=[string]$n.InterfaceAlias; ip=[string]$ip.IPAddress } }
    });
    $policies = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
      @{ name=[string]$_.Name; enabled=[string]$_.Enabled; defaultInboundAction=[string]$_.DefaultInboundAction; allowInboundRules=[string]$_.AllowInboundRules }
    });
    function RuleValues { param([object]$Raw)
      if ($null -eq $Raw) { return @('Any') }
      $items = @($Raw | ForEach-Object { [string]$_ } | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($items.Count -eq 0 -or $items -contains '*' -or $items -contains 'All') { return @('Any') }
      return $items
    }
    $fw = New-Object -ComObject HNetCfg.FwPolicy2;
    $r = @($fw.Rules | Where-Object { $_.Enabled -and ([int]$_.Direction -eq 1) -and ([int]$_.Protocol -eq 6 -or [int]$_.Protocol -eq 256) } | ForEach-Object {
      $rule = $_; $profilesForRule = @(); $profileBits = [int64]$rule.Profiles;
      if ($profileBits -eq 2147483647) { $profilesForRule = @('Any') }
      else { if (($profileBits -band 1) -ne 0) { $profilesForRule += 'Domain' }; if (($profileBits -band 2) -ne 0) { $profilesForRule += 'Private' }; if (($profileBits -band 4) -ne 0) { $profilesForRule += 'Public' }; if ($profilesForRule.Count -eq 0) { $profilesForRule = @('Any') } }
      $action = if ([int]$rule.Action -eq 1) { 'Allow' } else { 'Block' };
      $protocol = if ([int]$rule.Protocol -eq 6) { 'TCP' } else { 'Any' };
      $programName = if ($rule.ApplicationName) { [string]$rule.ApplicationName } else { 'Any' };
      $serviceName = if ($rule.ServiceName) { [string]$rule.ServiceName } else { 'Any' };
      $auth = if ($rule.AuthMethods) { [string]$rule.AuthMethods } else { 'NotRequired' };
      @{ displayName=[string]$rule.Name; profile=$profilesForRule; enabled=[bool]$rule.Enabled; action=$action;
         protocol=$protocol; localPort=@(RuleValues $rule.LocalPorts); program=$programName; service=$serviceName;
         localAddress=@(RuleValues $rule.LocalAddresses); remoteAddress=@(RuleValues $rule.RemoteAddresses); interfaceAlias=@(RuleValues $rule.Interfaces);
         interfaceType=@(RuleValues $rule.InterfaceTypes); authentication=$auth }
    });
    ConvertTo-Json @{ profiles=$p; policies=$policies; rules=$r } -Depth 7 -Compress
  `
  return new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      try { resolve(assessFirewall({ ...JSON.parse(String(stdout)), ports, program })) }
      catch { resolve(null) }
    }))
}
module.exports = { assessFirewall, ruleCovers, readWindowsNetworkPosture }
