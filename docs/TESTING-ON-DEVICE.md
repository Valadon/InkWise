# Testing Inkwise on a Supernote

Everything in this repo has been tested against fakes (of Readwise, the Supernote plugin host and Supernote Cloud), but none of it has run on a device yet. This is the checklist for the first real run. It's ordered so each step tells you something even if the next one fails.

You'll need your Readwise token from [readwise.io/access_token](https://readwise.io/access_token).

## Part 1: before the plugin beta (CLI only, about 15 minutes)

These steps prove that the EPUBs read well and that highlights match, without touching the plugin.

```bash
git clone https://github.com/Valadon/InkWise.git && cd InkWise
npm ci && npm run build
export READWISE_TOKEN=your-token
alias inkwise="node $PWD/packages/cli/dist/index.js"

inkwise auth                                   # expect "Readwise token works."
inkwise sync --target folder --out ./out --limit 5
```

- [ ] **1.1** Five EPUBs appear in `./out`, named `Title__<id>.epub`.
- [ ] **1.2** Copy them to the Manta's `Document/` folder over USB, open each one in the DOC app, and check:
  - The title block at the top looks right.
  - Text is readable at the default size.
  - Images show up in greyscale.
  - Code blocks and tables don't overflow the page.
  - The table of contents opens.
- [ ] **1.3** **Highlight spike (the riskiest piece).** Pick a sentence from one of those articles that has curly quotes or an em dash, and send it from the terminal:

  ```bash
  inkwise highlight ./out/Some-Title__<id>.epub "the sentence, copied from the article"
  ```

  Expect `Highlight sent.` Then check in Reader that the highlight is on that article. Also try typing it with straight quotes (`"`); the output should say `Matched Reader's text as: …` with the curly version.
- [ ] **1.4** `inkwise archive <id>` moves the article to Archive in Reader. Move it back afterwards if you want to keep it.
- [ ] **1.5** (Optional) Supernote Cloud upload: `inkwise supernote-login`, then `inkwise sync --limit 2`. The files should show up in `Document/Inkwise` on the Manta after it syncs. If login fails, `inkwise supernote-login --token <x-access-token cookie from cloud.supernote.com>` also works.

## Part 2: install the plugin

1. Get `Inkwise.snplg` from the latest green CI run: **Actions → CI → newest run → Artifacts → Inkwise-snplg**. It downloads as a zip; the `.snplg` is inside.
2. Copy `Inkwise.snplg` into `MyStyle/` on the Manta.
3. **Settings → Apps → Plugins → Add Plugin**, then choose Inkwise.

- [ ] **2.1** It installs, and the plugin list shows the Inkwise icon (a page with lines).
- [ ] **2.2** Three buttons appear:
  - **Sync Reader** in the sidebar (in NOTE and DOC)
  - **Done** in the DOC sidebar
  - **Send highlight** in the DOC text-selection toolbar

## Part 3: plugin checks

### Setup
- [ ] **3.1** Open Inkwise's settings (the gear in the plugin list). Paste your token and tap **Save token**. Expect an Internet permission prompt. Choose **Always allow**, then expect "Token works."
- [ ] **3.2** Alternative path: tap **Disconnect**, save the token as `MyStyle/Inkwise/token.txt`, then tap **Import token file**. Expect read and delete permission prompts, then a message that the file was deleted.

### Sync
- [ ] **3.3** Tap **Sync Reader**. Expect write and read permission prompts (choose Always for both), progress lines, then "Synced N new, 0 updated."
- [ ] **3.4** Open `Document/Inkwise/` in the file browser. The articles are there and open in DOC.
- [ ] **3.5** Tap **Sync Reader** again. Expect "Synced 0 new, 0 updated."

### Highlights (the main event)
For each passage below, select it in an Inkwise EPUB and tap **Send highlight**. Expect "Highlight sent." Afterwards, check that every one shows up in Reader on the right article.
- [ ] **3.6** A plain sentence.
- [ ] **3.7** A sentence with curly quotes or an apostrophe (it’s).
- [ ] **3.8** A sentence with an em dash.
- [ ] **3.9** A selection that spans two paragraphs.
- [ ] **3.10** A sentence containing italics or a link.
- [ ] **3.11** Add a note from the highlight screen. It should show in Reader.
- [ ] **3.12** Send the same passage twice. The second time should say "Already sent this highlight."
- [ ] **3.13** Turn off Wi-Fi and send a highlight. Expect "Saved offline, will send on next sync." Turn Wi-Fi back on and tap **Sync Reader**. The result line should say it sent 1 saved highlight.
- [ ] **3.14** Select text in a non-Inkwise PDF and tap Send highlight. Expect "This document isn't from Readwise."

### Done
- [ ] **3.15** In an Inkwise article, tap **Done**. Expect "Archived in Reader. Moved to Inkwise/Archive." Check that the article is archived in Reader and the file is now in `Document/Inkwise/Archive/`.

## What we don't know yet

These are the open questions only a device can answer. If any of them goes wrong, the screen message (or a photo of it) is usually enough to fix it.

| Question | Where it matters | What to look for |
| --- | --- | --- |
| Does `getLastSelectedText()` work on EPUBs, and what does it return for multi-paragraph selections? | Send highlight | Steps 3.6 to 3.10. Wrong text shows up as "needs attention" in the settings queue. |
| Does `getCurrentFilePath()` return the full path in DOC? | Send highlight, Done | If it doesn't, every highlight will say "This document isn't from Readwise." |
| Does `react-native-fs` load inside PluginHost? | Everything that touches files | If not, Sync fails right away with a native module error. |
| Does the host allow `fetch` once Internet is granted? | Sync, highlights | "No connection to Readwise" even though Wi-Fi works. |
| Do the button icons render? | Looks only | Blank icons. |
| Does reopening the plugin view from a second button press re-run the action? | All buttons | Pressing Sync twice should sync twice. |
| Does Reader's tag filter want the tag's display name or its lowercase key? | Sync with a tag set | A tag filter that finds nothing. Try the tag in lowercase. |

## If something breaks

Post in the project thread with:
- the step number,
- exactly what the screen said (a photo works),
- your firmware version (Settings → About).

On the device, Inkwise keeps its state in the plugin's private folder. To start over, remove and re-add the plugin.
