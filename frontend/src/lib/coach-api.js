// Talking to the Coach endpoints, and knowing when to stop.
//
// Jobs are minutes-scale, so the client polls. The one rule worth stating: polling only runs
// while a Coach surface is on screen or a job is known to be in flight. An app that pings the
// server every thirty seconds forever because a feature exists is an app that costs battery
// for a feature nobody is using.

import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from './api.js'
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'
import { t, tn, getLang } from './i18n.js'
import { useStore } from '../store/useStore.js'
import { todayForCoach } from './coach-context.js'
import { useUI } from '../store/useUI.js'

const POLL_MS = 3000        // a job is running: often enough to feel live
const IDLE_MS = 60000       // a Coach screen is open but nothing is running

// The demo build has no backend, so it answers these locally with a canned proposal built
// from its own seeded profile (lib/coach-demo.js). Everything downstream — validation,
// staleness, apply, revert, the log — runs unchanged; only the provider is faked. The module
// is imported dynamically so none of it lands in a self-hosted bundle.
let demoMod = null
const demo = async () => (demoMod = demoMod || await import('./coach-demo.js'))
const S = () => useStore.getState().S
// Each request says which language the app is in: a profile that never picked one has no stored
// `lang` worth trusting — it is worked out per device (#303, lib/default-lang.js) — and the
// Coach should answer in what the person is reading.

// The mobile build's third answer: a phone that brought its own API key runs the Coach itself
// (lib/coach-local.js — the same core the server runs, imported lazily so the catalogue and the
// validator only ever load on a phone that chose this). A paired phone takes the api() branch
// like the web app does; nothing on the web or demo builds reaches this.
let localMod = null
const LOCAL = () => MOBILE && useStore.getState().coachLocal?.mode === 'byok'
const local = async () => {
  if (!localMod) {
    localMod = await import('./coach-local.js')
    // There is no admin card on a phone: the user is the operator, so failures go to them.
    localMod.setNotifier(ev => {
      const toast = useUI.getState().toast
      // An automatic review speaks only when it has something to suggest, like the server's
      // (api/coach/cadence.js): a skip, a failure or "nothing to change" nobody asked for is noise.
      if (ev.scheduled) { if (ev.kind === 'ready') announceProposal(ev.pending); return }
      if (ev.kind === 'failed') toast(jobErrorText(ev.errorClass, ev.detail))
      else if (ev.kind === 'nochange') toast(t('Nothing to change right now: {0}', String(ev.reading || '').slice(0, 140)))
    })
  }
  return localMod
}

// The job this app last started and has not written a reply for yet. A run that fails before
// the first status poll — a provider refusing the connection answers in milliseconds — is never
// seen running, so "running, then gone" cannot be the only way the chat learns a run ended: it
// also compares the server's last outcome with the id the start request returned. Kept here,
// at module level, because the plan the intake asks for is started on another screen.
const runtimeModeKey = () => DEMO ? 'demo' : LOCAL() ? ['byok', ...['provider','baseUrl','model'].map(k => useStore.getState().coachLocal?.[k])].join('|') : 'server|' + decisionIdentity()
let awaited = null
let awaitedMode = null
const track = (r, identity) => {
  if (r?.job?.id) { awaited = r.job.id; awaitedMode = identity }
  return r
}
export const awaitedJob = () => awaitedMode === runtimeModeKey() ? awaited : null
export const settleAwaited = id => { if (!id || awaited === id) awaited = null }

