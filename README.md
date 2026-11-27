# Study Docs

A Windows app for reading and organising study documents: Markdown, HTML, PDF, Word, plain text, spreadsheets (CSV, XLSX), EPUB and Kindle books, and pictures. Tags, study status, highlights and notes for every document; full-text search that ignores Vietnamese accents; a calendar of classes, each linked to its documents and notes. The interface is in English or Vietnamese.

Built with Electron + React + TypeScript (electron-vite).

## Run

```bash
npm install
npm run dev        # run the app in development mode (reloads when you change code)
npm run typecheck  # TypeScript type check
npm test           # unit tests (Vitest)
npm run smoke      # build, then click through the app on a copy of sample-library/; fails on any problem; screenshots go to scripts/ (CI on GitHub runs it too)
npm run dist       # package release/Study Docs Setup x.y.z.exe (local only, not published)
npm run release    # package and publish to GitHub Releases, so installed apps update themselves
npm run make-icon  # redraw build/icon.png + icon.ico from build/icon.svg
node scripts/make-sample-epub.mjs  # rebuild sample-library/sach/Git cơ bản.epub
node scripts/make-sample-mobi.mjs  # rebuild sample-library/sach/Docker nhanh.mobi
node scripts/make-sample-docx.mjs  # rebuild sample-library/frontend/CSS Flexbox.docx
```

## Using the app

