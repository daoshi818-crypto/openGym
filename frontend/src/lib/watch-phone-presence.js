export function nextPhoneSessionGeneration(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER ? n + 1 : 1
}

const sidOf = active => active?.watchSid || (active?.start ? String(active.start) : '')
const livePhoneSession = S => {
  const active = S?.active
  const sid = sidOf(active)
  return sid && !active?.editingWorkoutId && active.watchStarted !== true
    ? { active, sid, generation: Number.isSafeInteger(active.watchSessionGeneration) ? active.watchSessionGeneration : 0 } : null
}

export function createPhoneWatchPresence(deps) {
  let last = null
  let disposed = false
  let activation = 0
  let persisted = Promise.resolve(true)

  async function revoke(target = last) {
    if (!target || last === target) last = null
    if (target && deps.canSend()) {
      try { await deps.sendPresence({ t: 'session_presence', sid: target.sid,
        sessionGeneration: target.generation, active: false, sentAt: Date.now(),
        commitRev: Number.isSafeInteger(target.commitRev) ? target.commitRev : 0 }) } catch { /* lease expires */ }
    }
  }

  async function publish({ advance = false, snapshot = false } = {}) {
    if (disposed) return false
    const current = livePhoneSession(deps.getState())
    if (!current || !deps.isForeground()) { await revoke(); return false }

    const token = advance ? ++activation : activation
    let generation = current.generation
    if (advance || !generation) {
      generation = nextPhoneSessionGeneration(generation)
      deps.update(s => {
        const a = s.active
        if (sidOf(a) !== current.sid || a.editingWorkoutId) return
        a.watchPhoneSession = true
        a.watchSessionGeneration = generation
      })
      persisted = Promise.resolve().then(deps.checkpoint).then(() => true, () => false)
    }
    if (!(await persisted) || disposed || token !== activation) return false
    const S = deps.getState(), A = S.active
    if (!A || sidOf(A) !== current.sid || A.editingWorkoutId || !deps.isForeground()) return false
    generation = Number.isSafeInteger(A.watchSessionGeneration) ? A.watchSessionGeneration : generation
    const target = { sid: current.sid, generation, commitRev: A.syncRev || 0 }
    if (!deps.canSend()) return false
    if (snapshot) {
      try { if (!(await deps.sendSnapshot(S))) return false } catch { return false }
    }
    const latest = livePhoneSession(deps.getState())
    if (disposed || token !== activation || !deps.isForeground() || !deps.canSend() ||
        latest?.sid !== target.sid || latest.generation !== target.generation) return false
    last = target
    try {
      const sent = await deps.sendPresence({ t: 'session_presence', sid: target.sid,
        sessionGeneration: target.generation, active: true, sentAt: Date.now(), commitRev: target.commitRev })
      return !!sent
    } catch { return false }
  }

  async function heartbeat() {
    const current = livePhoneSession(deps.getState())
    const snapshot = !last || last.sid !== current?.sid || last.generation !== current.generation
    return publish({ snapshot })
  }

  return {
    activate: () => publish({ advance: true, snapshot: true }),
    reassert: () => publish({ advance: false, snapshot: true }),
    heartbeat,
    deactivate: () => { ++activation; return revoke() },
    dispose: () => { disposed = true; ++activation; return revoke() },
    current: () => last && { ...last },
  }
}

export function stalePhoneActivationEvent(S, ev, presenceSupported = false, foreground = true) {
  const A = S?.active
  const closedPhoneLed = S?.watchClosed?.[ev?.sid]?.phoneLedSession === true
  if ((!A?.watchPhoneSession && !closedPhoneLed) || !ev?.sid || (A ? sidOf(A) : ev.sid) !== ev.sid ||
      ['session_close', 'session_close_ack', 'summary'].includes(ev.t) || !(ev.protocolVersion >= 3)) return false
  const record = A || S.watchClosed[ev.sid]
  const expected = Number.isSafeInteger(record.watchSessionGeneration) ? record.watchSessionGeneration : 0
  if (!expected) return presenceSupported
  if (ev.phoneSessionGeneration != null) return !foreground || ev.phoneSessionGeneration !== expected
  return presenceSupported || ev.phoneLed === true
}