const decisionIdentity = () => {
  const store = useStore.getState()
  return JSON.stringify([store.sync?.server || globalThis.location?.origin || 'web', store.user?.id || null])
}
export const coachStatus = async () => {
  if (DEMO) return (await demo()).demoStatus()
  if (LOCAL()) return (await local()).localStatus()
  const identity = decisionIdentity(), status = await api('/api/coach/status')
  if (identity !== decisionIdentity()) throw new Error('Coach account changed')
  return status.pending ? { ...status, pending: { ...status.pending, originIdentity: identity } } : status
}
const _requestReview = async (note, scope) => {
  if (DEMO) return (await demo()).demoReview(S(), scope)
  if (LOCAL()) return (await local()).localReview(S(), note, scope)
  if (scope && (await coachStatus()).scopeVersion !== 2) throw new Error(t('Upgrade the server to use this Coach feature.'))
  return api('/api/coach/review', { method: 'POST', body: JSON.stringify({ note: note || '', scope, lang: getLang() }) })
}
export const requestReview = (...a) => { const identity = runtimeModeKey(); return _requestReview(...a).then(r => track(r, identity)) }
const _requestPlan = async intake => DEMO ? (await demo()).demoPlan(S(), intake) : LOCAL() ? (await local()).localPlan(S(), intake) : api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ intake, lang: getLang() }) })
export const requestPlan = (...a) => { const identity = runtimeModeKey(); return _requestPlan(...a).then(r => track(r, identity)) }
const _refinePlan = async text => DEMO ? (await demo()).demoRefine(S()) : LOCAL() ? (await local()).localRefine(S(), text) : api('/api/coach/plan', { method: 'POST', body: JSON.stringify({ refine: text, lang: getLang() }) })
export const refinePlan = (...a) => { const identity = runtimeModeKey(); return _refinePlan(...a).then(r => track(r, identity)) }
const _requestDebrief = async selection => {
  const body = selection && typeof selection === 'object'
    ? { debriefSelection: selection, workoutId: selection.mode === 'single' ? selection.refs?.[0]?.value || null : null, lang: getLang() }
    : { workoutId: selection || null, lang: getLang() }
  if (DEMO) return (await demo()).demoDebrief(S(), selection)
  if (LOCAL()) return (await local()).localDebrief(S(), selection)
  if (selection && typeof selection === 'object' && (await coachStatus()).debriefSelectionVersion !== 2) {
    throw new Error(t('Upgrade the server to use this Coach feature.'))
  }
  return api('/api/coach/debrief', { method: 'POST', body: JSON.stringify(body) })
}
export const requestDebrief = (...a) => { const identity = runtimeModeKey(); return _requestDebrief(...a).then(r => track(r, identity)) }
// A question in the chat, answered in words (the `ask` job). The session running here goes along
// (lib/coach-context.js): the server never holds it.
const _askCoach = async text => DEMO ? (await demo()).demoAsk(S(), text) : LOCAL() ? (await local()).localAsk(S(), text, todayForCoach(S())) : api('/api/coach/ask', { method: 'POST', body: JSON.stringify({ text, today: todayForCoach(S()), lang: getLang() }) })
export const askCoach = (...a) => { const identity = runtimeModeKey(); return _askCoach(...a).then(r => track(r, identity)) }
// An automatic review, if one is due (lib/coach-schedule.js asks while the app is open). Only a
// phone with its own key runs them here; a server runs its own on its tick. The data-sharing
// question was asked when they were switched on, and nobody is there to ask it now: a "yes"
// withdrawn since (Coach menu, AI data sharing) means no run, not a dialog out of nowhere.
export async function scheduledReview() {
  if (DEMO || !LOCAL()) return null
  if (!S()?.coach?.consent?.agreedAt) return null
  return (await local()).localScheduled(S())
}
// A phone paired with a server leaves the reviews to the server's tick, and the server tells
// people about a proposal by web push, which the phone app does not have. So the phone asks once
// when it comes to the foreground, and says it once per proposal.
const ANNOUNCED_KEY = 'gym_coach_announced'
export async function scheduledNotice() {
  if (DEMO || LOCAL() || !MOBILE) return null
  const p = (await api('/api/coach/status'))?.pending
  if (!p || p.trigger !== 'scheduled') return null
  try { if (localStorage.getItem(ANNOUNCED_KEY) === p.id) return null; localStorage.setItem(ANNOUNCED_KEY, p.id) } catch { /* said again next time, at worst */ }
  await announceProposal(p)
  return p
}
// "The Coach has something for you", for a proposal nobody is looking at yet: a toast while the
// app is on screen, a notification when it went to the background meanwhile (a review takes a
// minute or two). Never a permission prompt: notifications were allowed in Settings, or not.
const PROPOSAL_NOTIFICATION_ID = 3100
async function announceProposal(pending) {
  const n = (pending?.changes || []).length
  if (!n) return
  const body = tn('{0} suggestion', '{0} suggestions', n)
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    useUI.getState().toast(t('Coach') + ': ' + body)
    return
  }
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return
    await LocalNotifications.schedule({ notifications: [{ id: PROPOSAL_NOTIFICATION_ID, title: t('Coach'), body, schedule: { at: new Date(Date.now() + 1000) } }] })
  } catch { /* no notification plugin: the proposal still waits in the Coach tab */ }
}


