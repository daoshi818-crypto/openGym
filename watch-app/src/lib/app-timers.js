import { runtime } from './runtime.js'

// BlueOS binds timer callbacks to their creating App/Page. The App installs these
// functions before any page starts; sharing timer IDs alone does not share lifetime.
export function appTimeout(fn, ms) { return (runtime().timers?.setTimeout || setTimeout)(fn, ms) }
export function cancelAppTimeout(id) { if (id != null) (runtime().timers?.clearTimeout || clearTimeout)(id) }
export function appInterval(fn, ms) { return (runtime().timers?.setInterval || setInterval)(fn, ms) }
export function cancelAppInterval(id) { if (id != null) (runtime().timers?.clearInterval || clearInterval)(id) }
