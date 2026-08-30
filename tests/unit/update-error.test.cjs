// The panel shows updater errors to the operator. Right now the repository is public and
// nothing has been released yet, which means every packaged café PC would carry a permanent
// amber line saying the update check failed — on a station that is working perfectly.
//
// That is the exact habit this project keeps having to undo: a panel that cries wolf gets
// ignored, and then the one line that matters gets ignored with it.
//
// The line between "nothing published" and "something is actually wrong" is the whole point,
// so both sides of it are pinned here.

const test = require('node:test')
const assert = require('node:assert')
const { classifyUpdateError, looksLikeNoRelease } = require('../../server/update-error.cjs')

test('yayınlanmış sürüm yoksa bu bir arıza sayılmaz', () => {
  // The wording differs between electron-updater versions, so several shapes of the same
  // fact are recognised.
  const messages = [
    'HttpError: 404 Not Found',
    'Cannot find latest.yml in the latest release artifacts',
    'Unable to find latest version on GitHub, please ensure a production release exists',
    'No published versions on GitHub'
  ]
  for (const message of messages) {
    const verdict = classifyUpdateError(new Error(message))
    assert.equal(verdict.error, null, `operatöre hata gösterilmemeli: ${message}`)
    assert.equal(verdict.noReleaseYet, true, `teşhis için işaretlenmeli: ${message}`)
  }
})

test('gerçek arızalar olduğu gibi gösterilir', () => {
  // The other half. Hiding a real failure would be the same mistake in the other direction:
  // the café would sit on an old version believing it updates itself.
  const cases = [
    'getaddrinfo ENOTFOUND github.com',
    'net::ERR_INTERNET_DISCONNECTED',
    'Error: certificate has expired',
    'HttpError: 403 rate limit exceeded'
  ]
  for (const message of cases) {
    const verdict = classifyUpdateError(new Error(message))
    assert.ok(verdict.error, `hata gösterilmeli: ${message}`)
    assert.equal(verdict.noReleaseYet, false)
    assert.match(verdict.error, new RegExp(message.split(':').pop().trim().slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('aşırı uzun hata mesajı kırpılır', () => {
  // Some of these arrive with a stack trace attached, and it would be laid across the card.
  const verdict = classifyUpdateError(new Error('X'.repeat(1000)))
  assert.ok(verdict.error.length <= 200)
})

test('mesajsız hata da anlamlı bir şey söyler', () => {
  // An updater failure with nothing in it must not render as an empty warning line, which
  // reads as a broken panel rather than a broken update.
  assert.ok(classifyUpdateError(new Error('')).error)
  assert.ok(classifyUpdateError(null).error)
  assert.ok(classifyUpdateError(undefined).error)
})

test('403 yetki hatası 404 ile karıştırılmaz', () => {
  // A private repository answers 403, and that IS a misconfiguration worth showing —
  // matching too broadly on numbers would swallow it.
  assert.equal(looksLikeNoRelease(new Error('HttpError: 403 Forbidden')), false)
})

test('ilgisiz metinde geçen sayı yanlış eşleşmez', () => {
  assert.equal(looksLikeNoRelease(new Error('Downloaded 1404 bytes, checksum mismatch')), false)
})
