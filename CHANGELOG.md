# Changelog

All notable changes to this project will be documented in this file.

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
