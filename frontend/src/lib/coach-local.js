// The Coach, on a phone that brings its own API key.
//
// No server. The pipeline the server runs — payload allowlist, prompt, provider call, parser,
// validator, one repair round — is imported from api/coach/core and run here, in-process, so
// the phone gets exactly the code the server has and not a second opinion of it. The apply
// engine, staleness, snapshot/revert and the log are the ones every build already uses.
//
// This module is the one static importer of the core, which makes `import('./coach-local.js')`
// the whole lazy chunk: the exercise catalogue, the prompts and the validator arrive together
// and only after the user chose this mode. coach-api.js dispatches here the same way it
// dispatches to the demo provider, so the screens never learn that there is no server.
//
// What is different from the server, and on purpose:
//   - the user pays. There is no cfg.caps to lean on, so a local daily cap is not optional —
//     but on a LAN model even that is friction, so it is one of the three dials the setup
//     screen's Advanced section keeps in the device file (#527).
//   - the pseudonym is drawn at random once and kept, rather than derived from a secret.
//   - a proposal waits in the device file, not in S, so it survives an app kill without
//     riding into a backup or a sync.
import * as payloadLib from '../../../api/coach/core/payload.js'
import { runPipeline } from '../../../api/coach/core/pipeline.js'
import { waitingProposal } from '../../../api/coach/core/pending.js'
import { isDue } from '../../../api/coach/core/due.js'
import { HTTP_PROVIDERS, baseUrlFor } from '../../../api/coach/core/providers.js'
import anthropic from '../../../api/coach/core/adapters/anthropic.js'
import openai from '../../../api/coach/core/adapters/openai.js'
import gemini from '../../../api/coach/core/adapters/gemini.js'
import compatible from '../../../api/coach/core/adapters/compatible.js'
import { modelSubstitute } from '../../../api/coach/core/adapters/http.js'
import { nativeFetch } from './capacitor-fetch.js'
import { getApiKey } from './coach-secrets.js'
import { loadCoachDevice, saveCoachDevice, coachLimits } from './coach-device.js'
import { planHash } from './coach.js'
import { todayISO } from './format.js'
import { t, getLang } from './i18n.js'
import { prepareCoachRequest, assertPayloadSize } from '../../../api/coach/core/preflight.js'
import { debriefMetadata } from '../../../api/coach/core/debrief-report.js'
import { coachContext } from '../../../api/coach/core/context.js'
import { fingerprint } from '../../../api/coach/core/debrief-selection.js'

export const ADAPTERS = { anthropic, openai, gemini, compatible }
// Five minutes is right for a cloud API and wrong for a model on somebody's laptop; the
// OpenAI-compatible endpoint is the one that may be local, so it gets the long budget.
export const TIMEOUT_MS = 5 * 60000
export const LOCAL_ENDPOINT_TIMEOUT_MS = 25 * 60000
export const timeoutFor = provider => (provider === 'compatible' ? LOCAL_ENDPOINT_TIMEOUT_MS : TIMEOUT_MS)
const PENDING_DAYS = 14
const HANDLE_LENGTH = 16

let job = null
let starting = false
let generation = 0
let controller = null
let recovered = false
let lastError = null
let last = null   // how the most recent job ended — the same shape the server's status() reports
// Reported to the screens through the same status shape the server answers with; a toast is
// also raised because on the server a failed job lands in the admin card, and here there is
// no admin card — the user is the operator.
let notify = null
export function setNotifier(fn) { notify = fn }

/* ---------- what this phone is configured with ---------- */

const cfgOf = d => ({ provider: d.provider, providerOptions: d.baseUrl ? { [d.provider]: { baseUrl: d.baseUrl } } : {} })
const envOf = (d, key) => (key ? { [HTTP_PROVIDERS[d.provider].apiKeyEnv]: key } : {})

function mintHandle() {
  const bytes = new Uint8Array(12)
  ;(globalThis.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256) })
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, HANDLE_LENGTH)
}
async function handle(mine) {
  const d = await loadCoachDevice()
  if (d.handle && d.handle.length === HANDLE_LENGTH) return d.handle
  const h = mintHandle()
  await saveCoachDevice(() => mine === generation ? { handle: h } : null)
  if (mine !== generation) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
  return h
}

/* ---------- the cap ---------- */

