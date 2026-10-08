# InkWise on reMarkable: investigation

Status: research plus a first piece of code (the highlight reader). Written 2026-10-08 for the Paper Pro and Paper Pro Move with reManager installed.

## Has anyone done this already?

Not really. Nothing runs on the tablet and talks to Readwise.

| Project | What it does | Why it isn't InkWise |
|---|---|---|
| [rextract](https://github.com/zachwick/rextract) | Python scripts: pull highlights with `remarking`, upload to Readwise | Desktop only, one direction, 2 commits, predates the Paper Pro's highlight format |
| [Scrybble](https://scrybble.magma.dev/), [remarks](https://github.com/lucasrla/remarks), [E-Ink Sync](https://community.obsidian.md/plugins/eink-sync) | Extract reMarkable highlights into Obsidian | Obsidian, not Readwise; run on a computer |
| Read on reMarkable (Chrome extension) | Sends web pages to the tablet | No Readwise Reader link, no highlights back |
| Vellum package index (what reManager installs from) | ~40 mods: KOReader, highlight-reflow, TRMNL, F1 timing, etc. | No Readwise, Pocket, Instapaper or Wallabag package |

Readwise itself imports from Kindle, Kobo, Boox, Apple Books and others but has no reMarkable integration that I could find.

So InkWise would be the first on-device Readwise sync for reMarkable, and it would fill a gap people have been asking about.

## How reManager mods work

- **reManager** is a desktop app over SSH that installs packages from **Vellum** ([vellum.delivery](https://vellum.delivery)). Supports Paper Pro, Paper Pro Move and Paper Pure.
- Mods are built on **xovi** (injects code into `xochitl`, the reading app) plus **qt-resource-rebuilder** (patches its QML screens).
- **AppLoad** is a xovi extension that adds an app launcher. An app is a folder in `/home/root/xovi/exthome/appload/<name>/` with `manifest.json`, `icon.png`, a compiled QML UI (`resources.rcc`) and an optional `backend/entry` executable that talks to the UI over a Unix socket. The backend can be any aarch64 binary. [reTaskable](https://github.com/jdkruzr/reTaskable) (a CalDAV client, Rust backend, HTTPS sync, installs via Vellum) is the closest model for what we want.

## Where reMarkable keeps things

- Documents live in `/home/root/.local/share/remarkable/xochitl/` as `<uuid>.metadata`, `<uuid>.content`, `<uuid>.epub` and a `<uuid>/` folder of per-page `.rm` files.
- EPUBs are rendered to a PDF internally. Highlights are stored per page, by position, in the v6 `.rm` scene files as `GlyphRange` items, and each one carries the **highlighted text and colour**. [rmscene](https://github.com/ricklupton/rmscene) parses them (3.6+ highlight format supported). Because the text is right there, we don't need the tablet to tell us what was selected the way Supernote's plugin API does.
- What a Paper Pro actually writes (checked on Lance's pages, 2026-10-08): one piece per stroke, so a highlight dragged over three lines is three pieces, and one across a page turn is a piece on each page. Line breaks inside a piece are dropped ("Every’sJanuary"). Ligatures are garbled: "offsite" comes out as "o2site" and "filled" as "lled". The colour is in the colour index (3 yellow, 4 green, 5 pink); the exact-colour field is black. `packages/remarkable/src/assemble.ts` finds each piece in the source text with a tolerant match and joins same-colour pieces that touch, so Readwise gets the clean passage.
- [highlight-reflow](https://github.com/rmitchellscott/rm-highlight-reflow) exists because reMarkable highlights drift when you change font or margins. Worth installing alongside InkWise.

## Proposed design

A new `packages/remarkable` that reuses `packages/core` unchanged where it can.

1. **Backend binary.** Bundle core plus a reMarkable adapter into one aarch64 executable (`bun build --compile --target=bun-linux-arm64`, or Node SEA as a fallback). Core is pure TS with injected IO, so this is mostly glue.
2. **Reader to tablet.** A new `OutputAdapter` writes the EPUB core already builds into the xochitl folder with matching `.metadata`/`.content` files inside an "Inkwise" folder, then asks xochitl to reload (restart, or a xovi hook if one turns out cleaner).
3. **Tablet to Readwise.** A small TypeScript reader for v6 `.rm` files that pulls out `GlyphRange` text and colour (port the slice of rmscene we need). Each new highlight goes through core's existing `sendHighlight`, which already matches text back to the source HTML and tracks state in the manifest. Colour could map to Readwise tags.
4. **UI.** An AppLoad app with Connect (token), Sync now, and last-sync status. Auto-sync on a timer or on wake via the backend.
5. **Ship via Vellum** so it installs from reManager like everything else.

## What changes from the Supernote UX

- **No Send button needed, at first.** Every highlight syncs automatically. That is closer to how Kindle and Kobo work with Readwise. A "send only this one" button in the highlight menu would mean a QML patch to xochitl, which breaks more often across firmware updates. Possible later.
- **Notes.** reMarkable highlights have no typed note field. Options: skip notes, or treat handwriting/typed text near a highlight as its note (later).
- **Archive / Done.** Moving a document to an "Archive" folder on the tablet could archive it in Reader.

## Risks

- Firmware updates can break xovi mods until they're updated. reManager lets you pause auto-updates.
- The `.rm` format has changed before (3.6 changed highlights). Pinning to rmscene's test files keeps us honest.
- Injecting documents while xochitl runs needs care so the library refreshes without corrupting anything.
- I can't reach the tablet from the cloud container, so device tests go through Lance (same as the Manta).

## Alternative: cloud route

Use the reMarkable cloud API (like rmapi) from a server or scheduled job instead of running on the tablet. No mods needed and both tablets stay in sync, but it depends on an undocumented API, needs cloud sync on, and can't add on-device UI. Keep as a fallback.

## Next steps

1. Lance: highlight a few passages (two colours, one across a page break) in any EPUB on the Paper Pro, then copy that document's folder from `/home/root/.local/share/remarkable/xochitl/` using reManager's file browser. Book text only, nothing private, since these files stay out of the public repo.
2. ~~Prototype the `.rm` highlight reader~~ Done: `packages/remarkable/src/rmHighlights.ts`, tested on rmscene fixtures (firmware 3.1 and 3.14). Checked on Lance's Paper Pro pages: all three highlights (two-line, three-line over links, across a page turn) come back whole.
3. Prototype the document writer and test one Reader article landing in an Inkwise folder.
4. Wrap both in an AppLoad app and a Vellum package.
