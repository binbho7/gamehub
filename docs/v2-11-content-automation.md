# V2.11 incremental content automation

V2.11 automates local-first planning and reviewed publication while retaining the V2.10 pipeline contract and run IDs (`pipeline-v2.10:<manifestHash>`). The planner is bounded to 10–150 candidates, deterministic, and has no D1/provider mutation in dry-run mode.

Selection version 1 remains compatible. Selection version 2 is strict and carries the base artifact SHA and game count; incremental export preserves every baseline game, rejects base mismatch and slug collisions, and replaces the tracked artifact atomically with rollback protection.

The scheduled workflow is disabled unless the repository variable `CONTENT_AUTOMATION_ENABLED` is exactly `true`. Manual dispatch is available regardless. Provider secret values are never printed. Production D1, R2, Cloudflare deployment, automatic merge, and Batch 004 are outside this foundation.

If bounded discovery cannot use an approved API, planning stops with `DISCOVERY_API_GAP`; it never scrapes Steam or guesses IDs. Operators must review the plan, selection, local gates, artifact SHA, and exact-head review before publication.
