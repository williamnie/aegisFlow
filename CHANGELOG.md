# Changelog

All notable changes to this project will be documented in this file.

## 1.0.4 - 2026-03-18

- Harden prompt generation across idea intake, requirement validation, technical design, review, roundtable, PRD revision, and integration review so user-facing artifacts stay scoped to the target project instead of leaking AegisFlow-specific workflow concepts.
- Add project-scoping guardrails and safer target-project inference to reduce prompt contamination when running the pipeline from inside the AegisFlow repository.
- Verify the goTorrent design flow with a clean `design-test.md` artifact and align release metadata for the new prompt-safety patch.

## 1.0.2 - 2026-03-19

- Fix stage2 prompt pollution issue


## 1.0.1 - 2026-03-17

- Add `aegis --sessions` to list saved sessions with their project paths and latest pipeline stages.
- Add `aegis <session-id> --from <stage>` so a run can restart from a specific pipeline stage and regenerate downstream artifacts cleanly.
- Improve markdown output handling across the orchestrator, adapters, and chat UI so generated documents render more reliably.
- Streamline configuration persistence, including stage-specific routing preferences, cleaner sample config output, and timeout migration into the global config.
- Remove the checked-in sample `prd.md` artifact from the repository.

## 1.0.0 - 2026-03-15

- Publish AegisFlow as an installable npm CLI package.
- Add executable commands `aeigs` and `aegisflow`.
- Bundle the CLI into `dist/index.js` with a release-friendly build pipeline.
- Add release checks, package docs, and GitHub Actions publish workflow.
