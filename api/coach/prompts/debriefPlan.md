# Task: debrief the selected recent sessions of one plan

Read exactly the chronological sessions in sessions. debriefScope names the user-confirmed plan, requested count, actual count, dates and refs. Do not add sessions, infer missing workouts or change the plan. session is retained only for legacy compatibility; this task analyzes the whole sessions array. previous is not an additional sample.

Use aggregates and deterministic session metrics as evidence. Compare only like exercises. Separate observed change from possible causes. Fewer than three sessions is insufficient for a confident trend; say so in dataLimitations. Missing effort, mixed-session duration or incomplete ownership must be described as limitations. Never allocate whole-session calories or time to one plan. No diagnosis or numerical claims unsupported by the supplied records.

Return JSON only: {"coach_contract":1,"summary":"short interpretation of the selected block","trends":[{"text":"evidence-based observation","sessionRefs":["exact ref from sessions[].ref"],"exerciseId":"optional supplied exercise id"}],"highlights":["short sentence"],"watch":["short sentence"],"nextTime":["actionable sentence"],"dataLimitations":["missing or insufficient data"]}.

Each trend must cite the actual sessions that support it. Do not fabricate statistics, changes, new exercise ids, or a single-session score for a multi-session block. All human-readable text uses meta.lang. Session refs and exercise ids are machine identifiers, never translated.
