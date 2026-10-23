# Integration plan — 2026-10-18

## Acceptance criteria
- Preserve and unify existing RPE/RIR, exercise collapse, in-workout reorder, and statistics calendar changes on live origin/main.
- Do not change muscle analysis or training volume rules.
- Complete focused regression tests and local UI checks before one local app build.
- Prefer cached/local dependencies; no hosted build or release workflow invocation.
- After successful local verification/build, commit and push source to GitHub without wasting remote build resources.

## Phases
1. In progress: snapshot changes; confirm remote HEAD and applicable instructions.
2. Pending: review and repair all four feature areas and their integration.
3. Pending: run regressions and inspect responsive UI.
4. Pending: verify version, build app locally, document artifact and limitations.
5. Pending: commit/push integrated changes; report exact verification results.

## Known issues from previous handoff
- Sparse checkout causes missing-file failures in full tests.
- Full tests also have timezone/fixture failures not yet isolated.
- Previous tests: 142 focused cases passed (historical evidence only).
