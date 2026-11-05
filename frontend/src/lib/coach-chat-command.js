// Whole-sentence intent only. This opens confirmation; it never authorizes a mutation.
export function chatCommand(text) {
  const line = String(text || '').trim().replace(/[。.!！?？]+$/u, '').replace(/\s+/gu, '').toLowerCase()
  if (['按这个改', '按上面的改', '就按这个改', '確認應用', '按這個改', '確認套用', '确认应用', '全部应用', '套用全部', 'applythis', 'applyall', 'confirmapply'].includes(line)) return 'apply'
  if (['放弃这个方案', '放棄這個方案', '取消这个方案', 'dismissthisproposal'].includes(line)) return 'dismiss'
  return null
}