// The room: anonymous medians across the profiles on this instance that opted in. Only a
// server has a room; a phone with its own key and the demo both answer locally.
export const cohortStats = async () => DEMO ? (await demo()).demoCohort(S()) : LOCAL() ? { ok: false, enabled: false } : api('/api/coach/cohort?lang=' + encodeURIComponent(getLang()))
export const setCohortShare = async share => (DEMO || LOCAL()) ? { ok: true, sharing: !!share } : api('/api/coach/cohort/share', { method: 'POST', body: JSON.stringify({ share: !!share }) })
export const resolvePending = async body => {
  const origin = DEMO ? 'demo' : LOCAL() ? 'local' : 'server'
  if (body?.origin && body.origin !== origin || body?.originIdentity && body.originIdentity !== decisionIdentity()) return { deferred: true }
  return DEMO ? (await demo()).demoResolve(body) : LOCAL() ? (await local()).localResolve(body) : api('/api/coach/pending/resolve', { method: 'POST', body: JSON.stringify(body) })
}
export const forgetCoach = async () => DEMO ? (await demo()).demoResolve() : LOCAL() ? (await local()).localForget() : api('/api/coach/forget', { method: 'POST', body: '{}' })
export const disclosure = async () => DEMO ? (await demo()).demoDisclosure() : LOCAL() ? (await local()).localDisclosure() : api('/api/coach/disclosure')

/* Whose provider account this profile is about to spend. Its own call because the constraint is
   that the Coach screen states it too, not just the admin card — and because in instance mode a
   second profile is refused outright, which is something the user has to be able to read before
   they ask for anything rather than after a job is turned down. */
export const coachAccount = async () =>
  DEMO ? { mode: 'instance', provider: 'demo', providerLabel: 'Demo', account: null, connected: true, reason: null, message: null }
    : LOCAL() ? { mode: 'device', provider: useStore.getState().coachLocal.provider, providerLabel: null, account: null, connected: true, reason: null, message: null }
      : api('/api/coach/account')

/* Admin-only. The token is write-only from the client's side: it goes up once and is never
   read back, so there is deliberately no "show me the current credential" call to pair with it. */
export const connectCredential = body => api('/api/admin/coach/connect', { method: 'POST', body: JSON.stringify(body) })
export const disconnectCredential = () => api('/api/admin/coach/disconnect', { method: 'POST', body: '{}' })

/**
 * Live job/proposal state.
 *
 * `active` lets a caller (the Home card) subscribe only while it is mounted and visible;
 * everything else keeps the poll off. Errors are swallowed on purpose — a Coach status call
 * failing while you are mid-workout is not something to interrupt anyone about.
 */
