import { useEffect, useRef, useState } from 'react'

export const REORDER_LONG_PRESS_MS = 380
export const REORDER_DRAG_SLOP = 8
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// Shared with the routine editor: long press, pointer ownership, cancellation and edge scrolling.
function scrollHostFor(node, axis = 'y') {
  const overflow = axis === 'x' ? 'overflowX' : 'overflowY'
  const scrollSize = axis === 'x' ? 'scrollWidth' : 'scrollHeight'
  const clientSize = axis === 'x' ? 'clientWidth' : 'clientHeight'
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const overflowValue = window.getComputedStyle(parent)[overflow]
    if (/(auto|scroll)/.test(overflowValue) && parent[scrollSize] > parent[clientSize]) return parent
  }
  return window
}

function autoScrollStep(host, clientPosition, axis = 'y') {
  const edge = 64
  const maxStep = 14
  let start, end, scrollPosition, maxScroll
  if (host === window) {
    const root = document.scrollingElement || document.documentElement
    if (axis === 'x') {
      start = 0; end = window.innerWidth || root.clientWidth
      scrollPosition = window.scrollX || root.scrollLeft || 0
      maxScroll = Math.max(root.scrollWidth, document.body?.scrollWidth || 0) - (end - start)
    } else {
      start = window.visualViewport?.offsetTop || 0
      end = start + (window.visualViewport?.height || window.innerHeight || root.clientHeight)
      scrollPosition = window.scrollY || root.scrollTop || 0
      maxScroll = Math.max(root.scrollHeight, document.body?.scrollHeight || 0) - (end - start)
    }
  } else {
    const rect = host.getBoundingClientRect()
    if (axis === 'x') {
      start = rect.left; end = rect.right
      scrollPosition = host.scrollLeft; maxScroll = host.scrollWidth - host.clientWidth
    } else {
      start = rect.top; end = rect.bottom
      scrollPosition = host.scrollTop; maxScroll = host.scrollHeight - host.clientHeight
    }
  }
  if (clientPosition < start + edge && scrollPosition > 0) return -Math.ceil(maxStep * clamp((start + edge - clientPosition) / edge, 0, 1))
  if (clientPosition > end - edge && scrollPosition < maxScroll) return Math.ceil(maxStep * clamp((clientPosition - end + edge) / edge, 0, 1))
  return 0
}

