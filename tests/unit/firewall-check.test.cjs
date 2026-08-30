// This verdict is shown to the operator as an explanation for why phones cannot connect. A
// wrong one is worse than none: a false alarm sends someone changing Windows settings that
// were never the problem, and a missed one leaves the café exactly where it started.
//
// So the edges are pinned down here, against data shapes taken from a real machine
// (Get-NetConnectionProfile / Get-NetFirewallRule) rather than invented.

const test = require('node:test')
const assert = require('node:assert')
const { assessFirewall, ruleCovers } = require('../../server/firewall-check.cjs')

const network = (name, category) => ({ name, category, interfaceAlias: 'Ethernet' })
const rule = (displayName, profile) => ({ displayName, profile, enabled: true, action: 'Allow' })

test('Public ağda Private kural kapsamaz — kafenin muhtemel arızası', () => {
  // The installer ran on the old network and scoped the rule to Private. A new router makes
  // Windows file the network as Public, and the same rule silently stops applying.
  const result = assessFirewall({
    profiles: [network('Kafe Wi-Fi', 'Public')],
    rules: [rule('Rovli Radyo', 'Private')]
  })
  assert.equal(result.problem, true)
  assert.match(result.message, /Genel/)
  assert.match(result.message, /Özel/, 'ne yapılacağını söylemeli')
})

test('Any profilli kural her ağı kapsar', () => {
  // What this project's own installer writes.
  for (const category of ['Public', 'Private', 'DomainAuthenticated']) {
    const result = assessFirewall({ profiles: [network('Ağ', category)], rules: [rule('Rovli Radyo', 'Any')] })
    assert.equal(result.problem, false, `${category} kapsanmalı`)
  }
})

test('birleşik profil listesi üye üye eşleşir', () => {
  const result = assessFirewall({
    profiles: [network('Kafe', 'Public')],
    rules: [rule('Rovli Radyo', 'Private, Public')]
  })
  assert.equal(result.problem, false)
})

test('etki alanı ağı ile Domain profili eşleşir', () => {
  // The category is called DomainAuthenticated; the firewall calls the same thing Domain.
  assert.equal(ruleCovers('Domain', 'DomainAuthenticated'), true)
  assert.equal(ruleCovers('Private', 'DomainAuthenticated'), false)
})

test('kapalı ve engelleyen kurallar sayılmaz', () => {
  // A disabled rule and a Block rule are both present on real machines and neither lets
  // anyone in; treating them as coverage would produce a confident, wrong "everything fine".
  const result = assessFirewall({
    profiles: [network('Kafe', 'Public')],
    rules: [
      { displayName: 'Kapalı', profile: 'Any', enabled: false, action: 'Allow' },
      { displayName: 'Engelle', profile: 'Any', enabled: true, action: 'Block' }
    ]
  })
  assert.equal(result.problem, true)
})

test('birden çok ağdan yalnızca kapsanmayanı bildirir', () => {
  // Two routers is the café's actual situation: one network may be fine while the other,
  // the one the phones are on, is not.
  const result = assessFirewall({
    profiles: [network('Ofis', 'Private'), network('Kafe Misafir', 'Public')],
    rules: [rule('Rovli Radyo', 'Private')]
  })
  assert.equal(result.problem, true)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].name, 'Kafe Misafir')
})

test('hepsi kapsanıyorsa hiçbir şey söylenmez', () => {
  const result = assessFirewall({
    profiles: [network('Ofis', 'Private')],
    rules: [rule('Rovli Radyo', 'Private')]
  })
  assert.equal(result.problem, false)
  assert.equal(result.message, null)
})

test('bilgi alınamadıysa hüküm verilmez', () => {
  // Windows may refuse the query, the machine may be something else entirely. Silence is the
  // only honest answer — a warning with no evidence behind it teaches the operator to ignore
  // the panel, which is the failure this whole line of work exists to undo.
  const bos = assessFirewall({ profiles: [], rules: [] })
  assert.equal(bos.checked, false)
  assert.equal(bos.problem, false)
  assert.equal(assessFirewall({}).problem, false)
  assert.equal(assessFirewall().problem, false)
})

test('kategorisi bilinmeyen ağ hakkında hüküm verilmez', () => {
  // Windows reports an empty category while a network is still being identified. That is a
  // "not yet", not a fault — and the check runs at startup, exactly when that happens.
  const result = assessFirewall({ profiles: [network('Yeni Ağ', '')], rules: [rule('Rovli Radyo', 'Any')] })
  assert.equal(result.blocked.length, 1, 'kategori bilinmiyorsa kapsandığı da iddia edilemez')
  assert.ok(result.message, 'yine de bir şey söylenmeli')
})
