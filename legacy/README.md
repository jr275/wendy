# Legacy prototype (FROZEN)

The original JavaScript prototype UI and its file-based backend, kept only as the frozen UI
shell (see WENDY_INITIAL_ARCHITECTURE_AUDIT.md). It is **not connected** to the Cognitive Core in
`src/` and contains **no reasoning**: after Phase 0.5 its interpretation/anticipation/recommendation
layers report `NOT_IMPLEMENTED` and it has no email provider.

    npm run legacy:ui     # http://127.0.0.1:3456 (data in legacy/data/, gitignored)
    npm run legacy:test

It will be replaced when the UI is reconnected to the Cognitive Core (AG-UI phase).
