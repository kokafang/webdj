# Public online edition

Approved scope: match the current offline edition's UI and interactions, with online YouTube/Bilibili sources and no downloaded performance media or private vault files in GitHub.

Reuse the current four-deck layout, glass styles, key/relative-key display, 10–400% speed faders, Crate, piano, Follow card and About modes. Ship a static public frontend with a small local development server. The public seed includes curated track metadata and canonical source URLs only. Personal changes and bulk link imports stay in each browser. No public Obsidian writeback button.

Official embedded players provide playback without an extension. The included desktop Chrome extension adds independent pitch, precise speed, EQ, gain and reverb inside each player frame. Only explicitly permitted WebDJ hosts and their verified direct-child player frames may receive commands. Missing or failed processing must be visibly unavailable, not simulated. Four frame reverbs share settings and per-deck sends; they are not one cross-origin audio bus. Native iframe seeking cannot reproduce the offline two-decoder overlapping seek.

Ambient motion uses online covers without the extension and sampled live frames when available. UI assets (piano instrument samples and the Follow card) are application resources, not downloaded performance material.

Publish a fresh public repository without historical vault data. Validate Node tests, desktop/mobile UI, real extension connection where the provider is reachable, and inspect the exact staged file list before pushing.
