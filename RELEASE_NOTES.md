# Release Notes — inplace_issue_editor

## Public release – 25 Nov 2026
- First public release on GitHub. The whole plugin is now licensed under the GNU GPL v2.

## [Unreleased]

### Security
- Per-issue access control on every address; inline edits follow the normal issue form's validation (assignee, version, category, parent, progress, priority), refuse values that are not allowed and stale edits (409)
- Custom field definitions, member/version/sprint lists and attachment lookup limited to what the user may see or needs
- API description needs a login; no catch-all OPTIONS answer; API-key calls skip the CSRF token only without a browser session
- Safe links for stored URLs, escaped dates/hours, escaped texts in scripts; clean 4xx answers for odd input; no internal error text
- Project custom field cells show what is stored; HTML copied back into the page after a save loses handlers that fire by themselves
- Swagger UI updated to 5.33

### Performance
- (none)

### Features
- (none)

### Bug Fixes
- (none)

---

## [1.4.1] — 2026-03-26

### Features
- Initial plugin release: {list core features}
