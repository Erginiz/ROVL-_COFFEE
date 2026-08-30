// A repository with no published release answers the update check with a 404, and
// electron-updater reports that as an error like any other. The café's station is then
// perfectly healthy while its panel carries a permanent amber line — which is how an operator
// learns to stop reading the panel, the habit this project has spent a long time undoing.
//
// This is exactly the state the project is in right now: the repo is public, nothing has been
// released yet, and the packaged app would say so in red on every café PC.
//
// It lives here rather than in electron/main.cjs so it can be tested without Electron, the
// same reason ezan-window, login-brake and firewall-check are separate modules.

// Matched on the message because that is all electron-updater gives: it wraps the HTTP
// failure and the wording differs between its GitHub provider versions. Deliberately narrow —
// anything that is not recognisably "there is no release" stays an error the operator sees.
const NO_RELEASE = /\b404\b|latest\.yml|Unable to find latest version|no published versions|cannot find channel/i

function looksLikeNoRelease(error) {
  return NO_RELEASE.test(String(error?.message || error || ''))
}

// Turns an updater error into what the panel should show. `error` is what the operator sees
// as a warning; `noReleaseYet` is the same fact kept for diagnostics, so a missing release is
// still visible to whoever is looking for it without alarming the café.
function classifyUpdateError(error) {
  if (looksLikeNoRelease(error)) return { error: null, noReleaseYet: true }
  return { error: String(error?.message || error || 'Bilinmeyen güncelleme hatası').slice(0, 200), noReleaseYet: false }
}

module.exports = { looksLikeNoRelease, classifyUpdateError }
