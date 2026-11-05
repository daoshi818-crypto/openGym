import { describe, expect, it } from 'vitest'
import { WORKOUT_COLUMNS, workoutsCSV } from './export-csv.js'
import { mergeImport, parseImport } from './import-csv.js'
import { setNoteOf } from './set-notes.js'

// A note on one set (upstream v1.4.4 "A note on any set") leaves through `set_note` and comes
// back on the same set. These are the two ends of one promise: the column exists, and a file that
// carries one re-imports with the note still on its own row rather than folded into the
// exercise's note.
const at = (d, h) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime()

const state = () => ({
  unit: 'kg',
  customEx: [],
  workouts: [{
    id: 'w1', d: '2026-03-02', start: at('2026-03-02', 18), end: at('2026-03-02', 19),
    name: 'Push', routineId: 'r1', prs: [],
    entries: [
      { id: '0025', note: 'whole exercise', sets: [
        { w: 60, r: 5, done: true },
        { w: 62.5, r: 5, done: true, note: 'grip slipped' },
        { w: 62.5, r: 4, done: true },
      ] },
      // A per-side set keeps ONE note on the row, written once (left row), never duplicated.
      { id: '0294', sets: [
        { done: true, w: 14, r: 15, note: 'left elbow', sides: { L: { w: 14, r: 8, done: true }, R: { w: 14, r: 7, done: true } } },
      ] },
      { id: '3666', sets: [{ min: 22.5, speed: 9, done: true, note: 'easy pace' }] },
    ],
  }],
})

// mergeImport fills the state it is given and reports what it added, so each case reads the
// state back after the call.
const importInto = S => csv => { mergeImport(S, parseImport(csv)); return S }

describe('set notes in the CSV', () => {
  it('has a set_note column', () => {
    expect(WORKOUT_COLUMNS).toContain('set_note')
    // Last, so every existing column keeps its position for a reader that counts them.
    expect(WORKOUT_COLUMNS[WORKOUT_COLUMNS.length - 1]).toBe('set_note')
  })

  it('writes the note on its own set row and leaves the others empty', () => {
    const csv = workoutsCSV(state())
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
    const header = lines[0].split(',')
    const col = header.indexOf('set_note')
    const noteCol = header.indexOf('note')
    const cells = lines.slice(1).map(l => l.split(','))
    // The exercise note stays in its own column, on the first row of that exercise.
    expect(cells[0][noteCol]).toBe('whole exercise')
    expect(cells[0][col]).toBe('')
    expect(cells[1][col]).toBe('grip slipped')
    expect(cells[1][noteCol]).toBe('')
    expect(cells[2][col]).toBe('')
    // The per-side pair: the note is on the left row only.
    const lRow = cells.find(c => c[header.indexOf('side')] === 'L')
    const rRow = cells.find(c => c[header.indexOf('side')] === 'R')
    expect(lRow[col]).toBe('left elbow')
    expect(rRow[col]).toBe('')
    // A cardio row keeps its own note too.
    expect(cells.at(-1)[col]).toBe('easy pace')
  })

  it('re-imports the note on the same set, not on the exercise', () => {
    const csv = workoutsCSV(state())
    const fresh = { workouts: [], bodyweight: [], customEx: [], exWeights: {} }
    const merged = importInto(fresh)(csv)
    const w = merged.workouts.find(x => x.d === '2026-03-02')
    const bench = w.entries.find(e => e.id === '0025')
    expect(bench.sets.map(setNoteOf)).toEqual(['', 'grip slipped', ''])
    // The exercise's own note is untouched by the set's note.
    expect(bench.note).toBe('whole exercise')
    const side = w.entries.find(e => e.id === '0294').sets[0]
    expect(setNoteOf(side)).toBe('left elbow')
    expect(w.entries.find(e => e.id === '3666').sets[0].note).toBe('easy pace')
  })

  it('stays idempotent: importing the same file twice adds nothing and loses no note', () => {
    const csv = workoutsCSV(state())
    const fresh = { workouts: [], bodyweight: [], customEx: [], exWeights: {} }
    const twice = importInto(importInto(fresh)(csv))(csv)
    expect(twice.workouts).toHaveLength(1)
    const bench = twice.workouts[0].entries.find(e => e.id === '0025')
    expect(bench.sets.map(setNoteOf)).toEqual(['', 'grip slipped', ''])
  })

  it('reads a file with only a Note column the way it always did', () => {
    // No set_note column at all: the exercise keeps its single note, and no set grows one.
    const csv = '\uFEFFexercise,date,weight,reps,note\r\nBench Press,2026-02-01,60,5,felt good\r\n'
    const fresh = { workouts: [], bodyweight: [], customEx: [], exWeights: {} }
    const merged = importInto(fresh)(csv)
    const e = merged.workouts[0].entries[0]
    expect(e.note).toBe('felt good')
    expect(e.sets.every(s => !s.note)).toBe(true)
  })
})