async function capState() {
  const d = await loadCoachDevice()
  const today = todayISO()
  const used = d.daily && d.daily.d === today ? d.daily.n : 0
  return { used, limit: coachLimits(d).daily }
}
async function bumpDaily() {
  const { used } = await capState()
  await saveCoachDevice({ daily: { d: todayISO(), n: used + 1 } })
}

/* ---------- the API surface coach-api.js dispatches to ---------- */

export async function localStatus() {
  const d = await loadCoachDevice()
  if (d.pending && d.pending.expiresAt && d.pending.expiresAt < Date.now()) await saveCoachDevice({ pending: null })
  if (!recovered && !job && !starting) {
    recovered = true
    if (d.current) {
      const ended = { id: d.current.id, kind: d.current.kind, outcome: 'failed', errorClass: 'interrupted', at: Date.now() }
      await saveCoachDevice({ current: null, last: ended })
      last = ended
    } else last = d.last || last
  }
  return { job, pending: (await loadCoachDevice()).pending || null, cap: await capState(), lastError, last, debriefSelectionVersion: 2, decisionVersion: 2, maxMessageLen: coachLimits(d).maxMessageLen }
}

export const localReview = async (S, note, scope) => { const d = await loadCoachDevice(); return start(S, 'review', { note: note ? String(note).slice(0, coachLimits(d).maxMessageLen) : null, scope }) }

export const localPlan = (S, intake) => start(S, 'create', { intake: intake || null })
export const localRefine = async (S, text) => {
  const d = await loadCoachDevice()
  const pendingCreate = d.pending && d.pending.kind === 'create' ? d.pending : null
  return start(S, 'create', { refine: String(text || '').slice(0, coachLimits(d).maxMessageLen), previous: pendingCreate?.bundle || null, iteration: (pendingCreate?.iteration || 1) + 1 })
}
export const localDebrief = (S, selection) => start(S, 'debrief', {
  debriefSelection: selection && typeof selection === 'object' ? selection : null,
  workoutId: typeof selection === 'string' ? selection : selection?.mode === 'single' ? selection.refs?.[0]?.value || null : null
})
export async function localResolve(body = {}) {
  const d = await loadCoachDevice()
  if ([body.proposalId, body.requestId].some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) throw Object.assign(new Error('pending_mismatch'), { code: 'pending_mismatch', data: { code: 'pending_mismatch' } })
  if (Object.hasOwn(d.resolved || {}, body.proposalId)) return { ok: true, alreadyResolved: true }
  if (d.pending?.id !== body.proposalId) throw Object.assign(new Error('pending_mismatch'), { code: 'pending_mismatch', data: { code: 'pending_mismatch' } })
  await saveCoachDevice(current => {
    if (current.resolved?.[body.proposalId]) return null
    if (current.pending?.id !== body.proposalId) throw Object.assign(new Error('pending_mismatch'), { code: 'pending_mismatch' })
    return { pending: current.pending?.kind === 'ask' ? waitingProposal(current.pending.prev) : null, resolved: { ...Object.fromEntries(Object.entries(current.resolved || {}).filter(([, at]) => Date.now() - at < 21 * 864e5)), [body.proposalId]: Date.now() } } })
  return { ok: true, proposalId: body.proposalId }
}
export const localAsk = async (S, text, today) => {

  const d = await loadCoachDevice()
  return start(S, 'ask', { note: String(text || '').slice(0, coachLimits(d).maxMessageLen), today: today || null })
}

/* Automatic reviews. On a server the cadence tick runs them (api/coach/cadence.js); a phone with
   its own key has no server, and for a long time nothing ran them at all: the setting saved, the
   reviews never came (Discord, 10-19). So the phone asks the same question, with the same rule
   (core/due.js), whenever the app is open (lib/coach-schedule.js): right after a workout, and on
   the first open after a weekly slot. `reviewedAt` in the device file is the run marker, kept
   the way the server keeps its job history: a review the model answered counts, whether it
   proposed something, found nothing to change, or answered unusably (paid for all the same).
   Returns the started job, or null when nothing is due. Never throws: a skip is silent. */
