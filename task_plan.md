# openGym training calendar

## Acceptance criteria

- [x] Derive month calendar data from `S.workouts` without adding persisted fields.
- [x] Distinguish unique training days from saved workout sessions, including multiple sessions on one day.
- [x] Resolve day muscles through the existing `muscles.js` metadata and keep unknown mappings visible as neutral training.
- [x] Add a Stats calendar/trends switch while preserving all existing Stats content and interactions.
- [x] Add month navigation, current-month shortcut, day selection, and per-session details.
- [x] Add a lightweight Home entry and responsive styles without introducing dependencies.
- [ ] Add focused unit/component coverage, run locale checks, frontend tests, and production build.

## Phases

1. Data model and tests (complete)
2. Calendar component and Stats integration (complete)
3. Home entry, styles, and localization (complete)
4. Verification and browser smoke check (in progress)

## Decisions

- `workoutDay()` is the canonical local calendar-day reader.
- Each valid saved `S.workouts` item counts as one session; unique `workoutDay()` values count as days.
- Same-day sessions remain separate in details; muscle labels are deduplicated only for the day cell/summary.
- Existing `Heatmap`, `calendarSheet`, `WorkoutRow`, and `workoutDetailSheet` remain the detail/legacy trend primitives.
