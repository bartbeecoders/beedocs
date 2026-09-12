# BeeDocs v0.8.1 — QA suggestions for Claude Code

**Date:** 2026-09-04  
**Tester:** Appy (automated UI pass)  
**App:** https://beedocs.hideterms.com/  
**Account used:** `grok` (temporary test account)

## Summary

Signed in successfully and exercised the main documentation workspace: library hierarchy, markdown editing, diagrams, kanban, projects, slides, search, version history, export/import UI, public shelf preview, users/roles, statistics, themes, storage, AI providers, Git settings, help, and API health.

Overall the product feels feature-rich for v0.8.1. The issues below are prioritized for the next iteration.

## Priority suggestions

### 1. Diagram kind switching is unsafe (major)

**Observed:** Switching a diagram between BeeDiagram and Mermaid with incompatible content immediately produced `UnknownDiagramError` and changed the diagram kind without warning or confirmation.

**Suggestion:**
- Validate content before changing diagram kind.
- If incompatible, block the switch and offer: keep current kind, convert (when possible), or open a confirm dialog that explains data may be lost.
- Prefer soft rollback to the previous kind on parse failure instead of leaving a broken state.

### 2. Anonymous API publishing appears enabled by default (major / security)

**Observed:** Sign-in & API settings report: “No key set — apps can publish without authentication.”

**Suggestion:**
- Default to requiring authentication for publish/API write paths.
- Make anonymous publishing an explicit opt-in with a strong warning.
- Surface auth status prominently in the admin header / security checklist.

### 3. Force password change for temporary accounts (UX / security)

**Observed:** Account page clearly warns that Grok still uses the supplied temporary password.

**Suggestion:**
- On first login with a temporary password, force a password-change flow before entering the workspace.
- Optionally expire temporary passwords after first successful login or after N days.

### 4. Context menu leftover after drag/drop (minor)

**Observed:** Dragging a page into a folder left the context menu visible afterward.

**Suggestion:** Dismiss open context menus / overlays on successful drag end, Escape, and blur.

### 5. Inconsistent “New project” entry points (minor)

**Observed:** Top-menu “New project” initially produced no visible response; the workspace CTA worked.

**Suggestion:** Route all create actions through one shared command/handler so menu, toolbar, and empty-state CTAs behave identically and show toast/feedback.

### 6. Storage provider creation is too eager (minor)

**Observed:** Adding a storage provider created an empty provider record immediately rather than first showing a confirmation/setup form.

**Suggestion:** Open a setup modal first; only persist after required fields validate. Offer cancel without creating a stub record.

### 7. Export feedback (UX)

**Observed:** Export menu opened and Markdown export initiated; success/download feedback was not clearly visible, and download bytes were not independently verified in this pass.

**Suggestion:**
- Show toast: “Export started / downloaded” with format and filename.
- On failure, show actionable error text.
- Consider in-app download history for large exports.

## Accessibility / polish

- Strengthen focus states for keyboard navigation.
- Ensure icon-only buttons have accessible names.
- Audit keyboard coverage for library tree, editor modes, and dialogs.
- Keep destructive actions behind confirm dialogs with clear object names.

## What worked well

- Login and workspace load were reliable.
- Creating/editing books, folders, pages, diagrams, kanban, projects, and slides worked.
- Renaming, markdown editing, autosave, search, page movement, and version history (v1/v2 + author metadata) worked.
- Mermaid rendering and basic BeeDiagram editing worked.
- Public website preview opened as an unpublished preview.
- Admin screens (users, settings, statistics, help, storage, API, AI providers) loaded.
- API health returned OK (`BeeDocs.Api`, v0.8.1).
- Statistics reported 27 documents and 0 uploads/attached files at test time.

## Gaps not fully tested (need follow-up)

These need local file selection or longer flows:

- Attachment / PDF / 3D uploads
- Completing an import of `.beedocs`, ZIP Markdown, or single `.md`
- Verifying PDF/DOCX export file contents
- Full permission matrix across roles
- Collaborative multi-user editing conflicts

## Leftover test content (safe to delete)

All intentionally prefixed for cleanup:

- `Appy Test Book`
- `Appy Test Folder`
- `Appy Test Page Renamed`
- `Appy Test Diagram`
- `Appy Test Slides`
- `Appy Test Kanban`
- `Appy Test Project`

No real user content was deleted during the pass. A temporary empty Azure storage provider created during inspection was removed.

## Suggested Claude Code prompts

Use these as starter tickets:

1. “Harden diagram kind switching: validate before switch, confirm on incompatible content, rollback on `UnknownDiagramError`.”
2. “Default API publish to authenticated-only; make anonymous publish an explicit admin opt-in with banner.”
3. “Force password change on first login when account flag `mustChangePassword` is set.”
4. “Close context menus after drag-and-drop completes in the library tree.”
5. “Unify New project / create handlers and add success toasts for create + export actions.”
6. “Don’t persist storage providers until setup form is submitted.”

---

*Generated from an automated browser QA pass against BeeDocs v0.8.1.*
