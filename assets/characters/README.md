# Character artwork (Emotional Concierge)

Source files supplied by the product owner, who stated on 2026-10-10 that they hold the rights to this
artwork (Inside Out characters). The licence is the owner's responsibility and has not been verified.

- `source/` — the originals as supplied (not served).
- `web/public/characters/<id>.webp` — 256×256 face crops generated from them by
  `node scripts/build-characters.mjs` (served to the interface; the registry in
  `web/lib/characters.ts` is the only thing that maps an id to a file).
- Replacing artwork: drop a new file in `source/`, adjust its crop in the script, rebuild.
