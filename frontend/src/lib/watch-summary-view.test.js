import { describe, expect, it } from 'vitest'
import { summaryDurationLabel, summaryMinutesOf, summaryNameLabel, summarySetsLabel,
  summaryVolumeOf, summaryHeartOf, summaryCaloriesOf, summarySyncLabel } from '../../../watch-app/src/lib/summary-view.js'

describe('summary duration', () => {
  it('reads whole minutes, never a fake stopwatch', () => {
    expect(summaryDurationLabel(52.13)).toBe('52分钟')
    expect(summaryDurationLabel(52)).toBe('52分钟')
    // Rounds first, so 59.6 is the hour it rounds to and 65 keeps its minutes.
    expect(summaryDurationLabel(59.6)).toBe('1小时00分钟')
    expect(summaryDurationLabel(65)).toBe('1小时05分钟')
    expect(summaryDurationLabel(125)).toBe('2小时05分钟')
  })

  it('says what it knows for a very short, missing or broken duration', () => {
    expect(summaryDurationLabel(0)).toBe('少于1分钟')
    expect(summaryDurationLabel(0.4)).toBe('少于1分钟')
    expect(summaryDurationLabel(null)).toBe('未记录')
    expect(summaryDurationLabel(undefined)).toBe('未记录')
    expect(summaryDurationLabel(NaN)).toBe('未记录')
    expect(summaryDurationLabel(-3)).toBe('未记录')
    expect(summaryDurationLabel('52')).toBe('未记录')
  })

  it('prefers the whole-session minutes and falls back to the segment', () => {
    expect(summaryMinutesOf({ totalMinutes: 52.13, minutes: 12 })).toBe(52.13)
    expect(summaryMinutesOf({ minutes: 12 })).toBe(12)
    expect(summaryMinutesOf({ totalMinutes: null, minutes: 12 })).toBe(12)
    expect(summaryMinutesOf({ totalMinutes: NaN, minutes: 12 })).toBe(12)
    expect(summaryMinutesOf({})).toBeNull()
    expect(summaryMinutesOf(null)).toBeNull()
  })
})

describe('summary fields', () => {
  it('names the workout, and says "freestyle" rather than showing a blank title', () => {
    expect(summaryNameLabel({ workout: 'Push day' })).toBe('Push day')
    expect(summaryNameLabel({ workout: '   ' })).toBe('自由训练')
    expect(summaryNameLabel({ workout: 42 })).toBe('自由训练')
    expect(summaryNameLabel({})).toBe('自由训练')
  })

  it('keeps a real zero apart from a missing value', () => {
    expect(summarySetsLabel({ sets: 0 })).toBe('0')
    expect(summarySetsLabel({ sets: 17 })).toBe('17')
    expect(summarySetsLabel({})).toBe('未记录')
    expect(summarySetsLabel({ sets: null })).toBe('未记录')
    // An old summary that stored the set list itself reads as a count, not "[object Object]".
    expect(summarySetsLabel({ sets: [{}, {}] })).toBe('2')
    expect(summaryCaloriesOf({ totalCalories: 0 })).toBe('0')
    expect(summaryCaloriesOf({})).toBeNull()
    expect(summaryCaloriesOf({ totalCalories: NaN, calories: 312 })).toBe('312')
    expect(summaryCaloriesOf({ totalCalories: 340, calories: 312 })).toBe('340')
  })

  it('shows volume with its unit, and hides it when there is none', () => {
    expect(summaryVolumeOf({ volume: 4200, weightUnit: 'kg' })).toEqual({ text: '4,200', unit: 'kg' })
    expect(summaryVolumeOf({ volume: 0, weightUnit: 'lb' })).toEqual({ text: '0', unit: 'lb' })
    expect(summaryVolumeOf({ volume: 1200 })).toEqual({ text: '1,200', unit: 'kg' })
    expect(summaryVolumeOf({})).toBeNull()
    expect(summaryVolumeOf({ volume: NaN })).toBeNull()
  })

  it('never paints an unsampled 0 as a heart rate', () => {
    expect(summaryHeartOf({ avgHr: 118, maxHr: 156 })).toEqual({ text: '118 平均 · 156 最高' })
    expect(summaryHeartOf({ avgHr: 118, maxHr: 0 })).toEqual({ text: '118 平均' })
    expect(summaryHeartOf({ avgHr: 0, maxHr: 156 })).toEqual({ text: '156 最高' })
    expect(summaryHeartOf({ avgHr: 0, maxHr: 0 })).toBeNull()
    expect(summaryHeartOf({})).toBeNull()
  })
})

describe('summary sync label', () => {
  it('only claims a phone copy once this session\'s summary was really acknowledged', () => {
    expect(summarySyncLabel({ delivered: true, pending: 0, connected: true })).toBe('已同步到手机')
    // A close ack landed but the summary did not: still waiting for the phone.
    expect(summarySyncLabel({ delivered: false, pending: 0, connected: true })).toBe('已本地保存 · 待手机确认')
    // An empty queue on a live connection is not proof of anything.
    expect(summarySyncLabel({ delivered: false, pending: 0, connected: true })).not.toBe('已同步到手机')
  })

  it('describes offline and queued states without inventing failures', () => {
    expect(summarySyncLabel({ delivered: false, pending: 3, connected: false })).toBe('已本地保存 · 离线待同步')
    expect(summarySyncLabel({ delivered: false, pending: 3, connected: true })).toBe('已本地保存 · 有待传事件')
    expect(summarySyncLabel({ delivered: false, pending: 0, connected: false })).toBe('已本地保存 · 离线待同步')
    // No journal entry / no sid on an old summary: stay conservative.
    expect(summarySyncLabel({})).toBe('已本地保存 · 离线待同步')
  })
})