| Key / button | What it does |
|---|---|
| Page icon with +, `Ctrl+O`, or drop files on the window | Open single files from anywhere, like opening a file in Word. Files outside the workspace are listed under **Single files** below the folder tree; hover and click × to remove one from the list. |
| Folder icon with + | Add one or more folders to the workspace, on any drive (C:, D:, USB…). Each folder is a branch of the tree; hover its name and click × to remove it from the workspace (no files are deleted). |
| `Ctrl+K` | Search every folder (accents are optional: "su kien" finds "sự kiện") |
| `Ctrl+F` | Find in the open document (Markdown, HTML, PDF, Word, text, a whole EPUB/Kindle book), accents optional. `Enter` / `Shift+Enter` for next / previous, `Esc` to close. |
| `Ctrl+E` or the clock icon | Recently opened documents |
| `↑` `↓` `Enter` `←` `→` in the document list | Move, open, fold/unfold folders. Settings can order documents by name or by last change. |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+W` | Next / previous tab, close the tab |
| `Alt+←` / `Alt+→`, the ‹ › buttons, mouse back/forward buttons | Go back / forward between documents |
| **Outline** | Headings on the right; click to jump, the section being read is highlighted. The reading position of every document is remembered. |
| **Select text** | Shows the highlight bar: 4 colours or **✎ Note**. Click a highlight to edit its note, change its colour or delete it. The **Notes** tab on the right lists every highlight, plus a **Document note** for the whole document. Notes are Markdown (`**bold**`, lists, `code`, links). |
| **⋯ → Export PDF…** | Export a .md / .html document to PDF (A4, page numbers, bookmarks from the headings, always light). Pictures from the web that the note shows are in the PDF too. |
| **⋯ → Export PDF with highlights and notes…** | The same, with highlights in their colours, note numbers ¹ ² ³ after the passages, and a **Notes** section at the end |
| `.epub` files | Read books **page by page**: ‹ › buttons, ← → / PageUp PageDown, or the mouse wheel. One page, or two side by side on a wide window (Settings → Reading). The bottom bar shows the chapter and % read. Books with DRM (bought on Kindle, Google Play…) can't be opened. |
| `.mobi` / `.azw3` files | Kindle books, read like EPUB (pages, outline, highlights, `Ctrl+F`, search). The book is turned into an EPUB in memory when opened; the file is not changed. Books with DRM can't be opened. |
| `.pdf` files | Shown with pdf.js: scroll through the pages, zoom (buttons at the bottom right), outline from the PDF's bookmarks, reading position remembered. Highlights, notes and `Ctrl+F` work as in Markdown; search finds text inside PDFs. Chinese/Japanese/Korean text and JPEG 2000 pictures show correctly. **Scanned PDFs** (pages that are pictures) show a bar with **Recognise text (OCR)**: the app reads the pages itself, offline (Vietnamese + English), and keeps the text in its data, so selecting, highlights, `Ctrl+F` and search work; the PDF is not changed. |
| `.docx` / `.txt` / pictures | Word documents are shown in pages close to Word (**Word layout**, with docx-preview): fonts, colours, tables, alignment, headers and footers; Word's headings fill the outline. Some things (text boxes, drawings) may be off. A bar at the top switches to the **Simple view** (text and structure only) or opens the file **in Word**. Text files are shown as they are (UTF-8, UTF-16 or Windows-1258). Highlights, notes, `Ctrl+F` and search work; these files are never changed. Pictures (.png, .jpg, .svg…) can be zoomed with the buttons or `Ctrl` + mouse wheel; Settings can hide them from the list. |
| Markdown | Code blocks coloured by language (` ```js `, ` ```python `…), formulas `$...$` and `$$...$$` drawn with KaTeX, ` ```mermaid ` diagrams. |
| `Ctrl+N`, or right-click in the tree | **New note** (`.md` or `.html`, the last type is remembered), **New folder** (empty, or with a first note; empty folders show in the tree), **Rename** (`F2`), **Delete** (to the Recycle Bin, after asking). Drag a note or folder onto another folder to move it, also into another workspace folder (on another drive it is copied, then removed). Tags, notes, the reading position, OCR text and calendar links follow renames and moves. Only inside workspace folders. |
| **Write** (Markdown) | Write in a live-preview editor: headings look like headings, `**bold**` is bold, lists, `- [ ]` checkboxes (click to tick), quotes, code, links, images, **tables, formulas (`$…$`, `$$…$$`) and Mermaid diagrams** are drawn in place; the line (or block) with the cursor shows its Markdown, click a drawn block to edit it. Type **`/`** at the start of a line for a menu of headings, lists, to-dos, quotes, tables, code, formulas, diagrams, rules and pictures (type a few letters to narrow it, accents optional). `Ctrl+B` / `Ctrl+I` / `Ctrl+K` (link) / `Ctrl+E` (code), toolbar for headings, lists, quotes; Enter continues a list; `Ctrl+F` finds and replaces. What you type is exactly what is saved, **by itself a moment after you stop typing** (or `Ctrl+S`); **Done** saves and closes. New Markdown notes open here. |
| **Edit text** (HTML) | Edit right on the page, including text in SVG diagrams (click it to get a text box): `Ctrl+B` / `Ctrl+I` / `Ctrl+U`, strikethrough, links (`Ctrl+K`), pictures; **Enter** starts a new paragraph or list item, `Shift+Enter` a line break; the **Paragraph type** menu turns a paragraph or list item you just added into a heading, a paragraph or a bulleted / numbered list (Enter on an empty item ends the list); the **⋮⋮** handle at the left of a block drags it up or down among its neighbours (list items, paragraphs, tables…); **Table** inserts a table (Tab moves between cells, Tab in the last cell adds a row); in any table, empty cells can be filled and the bar over it adds or deletes rows and columns, or the whole table; `Ctrl+F` finds. Only the blocks you changed or moved are written (cleaned of scripts); other layout changes go through Raw. `Ctrl+S` saves, `Esc` cancels. Works on any HTML page, not only notes made in the app. New HTML notes open here. |
| Look of HTML notes | HTML notes made with **New note** use the app's note style: headings with a touch of colour, tables as cards, tinted code and quotes, in your accent colour, light or dark. The style is also written into the note, so it looks right outside the app; in the app the current style is always shown, so older notes (including ones made with the first, plainer template) follow it. Bare HTML pages without CSS get it too. Imported pages with CSS of their own are left as they are. Showing a page never changes its file. |
| Tabs | Documents open in tabs over the page. A click in the sidebar shows the document in the open tab (or goes to its tab if it has one); **Ctrl+click**, the middle button, or dragging it onto the tab bar opens a new tab. Only the open tab is loaded; the others come back where you were reading. Drag tabs to reorder; middle click or × closes. Tabs are kept between runs. |
| Pasting copied text (`Ctrl+V`, HTML editing) | Text copied from a web page, Word or Google Docs keeps its **bold**, *italic*, underline, strikethrough, `code`, links, sub/superscript and highlights, and its paragraphs and headings become blocks here. Colours, fonts and sizes are left out, as are scripts and handlers. |
| Translating (select text → **文A Dịch**) | The selected words or paragraph are translated with Google Translate (English → Vietnamese; text already in Vietnamese goes into English, and a button switches the direction). Only the selected text is sent, never the file. **Highlight + ghi chú** highlights the text with the translation as its note; **Chép** copies it. Needs an internet connection. |
| Pasting pictures (`Ctrl+V`) | In the editor, Raw and HTML editing. Pictures are shrunk to 1600 px wide and compressed (WebP), then **embedded in the file** (base64), so a note always carries its pictures; Raw shows a small label instead of the base64 text. Settings → Library → **Pasted images** can save them in an `assets/` folder next to the note instead; a picture still over 2 MB asks first. |
| Spreadsheets (CSV, XLSX) | Open as a grid (sheet tabs for XLSX). Edit a cell with Enter, F2 or by typing; Enter goes down, Tab right, Esc cancels; Delete clears; a block copied from Excel can be pasted. CSV files can also get or lose rows and columns. Formulas are not calculated: a formula cell shows the result Excel saved and is read-only. Saving changes only what you edited: unchanged CSV rows stay byte for byte (delimiter, quotes, BOM, line endings kept); in an XLSX only the edited cells change (their style kept), and Excel recalculates formulas when it opens the file. Cell text is searchable. |
| **Raw** | Open the source next to the document to change layout, diagrams, HTML tags… Markdown previews as you type; HTML updates when you save (`Ctrl+S`). |
| `Ctrl+,` or the gear icon | Settings, in tabs: **Appearance** (language, light/dark, accent colour), **Reading** (Markdown text size, font and width; one or two book pages), **Library** (folders, sidebar order, pictures), **Data** (backup and restore, tags across the workspace, clean-up, recovery), **Updates**. |

