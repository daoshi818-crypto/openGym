// App-owned training work. schedule is a real checkpoint/recovery job, not a
// claim of continuous residency. Public contract: /api/system/schedule/.
export function createTrainingRuntime(deps) {
  let disposed = false, foreground = false, state = {}, key = '', job = null, serial = 0
  let screen = null, screenRequested = false, screenEpoch = 0, maintenance = false, lastRunToken = ''
  const alive = () => !disposed && !deps.isDestroyed()
  const segment = s => s.segmentStartedAt || s.startedAt || 0
  const active = s => !!s?.active && !!s.sid && !s.pausedAt && !s.closeIntent &&
    segment(s) > 0 && Date.now() - segment(s) < 21600000
  const trace = (stage, data = {}) => { try { deps.record(stage, data) } catch {} }
  const writeJob = value => Promise.resolve().then(() => alive() ? deps.writeJob(value) : false).catch(() => false)
  const clearWatchdog = value => { if (value?.watchdog != null) deps.clearTimeout(value.watchdog) }
  function readState() { try { return deps.readState() } catch { trace('training_state_failed'); return null } }
  const cancel = id => { if (Number.isInteger(id) && id >= 0) { try { deps.schedule.cancel(id) } catch {} } }
  function releaseJob(clear = true) {
    const previous = job; job = null
    if (previous) { clearWatchdog(previous); cancel(previous.id) }
    if (clear && alive()) writeJob(null)
  }
  function syncScreen() {
    if (!alive()) return
    const desired = foreground && active(state)
    if (screen === desired) return
    screen = desired
    const epoch = ++screenEpoch
    try {
      if (desired) screenRequested = true
      deps.brightness.setKeepScreenOn({ keepScreenOn: desired,
        success() { if (epoch === screenEpoch) screenRequested = desired },
        fail: (_, code) => { if (alive() && epoch === screenEpoch) { screen = null; trace('training_screen_failed', { code }) } } })
    } catch { screen = null; trace('training_screen_failed') }
  }
  function arm() {
    if (!alive() || !active(state) || job || maintenance) return
    const current = { token: Date.now().toString(36) + ':' + (++serial) + ':' + Math.random().toString(36).slice(2, 9),
      sid: state.sid, segment: segment(state), id: null, watchdog: null }
    job = current
    const accepted = id => {
      if (!Number.isInteger(id) || id < 0) return
      if (!alive() || job !== current) { cancel(id); return }
      if (current.id != null) { if (current.id !== id) cancel(id); return }
      current.id = id; clearWatchdog(current); current.watchdog = null
      writeJob({ id, token: current.token, sid: current.sid, segment: current.segment }).then(ok => {
        if (!ok && alive() && job === current) { releaseJob(false); trace('training_job_storage_failed') }
      })
    }
    const failed = (_, code) => {
      if (!alive() || job !== current) return
      releaseJob(false); trace('training_job_failed', { code })
    }
    try {
      const id = deps.schedule.scheduleJob({ type: 2, timeout: 60000, triggerMethod: 'onTrainingMaintenance',
        params: { token: current.token, sid: current.sid, segment: current.segment },
        success: value => accepted(value?.id), fail: failed })
      accepted(id)
      if (job === current && current.id == null) current.watchdog = deps.setTimeout(() => failed(null, 'callback_timeout'), 5000)
    } catch { failed(null, 'unsupported') }
  }
  function observe(value, retry = false) {
    if (!alive()) return
    if (!value) { syncScreen(); return }
    // Keep only lifecycle scalars, never a reactive Page or the workout document.
    state = { active: !!value?.active, sid: value?.sid || '', startedAt: segment(value || {}),
      pausedAt: value?.pausedAt || 0, closeIntent: !!value?.closeIntent }
    syncScreen()
    const next = state.sid + ':' + state.startedAt + ':' + active(state)
    if (next === key && !retry) return
    key = next
    if (!active(state)) { if (job) releaseJob(); return }
    if (job && (job.sid !== state.sid || job.segment !== segment(state))) releaseJob()
    arm()
  }
  function restore() {
    if (!alive()) return
    try { deps.restore() } catch { trace('training_restore_failed') }
  }
  function checkpoint() {
    if (!alive()) return Promise.resolve(false)
    return Promise.resolve().then(() => {
      if (!alive()) return false
      return deps.checkpoint()
    }).then(result => {
      if (alive() && result?.ok === false) trace('training_checkpoint_failed')
      return result?.ok !== false
    }, () => { if (alive()) trace('training_checkpoint_failed'); return false })
  }
  return {
    observe, syncScreen,
    start() {
      // A previous one-shot may still be registered after process recovery.
      restore()
      const latest = readState()
      if (latest) {
        try { const previous = deps.readJob(); cancel(previous?.id); if (previous && !active(latest)) writeJob(null) } catch {}
        observe(latest)
      }
    },
    show() { if (!alive()) return; foreground = true; restore(); observe(readState(), true) },
    hide() { if (!alive()) return; foreground = false; syncScreen(); observe(readState(), true); return checkpoint() },
    async run(params) {
      if (!alive() || maintenance) return false
      const latest = readState()
      let saved
      try { saved = deps.readJob() } catch { return false }
      if (!active(latest) || latest.sid !== params?.sid || segment(latest) !== params?.segment ||
          saved?.token !== params?.token || lastRunToken === params?.token || job && job.token !== params?.token) return false
      lastRunToken = params.token
      maintenance = true
      if (job) { clearWatchdog(job); job = null }
      try { restore(); await checkpoint(); if (alive()) trace('training_checkpoint', { sid: latest.sid }); return true }
      finally { maintenance = false; if (alive()) observe(readState(), true) }
    },
    dispose() {
      if (disposed) return
      // Retain at most one confirmed, one-shot training checkpoint. The system
      // may invoke the App entry after suspension; it must never launch a Page.
      if (job) clearWatchdog(job)
      if (screenRequested) { try { deps.brightness.setKeepScreenOn({ keepScreenOn: false, success() {}, fail() {} }) } catch {} }
      screen = false; disposed = true; screenEpoch++
    },
  }
}
