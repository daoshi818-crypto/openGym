// BlueOS pages have separate module bundles. Bind every page to the application definition,
// so one owner serializes storage and owns the connection for the entire app lifetime.
let owner = {}
export function bindRuntime(app) { if (app && typeof app === 'object') owner = app }
export function runtime() { return owner.openGymRuntime ||= {} }
