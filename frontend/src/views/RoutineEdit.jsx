import { coachAvailable } from '../lib/coach.js'
import { DEMO } from '../lib/demo.js'
import { useNavigate, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import { useLongPressReorder, REORDER_LONG_PRESS_MS, REORDER_DRAG_SLOP } from '../lib/use-long-press-reorder.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr } from '../lib/exercises.js'
import { activeProfile, exAvailable } from '../lib/equipment.js'
import { uid, exerciseNameText } from '../lib/format.js'
import { t, exerciseNameFor, exerciseNameClass } from '../lib/i18n.js'
import { supersetUnits, moveRoutineEntry, cleanupSg, exLine, defaultConfig } from '../lib/history.js'
import { Thumb } from '../components/Media.jsx'
import { glyphPicker, exercisePicker, exConfigSheet, confirmSheet, supersetSheet } from '../sheets.jsx'
import { supersetMeta, setSupersetMeta } from '../lib/superset-meta.js'
import { fmtRest } from '../lib/duration.js'
import Icon from '../components/Icon.jsx'
import { glyphOf } from '../lib/glyphs.js'
import { Button, Row, SelectRow, Switch } from '../components/ui.jsx'
import SwipeRow from '../components/SwipeRow.jsx'
import { workoutControls } from '../lib/workout-controls.js'
import { copyRoutine, deleteRoutine, replaceSlotExercise } from '../lib/routines.js'
import { planPrintHTML, printPlan } from '../lib/plan-share.js'
import { markEntryUndone } from '../lib/sync-merge.js'
import { MOBILE, printHtml } from '../lib/mobile.js'
import { speedUnitOf } from '../lib/speed.js'
import { POLICIES_FOR, POLICY_NAME, POLICY_DESC } from '../lib/progression.js'
import { selectionForPlan } from '../lib/debrief-selection.js'
import BodyMap from '../components/BodyMap.jsx'
import { loadOfRoutine, rankOf, MUSCLE_NAME } from '../lib/muscles.js'

export const ROUTINE_LONG_PRESS_MS = REORDER_LONG_PRESS_MS
export const ROUTINE_DRAG_SLOP = REORDER_DRAG_SLOP

const clamp = (value, low, high) => Math.max(low, Math.min(high, value))

// Slots are defined after removing the source unit, so a grouped run can never be split.
export function reorderRoutineUnit(exercises, sourceIndex, targetSlot) {
  if (!Array.isArray(exercises) || !exercises.length) return false
  const units = supersetUnits(exercises)
  const sourcePosition = units.findIndex(unit => unit.includes(sourceIndex))
  if (sourcePosition < 0) return false
  const remaining = units.filter((_, position) => position !== sourcePosition)
  const slot = clamp(Number.isFinite(targetSlot) ? Math.trunc(targetSlot) : sourcePosition, 0, remaining.length)
  if (slot === sourcePosition) return false
  const source = units[sourcePosition]
  const moved = exercises.splice(source[0], source.length)
  const insertAt = remaining.slice(0, slot).reduce((count, unit) => count + unit.length, 0)
  exercises.splice(insertAt, 0, ...moved)
  cleanupSg(exercises)
  return true
}

function unitGeometry(list, exercises) {
  const rows = new Map([...list.querySelectorAll('[data-routine-row]')]
    .map(row => [Number(row.dataset.exIndex), row]))
  const units = supersetUnits(exercises)
  const geometry = units.map((unit, position) => {
    const rects = unit.map(index => rows.get(index)?.getBoundingClientRect()).filter(Boolean)
    if (rects.length !== unit.length) return null
    const top = Math.min(...rects.map(rect => rect.top))
    const bottom = Math.max(...rects.map(rect => rect.bottom))
    return { unit, position, top, bottom, center: top + (bottom - top) / 2 }
  })
  return geometry.every(Boolean) ? geometry : null
}


/**
 * Takes exercise `i` out of routine `routineId` with an Undo (v1.3.11: the row's swipe and the
 * exercise sheet's Remove). While the routine's exercises are still what the removal left, Undo
 * puts the list back as it was, superset links included (a partner left alone loses its link,
 * cleanupSg). Once something else changed them, the exercise goes back in at its old place.
 */
export function removeRoutineExercise(routineId, i) {
  const st = useStore.getState()
  const routine = st.S.routines.find(x => x.id === routineId)
  const slot = routine?.ex?.[i]
  if (!slot) return false
  const before = structuredClone(routine.ex)
  const base = Number(routine._f?.ex) || 0
  st.update(s => {
    const ex = s.routines.find(x => x.id === routineId)?.ex
    if (!ex) return
    ex.splice(i, 1); cleanupSg(ex)
  })
  const now = useStore.getState().S.routines.find(x => x.id === routineId)
  const after = JSON.stringify(now?.ex)
  const del = Number(now?._f?.ex) || 0
  useUI.getState().toast(t('“{0}” left the routine.', exerciseNameText(exOr(slot.id))),
    { action: t('Undo'), onAction: () => undoRemoveRoutineExercise({ routineId, i, before, after, base, del }) })
  return true
}
export function undoRemoveRoutineExercise({ routineId, i, before, after, base, del }) {
  if (!useStore.getState().S.routines.some(x => x.id === routineId)) {
    useUI.getState().toast(t('Too late, that one’s gone'))
    return false
  }
  useStore.getState().update(s => {
    const routine = s.routines.find(x => x.id === routineId)
    // Put back exactly, so a change another device made to these exercises before it saw the
    // removal still wins (lib/sync-merge.js, "Undo").
    if (JSON.stringify(routine.ex) === after) { routine.ex = structuredClone(before); if (del) markEntryUndone(routine, 'ex', base, del); return }
    routine.ex.splice(Math.min(i, routine.ex.length), 0, structuredClone(before[i]))
    cleanupSg(routine.ex)
  })
  return true
}

export default function RoutineEdit() {
  const coachEntry = useStore(s => MOBILE || coachAvailable(s.config, s.user, { demo: DEMO }))
  const nav = useNavigate()
  const { id } = useParams()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  const r = S.routines.find(x => x.id === id)
  useEffect(() => { if (!r) nav('/plan') }, [!!r])
  // Editing here has no explicit "save" — every field change persists immediately. A single
  // auto-backup on the way out (not per keystroke) covers the whole editing session, deletion
  // included: this still unmounts after the delete button navigates away.
  useEffect(() => () => useStore.getState().autoBackupNow(), [])
  const edit = fn => update(s => { fn(s.routines.find(x => x.id === id).ex) })
  const reorder = useLongPressReorder(r, r?.ex || [], (sourceIndex, targetSlot) => {
    edit(exercises => { reorderRoutineUnit(exercises, sourceIndex, targetSlot) })
  }, { geometry: unitGeometry, rowSelector: '[data-routine-row]', sourceOf: row => Number(row.dataset.exIndex) })
  if (!r) return null
  // The arrows move one exercise (#377): inside its superset, out of it at the edge, and past a
  // whole neighbouring unit otherwise (lib/history.js moveRoutineEntry). Drag moves supersets whole.
  const move = (i, dir) => {
    // Guard before update so a stale/boundary activation cannot trigger persistence or cleanup.
    if (!moveRoutineEntry(r.ex, i, dir)) return
    edit(ex => {
      const reordered = moveRoutineEntry(ex, i, dir)
      if (!reordered) return
      ex.splice(0, ex.length, ...reordered)
      cleanupSg(ex)
    })
  }
  // Replace (#110): the picker chooses what goes into slot `i`, and the slot keeps its sets, reps,
  // weight and the rest (lib/routines.js replaceSlotExercise). "+" on a picker row replaces at
  // once; tapping the row opens the new exercise's settings at those numbers first, the way the
  // add flow does. One pick and the picker closes — it is a chooser here, not a stack you keep
  // adding from. A slot that is no longer the exercise the sheet was opened on is left alone.
  const replace = i => {
    const openedOn = r.ex[i]?.id
    const commit = (ex, fn) => {
      picker.close()
      let done = false
      edit(x => { if (x[i] && x[i].id === openedOn) { x[i] = fn(x[i]); done = true } })
      if (done) toast(t('Replaced with “{0}”', exerciseNameText(ex)))
    }
    const picker = exercisePicker((ex, quick) => {
      // The slot and the history as they are now, not as this render saw them: a sync can land
      // while the picker is open, and the new exercise's weight comes from its own sessions.
      const live = useStore.getState().S
      const slot = live.routines.find(x => x.id === id)?.ex[i]
      if (!slot || slot.id !== openedOn) { picker.close(); return }
      // "+" on the exercise that is already in the slot: nothing to replace, and no toast that
      // says something was.
      if (quick && ex.id === openedOn) { picker.close(); return }
      if (quick) { commit(ex, current => replaceSlotExercise(current, ex.id, live, id)); return }
      const next = replaceSlotExercise(slot, ex.id, live, id)
      exConfigSheet(ex, next, cfg => commit(ex, current => ({ id: ex.id, sg: current.sg, ...cfg })), null, r, null, null, t('Replace'))
    }, { title: t('Replace exercise'), like: openedOn })
  }
  // This routine on paper (#282): the weekly printout's page for one session, through the same
  // two print paths — the browser's print dialog (→ Save as PDF) on the web, the native Print
  // plugin in the app, where the WebView has no window.print().
  const printRoutine = () => {
    const owner = useStore.getState().user?.name || ''
    // Android's print manager refuses a job without a name. The editor never leaves a name blank,
    // but a routine that arrived from an import or another client may have none.
    if (MOBILE) printHtml(planPrintHTML(S, owner, { routineId: id }), r.name || t('Routine')).catch(() => { /* dismissed */ })
    else printPlan(S, owner, { routineId: id })
  }
  const toggleLink = i => edit(ex => {
    if (i < 1) return
    const cur = ex[i], prev = ex[i - 1]
    if (cur.sg && prev.sg && cur.sg === prev.sg) delete cur.sg
    else { const gid = prev.sg || ('sg' + uid()); prev.sg = gid; cur.sg = gid }
    cleanupSg(ex)
  })

  const addExercise = () => exercisePicker((ex, quick) => {
    if (quick) {
      edit(x => x.push({ id: ex.id, ...defaultConfig(ex.id) }))
      toast(t('“{0}” added to {1}', exerciseNameText(ex), r.name))
    } else {
      exConfigSheet(ex, null, cfg => edit(x => { x.push({ id: ex.id, ...cfg }) }), null, r)
    }
  })

  const units = supersetUnits(r.ex)
  const unitFirst = new Set(units.filter(u => u.length > 1).map(u => u[0]))
  // Each superset gets a letter and each member its place in the round (A1, A2, B1…), so the
  // order you do them in reads off the list (#293).
  const ssPos = new Map()
  units.filter(u => u.length > 1).forEach((u, k) => u.forEach((idx, n) => ssPos.set(idx, String.fromCharCode(65 + (k % 26)) + (n + 1))))
  const unitOf = new Map(units.flatMap(u => u.map(idx => [idx, u])))
  const editSuperset = i => {
    const sg = r.ex[i]?.sg
    if (!sg) return
    supersetSheet(supersetMeta(r.ex, unitOf.get(i)), meta => edit(ex => { setSupersetMeta(ex, sg, meta) }))
  }
  const inSS = new Set(units.filter(u => u.length > 1).flat())
  const profile = activeProfile(S)
  const missingCount = profile ? r.ex.filter(e => !exAvailable(S, exOr(e.id))).length : 0
  const swipe = workoutControls(S).swipeSets

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/plan')} aria-label={t('Plan')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, margin: '0 12px' }}>
        <input className="input" defaultValue={r.name} style={{ fontWeight: 600, fontSize: 20, letterSpacing: '-.021em' }}
          onChange={e => update(s => { s.routines.find(x => x.id === id).name = e.target.value.trim() || t('Routine') })} />
      </div>
      <button className="iconbtn" aria-label={t('Pick an icon')} onClick={() => glyphPicker(r.emoji, g => update(s => { s.routines.find(x => x.id === id).emoji = g }))}><Icon name={glyphOf(r.emoji)} /></button>
    </div>

    <div className="sect-b" style={{ marginBottom: 16 }}>
      <SelectRow icon="chartLine" title={t('Progression')} sheetTitle={t('Progression')}
        value={r.prog || 'linear'} onChange={v => update(s => { s.routines.find(x => x.id === id).prog = v })}
        options={POLICIES_FOR.reps.map(p => ({ value: p, label: t(POLICY_NAME[p]), subtitle: t(POLICY_DESC[p]) }))} />
      {/* Two controls that read alike and are not (issue #294). Progression picks how this
          routine's own targets move, and "No automatic progression" keeps them where they are.
          This switch decides whether the routine's workouts count at all: a deload routine's
          sessions open at its own numbers and are never the baseline the next regular session
          progresses from (session-start.js, history.js entryExcluded). */}
      <Row icon="chartLineSlash" iconTint="var(--orange)" title={t('Deload routine')}
        subtitle={t('Its workouts do not count toward progression. They still show in history and statistics.')}>
        <Switch checked={r.excludeFromProgression === true} onChange={v => update(s => {
          const routine = s.routines.find(x => x.id === id)
          if (v) routine.excludeFromProgression = true
          else delete routine.excludeFromProgression
        })} />
      </Row>
    </div>
    <div className="small dim" style={{ margin: '-10px 2px 16px' }}>
      {r.excludeFromProgression
        ? t('A deload routine opens at the numbers set here, so the progression above does not apply to it.') + ' ' + t('The next regular target continues from the last included workout.')
        : t(POLICY_DESC[r.prog || 'linear'] || POLICY_DESC.linear) + ' ' + t('Applies to every exercise in this routine that does not set its own rule.')}
    </div>

    {missingCount > 0 && <div className="card" style={{ marginBottom: 16, borderColor: 'var(--orange)' }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Icon name="warning" style={{ color: 'var(--orange)' }} />
        <div className="small">{t('{0} of {1} exercises need equipment outside "{2}"', missingCount, r.ex.length, profile.name)}</div>
      </div>
    </div>}

    {coachEntry && <Button icon="sparkles" onClick={() => {
      try { useUI.setState({ coachDebriefIntent: selectionForPlan(S, id, 5) }); nav('/coach') }
      catch { useUI.getState().toast(t('No plan has saved workouts yet')) }
    }}>{t('Review recent workouts from this plan')}</Button>}
    {/* "Add exercise" heads the list (v1.3.11): with it under the last exercise, a long routine
        had to be scrolled to the bottom before anything could be added. */}
    <div className="row between plan-sec-h routine-ex-h">
      <h4 className="sec">{t('Exercises')}</h4>
      <Button size="sm" variant="tinted" icon="plus" onClick={addExercise}>{t('Add exercise')}</Button>
    </div>
    {r.ex.length ? <div ref={reorder.listRef} onClickCapture={reorder.onClickCapture}
      className={'list routine-list' + (reorder.drag ? ' is-reordering' : '')}>{r.ex.map((e, i) => {
      // An unresolvable id is shown rather than skipped — hiding it left an entry you
      // could neither see nor delete, but that still turned up in the workout.
      const ex = exOr(e.id)
      const noEquip = profile && !exAvailable(S, ex)
      const linkedPrev = i > 0 && e.sg && r.ex[i - 1].sg === e.sg
      // At a superset's edge an arrow takes the exercise out of it rather than past a neighbour.
      const leavesUp = inSS.has(i) && !linkedPrev
      const leavesDown = inSS.has(i) && r.ex[i + 1]?.sg !== e.sg
      const isDragging = reorder.drag && i >= reorder.drag.first && i <= reorder.drag.last
      const removeHere = () => removeRoutineExercise(id, i)
      // A tap anywhere on the row opens the exercise's sheet; its Remove is the keyboard's way
      // to take it out. The row itself is no button (it holds the link and Move buttons, which a
      // screen reader would lose inside one): the name is, a real <button> a click bubbles up
      // from. The long press treats it as the row (data-row-open, useRoutineReorder).
      const item = <div className={'item' + (inSS.has(i) ? ' in-ss' : '')} onClick={() => {
          exConfigSheet(ex, e, cfg => edit(x => { x[i] = { id: x[i].id, sg: x[i].sg, ...(x[i].sg ? { sgName: x[i].sgName, sgRest: x[i].sgRest } : {}), ...cfg }; cleanupSg(x) }), removeHere, r, null, () => replace(i))
        }}>
          {/* Shown on pointer devices only (index.css .routine-grip); the Move buttons and the
              long press stay the way in for a keyboard and a finger. */}
          <span className="routine-grip" data-drag-handle aria-hidden="true" title={t('Reorder exercises')}><Icon name="grip" /></span>
          {ssPos.has(i) && <span className="ss-pos" aria-label={t('Superset position {0}', ssPos.get(i))}>{ssPos.get(i)}</span>}
          <Thumb ex={ex} />
          <button type="button" className="grow item-open" data-row-open><span className={`tt ${exerciseNameClass(ex)}`}>{exerciseNameFor(ex)}</span><span className="ss">{exLine(e, S.unit, speedUnitOf(S))}</span>
            {e.note && <span className="small dim" style={{ marginTop: 2 }}>{e.note}</span>}</button>
          {noEquip && <span className="tag" style={{ color: 'var(--orange)', borderColor: 'var(--orange)' }} title={t('Needs {0}, which isn’t in your active profile', t(ex.eq))}><Icon name="warning" /></span>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 'none', alignItems: 'center' }}>
            {i > 0 && <button className={'iconbtn' + (linkedPrev ? ' on-ss' : '')} title={t('Superset with exercise above')} style={{ width: 32, height: 28, borderRadius: 8, fontSize: 15 }} onClick={ev => { ev.stopPropagation(); toggleLink(i) }}><Icon name="link" /></button>}
            <div style={{ display: 'flex', gap: 2 }}>
              <button className="iconbtn" aria-label={t('Move up')} title={leavesUp ? t('Move out of the superset') : t('Move up')} disabled={!moveRoutineEntry(r.ex, i, -1)} style={{ width: 28, height: 24, borderRadius: 7, fontSize: 12 }} onClick={ev => { ev.stopPropagation(); move(i, -1) }}><Icon name="chevronUp" /></button>
              <button className="iconbtn" aria-label={t('Move down')} title={leavesDown ? t('Move out of the superset') : t('Move down')} disabled={!moveRoutineEntry(r.ex, i, 1)} style={{ width: 28, height: 24, borderRadius: 7, fontSize: 12 }} onClick={ev => { ev.stopPropagation(); move(i, 1) }}><Icon name="chevronDown" /></button>
            </div>
          </div>
        </div>
      return <div key={i} data-routine-row data-ex-index={i}
        className={'routine-drag-row' + (isDragging ? ' is-dragging' : '')}
        style={isDragging ? { transform: `translate3d(0, ${reorder.drag.deltaY}px, 0)` } : undefined}>
        {unitFirst.has(i) && (() => {
          const meta = supersetMeta(r.ex, unitOf.get(i))
          return <button type="button" className="ss-label ss-label-btn" onClick={() => editSuperset(i)} title={t('Name and rest of this superset')}>
            <Icon name="link" /><span className="ss-label-name">{meta.name || t('Superset')}</span>
            {meta.rest > 0 && <span className="dim">· {t('{0} rest after each round', fmtRest(meta.rest))}</span>}
            <Icon name="pencil" />
          </button>
        })()}
        {/* Swipe (v1.3.11, Settings → Swipe actions): toward the start takes the exercise out,
            with an Undo; nothing on the other side. The long press still picks the row up to
            reorder it (a press that has lifted keeps the swipe out), and the row's sheet keeps
            Remove for a keyboard. Rows are keyed by index, so the row shuts when the count changes. */}
        {swipe
          ? <SwipeRow className="swrow-item" deleteLabel={t('Remove')} deleteIcon="minus" closeKey={r.ex.length}
            canSwipe={() => !reorder.lifted()} onDelete={removeHere}>{item}</SwipeRow>
          : item}
      </div>
    })}{reorder.drag && <div className="routine-drop-indicator" data-testid="routine-drop-indicator"
      aria-hidden="true" style={{ top: `${reorder.drag.indicatorTop}px` }} />}</div> : <div className="empty"><div className="ico"><Icon name="dumbbell" /></div>{t('No exercises yet. Add your first one!')}</div>}

    {/* Coverage of the routine as planned, so a gap shows up while you're building it
        rather than after a month of training around it. */}
    {r.ex.length > 0 && (() => {
      const load = loadOfRoutine(r)
      const { worked } = rankOf(load)
      return <div className="card" style={{ marginTop: 12 }}>
        <h2>{t('What this session hits')}</h2>
        <BodyMap load={load} body={S.body} />
        <div className="mchips">
          {worked.slice(0, 6).map(m => <span key={m} className="mchip">{t(MUSCLE_NAME[m])}</span>)}
        </div>
      </div>
    })()}

    <div className="small dim row" style={{ margin: '10px 2px', gap: 5 }}><Icon name="link" style={{ fontSize: 13 }} />{t('Tap the link button on an exercise to superset it with the one above. You’ll do them back-to-back.')}</div>
    <Button onClick={() => {
      const copy = copyRoutine(r, t('Copy'))
      update(s => { s.routines.push(copy) })
      nav('/plan/r/' + copy.id)
    }}>{t('Copy routine')}</Button>
    <div style={{ height: 10 }} />
    <Button disabled={!r.ex.length} onClick={printRoutine}>{t('Print / Save as PDF')}</Button>
    <div style={{ height: 10 }} />
    <Button variant="danger" onClick={() => confirmSheet({
      title: t('Delete routine?'), message: t('“{0}” and its exercises will be removed.', r.name), confirmText: t('Delete'), danger: true,
      onConfirm: () => {
        update(s => { deleteRoutine(s, id) })
        nav('/plan')
      }
    })}>{t('Delete routine')}</Button>
  </div>
}
