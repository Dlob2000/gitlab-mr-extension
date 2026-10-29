# MR approval count

Show the number of received approvals beside GitLab's Approved badge in the existing
MR list. The user requested research followed by implementation, and explicitly
reserved testing for themselves.

## Approach

- Parsing the existing GitLab tooltip needs no requests, but depends on its wording
  and cannot reliably distinguish missing data from zero approvals.
- Use GitLab's documented `GET /api/v4/projects/:id/merge_requests/:iid/approvals`
  and count `approved_by`. This is the implementation choice: it includes all
  approving users, regardless of approval-rule eligibility.

Use same-origin requests with the current GitLab session cookie. No token,
dependencies, settings, or extra extension permissions are needed.

## Behavior and constraints

- A native GitLab pill badge beside Approved shows `Approvals: N`, including zero.
- A loaded count matches Approved's success style; otherwise use a muted badge.
- Without Approved, place the count in the same controls area.
- Loading shows `Approvals: …`; unavailable data shows `Approvals: —` with a tooltip.
- Four concurrent requests maximum; cache successes and errors for 60 seconds.
- Refresh when the list changes or the user returns to the tab, subject to the cache.
- Support list re-rendering, pagination, nested project namespaces, and extension takeover.
- Do not infer merge readiness from the count or change Slack/clipboard formatting.
- Keep the existing plain JavaScript architecture; no tests or browser testing.

## Sources

- https://docs.gitlab.com/api/merge_request_approvals/#retrieve-approval-state-for-a-merge-request
- https://docs.gitlab.com/api/rest/authentication/#session-cookie
