# Cork

A little room for loose thoughts: a cork board with colorful sticky notes and lined index cards. Put things wherever they make sense, move them around, and let the notes grow with your thoughts.

**Plain HTML, CSS, and JavaScript. No backend, accounts, API keys, npm dependencies, or build step required to use it.** GitHub Pages serves the same static files that run locally.

## Use the board

1. Choose a category in the left sidebar. A preview note, with the category in bold, follows your cursor over the board.
2. Click anywhere on the cork to pin it. On a phone or tablet, open the sidebar with the small button in the top-left corner, choose a category, then tap a spot.
3. Type in the note. It grows vertically as you write, and longer lines can widen it. The text is plain text; the list button adds bullets and Enter continues bulleted or numbered lists. Press Enter on an empty bullet to finish the list.
4. Grab a note by its **top edge** to move it anywhere. You can also focus that edge with Tab and move it with the arrow keys; hold Shift for one-pixel adjustments.

**Index card** places a larger, lined card with its own editable title and no category. Both notes and index cards expand with their content. Drag the little bottom-right corner to choose a width; double-click that corner to restore automatic width. With the corner focused, the left and right arrow keys adjust width.

Use **Find a category** to search the scrollable list. The sidebar works with 100 or more categories. **Surprise me** picks from the entire category file, even when a search is active, and avoids immediately repeating the currently attached category when there is a choice.

Drag empty cork to pan. Use the bottom-right controls to zoom, switch to the hand tool, or fit all notes into view. A trackpad or mouse wheel zooms around the cursor without a modifier key. Drag empty cork to pan. Two-finger pinch also zooms on touch screens. On phones, tapping note text brings it in close for writing and keeps the caret above the keyboard. Tap **Done** to finish, then pinch or use **Fit all notes** to step back. Escape cancels a note before it is placed.

Select a note to reveal bullet, duplicate, and delete controls. Delete can be undone. The left sidebar holds the board name, save status, undo/redo, and the **⋯** board menu for export/import and the guide. Click the board name to rename it. Collapse the sidebar with its chevron to give the board the whole screen; use the small sidebar button to bring it back. Desktop remembers your preference.

### Keyboard shortcuts

Shortcuts do not fire while you type in a text field.

| Key | Action |
| --- | --- |
| `R` | Attach a random category note |
| `I` | Attach an index card |
| `/` | Search categories |
| `Enter` | Pin an attached note at the preview position |
| `Escape` | Cancel placement or close a menu |
| Hold `Space` | Temporarily use the hand tool |
| `Delete` / `Backspace` | Delete the selected note when not editing text |
| `Ctrl/Cmd+Z` | Undo a board change when not editing text |
| `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` | Redo a board change |

## Edit the categories

Edit **[`categories.txt`](./categories.txt)** in the repository root. Each nonempty line is a category:

```text
Ideas
Questions
Characters
Places
Something completely different
```

Commit the file to `main`. Once the Pages workflow finishes, refresh the app. It fetches `categories.txt` directly using a relative URL, so it also works under GitHub Pages project paths and other static hosting paths.

Leading/trailing spaces and empty lines are ignored. Duplicate names are removed without regard to case. `#` is ordinary category text, not a comment marker. Existing notes keep their category names and content even when you remove or rename a category in the file. Removing a category does **not** delete its notes.

No category count is hard-coded. The default file is just a set of starter categories; replace it with your own list.

## Appearance and color maps

The board uses a bundled photograph of real cork. The grain moves and scales with the notes as you pan and zoom, and mirrored photo edges keep the surface continuous. Index cards have white cardstock, a blank heading area, a red header rule, and blue lines that stay aligned as the title grows. Asset source and license are in [assets/README.md](./assets/README.md).

At the bottom of the sidebar, choose **Natural cork**, **Pale cork**, or **Dark cork** and independently choose a category color map:

| Color map | Character |
| --- | --- |
| **HSV · soft paper** (default) | Evenly spaced cyclic hues; softened saturation keeps dark note text legible |
| Pastel spectrum | Gentle gold, peach, pink, lavender, blue, and green |
| Viridis · soft paper | Purple through blue/green to yellow, mixed with ivory paper |
| Cividis · soft paper | Blue through muted gray to yellow, mixed with ivory paper |
| Warm tones | Yellow, apricot, coral, rose |
| Cool tones | Mint, blue, periwinkle, lavender |
| Earth tones | Sand, clay, sage |

Colors are sampled across the category count in file order. HSV excludes the duplicate end hue. Changing the list order or number of categories can change the assigned colors; note content and position are preserved. With a hundred categories, nearby colors can look similar, so every note also has its category name in bold. Appearance choices save and export with the board. Index cards stay ivory and lined.

## Saving and backups

The board automatically saves to **localStorage in your current browser on this device**, including notes, positions, widths, theme, color map, board name, and view. The save indicator reports browser-storage failures rather than claiming the board was saved.

- Notes are **not** written back into the repository and are **not** shared with other visitors or other devices.
- Clearing site data, private-browsing cleanup, or moving to another browser/origin can remove or separate the saved board.
- Use the sidebar’s **⋯ → Export board** for a JSON backup. **Import board** validates the file and asks before replacing the current board. Import is undoable in the current session.
- If another tab changes the same board, this tab pauses saving to avoid overwriting it. Export this tab’s copy if needed, then reload to use the saved board.
- A damaged stored board is left untouched and automatic saving pauses. Recover the original storage before intentionally clearing the damaged copy.

This is a personal, browser-local board. There is no server-side storage, collaboration, telemetry, or third-party asset loading.

## Publish on GitHub Pages

The included **Test and publish Cork** workflow tests the app, copies only public site files into `dist/`, and deploys those files on pushes to `main`.

**One-time repository setup:** in **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. The repository owner must enable this setting. Then run the workflow from **Actions → Test and publish Cork → Run workflow**, or push another commit to `main`.

After a successful deployment, GitHub displays the live URL on **Settings → Pages** and the workflow’s `github-pages` deployment. No custom domain is required. A deployment attempted before Pages is enabled can fail at “Configure Pages”; enable the setting and rerun that workflow.

### Other static hosting or local use

Serve this directory with any static web server. For example, with Python:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Use a web server rather than double-clicking `index.html`: browsers restrict ES modules and text-file fetching on `file://` URLs.

For a public-files-only folder (Node 22+; no install needed):

```sh
npm test
npm run build
python3 -m http.server 8000 --directory dist
```

The `dist/` build is just a file copy. It does not transform the app or add a runtime dependency. Deploy the root files or `dist/` to any static host.

## Project files

| File | Purpose |
| --- | --- |
| `categories.txt` | One category per line; the only file you need to edit to replace the list |
| `index.html` | Accessible application shell and built-in help |
| `styles.css` | Cork, paper, responsive layouts, and themes |
| `app.js` | Placement, cursor preview, dragging, editing, pan/zoom, saving, export/import |
| `board-core.js` | Category parsing, color maps, coordinate transforms, import validation, list continuation |
| `tests/core.test.mjs` | Tests for category loading rules, 100 HSV colors, positioning math, lists, and backups |
| `.github/workflows/pages.yml` | Automated checks and GitHub Pages publishing |
