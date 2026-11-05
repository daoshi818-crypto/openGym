# Findings

- `S.workouts` is the completed-history source; `S.active` is an in-progress session.
- `frontend/src/lib/history.js` provides `workoutDay`, `workoutAt`, `workoutDuration`, `workoutVolume`, and completion helpers.
- `frontend/src/lib/muscles.js` provides canonical muscle aliases, primary/secondary weights, snapshots, and body-part fallback.
- `Stats.jsx` already contains summary tiles, a 12-month Heatmap, muscle balance/fatigue/strength, weekly plan volume, structural balance, photos, measurements, effort, bodyweight, exercise progress, and recent workouts.
- `sheets.jsx` already has a month calendar and separate same-day workout selection, but it does not show muscle labels or unique training-day counts.
- Existing locale packs already contain `Sessions`, `Workouts`, `No workouts this month`, `Previous month`, `Next month`, `Today`, and muscle names, so new strings should be kept minimal.
- The current working tree was clean before implementation.
