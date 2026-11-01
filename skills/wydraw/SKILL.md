---
name: wydraw
description: Create or edit local, editable diagrams with wydraw. Use for system architecture, flows, schemas, or visual explanations requested in wydraw.
---

# Wydraw

Understand → compose → render → inspect → refine.

Resolve this skill's real path; the tool root is `../..`. Run `node scripts/diagram.mjs` from that root. Read the [command and scene reference](../../README.md#agent-interface) when drawing; `help` lists commands. Requires Node 22+ and installed dependencies (`npm ci --ignore-scripts` if missing).

Use whatever composition aids understanding: mix people, objects, auth boundaries, services, schemas, keys, and relationships. Default to warm white paper, graphite pencil strokes, rounded shapes, monospace labels, and FeedMe orange accents (`#FF8125`, pale peach `#FFF0E3`, dark orange `#B9480A` for small labels); freely adapt the style. Render meaningful diagram labels, without decorative prose unless requested. Ground actual-system diagrams in source evidence.

Use stable IDs, bound labels, groups for compound cards, and endpoint IDs for attached arrows. Inspect the current revision before patching. Preserve unrelated edits and locks. Enable untangle only when requested.

Render PNG/SVG headlessly and inspect for clipping, overlaps, and unclear connections. Deliver the editable `.excalidraw` file and preview. Use `open FILE` for the local viewer and cursor editing; pause agent writes during cursor mode until the user saves and returns control. No computer use is needed to draw. Keep private diagrams out of public repositories.