export async function localScheduled(S, now = new Date()) {
  const cadence = S?.coach?.cadence
  if (job || !cadence || cadence === 'off' || !S?.coach?.consent?.agreedAt) return null
  const d = await loadCoachDevice()
  if (d.mode !== 'byok' || !ADAPTERS[d.provider]) return null
  // A proposal nobody has answered is not replaced by the next one, as on the server.
  if (d.pending && !(d.pending.expiresAt && d.pending.expiresAt < now.getTime())) return null
  const cap = await capState()
  if (cap.limit > 0 && cap.used >= cap.limit) return null
  const tz = deviceZone()
  if (!isDue(S.coach, S, wallClock(now), d.reviewedAt || 0, tz)) return null
  try { return await start(S, 'review', { scheduled: true }) } catch { return null }

}
export async function localForget() {
  generation++; controller?.abort(); controller = null
  const cancelled = job ? { id: job.id, kind: job.kind, outcome: 'cancelled', at: Date.now() } : null
  job = null; lastError = null; last = cancelled
  await saveCoachDevice({ pending: null, current: null, last: cancelled, handle: null, resolved: null })
  return { ok: true }
}
export async function cancelLocalJob() {
  generation++; controller?.abort(); controller = null
  const cancelled = job ? { id: job.id, kind: job.kind, outcome: 'cancelled', at: Date.now() } : null
  job = null
  await saveCoachDevice(current => current.current ? { current: null, last: cancelled || { ...current.current, outcome: 'cancelled', at: Date.now() } } : null)
}




export async function localDisclosure() {
  const d = await loadCoachDevice()
  const meta = HTTP_PROVIDERS[d.provider] || {}
  const base = d.provider ? baseUrlFor(d.provider, cfgOf(d)) : ''
  return {
    provider: d.provider, providerLabel: meta.label || t('the configured AI provider'),
    categories: payloadLib.DATA_CATEGORIES, version: 2,
    // The honest difference from the self-hosted flow: it is the user's own account.
    payer: 'you', host: hostOf(base)
  }
}

/** The models the configured endpoint serves — the setup screen's list, and its reachability test. */
export async function localModels(settings, key) {
  const adapter = ADAPTERS[settings.provider]
  if (!adapter) return { ok: false, error: 'unknown provider', models: [] }
  return adapter.models(cfgOf(settings), envOf(settings, key), { fetch: nativeFetch, timeoutMs: 20000 })
}

const hostOf = url => { try { return new URL(url).host } catch { return url || '' } }

/* ---------- running a job ---------- */

async function start(S, kind, options) {
  if (starting || job) throw Object.assign(new Error(t('The Coach is already thinking about your training.')), { status: 409, code: 'busy' })
  starting = true
  const mine = generation
  try {
    const snapshot = JSON.parse(JSON.stringify(S))
    const opts = prepareCoachRequest(snapshot, kind, options)
    const d = await loadCoachDevice()
    const adapter = ADAPTERS[d.provider]
    if (mine !== generation) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    if (d.mode !== 'byok' || !adapter) throw Object.assign(new Error(t('The Coach isn’t set up on this phone.')), { code: 'off' })
    const payload = assertPayloadSize(payloadLib.build(snapshot, {
      handle: await handle(mine), kind, ...opts, lang: getLang()
    }), payloadLib.MAX_PAYLOAD_CHARS)
    const key = await getApiKey(d)
    if (!key && !HTTP_PROVIDERS[d.provider].keyOptional) throw Object.assign(new Error('No API key configured'), { code: 'missing' })
    if (mine !== generation) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
    const cap = await capState()
    if (cap.limit > 0 && cap.used >= cap.limit) throw Object.assign(new Error(t('The Coach is taking a breather. You’ve used today’s {0} runs on this phone.', cap.limit)), { status: 429, code: 'cap' })
    const startedAt = Date.now()
    const ctx = { id: 'local-' + (globalThis.crypto?.randomUUID?.() || startedAt.toString(36) + Math.random().toString(36).slice(2)), kind, state: 'running', startedAt, ...(opts.scheduled ? { trigger: 'scheduled' } : {}),
      generation: mine, modeFingerprint: fingerprint({ mode: d.mode, provider: d.provider, baseUrl: d.baseUrl, model: d.model }), deadlineAt: startedAt + timeoutFor(d.provider) }
    const ctl = new AbortController()
    await saveCoachDevice(current => mine === generation ? { daily: { d: todayISO(), n: (current.daily?.d === todayISO() ? current.daily.n : 0) + 1 }, current: ctx } : null)
    if (mine !== generation) { await saveCoachDevice(current => current.current?.id === ctx.id ? { current: null } : null); throw Object.assign(new Error('cancelled'), { code: 'cancelled' }) }
    job = ctx; controller = ctl; lastError = null; recovered = true
    const owns = () => generation === ctx.generation && job?.id === ctx.id
    run(snapshot, kind, opts, d, adapter, payload, key, ctx, ctl, owns)
      .catch(async e => {
        if (!owns()) return
        lastError = { errorClass: e.code || 'internal', detail: String(e?.message || e).slice(0, 300) }
        last = { id: ctx.id, kind, outcome: 'failed', errorClass: lastError.errorClass, at: Date.now() }
        await saveCoachDevice(current => owns() ? { last, current: null } : null)
      }).catch(() => {}).finally(() => { if (owns()) { job = null; controller = null } })
    return { job: { ...ctx } }
  } finally { starting = false }


}

