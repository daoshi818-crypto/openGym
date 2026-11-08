// Conservative read/write footprints. Unknown/legacy targets are barriers, never guessed independent.
export function eventFootprint(event) {
  const row = event.entryInstanceId && event.setId ? event.entryInstanceId + ':' + event.setId : null
  const reads = ['session', 'structure', 'structure:' + (event.entryInstanceId || '')]
  let writes
  if (row && ['weight', 'reps', 'effort'].includes(event.t)) writes = [row + ':' + event.t]
  else if (row && event.t === 'set') writes = [row + ':done', row + ':weight', row + ':reps', 'rest', 'focus']
  else if (row && event.t === 'unset') writes = [row + ':done', 'rest', 'focus']
  else return { barrier: true, reads: [], writes: [] }
  return { barrier: false, reads, writes }
}
export function eventsOverlap(a, b) {
  if (a.sid !== b.sid) return true // One active session on the phone.
  const x = eventFootprint(a), y = eventFootprint(b)
  if (x.barrier || y.barrier) return true
  return x.writes.some(k => y.writes.includes(k) || y.reads.includes(k)) || y.writes.some(k => x.reads.includes(k))
}
export function dependenciesFor(event, pending) {
  return [...new Set(pending.filter(e => e.eventId !== event.eventId && eventsOverlap(e, event)).map(e => e.eventId))]
}
export function dependencyDecision(event, lookup) {
  if (event.dependencyEvents !== true) return { status: 'ready' }
  const ids = event.dependsOn
  if (!Array.isArray(ids) || ids.length > 256 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || id.length > 512 || id === event.eventId)) return { status: 'rejected', reason: 'invalid_dependencies' }
  for (const id of ids) {
    const parent = lookup(id)
    if (!parent) return { status: 'missing', reason: 'dependency_missing', parent: id }
    if (parent.status !== 'applied' && !(parent.status === 'conflict' && parent.resolution === 'phone')) return { status: 'rejected', reason: 'dependency_' + parent.status, parent: id }
    if (parent.sid !== event.sid) return { status: 'rejected', reason: 'session_dependency', parent: id }
  }
  return { status: 'ready' }
}
export function selectReadyEvent(outbox, durable, decisions, now, extended) {
  const eligible = e => durable.has(e.msg.eventId) && now >= (e.nextAttemptAt || 0) && (!e.sent || now >= (e.nextAttemptAt || (e.sentAt || 0) + 4000))
  if (!extended) return eligible(outbox[0] || { msg: {} }) ? outbox[0] : null
  return outbox.find((entry, index) => {
    if (!eligible(entry)) return false
    const msg = entry.msg
    // A legacy prefix must drain in its original order before extension events overtake it.
    if (!msg.dependencyEvents) return index === 0
    if (outbox.slice(0, index).some(e => !e.msg.dependencyEvents || eventsOverlap(e.msg, msg))) return false
    return dependencyDecision(msg, id => decisions[id]).status === 'ready'
  }) || null
}
