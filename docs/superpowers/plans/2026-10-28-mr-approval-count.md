# MR Approval Count Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan.

**Goal:** Display received approval counts in the existing MR list.

**Architecture:** Fetch approval state from GitLab in the content script using
session authentication. Render cached results through the existing DOM scan.

**Tech Stack:** Plain JavaScript, Chrome Manifest V3, GitLab REST API.

**Spec:** `docs/superpowers/specs/2026-10-28-mr-approval-count-design.md`

## Global Constraints

- No dependencies, token settings, or additional permissions.
- No tests or browser testing, per the user's explicit instruction.
- Leave changes in the current workspace for the user to test.

## Review Focus

- API errors and malformed payloads must not appear as zero approvals.
- Nested project paths must be encoded correctly and requests stay on the current origin.
- DOM scans must be idempotent and pending requests must be deduplicated.
- Re-rendering and navigation must not attach old results to a different MR.
- Extension takeover must cancel requests and prevent orphaned UI recreation.

### Task 1: Add and document the approval badge

**Files:** Modify `content.js` and `README.md`.

**Interfaces:** `getApprovalApiUrl(link)` returns a same-origin API URL or null;
`updateApprovalCounts()` attaches badges and renders request-cache state.

- [x] Add the badge styles, API URL parsing, request queue, timeout, and cache.
- [x] Integrate rendering, focus/visibility refresh, parsing, and takeover cleanup.
- [x] Document the feature and its session/API requirement.
- [x] Review the diff and perform a read-only code review; do not execute tests.

## Completion record

Implemented in the current workspace. `git diff --check` reported no whitespace
errors. Independent read-only review found no actionable issues. Tests, syntax
checks, and browser checks were not run, as requested.

The implementation uses event-driven refresh, and in-flight requests may finish
after their rows disappear. API URLs assume GitLab is hosted at the origin root,
consistent with the existing documented deployment; URL-subpath installations
would need additional API-base resolution.