### Calendar

The calendar icon in the sidebar shows a week or month calendar instead of a document.

- **Events** have a title, time (or all day), place, colour and notes. Drag on the calendar or click **+ Event** to add one; drag an event to move it, drag its edge to change its length.
- **Repeat:** the usual choices (daily, weekly on that day, every weekday, monthly on that date or on "the 2nd Tuesday", yearly), or **Custom…**: every N days / weeks / months / years, on several weekdays (Tue + Thu), monthly by date or by weekday, ending never, on a date or after N times. The dialog says the rule in words and shows the first dates. **Skip dates** leaves out holidays or exam weeks.
- Changing or deleting one class of a repeating event asks: **this event**, **this and following events**, or **all events**.
- **Documents of a class:** drag a document from the sidebar onto an event, or use **+ Link a document…**. Link it to **this class** (the slides of that lesson) or to the **whole course** (the syllabus). As many as you like; click one to open it. A document shows chips for the classes it belongs to; clicking one goes back to the calendar.
- **Whole folders:** drag a folder from the sidebar onto an event, or pick it in **+ Link a document…**. Every document in it belongs to the class, also ones added to the folder later; the panel lists them.
- **Files anywhere on the PC:** **Choose files on this PC…** in the same dialog. Files outside the workspace are added to **Single files** and linked.
- **Notes for this class** creates `<folder>\<course>\<date>.md` from a small template (date, time, place), opens it and links it to the class. The first time, the app asks which folder a course's notes go in (inside a workspace folder they are searchable like any document). An existing file is opened, never overwritten.
- **Times** are typed on a 24-hour clock: `7`, `0730`, `7h30`, `19:30`; ↑ / ↓ move by 15 minutes.
- **Reminders:** an event can remind you (at the start, 5 / 10 / 15 / 30 minutes, 1 hour or 1 day before) with a Windows notification while the app is open; clicking it opens that class. Saved as a standard `VALARM`.
- **Import .ics… / Export .ics…** read and write standard calendar files, so events move to and from Google Calendar, Outlook, a phone, or a timetable exported by your school.
- **Subscribed calendars…** follow a calendar by its link (Google Calendar: calendar settings → "Secret address in iCal format", or a school timetable online). Its events show in their own colour, read-only (change them in the original), and documents can still be linked to them. The app downloads it again on start and every 30 minutes; the link stays on this PC and is not put in backups.

