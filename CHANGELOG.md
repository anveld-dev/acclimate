# Changelog

All notable changes to Acclimate will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial open-source release under Apache-2.0. The service, TypeScript packages and Python SDK are versioned `0.1.0`.
- A GitHub composite action (`examples/ci/action.yml`) and example pull request and post-merge release workflows in the CI starter.
- `acclimate-operator`, the review and release CLI, now ships in `@acclimate/sdk`.

### Changed

- The CI wrapper forwards cancellation to the evaluator, always prints its summary, reuses unchanged results across commits, reports diagnostics for every phase, writes GitHub annotations and Markdown, and accepts the token from an environment variable or file. `--rerun-after` replaces the wrapper's `--retry-after`, which remains as a deprecated alias.
- `compare --retry-after` accepts an interrupted predecessor. A request against a channel without a release reports `request.channel_empty`.
