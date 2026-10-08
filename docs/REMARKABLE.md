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
2. **Reader to tablet.** A new `OutputAdapter` writes the EPUB core already builds into the xochitl folder with matching `.metadata`/`.content` files inside an "Inkwise" folder, then tells the running xochitl about it through the [librarian](https://github.com/rmitchellscott/rm-librarian) xovi extension (see "Refreshing the library" below).
3. **Tablet to Readwise.** A small TypeScript reader for v6 `.rm` files that pulls out `GlyphRange` text and colour (port the slice of rmscene we need). Each new highlight goes through core's existing `sendHighlight`, which already matches text back to the source HTML and tracks state in the manifest. Colour could map to Readwise tags.
4. **UI.** An AppLoad app with Connect (token), Sync now, and last-sync status. Auto-sync on a timer or on wake via the backend.
5. **Ship via Vellum** so it installs from reManager like everything else.

## Refreshing the library without a restart

xochitl reads its library folder when it starts and doesn't notice files added later. Restarting it works (and keeps other mods running) but is clunky, and must never happen while someone is reading.

[librarian](https://github.com/rmitchellscott/rm-librarian) (`librarian` in reManager; it pulls in `xovi-message-broker`) exposes xochitl's own library calls on a pipe: write `>e<signal>:<params>` to `/run/xovi-mb`, read the reply from `/run/xovi-mb-out`. InkWise uses four of them (`src/librarian.ts`):

- `rescanLibrary` once after a sync, so books written to disk show up. It loads every `.metadata` the running library doesn't know yet.
- `createFolder` for the Inkwise and Archive folders, so they exist in the running library before books go in them.
- `moveEntry` to archive and `trashEntry` to remove, so xochitl makes the change itself instead of us editing a `.metadata` it holds in memory.

`inkwise-rm` probes for librarian at start (a lookup of a made-up UUID, which librarian echoes). Without it, or if a call fails, InkWise falls back to editing files and restarting xochitl, which is what `XochitlOutput.needsRestart` tracks. Librarian needs software 3.28.

A book is never replaced once it's been opened (it has page files, a saved layout, or a `lastOpened` time): replacing it would move annotations onto the wrong words or pull it out from under the reader. A never-opened book is overwritten in place, which needs no restart because xochitl only reads the EPUB when the book is first opened.

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

1. ~~Sample pages from the Paper Pro~~ Done (Lance, 2026-10-08).
2. ~~Highlight reader~~ Done: `rmHighlights.ts` + `assemble.ts`. All three of Lance's test highlights (two-line, three-line over links, across a page turn) come back whole.
3. ~~Document writer~~ Done, against a fake library folder: `xochitl.ts` (`XochitlOutput`) puts Reader EPUBs in an "Inkwise" folder, archives to "Inkwise/Archive", sends removed ones to the tablet's trash, and never replaces a book that has annotations. `highlightSync.ts` sends every highlight on every Inkwise book to Readwise; a full round trip passes against the fake Readwise API.
4. ~~Check the `.metadata`/`.content` we write against a real one~~ Done against Lance's Paper Pro on software 3.28.0.172: metadata now has the same fields, and EPUBs still use the flat `pages` list (`formatVersion: 1`), which `pageOrder` reads. The `.pdf` xochitl renders from an EPUB has broken ligature mappings ("E cient", "o site"), which is where the garbled highlight text comes from; we match against the EPUB text instead.
5. ~~Device runtime~~ Done: `inkwise-rm`, one aarch64 binary (`bun build --compile`). Tested on Lance's Paper Pro with real Readwise. Uses librarian when it's installed; otherwise restarts xochitl only when `XochitlOutput.needsRestart` is set.
6. AppLoad screen (Connect, Sync now, last result) and automatic syncing.
7. Vellum package so it installs from reManager, depending on `librarian`.

Open questions: whether growing an existing highlight should replace the old one in Readwise (today it adds a second one).