The calendar is stored in the standard iCalendar format (RFC 5545), so other calendar apps read it as it is: repeats are `RRULE`, skipped dates `EXDATE`, a class changed on its own is a second `VEVENT` with the same `UID` and a `RECURRENCE-ID`, colours are `COLOR` (RFC 7986). Events made in the app use local wall-clock ("floating") times; imported events keep their time zone (`TZID` with its `VTIMEZONE`), so a class at 09:00 New York time shows at the right hour here and exports unchanged. Only what is the app's own (documents linked to classes, the notes folder of each course) is kept in a separate JSON file.

When editing text, the app replaces exactly the text you changed in the file and keeps every other character. If it can't be sure of that (an HTML tag without its closing tag, or text that Markdown would read as formatting), it doesn't save and tells you to use Raw. If the file is changed by another app while you edit, it isn't overwritten either.

## Updates

The installed app **updates itself** from [GitHub Releases](https://github.com/jessiicamaru/study-docs/releases):

- Every time it starts (and every 4 hours), it checks for a new version and downloads it in the background.
- When it's ready, a bar says "Restart to update". If you don't click it, the new version is installed the next time you close the app.
- Documents, tags, status, notes and settings are kept.

Publishing a new version:

```bash
npm version patch --no-git-tag-version   # 0.9.1 -> 0.9.2 (use minor for bigger features)
git commit -am "Release v0.9.2"
git push
npm run release
```

`npm run release` refuses to run with uncommitted or unpushed changes, or if that version was already published. It runs the type check and unit tests first. Uploading uses the GitHub CLI (`gh`), already logged in; no token is stored in any file. If an earlier run stopped half-way, running it again uploads what is missing.

Uninstalling: double-click `uninstall.bat`. It closes the app, uninstalls it, then asks whether to delete the app's data in `%APPDATA%\Study Docs` (settings, tags, notes; back them up first in Settings → Data). Your document folders are never touched.

## Where things are stored

- **Documents are only changed when you use Edit text or save in Raw.** Then only the part you changed is replaced, the file's line endings are kept, files that are not UTF-8 are never edited, and a file changed elsewhere in the meantime is not overwritten. Reading, highlighting, tagging and exporting never touch the documents.
- **Tags, study status, highlights and notes** are kept in the app's own data, **never in your documents' folders**. Like Claude Code keeps one folder per project, every workspace folder (and every folder of single files) gets a sub-folder:
  ```
  %APPDATA%\Study Docs\data\<folder key>\
    info.json    the real path of the folder
    meta.json    tags, status
    notes.json   highlights, notes
  ```
  - The key is a short hash of the path, so removing a folder from the workspace and adding it again keeps its data.
  - Versions up to 0.8 kept these in `.docs-meta.json` / `.docs-notes.json` inside the folder. They are read in once, automatically; the old files are left as they are. One too broken to read is copied to the data folder as a broken backup and offered under **Recover…**, like the app's own data files.
  - If a folder's path changed (renamed or moved, a USB drive with another letter, another PC), the app recognises its old data by the files' content and names, and asks whether to move the tags and notes to the new path. The old data stays on disk.
  - **Settings → Data → Back up to a file…** saves everything to one `.json` file; **Restore from a file…** merges it back (nothing is deleted). Data of a folder that isn't in the workspace at its old path can go to the matching folder you pick. Use it when moving to another PC or reinstalling Windows.
  - If a data file is broken, the app first copies it to `meta.corrupt-<time>.json` and shows **Recover…**: fix the backup by hand, then click **Merge**; the current data is kept.
  - Renaming or moving a file inside a workspace folder keeps its tags: the file is recognised by identical content, or by the same file name (moved and edited). If several files match, the app doesn't guess.
- **Single files** (`Ctrl+O`, drag and drop, double-click in Explorer): only the path is remembered, the file isn't copied. A moved or deleted file shows "not found"; click × to remove it from the list (the file and its notes are kept).
- **Highlights** are never written into the document. Each one keeps the selected text with a few words before and after, so it is found again after the document is edited; if the passage is gone, the note is kept and marked "no longer found". In EPUB books the exact position is kept as an EPUB CFI; in PDFs, the page.
- **The calendar** is in `%APPDATA%\Study Docs\data\calendar.ics` (standard iCalendar), with the documents linked to classes in `calendar.json` next to it. A linked document is remembered by its path, content hash and name, so it is found again after it is renamed or moved. Backups (Settings → Data) include both. A calendar file that can't be read is copied to `calendar.corrupt-<time>.ics` before anything is written.
- **Settings and "recently opened"** are in `%APPDATA%\Study Docs`.
- **Text read by OCR** from scanned PDFs is in `%APPDATA%\Study Docs\ocr`, and subscribed calendars' copies in `data\calendar-sub-<id>.ics`.
- **Caches for speed** are there too: `scan-cache.json` (document names) and `text-cache` (text read out for search, stored as UTF-8). Deleting them loses nothing; the app reads the files again. Text of files that left the workspace is cleaned up automatically.

## Security

- HTML documents open in a `sandbox` iframe: their own CSS/JS runs, but they can't reach the app or the disk.
- Links in documents: other documents open in the app; web links open in the browser. Other files are only opened with their default app if they are on the safe list (pdf, pictures, csv, Office without macros, audio/video; see `src/main/open-policy.ts`), and the app asks first when the request comes from inside a document. Anything else (programs, scripts, `.py`, `.url`, Office files with macros…) is only shown in Explorer, never run.
- When exporting to PDF, the page can't fetch other files (CSP), and the export window can't reach the internet, except the Google Fonts servers many pages use and the web pictures written in the file itself (an address a script makes up is blocked, so a page can't send pictures of your library out).
- OCR runs inside the app with its own copy of the recognition engine and language data: nothing is sent anywhere. Hidden files and folders (names starting with a dot) are never served to a page, and the app's data is outside the documents' folders, out of reach of pages.
- Opening a single file doesn't open its whole folder: only the files you opened, plus the pictures, styles, fonts and scripts a page needs around it, can be loaded.
- A page can't flood the browser with tabs: two links opened within 10 seconds go through, the third asks, more are dropped.
- Word documents in the Word layout are drawn inside a frame where no script runs and nothing loads from the internet, so a document's own styles can't change the app around it.
- SVG pictures are shown with `<img>`, where their scripts never run. Kindle books are decoded by a copy of foliate-js's `mobi.js` taken unchanged from its author's repository (see `src/vendor/foliate/README.md`).

## Reading the code

| File | What it does |
|---|---|
| `src/shared/types.ts` | Shared data types: DocEntry, DocMeta, Annotation, DocsApi |
| `src/shared/i18n.ts`, `src/shared/locales/en.ts` | Interface language: `t('Vietnamese text')`, English translations keyed by that text |
| `src/main/index.ts` | Main process: window, `doc://` protocol, IPC, folder watching, single files, backup, link handling |
| `src/main/library.ts` | Folder scanning (cached), titles and searchable text of every document type |
| `src/main/doc-store.ts` | One JSON file per workspace folder (in `%APPDATA%\Study Docs\data`): write queue, backup of broken files, following renamed files |
| `src/main/meta-store.ts` | `meta.json`: tags and status, renaming/removing a tag everywhere |
| `src/main/notes-store.ts` | `notes.json`: highlights, notes, document notes |
| `src/main/storage.ts` | Settings and "recently opened" in `%APPDATA%\Study Docs` |
| `src/main/workspace.ts` | Multi-folder workspace: folder keys, no duplicate/nested folders, display names |
| `src/main/search-worker.ts`, `search.ts` | Full-text search in a background thread (accent-insensitive), and its main-process side |
| `src/main/text-cache.ts` | Compact on-disk text cache for search snippets |
| `src/main/pdf-text.ts`, `mobi-text.ts` | Text of PDFs (pdf.js) and Kindle books for search, in the search thread |
| `src/main/zip.ts` | Reads single files out of a zip/EPUB/docx without loading all of it |
| `src/main/scan-cache.ts` | Remembers names + hashes between runs, so big folders open fast |
| `src/main/sheet.ts` | CSV and XLSX: reading into a grid, writing edited cells/rows back in place (JSZip) |
| `src/main/html-edit.ts` | Editing HTML text: script added to the page while editing, and writing back in place (parse5) |
| `src/main/page-style.ts` | Style of HTML notes (written into new notes, shown live in the app) and of bare HTML pages |
| `src/main/view-helper.ts` | Small script added to HTML pages while reading: outline, reading position, shortcuts, find |
| `src/main/open-policy.ts` | Which files may be opened with their default app |
| `src/main/updater.ts` | Self-update from GitHub Releases |
| `src/shared/anchor.ts` | Finding and drawing highlights and find results (Markdown, HTML pages, PDF export) |
| `src/shared/text.ts` | Removing Vietnamese accents, snippets, text decoding |
| `src/preload/index.ts` | The only bridge between the window and Node, exposed as `window.api` |
| `src/renderer/src/App.tsx` | Main state: library, open document, filters, search, shortcuts, drag & drop |
| `src/renderer/src/components/Sidebar.tsx` | Folder tree, single files, search results, filters, arrow keys |
| `src/renderer/src/components/DocView.tsx` | Header (status, tags), view / edit text / raw modes, outline and notes panel |
| `src/renderer/src/components/reader.ts` | What every document view provides (outline, position, highlights, find) |
| `src/renderer/src/components/MarkdownView.tsx` | Markdown + Mermaid + code colours + KaTeX, links, editing text |
| `src/renderer/src/components/SheetView.tsx` | The spreadsheet grid: editing cells, CSV rows/columns, sheet tabs |
| `src/renderer/src/components/HtmlView.tsx` | Iframe for HTML documents, talks to the page scripts |
| `src/renderer/src/components/PdfView.tsx` | PDFs with pdf.js: pages drawn on demand, text layer, zoom |
| `src/renderer/src/components/EpubView.tsx` | EPUB (and converted Kindle) books with epub.js |
| `src/renderer/src/components/ArticleView.tsx` | Word (mammoth) and plain text documents |
| `src/renderer/src/components/ImageView.tsx` | Pictures with zoom |
| `src/renderer/src/components/Annotations.tsx` | Highlight bar, note editor, notes list |
| `src/renderer/src/components/FindBar.tsx` | Ctrl+F bar |
| `src/renderer/src/components/RawEditor.tsx` | Source editor (CodeMirror) |
| `src/renderer/src/components/SettingsDialog.tsx` | Settings window (tabs) |
| `src/renderer/src/lib/md-edit.ts` | Maps edited text back to its place in the Markdown file |
| `src/renderer/src/lib/mobi-to-epub.ts` | Kindle book → EPUB in memory |
| `src/renderer/src/lib/epub-locations.ts` | "% read" positions of a book, computed without freezing the window |
| `src/renderer/src/PrintPage.tsx` | Page used to export Markdown to PDF |
| `tests/` | Unit tests |
