// Browser-preview adapter only. This does not compile or package a BlueOS app.
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { parseDocument } = require('htmlparser2')
const fn = expr => 'function(){with(this){return (' + expr + ')}}'
function binding(text) {
  const parts = [], re = /{{([\s\S]*?)}}/g
  let from = 0, match
  while ((match = re.exec(text))) {
    if (match.index > from) parts.push(JSON.stringify(text.slice(from, match.index)))
    parts.push('(' + match[1].trim() + ')'); from = re.lastIndex
  }
  if (!parts.length) return null
  if (from < text.length) parts.push(JSON.stringify(text.slice(from)))
  return fn(parts.length === 1 ? parts[0] : parts.join('+'))
}
export function sourceTemplate(source) {
  const markup = source.match(/<template>([\s\S]*?)<\/template>/)?.[1]
  if (!markup) throw new Error('Missing source template')
  const doc = parseDocument(markup, { xmlMode: true, decodeEntities: true })
  function convert(el) {
    const a = el.attribs || {}, n = { type: el.name, attr: {}, children: [] }
    // Class bindings are arrays in the original preview's compiled-template shape.
    if (a.class?.includes('{{')) n.$class = 'function(){return [' + binding(a.class) + '.call(this)]}'
    else if (a.class) n.class = a.class
    if (a.if) n.$shown = binding(a.if)
    if (a.for) {
      const m = a.for.match(/^\s*{{\s*(\w+)\s+in\s+([\s\S]+?)\s*}}\s*$/)
      if (!m) throw new Error('Unsupported repeat: ' + a.for)
      n.repeat = { value: m[1], $exp: fn(m[2]) }
    }
    if (a.id) n.attr.id = a.id
    if (a.tid) n.attr.tid = a.tid
    if (a.onclick) n.action = a.onclick
    if (a.disabled) n.attr.$disabled = binding(a.disabled)
    if (n.type === 'text' || n.type === 'input') {
      const value = n.type === 'input' ? a.value || '' : (el.children || []).filter(c => c.type === 'text').map(c => c.data).join('')
      const dynamic = binding(value)
      if (dynamic) n.attr.$value = dynamic
      else n.attr.value = value
    }
    if (n.type === 'image') {
      if (binding(a.src || '')) n.attr.$src = binding(a.src)
      else n.attr.src = a.src
    }
    n.children = (el.children || []).filter(c => c.type === 'tag').map(convert)
    return n
  }
  const roots = doc.children.filter(c => c.type === 'tag')
  if (roots.length !== 1) throw new Error('Expected one source template root')
  return convert(roots[0])
}