export function useCoachStatus(active = true) {
  const [state, setState] = useState({ job: null, pending: null, cap: null, loading: true })
  const timer = useRef(null)
  const loop = useRef(null)   // the running poll loop's `tick`, so a manual refresh can re-pace it
  const seq = useRef(0)       // which status request is the newest one
  const knownJob = useRef(false)
  const coachLocal = useStore(s => s.coachLocal)
  const server = useStore(s => s.sync?.server)
  const userId = useStore(s => s.user?.id)
  const modeKey = [coachLocal?.mode, coachLocal?.provider, coachLocal?.baseUrl, coachLocal?.model, server, userId].join('|')

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    const identity = runtimeModeKey()
    try {
      const s = await coachStatus()
      // An answer that arrives after a newer request was sent is older than what that request
      // will bring: the idle poll in flight when a run is started must not land after the
      // refresh that follows the start, putting back the run count and last outcome from before.
      if (mine !== seq.current || identity !== runtimeModeKey()) return null
      knownJob.current = !!s?.job
      setState({ ...s, loading: false, statusError: null, isStale: false, lastSuccessfulAt: Date.now() })
      // A refresh that finds a job in flight — the one the caller just started — must not leave
      // the loop asleep on its idle cadence: without this the card shows up to a minute after
      // the job ended, sitting on "thinking…" the whole time.
      if (s?.job && loop.current) { clearTimeout(timer.current); timer.current = setTimeout(loop.current, POLL_MS) }
      return s
    } catch (error) {
      if (mine === seq.current && identity === runtimeModeKey()) setState(s => ({ ...s, loading: false, isStale: true, statusError: error?.message || 'status_unavailable' }))
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let stopped = false
    const tick = async () => {
      const s = await refresh()
      if (stopped) return
      clearTimeout(timer.current)
      timer.current = setTimeout(tick, s?.job || (!s && knownJob.current) ? POLL_MS : IDLE_MS)
    }
    loop.current = tick
    knownJob.current = false
    setState({ job: null, pending: null, cap: null, loading: true })
    tick()
    return () => { stopped = true; seq.current++; loop.current = null; clearTimeout(timer.current) }
  }, [active, refresh, modeKey])

  return { ...state, refresh }
}

// Server failure classes, in the app's voice. The provider's own words go to the admin card;
// what a lifter needs is what it means for them and whether trying again will help.
//
// Each line is a getter, so it is translated when it is read, not when this module loads: the
// module loads once, in English, before any locale pack has arrived, and a language picked later
// would otherwise never reach these lines. The lookup is still JOB_ERRORS[cls].
export const JOB_ERRORS = {
  get off() { return t('The Coach isn’t set up on this instance.') },
  get busy() { return t('The Coach is already thinking about your training.') },
  get cap() { return t('The Coach is taking a rest day. Try again tomorrow.') },
  get consent() { return t('The Coach needs your go-ahead first.') },
  get timeout() { return t('The Coach took too long and gave up.') },
  get auth() { return t('The Coach couldn’t sign in to its provider. The instance owner needs to check its setup.') },
  get missing() { return t('The Coach isn’t installed properly on this instance.') },
  get provider() { return t('The Coach couldn’t run. The instance owner needs to check its setup.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get restart() { return t('The server restarted while the Coach was thinking.') },
  get nostate() { return t('The Coach couldn’t read your training data.') },
  get noworkout() { return t('There’s no workout to look at yet. Log one first.') },
  // The refusal at enqueue when the process cannot drop privileges (api/coach/jobs.js). The same
  // words as api/coach/routes.js USER_ERROR.unprivileged; what to fix goes to the admin card.
  get unprivileged() { return t('The Coach is switched off on this instance for safety reasons.') },
  get internal() { return t('Something went wrong on the server.') }
}

// The same failures on a phone that brought its own key: there is no instance owner to
// check anything, the person reading this is the operator, and the provider's own words
// are the only thing that lets them fix it (a spent quota, a wrong model, a rejected key).
export const BYOK_ERRORS = {
  get auth() { return t('Your AI provider rejected the key on this phone. Check it under Settings → AI Coach.') },
  get missing() { return t('The Coach isn’t set up on this phone. Check Settings → AI Coach.') },
  get provider() { return t('Your AI provider couldn’t answer.') },
  get unusable() { return t('The Coach answered with something the app couldn’t use.') },
  get internal() { return t('Something went wrong on this phone.') }
}

/** The line the person sees for a failed job — with the reason attached where they can act on it. */
export function jobErrorText(cls, detail) {
  const own = LOCAL()
  const base = (own && BYOK_ERRORS[cls]) || JOB_ERRORS[cls] || (own ? BYOK_ERRORS.internal : JOB_ERRORS.internal)
  const why = own && detail ? String(detail).trim().slice(0, 300) : ''
  return why ? `${base}\n${why}` : base
}
