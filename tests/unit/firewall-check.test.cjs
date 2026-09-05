const test = require('node:test')
const assert = require('node:assert/strict')
const { assessFirewall, ruleCovers } = require('../../server/firewall-check.cjs')

const program = 'C:\\Apps\\Rovli Radyo.exe'
const profile = { name: 'Kafe', category: 'Public', interfaceAlias: 'Wi-Fi', ip: '192.168.1.5' }
const policy = { name: 'Public', enabled: true, defaultInboundAction: 'Block', allowInboundRules: true }
const rule = (extra = {}) => ({ displayName: 'Farklı isimli izin', profile: 'Any', enabled: true, action: 'Allow',
  protocol: 'TCP', localPort: ['8090', '8443'], program, service: 'Any', localAddress: ['Any'], remoteAddress: ['Any'],
  interfaceAlias: ['Any'], interfaceType: 'Any', authentication: 'NotRequired', ...extra })
const assess = (rules, extra = {}) => assessFirewall({ profiles: [profile], policies: [policy], rules, ports: [8090, 8443], program, ...extra })

test('yalnız HTTPS izni HTTP erişimini kapsıyor sayılmaz', () => {
  const result = assess([rule({ localPort: ['8443'] })])
  assert.equal(result.networks[0].ports[0].status, 'missing-permission')
  assert.equal(result.networks[0].ports[1].status, 'permission-found')
  assert.equal(result.problem, true)
  assert.equal(result.connectivityVerified, false)
})
test('çakışan Block izinlerden önce raporlanır', () => {
  const result = assess([rule(), rule({ action: 'Block', localPort: ['8090'] })])
  assert.equal(result.networks[0].ports[0].status, 'blocked')
  assert.equal(result.problem, true)
})
test('yanlış program yolu ve UDP izni TCP istasyon izni sayılmaz', () => {
  for (const wrong of [{ program: 'C:\\Old\\Rovli Radyo.exe' }, { protocol: 'UDP' }, { localAddress: ['192.168.2.5'] }, { service: 'OtherService' }]) {
    assert.equal(assess([rule(wrong)]).networks[0].ports[0].status, 'missing-permission')
  }
})
test('kurala isim yerine gerçek filtreleriyle bakılır', () => {
  const result = assess([rule()])
  assert.equal(result.problem, false)
  assert.equal(result.networks[0].ports[0].status, 'permission-found')
  assert.equal(result.connectivityVerified, false, 'izin bulmak telefon erişimini kanıtlamaz')
})
test('Windows filtrelerinde büyük/küçük harf farkı sonucu değiştirmez', () => {
  const result = assess([rule({ action: 'allow', profile: 'any', interfaceAlias: ['wi-fi'] })])
  assert.equal(result.networks[0].ports[0].status, 'permission-found')
})
test('kapalı güvenlik duvarı ve varsayılan Allow için izinsizdir uyarısı verilmez', () => {
  assert.equal(assess([], { policies: [{ ...policy, enabled: false }] }).problem, false)
  assert.equal(assess([], { policies: [{ ...policy, defaultInboundAction: 'Allow' }] }).problem, false)
})
test('açık tüm gelenleri engelle politikası Allow kuralıyla gizlenmez', () => {
  const result = assess([rule()], { policies: [{ ...policy, allowInboundRules: false }] })
  assert.equal(result.networks[0].ports[0].status, 'blocked')
})
test('eksik veya sınırlı filtre verisi kesin hüküm oluşturmaz', () => {
  const result = assess([{ displayName: 'Rovli', action: 'Allow', profile: 'Any' }])
  assert.equal(result.networks[0].ports[0].status, 'unknown')
  assert.equal(result.uncertain, true)
  assert.equal(result.problem, false)
  assert.match(result.message, /doğrulanamadı/)
  assert.equal(assess([rule({ remoteAddress: ['10.0.0.0/24'] })]).uncertain, true)
})
test('LocalSubnet izni uzak router ağına erişim garantisi vermez', () => {
  const result = assess([rule({ remoteAddress: ['LocalSubnet'] })])
  assert.equal(result.networks[0].ports[0].status, 'local-subnet-permission')
  assert.equal(result.connectivityVerified, false)
  assert.match(result.message, /alt ağ/)
})
test('profil üyeleri eşleşir fakat boş kategori bilinmez', () => {
  assert.equal(ruleCovers('Private, Public', 'Public'), true)
  assert.equal(ruleCovers('Private', 'Public'), false)
  assert.equal(ruleCovers('Domain', 'DomainAuthenticated'), true)
  assert.equal(ruleCovers('Any', ''), false)
  assert.equal(ruleCovers('', 'Public'), false)
})
test('Windows bilgisi alınmadıysa erişim hakkında hüküm verilmez', () => {
  const result = assessFirewall()
  assert.equal(result.checked, false)
  assert.equal(result.problem, false)
  assert.equal(result.connectivityVerified, false)
})
test('PowerShell tek kayıt döndürdüğünde de güvenlik duvarı denetlenir', () => {
  const result = assessFirewall({ profiles: profile, policies: policy, rules: rule(), ports: [8090], program })
  assert.equal(result.checked, true)
  assert.equal(result.networks[0].ports[0].status, 'permission-found')
  assert.equal(result.problem, false)
})
test('IPv4 aralık filtresi bu ağdaki etkin Block kuralını yakalar', () => {
  const result = assess([rule({ action: 'Block', remoteAddress: ['0.0.0.0-255.255.255.255'] })])
  assert.equal(result.networks[0].ports[0].status, 'blocked')
  assert.equal(result.problem, true)
})
test('noktalı IPv4 netmask filtresi doğru eşleşir', () => {
  const result = assess([rule({ action: 'Block', remoteAddress: ['192.168.1.0/255.255.255.0'] })])
  assert.equal(result.networks[0].ports[0].status, 'blocked')
  assert.equal(result.problem, true)
})
