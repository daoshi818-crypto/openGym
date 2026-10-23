import { baseUrlFor } from '../../../api/coach/core/providers.js'
import { fingerprint } from '../../../api/coach/core/debrief-selection.js'
export function credentialScope(settings) {
  const provider = settings?.provider
  if (!provider) return null
  const raw = baseUrlFor(provider, { providerOptions: { [provider]: { baseUrl: settings.baseUrl || '' } } })
  let endpoint = raw
  try { const url = new URL(raw); url.hash = ''; url.search = ''; endpoint = url.href.replace(/\/+$/, '') } catch { return null }
  return fingerprint({ provider, endpoint })
}
