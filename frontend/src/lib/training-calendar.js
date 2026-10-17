import { EXIDX } from './exercises.js'
import { workoutDay, workoutDuration, workoutVolume } from './history.js'
import { hasCompletedWork, isWarmupRow } from './workout-model.js'
import { MUSCLES, MUSCLE_NAME, muscleWeightsOf } from './muscles.js'
import { isoOf, weekDayOffset, MONDAY } from './format.js'

const asDate = (year, month, day = 1) => new Date(year, month, day, 12, 0, 0, 0)

export const monthKeyOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

export const monthLabelOf = (year, month, locale) =>
  asDate(year, month).toLocaleDateString(locale, { month: 'long', year: 'numeric' })

export function monthCellsOf(year, month, weekStart = MONDAY) {
  const first = asDate(year, month)
  const leading = weekDayOffset(first.getDay(), weekStart)
  const count = new Date(year, month + 1, 0).getDate()
  const total = Math.ceil((leading + count) / 7) * 7
  return Array.from({ length: total }, (_, index) => {
    const date = asDate(year, month, index - leading + 1)
    return {
      iso: isoOf(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    }
  })
}

function sourceForEntry(entry) {
  const historical = entry?.exercise || entry
  // Preserve saved muscle weights when a custom exercise changes or disappears.
  return historical?.muscleWeights ? historical : (EXIDX[entry?.id] || historical || null)
}

// The catalogue gives primary muscles weight 1 and supporting muscles weight 0.4.
// For old body-part-only exercises, the largest fallback weight is the most useful
// conservative label for a compact day cell.
export function primaryMusclesOf(entry) {
  const weights = muscleWeightsOf(sourceForEntry(entry))
  const values = Object.entries(weights).filter(([, weight]) => Number(weight) > 0)
  if (!values.length) return []
  const primaryWeight = Math.max(...values.map(([, weight]) => Number(weight)))
  return MUSCLES.filter(slug => values.some(([value, weight]) => value === slug && Number(weight) === primaryWeight))
}

export function musclesOfWorkout(workout) {
  const muscles = new Set()
  for (const entry of workout?.entries || []) {
    if (!(entry?.sets || []).some(set => hasCompletedWork(set) && !isWarmupRow(set))) continue
    for (const slug of primaryMusclesOf(entry)) muscles.add(slug)
  }
  return MUSCLES.filter(slug => muscles.has(slug))
}

const routineIdsOf = workout => {
  if (Array.isArray(workout?.routineIds)) return workout.routineIds
  return workout?.routineId ? [workout.routineId] : []
}

// The calendar label is the routine the user selected for the session. Exercise muscles remain
// available for analysis elsewhere, but they are not a training-day topic and must not be shown as
// one (a chest routine can contain shoulder and triceps assistance work).
export function trainingTopicsOf(workout, routines = []) {
  const byId = routines instanceof Map ? routines : new Map((Array.isArray(routines) ? routines : []).map(r => [r.id, r]))
  const topics = []
  const add = value => {
    const name = String(value || '').trim()
    if (name && !topics.includes(name)) topics.push(name)
  }
  routineIdsOf(workout).forEach(id => add(byId.get(id)?.name))
  if (!topics.length) add(workout?.name)
  return topics
}

function sessionOf(workout, index, day, routines) {
  const volume = Array.isArray(workout?.entries) ? workoutVolume(workout) : Number(workout?.vol) || 0
  return {
    workout,
    index,
    day,
    topics: trainingTopicsOf(workout, routines),
    // Keep this field for callers that use the calendar data for analysis; the UI renders topics.
    muscles: musclesOfWorkout(workout),
    duration: workoutDuration(workout),
    volume: Math.max(0, volume),
  }
}

export function monthDataOf(workouts, year, month, routines = []) {
  const routineMap = routines instanceof Map ? routines : new Map((Array.isArray(routines) ? routines : []).map(r => [r.id, r]))
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`
  const sessions = (Array.isArray(workouts) ? workouts : [])
    .flatMap((workout, index) => {
      const day = workoutDay(workout)
      return day?.startsWith(prefix) ? [sessionOf(workout, index, day, routineMap)] : []
    })
  const byDay = new Map()
  for (const session of sessions) {
    const list = byDay.get(session.day) || []
    list.push(session)
    byDay.set(session.day, list)
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.workout.start || 0) - (b.workout.start || 0) || a.index - b.index)
  }
  const dayData = new Map()
  for (const [day, list] of byDay) {
    const muscles = new Set(list.flatMap(session => session.muscles))
    const topics = []
    list.flatMap(session => session.topics).forEach(topic => {
      if (!topics.includes(topic)) topics.push(topic)
    })
    dayData.set(day, {
      iso: day,
      sessions: list,
      topics,
      // Keep muscle data in the model for existing analysis consumers; the calendar presentation
      // deliberately uses topics above.
      muscles: MUSCLES.filter(slug => muscles.has(slug)),
      duration: list.reduce((sum, session) => sum + session.duration, 0),
      volume: list.reduce((sum, session) => sum + session.volume, 0),
    })
  }
  const topics = []
  for (const day of dayData.values()) day.topics.forEach(topic => { if (!topics.includes(topic)) topics.push(topic) })
  return {
    year,
    month,
    days: dayData,
    sessions,
    trainingDays: dayData.size,
    trainingSessions: sessions.length,
    topics,
    muscles: MUSCLES.filter(slug => [...dayData.values()].some(day => day.muscles.includes(slug))),
  }
}

export function dayLabelOf(slug) {
  return MUSCLE_NAME[slug] || slug
}
