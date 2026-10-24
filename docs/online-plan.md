# Public Online Edition Implementation Plan

**Goal:** Publish the current WebDJ design as a usable online public GitHub project, excluding downloaded performance media.
**Architecture:** Reuse the offline presentation modules. Add official-player and extension adapters, browser-local library storage, and a static-only development server.
**Tech Stack:** Vanilla JavaScript, Node.js 22+, Chrome Manifest V3, Playwright.

- [x] Copy current presentation assets and sanitize 184 track records; retain URLs, metadata and category relationships only.
- [x] Implement browser library edits/imports and official iframe playback with generation guards; expose accurate audio capability states.
- [x] Adapt the existing trusted-frame extension for four decks, current fader limits, frame snapshots and reverb sends; test validation and frame isolation.
- [x] Verify browser desktop/mobile flows, About click-through, Crate, links, library persistence and extension behavior; document platform limits.
- [x] Inspect staged contents, run complete tests, create public kokafang/webdj repository and verify the pushed commit/visibility.
