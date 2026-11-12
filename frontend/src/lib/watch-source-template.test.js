// @vitest-environment node
import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { sourceTemplate } from '../../../watch-app/scripts/source-template.mjs'
const value = (expr, ctx) => runInNewContext('(' + expr + ')', {}).call(ctx)
it('previews current source bindings, repeat scope and native vector tags without a build', () => {
  const tree = sourceTemplate('<template><div class="page {{ active ? \'selected\' : \'\' }}"><text if="{{ active }}">第 {{ index + 1 }} 组</text><div for="{{ item in rows }}" tid="key" onclick="pick(item)"><image src="{{ item.icon }}" /><input type="button" value="{{ item.name }}" /></div></div></template>')
  const ctx = { active: true, index: 1, rows: [{ name: '撤回', icon: '/check.svg' }] }
  expect(value(tree.$class, ctx)).toEqual(['page selected'])
  expect(value(tree.children[0].$shown, ctx)).toBe(true)
  expect(value(tree.children[0].attr.$value, ctx)).toBe('第 2 组')
  const repeat = tree.children[1]
  expect(value(repeat.repeat.$exp, ctx)).toBe(ctx.rows)
  expect(repeat.children.map(n => n.type)).toEqual(['image', 'input'])
  expect(value(repeat.children[0].attr.$src, { item: ctx.rows[0] })).toBe('/check.svg')
})