async function run(S, kind, opts, d, adapter, payload, key, ctx, ctl, owns) {
  const current = await loadCoachDevice()
  if (!owns()) return
  if (fingerprint({ mode: current.mode, provider: current.provider, baseUrl: current.baseUrl, model: current.model }) !== ctx.modeFingerprint) throw Object.assign(new Error('Configuration changed'), { code: 'cancelled' })

  const model = d.model || HTTP_PROVIDERS[d.provider].defaultModel
  const attempt = await runPipeline({
    adapter, cfg: cfgOf(d), kind, payload,
    model: d.model || HTTP_PROVIDERS[d.provider].defaultModel,
    timeoutMs: Math.max(1, ctx.deadlineAt - Date.now()), deadlineAt: ctx.deadlineAt,
    invokeOpts: { env: envOf(d, key), fetch: nativeFetch, signal: ctl.signal, maxTokens: coachLimits(d).maxOutputTokens }

  })
  if (!owns()) return
  // The saved model was refused and another one answered (#758): keep that one, so the next
  // launch does not pay for the same 404 again. The setup screen shows the new name.
  const swapped = model && modelSubstitute(d.provider, cfgOf(d), model)
  if (swapped && swapped !== d.model) await saveCoachDevice({ model: swapped })

  if (!attempt.ok) {
    const detail = attempt.detail || (attempt.errors || []).slice(0, 3).map(String).join(' · ').slice(0, 300) || null
    lastError = { errorClass: attempt.errorClass, detail }
    last = { id: ctx.id, kind, outcome: 'failed', errorClass: attempt.errorClass, at: Date.now() }
    await saveCoachDevice(current => owns() ? { current: null, last, ...(kind === 'review' && attempt.errorClass === 'unusable' ? { reviewedAt: Date.now() } : {}) } : null)
    if (owns()) notify?.({ kind: 'failed', errorClass: attempt.errorClass, detail, scheduled: !!opts.scheduled })
    return
  }
  if (attempt.nochange) {
    last = { id: ctx.id, kind, outcome: 'nochange', errorClass: null, at: Date.now(), reading: attempt.reading }
    await saveCoachDevice(current => owns() ? { current: null, last, pending: null, ...(kind === 'review' ? { reviewedAt: Date.now() } : {}) } : null)
    if (owns()) notify?.({ kind: 'nochange', reading: attempt.reading, scheduled: !!opts.scheduled })

    return
  }
  const pending = {
    ...(kind === 'ask' ? { prev: waitingProposal((await loadCoachDevice()).pending) } : {}),
    ...attempt.result, id: ctx.id, kind, createdAt: Date.now(), expiresAt: Date.now() + PENDING_DAYS * 86400000,
    planHash: planHash(S), context: coachContext(S, planHash(S), opts.scope), scope: opts.scope || null, iteration: opts.iteration || 1,
    ...(kind === 'debrief' ? debriefMetadata(payload) : {}),
    ...(kind === 'create' ? { bundle: { ...attempt.result.bundle, unit: payload.meta.unit } } : {})

  }
  last = { id: ctx.id, kind, outcome: 'ready', errorClass: null, at: Date.now() }
  await saveCoachDevice(current => owns() ? { pending, current: null, last, ...(kind === 'review' ? { reviewedAt: Date.now() } : {}) } : null)
  if (owns()) notify?.({ kind: 'ready', pending, scheduled: !!opts.scheduled })

}
// Any review the model read counts as the latest one, asked for or scheduled, as on the server.
const markReviewed = () => saveCoachDevice({ reviewedAt: Date.now() })

export function _resetLocal() {
  generation++; controller?.abort(); controller = null; job = null; starting = false; lastError = null; last = null; recovered = false
}

export function wallClock(now) { const p=n=>String(n).padStart(2,'0'); return { date: `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}`, hhmm: `${p(now.getHours())}:${p(now.getMinutes())}`, weekday: now.getDay() } }
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null } }
