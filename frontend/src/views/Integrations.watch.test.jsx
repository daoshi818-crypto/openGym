// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'
import Integrations from './Integrations.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { bindUI } from '../components/ui.jsx'
import { collectWatchDiagnosticReport } from '../lib/watch-diagnostic-export.js'
import { shareExport, isAndroid } from '../lib/mobile.js'
import { pushWatchCatalog, selectWatchDevice } from '../lib/watch-link.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.__APP_VERSION__ = 'test'
const mocks = vi.hoisted(() => ({ sheet: null, navigate: vi.fn(), connection: { devices: [], selectedId: '', sdkConnected: false, appConnected: false } }))
vi.mock('../store/useStore.js', () => {
  const state = { S: { unit: 'kg', restSec: 90, effort: 'none', workouts: [], routines: [], exWeights: {} }, user: null, update: vi.fn() }
  state.update.mockImplementation(fn => fn(state.S))
  const useStore = selector => selector ? selector(state) : state
  useStore.getState = () => state
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const state = { toast: vi.fn(), openSheet: render => { mocks.sheet = render; return { close: vi.fn() } } }
  const useUI = selector => selector ? selector(state) : state
  useUI.getState = () => state
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: true, isAndroid: vi.fn(), shareExport: vi.fn(), syncReminder: vi.fn(), onAppActive: () => () => {} }))
vi.mock('../lib/rest-alert.js', () => ({ overlayStatus: async () => null }))
vi.mock('../lib/watch-link.js', async importOriginal => ({ ...await importOriginal(), watchState: () => 'off',
  watchAvailable: async () => ({ available: true }), onWatchState: () => () => {}, watchDevice: () => null,
  onWatchCommitStatus: () => () => {}, watchConnection: () => mocks.connection,
  onWatchConnection: cb => { cb(mocks.connection); return () => {} },
  watchCatalogStatus: () => ({ phase: 'idle' }), onWatchCatalogStatus: () => () => {},
  discoverWatchDevices: vi.fn(async () => true), probeWatchConnection: vi.fn(async () => false),
  getWatchDeviceInfo: vi.fn(async () => null), pushWatchCatalog: vi.fn(async () => true), selectWatchDevice: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/watch-workout.js', () => ({ watchCatalogOf: S => ({ t: 'plan_catalog', date: '2026-11-19', plans: S.routines, todayPlan: null }) }))
vi.mock('../lib/watch-diagnostic-export.js', () => ({ collectWatchDiagnosticReport: vi.fn() }))

let root, host
beforeEach(() => {
  bindUI(useUI)
  mocks.sheet = null
  mocks.navigate.mockClear()
  useStore.getState().S.modules = {}
  useStore.getState().S.routines = []
  useStore.getState().S.watchPlanIds = []
  mocks.connection = { devices: [], selectedId: '', sdkConnected: false, appConnected: false }
  pushWatchCatalog.mockClear(); selectWatchDevice.mockClear()
  isAndroid.mockResolvedValue(true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  shareExport.mockReset().mockResolvedValue(undefined)
  collectWatchDiagnosticReport.mockReset().mockResolvedValue({ format: 'opengym-watch-diagnostics', watchLog: { status: 'timeout' } })
})
afterEach(() => { act(() => root.unmount()); host.remove() })
async function openSheet() {
  await act(async () => root.render(<Integrations />))
  const row = [...host.querySelectorAll('.lrow')].find(e => e.textContent.includes('vivo BlueOS watch'))
  expect(row).toBeTruthy()
  expect(host.textContent).not.toContain('发送到手表的计划')
  act(() => row.click())
  expect(mocks.navigate).not.toHaveBeenCalled()
  await act(async () => root.render(mocks.sheet(vi.fn())))
}
const exportButton = () => [...host.querySelectorAll('button')].find(e => e.textContent.includes('导出诊断日志'))
describe('watch controls in integrations', () => {
  it('keeps device controls available when only server integrations are paused', async () => {
    useStore.getState().S.modules = { integrations: false }
    await openSheet()
    expect(exportButton()).toBeTruthy()
  })
  it('shows actual app connection and syncs the full catalog without displaying historical installations as devices', async () => {
    useStore.getState().S.routines = [{ id: 'plan-a', name: 'Strength A' }]
    mocks.connection = { devices: [{ id: 'watch-one', name: 'WATCH GT' }, { id: 'watch-two', name: 'WATCH GT' }], selectedId: 'watch-one', sdkConnected: true, appConnected: false }
    await openSheet()
    expect(host.textContent).toContain('手表连接：通道已连接，等待手表应用确认')
    expect(host.textContent).not.toContain('watch-two')
    expect([...host.querySelectorAll('button')].some(e => e.textContent === '选择')).toBe(false)
    await act(async () => [...host.querySelectorAll('button')].find(e => e.textContent === '同步全部训练计划').click())
    expect(pushWatchCatalog).toHaveBeenCalledWith(expect.objectContaining({ t: 'plan_catalog', plans: [{ id: 'plan-a', name: 'Strength A' }] }), true)
  })
  it('removes device controls from workout settings', async () => {
    await act(async () => root.render(<Settings page="workout" />))
    expect(host.textContent).not.toContain('Connect watch')
    expect(host.textContent).not.toContain('发送到手表的计划')
  })
  it('keeps watch controls hidden when its module is paused', async () => {
    useStore.getState().S.modules = { watch: false }
    await act(async () => root.render(<Integrations />))
    expect(host.textContent).not.toContain('vivo BlueOS watch')
    expect(host.textContent).not.toContain('发送到手表的计划')
  })
  it('does not offer Android watch controls on unsupported platforms', async () => {
    isAndroid.mockResolvedValue(false)
    await act(async () => root.render(<Integrations />))
    expect(host.textContent).not.toContain('vivo BlueOS watch')
    expect(host.textContent).not.toContain('发送到手表的计划')
  })
  it('exports a JSON report through native sharing even while disconnected', async () => {
    await openSheet()
    await act(async () => exportButton().click())
    expect(shareExport).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^openGym-watch-diagnostics-\d+\.json$/))
    expect(JSON.parse(shareExport.mock.calls[0][0])).toMatchObject({ watchLog: { status: 'timeout' } })
  })
  it('disables repeated export while collecting and re-enables after failure', async () => {
    await openSheet()
    let fail
    collectWatchDiagnosticReport.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    act(() => exportButton().click())
    const busy = [...host.querySelectorAll('button')].find(e => e.textContent.includes('正在收集日志'))
    expect(busy.disabled).toBe(true)
    await act(async () => { fail(new Error('failed')) })
    expect(host.textContent).toContain('日志导出失败，请重试')
    expect(exportButton().disabled).toBe(false)
    expect(shareExport).not.toHaveBeenCalled()
  })
})
