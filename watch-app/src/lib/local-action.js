// Page plumbing only: business functions remain unchanged. A detached view prevents any
// success UI from escaping before the operation + intention document is on disk.
export async function commitPageAction(page, operation, deps) {
  if (page.sessionActionDraft) return operation.call(page)
  if (page.localCommitPending) return false
  page.localCommitPending = true
  const sid = page.state.sid, wasVisible = page.visible
  let draft, refresh = false
  const effects = []
  const deferred = ['setRestScreenLock', 'syncClockTimer', 'focusCrown', 'stopHrCapture', 'startHrCapture', 'cancelRestNudge']
  try {
    const result = await deps.commitSessionAction(page.state.sid, state => {
      // BlueOS Page is a Proxy with receiver-ignoring setters and bound methods.
      // Never inherit from it: assignments would mutate the live Page, and helper
      // calls would bypass this draft. Own writes stay private; raw helpers use it.
      draft = new Proxy({}, {
        get(target, name) {
          if (Object.prototype.hasOwnProperty.call(target, name)) return target[name]
          const method = deps.pageDefinition && deps.pageDefinition[name]
          if (typeof method === 'function' && !Object.prototype.hasOwnProperty.call(page, name)) return method
          return page[name]
        },
      })
      draft.sessionActionDraft = true
      draft.state = state
      draft.flushPendingRowEdits = () => {} // Replayed once, after the shared document commits.
      draft.refresh = () => { refresh = true }
      for (const name of deferred) if (typeof page[name] === 'function') draft[name] = (...args) => effects.push(() => page[name](...args))
      return operation.call(draft)
    })
    if (!result.ok) { page.inputNotice = '存储失败，未保存，请重试'; page.syncWarning = true; page.syncLabel = '存储失败，请重试'; return false }
    deps.replayPendingEvents()
    if (page.state?.sid !== sid || (wasVisible === true && page.visible === false) || deps.loadState().sid !== sid) return true
    for (const name of Object.keys(draft)) if (name !== 'flushPendingRowEdits' && name !== 'sessionActionDraft' && name !== 'state' && name !== 'refresh' && !deferred.includes(name)) page[name] = draft[name]
    page.state = deps.loadState()
    for (const effect of effects) effect()
    if (refresh) page.refresh()
    return true
  } catch (error) {
    page.inputNotice = '未保存：' + String(error?.message || error).slice(0, 60)
    return false
  } finally { page.localCommitPending = false }
}
