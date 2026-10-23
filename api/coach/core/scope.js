// Shared hard boundary: a routine review cannot edit another routine or scheduling.
export function reviewScopeErrors(changes, scope) {
  if (!scope) return [];
  if (scope.kind !== 'routine' || typeof scope.routineId !== 'string') return ['invalid review scope'];
  return (changes || []).filter(c => ['week', 'add-routine', 'remove-routine'].includes(c.type)
    || c.target?.routineId !== scope.routineId).map(c => `change "${c.id}" is outside routine scope "${scope.routineId}"`);
}