export function useLongPressReorder(routineIdentity, exercises, onDrop, options = {}) {
  const listRef = useRef(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const enabled = options.enabled !== false
  const gestureRef = useRef(null)
  const exercisesRef = useRef(exercises)
  const routineIdentityRef = useRef(routineIdentity)
  const onDropRef = useRef(onDrop)
  const suppressClickRef = useRef(false)
  const suppressTimerRef = useRef(null)
  const [drag, setDrag] = useState(null)
  exercisesRef.current = exercises
  routineIdentityRef.current = routineIdentity
  onDropRef.current = onDrop
  const hasRows = exercises.length > 0

  useEffect(() => () => {
    suppressClickRef.current = false
    window.clearTimeout(suppressTimerRef.current)
  }, [])

  useEffect(() => {
    const list = listRef.current
    setDrag(current => current ? null : current)
    if (!list || !enabled) return undefined
    let frame = null

    const clearFrame = () => {
      if (frame != null) window.cancelAnimationFrame(frame)
      frame = null
    }
    const clearTimer = gesture => {
      if (gesture?.timer != null) window.clearTimeout(gesture.timer)
      if (gesture) gesture.timer = null
    }
    const matchesSnapshot = gesture => routineIdentityRef.current === gesture.routineIdentity
      && exercisesRef.current === gesture.listIdentity
      && JSON.stringify(exercisesRef.current) === gesture.snapshot
    const releaseCapture = gesture => {
      const target = gesture?.captureTarget
      if (!target?.releasePointerCapture) return
      try { target.releasePointerCapture(gesture.pointerId) } catch { /* already released */ }
    }
    const finish = (gesture, commit, x = gesture?.lastX, y = gesture?.lastY) => {
      if (!gesture || gestureRef.current !== gesture) return
      clearTimer(gesture)
      clearFrame()
      gestureRef.current = null
      if (!gesture.active) return
      releaseCapture(gesture)
      suppressClickRef.current = true
      window.clearTimeout(suppressTimerRef.current)
      // The compatibility click lands synchronously after pointerup; anything
      // later is a real tap, so the guard only needs to outlive that one event.
      suppressTimerRef.current = window.setTimeout(() => { suppressClickRef.current = false }, 150)
      setDrag(null)
      const rect = list.getBoundingClientRect()
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      const geometry = optionsRef.current.geometry(list, exercisesRef.current)
      if (commit && inside && geometry && matchesSnapshot(gesture) && gesture.targetSlot !== gesture.sourcePosition) {
        onDropRef.current(gesture.sourceIndex, gesture.targetSlot)
      }
    }
    const indicatorTop = (geometry, gesture, slot, listRect) => {
      if (slot === gesture.sourcePosition) return clamp(gesture.sourceTop - listRect.top, 0, listRect.height)
      const remaining = geometry.filter(unit => unit.position !== gesture.sourcePosition)
      let top
      if (slot <= 0) top = remaining[0]?.top ?? gesture.sourceTop
      else if (slot >= remaining.length) top = remaining.at(-1)?.bottom ?? gesture.sourceBottom
      else top = (remaining[slot - 1].bottom + remaining[slot].top) / 2
      return clamp(top - listRect.top, 0, listRect.height)
    }
    const updateDrag = (gesture, x, y, schedule = true) => {
      if (gestureRef.current !== gesture || !gesture.active || !matchesSnapshot(gesture)) {
        if (gestureRef.current === gesture) finish(gesture, false)
        return
      }
      const geometry = optionsRef.current.geometry(list, exercisesRef.current)
      if (!geometry) { finish(gesture, false); return }
      const listRect = list.getBoundingClientRect()
      const remaining = geometry.filter(unit => unit.position !== gesture.sourcePosition)
      const probeY = clamp(y, listRect.top, listRect.bottom)
      const moved = Math.hypot(x - gesture.startX, y - gesture.startY) > REORDER_DRAG_SLOP
      const slot = moved ? remaining.reduce((count, unit) => count + (probeY > unit.center ? 1 : 0), 0) : gesture.sourcePosition
      if (optionsRef.current.followLayout) {
        const source = geometry.find(unit => unit.position === gesture.sourcePosition)
        if (!source) { finish(gesture, false); return }
        gesture.sourceTop = source.top
        gesture.sourceBottom = source.bottom
      }
      const rawDelta = y - gesture.grabOffset - gesture.sourceTop
      const deltaY = clamp(rawDelta, listRect.top - gesture.sourceTop, listRect.bottom - gesture.sourceBottom)
      gesture.lastX = x; gesture.lastY = y; gesture.targetSlot = slot; gesture.deltaY = deltaY
      setDrag({ first: gesture.sourceUnit[0], last: gesture.sourceUnit.at(-1), deltaY, indicatorTop: indicatorTop(geometry, gesture, slot, listRect) })
      if (schedule && frame == null) frame = window.requestAnimationFrame(runAutoScroll)
    }
    function runAutoScroll() {
      frame = null
      const gesture = gestureRef.current
      if (!gesture?.active) return
      const step = autoScrollStep(gesture.scrollHost, gesture.lastY)
      if (!step) return
      if (gesture.scrollHost === window) window.scrollBy(0, step)
      else gesture.scrollHost.scrollTop += step
      updateDrag(gesture, gesture.lastX, gesture.lastY, false)
      if (gestureRef.current === gesture) frame = window.requestAnimationFrame(runAutoScroll)
    }
    const lift = gesture => {
      if (gestureRef.current !== gesture) return
      if (!matchesSnapshot(gesture)) { finish(gesture, false); return }
      const geometry = optionsRef.current.geometry(list, exercisesRef.current)
      const source = geometry?.find(unit => unit.unit.includes(gesture.sourceIndex))
      if (!source) { finish(gesture, false); return }
      gesture.active = true; gesture.timer = null
      gesture.sourcePosition = source.position; gesture.sourceUnit = source.unit
      gesture.sourceTop = source.top; gesture.sourceBottom = source.bottom
      gesture.grabOffset = gesture.lastY - source.top; gesture.targetSlot = source.position
      gesture.scrollHost = scrollHostFor(list)
      gesture.captureTarget = optionsRef.current.captureList ? list : gesture.downTarget
      try { gesture.captureTarget.setPointerCapture?.(gesture.pointerId) } catch { /* unsupported */ }
      suppressClickRef.current = true
      window.clearTimeout(suppressTimerRef.current)
      optionsRef.current.onLift?.()
      updateDrag(gesture, gesture.lastX, gesture.lastY)
    }
    const onPointerDown = event => {
      // a new touch is intentional — never let the post-drop guard eat its click
      suppressClickRef.current = false
      window.clearTimeout(suppressTimerRef.current)
      const current = gestureRef.current
      if (current) {
        if (event.pointerId !== current.pointerId) finish(current, false)
        return
      }
      if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return
      const target = event.target
      if (!target?.closest || target.closest(optionsRef.current.ignored || 'button:not([data-row-open]),a,input,textarea,select,[data-nodrag]')) return
      const row = target.closest(optionsRef.current.rowSelector)
      if (!row || !list.contains(row)) return
      const sourceIndex = optionsRef.current.sourceOf(row)
      if (sourceIndex == null || sourceIndex === '' || (typeof sourceIndex === 'number' && !Number.isInteger(sourceIndex))) return
      const gesture = {
        pointerId: event.pointerId, sourceIndex, downTarget: target,
        startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
        routineIdentity: routineIdentityRef.current,
        listIdentity: exercisesRef.current,
        snapshot: JSON.stringify(exercisesRef.current), active: false, timer: null,
      }
      gestureRef.current = gesture
      // The grip, pressed with a mouse, picks the row up at once (#277): the hold exists so a
      // finger can still scroll the list, and a mouse scrolls with its wheel. preventDefault
      // keeps the press from starting a text selection or the row's swipe-to-delete, which
      // listen to the mouse events a pointerdown would otherwise go on to fire.
      if (event.pointerType === 'mouse' && target.closest('[data-drag-handle]')) {
        event.preventDefault()
        lift(gesture)
        return
      }
      gesture.timer = window.setTimeout(() => lift(gesture), REORDER_LONG_PRESS_MS)
    }
    const onPointerMove = event => {
      const gesture = gestureRef.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      if (!gesture.active) {
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > REORDER_DRAG_SLOP) {
          clearTimer(gesture); gestureRef.current = null
        } else { gesture.lastX = event.clientX; gesture.lastY = event.clientY }
        return
      }
      event.preventDefault()
      updateDrag(gesture, event.clientX, event.clientY)
    }
    const onPointerUp = event => {
      const gesture = gestureRef.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      if (gesture.active) {
        event.preventDefault()
        updateDrag(gesture, event.clientX, event.clientY, false)
      }
      finish(gesture, gesture.active, event.clientX, event.clientY)
    }
    const onPointerCancel = event => {
      const gesture = gestureRef.current
      if (gesture && event.pointerId === gesture.pointerId) finish(gesture, false)
    }
    const onLostCapture = event => {
      const gesture = gestureRef.current
      if (gesture && event.pointerId === gesture.pointerId) finish(gesture, false)
    }
    const cancelActive = () => finish(gestureRef.current, false)
    const onKeyDown = event => {
      if (event.key !== 'Escape' || !gestureRef.current) return
      event.preventDefault(); cancelActive()
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') cancelActive() }
    const onContextMenu = event => { if (gestureRef.current?.active && event.target.closest?.(optionsRef.current.rowSelector)) event.preventDefault() }
    const onDragStart = event => { if (event.target.closest?.(optionsRef.current.rowSelector)) event.preventDefault() }

    // Touch: the rows keep `touch-action: pan-y` so the list still scrolls with a finger, but once
    // a long-press has lifted a row the browser must not claim the vertical drag as a pan — it
    // would fire pointercancel and scroll instead. preventDefault on a pointer event cannot stop
    // that; only a non-passive touchmove listener can, and only while a drag is actually active.
    const onTouchMove = event => { if (gestureRef.current?.active) event.preventDefault() }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('pointermove', onPointerMove, { passive: false })
    document.addEventListener('pointerup', onPointerUp, { passive: false })
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('lostpointercapture', onLostCapture)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('visibilitychange', onVisibility)
    list.addEventListener('contextmenu', onContextMenu)
    list.addEventListener('dragstart', onDragStart)
    window.addEventListener('blur', cancelActive)
    return () => {
      const gesture = gestureRef.current
      clearTimer(gesture); clearFrame(); gestureRef.current = null
      releaseCapture(gesture)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('lostpointercapture', onLostCapture)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('visibilitychange', onVisibility)
      list.removeEventListener('contextmenu', onContextMenu)
      list.removeEventListener('dragstart', onDragStart)
      window.removeEventListener('blur', cancelActive)
    }
  }, [hasRows, routineIdentity, exercises, enabled])

  const onClickCapture = event => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    window.clearTimeout(suppressTimerRef.current)
    event.preventDefault(); event.stopPropagation()
  }
  // Whether a long press has picked a row up: the row's swipe stays out of the way while it has.
  const lifted = () => !!gestureRef.current?.active
  return { listRef, drag, onClickCapture, lifted }
}
