// Update check — compares the installed version (__APP_VERSION__) against the latest release
// metadata and optionally downloads + installs the APK.
//
// The release metadata is static so the phone does not need to reach the GitHub API. GitHub is
// still the release and APK host; the metadata file contains the signed asset URLs.
// On Android (Capacitor) the APK is downloaded natively into the cache directory (an APK with
// the animations is ~300 MB: read into the WebView's memory it ran phones out of it, and
// github.com's download redirect has no CORS headers for a WebView fetch anyway), checked
// against its SHA-256 by the native Install plugin and handed to the system installer.

import { MOBILE } from './mobile.js'

const REPO = 'daoshi818-crypto/openGym'   // [fork] 指向自己的 fork：Actions 会把官方更新 rebase 本地定制后自动构建签名，发布到这里
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

// The CDN keeps a domestic-accessible path; origin avoids stale branch-cache metadata after
// a release. Either source may fail, and the newer successful manifest wins.
const UPDATE_PROXY = 'https://cdn.jsdelivr.net/gh/daoshi818-crypto/openGym@main/update.json'
const updateUrl = () => `${UPDATE_PROXY}?og=${Math.floor(Date.now() / 3600000)}`
const UPDATE_ORIGIN = `https://raw.githubusercontent.com/${REPO}/main/update.json`

/**
 * Compares two semver strings (e.g. "1.2.11" vs "1.3.0").
 * Returns  1 if a > b, -1 if a < b, 0 if equal.
 *
 * Build metadata is dropped first. A version that says which build it came from carries it as
 * semver build metadata ("1.3.8+2026-09-18.2"), and splitting that on "." makes the patch NaN —
 * which read as 0, so a release tagged that way compared as 1.3.0 and a real update went
 * unnoticed. Semver says the metadata plays no part in precedence, so "1.3.7+anything" and
 * "1.3.7" are the same version here. Dropped on both operands, so it holds whichever side
 * carries it.
 */
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('+')[0].split('.').map(Number)
  const pb = b.replace(/^v/, '').split('+')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff > 0) return 1
    if (diff < 0) return -1
  }
  return 0
}

/**
 * Checks the published release metadata for a newer version. The file is maintained alongside
 * the release and contains the signed APK and checksum URLs.
 * Returns { hasUpdate, latestVersion, apkUrl, hashUrl } or throws on network failure.
 *   - hasUpdate: true if the latest release tag is newer than the running build
 *   - latestVersion: the semver string of the latest release (without "v" prefix)
 *   - apkUrl: direct download URL of the first .apk asset, or null
 *   - hashUrl: direct download URL of the .apk.sha256 hash file, or null
 */
// One request per app session: Settings is opened often, the CDN does not need to hear
// about it every time. The promise is cached, a failure is not.
let cached = null
export function resetUpdateCheck() { cached = null }
export async function checkForUpdate() {
  // [fork] 重新启用应用内更新，检查对象是自己的 fork 仓库：
  // Actions 构建的 APK 与本机安装签名一致，可以正常覆盖安装。
  // 官方 DuarteSantos8/openGym 的 release 签名不同，不能用来升级本版本。
  if (!cached) cached = fetchLatest().catch(e => { cached = null; throw e })
  return cached
}
async function fetchLatest() {
  // Bound an unreachable source without letting it hide the other source's newer release.
  const results = await Promise.allSettled([updateUrl(), UPDATE_ORIGIN].map(async url => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`Update metadata ${res.status}`)
      return await res.json()
    } finally { clearTimeout(timeout) }
  }))
  const manifests = results.filter(r => r.status === 'fulfilled' && r.value?.tag_name).map(r => r.value)
  if (!manifests.length && results.every(r => r.status === 'rejected')) throw results[0].reason
  const latest = manifests.sort((a, b) => compareSemver(String(b.tag_name), String(a.tag_name)))[0] || {}
  const latestVersion = String(latest.tag_name || '').replace(/^v/, '')
  if (!latestVersion) return { hasUpdate: false, latestVersion: __APP_VERSION__, apkUrl: null, hashUrl: null }
  const hasUpdate = compareSemver(latestVersion, __APP_VERSION__) > 0
  const assets = latest.assets || []
  const apk = latest.apk_url ? { browser_download_url: latest.apk_url } : assets.find(a => /\.apk$/i.test(a.name))
  const hash = latest.hash_url ? { browser_download_url: latest.hash_url } : assets.find(a => /\.apk\.sha256$/i.test(a.name))
  return { hasUpdate, latestVersion, apkUrl: apk?.browser_download_url || null, hashUrl: hash?.browser_download_url || null }
}

/**
 * The SHA-256 the release publishes next to its APK, as 64 hex characters, or null. In the app it
 * comes down natively like the APK itself (github.com answers a WebView fetch without CORS).
 */
export async function fetchChecksum(hashUrl) {
  if (!hashUrl) return null
  let text
  if (MOBILE) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
    await Filesystem.downloadFile({ url: hashUrl, path: 'opengym-update.apk.sha256', directory: Directory.Cache })
    text = (await Filesystem.readFile({ path: 'opengym-update.apk.sha256', directory: Directory.Cache, encoding: Encoding.UTF8 })).data
  } else {
    const res = await fetch(hashUrl)
    if (!res.ok) return null
    text = await res.text()
  }
  const hex = String(text).trim().split(/\s/)[0]
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null
}

/**
 * Computes the SHA-256 hash of an ArrayBuffer using the Web Crypto API.
 * Returns the hex-encoded digest string.
 */
export async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Downloads the APK from `url` into the cache directory, natively and straight to disk, and
 * hands it to the Install plugin, which checks it against `expectedHash` before the installer
 * opens. Only works on the MOBILE (Capacitor) build with Android.
 *
 * @param {string} url - Direct download URL for the APK
 * @param {string} expectedHash - Expected SHA-256 hex string (from the .sha256 asset)
 * @param {function|null} onProgress - Called with (received, total) bytes during download, or null
 */
export async function downloadAndInstall(url, expectedHash, onProgress = null) {
  if (!MOBILE) {
    window.open(RELEASES_PAGE, '_blank', 'noopener')
    return
  }
  if (!/^[0-9a-f]{64}$/i.test(expectedHash || '')) throw new Error('no checksum to verify the download against')
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const fileName = 'opengym-update.apk'
  const listener = onProgress
    ? await Filesystem.addListener('progress', p => onProgress(p.bytes, p.contentLength))
    : null
  try {
    await Filesystem.downloadFile({ url, path: fileName, directory: Directory.Cache, progress: !!onProgress })
  } finally {
    await listener?.remove()
  }
  // The Install plugin streams the file through SHA-256 natively (300 MB never enter the
  // WebView) and refuses a mismatch before the installer opens.
  const { registerPlugin } = await import('@capacitor/core')
  const Install = registerPlugin('Install')
  await Install.installApk({ fileName, sha256: expectedHash.toLowerCase() })
}
