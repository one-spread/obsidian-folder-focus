# Changelog

## 1.2.1 - 2026-11-07

### Fixed
- Prevent external folder imports from recursively copying their own destination, including pathless directory drops.
- Prevent older asynchronous search results from replacing a newer query or folder view.
- Resolve official Obsidian lint findings and correct the manual install directory.

### Development
- Add official Obsidian lint checks, type checks, regression tests, and CI before release.

---

## 1.2.0 - 2026-11-07

### Added
- Session-only undo/redo for move, rename, delete, creation, grouping, and imports, including conflict checks and grouped actions.
- Space Quick Preview for Markdown, images, PDFs, folders, and unsupported-file information.
- Back/forward navigation, clickable breadcrumbs, responsive file details, and selection count.

### Changed
- Return now renames inline; Cmd+O or Cmd+Down opens the selection.
- Cmd+Shift+N now creates a folder. Cmd+Delete moves the selection to trash.
- File-operation shortcuts are scoped to the focused Folder Focus list.

---

## 1.1.3 - 2026-06-19

### Added
- Added a header button to copy the current folder path.
- Added path-like folder search that can jump to matching nested folders.

---

## 1.1.2 - 2026-06-10

### Added
- Added an explicit `Rename file` action to file row context menus.

### Fixed
- Made header action icons visible across Obsidian themes.
- Made search mode tabs wrap cleanly in narrow sidebars.
- Made filtered search results respect `Name`, `Created`, `Modified`, and sort direction settings.

---

## 1.1.1 - 2026-06-08

### Fixed
- Migrated the settings tab to Obsidian 1.13.0 declarative settings to resolve the deprecated `display()` review warning.

---

## 1.1.0 - 2026-06-08

### Added
- Added favorite folders with quick access chips and add/remove actions.
- Added a search mode toggle for file-name search vs names plus Markdown note text.
- Added highlighted file and folder name matches in search results.
- Added clearer drag/drop feedback for valid, invalid, and external drop targets.
- Updated the README with screenshots, a GIF demo, and supported file formats.

---

## 1.0.7 - 2026-06-08

### Fixed
- Removed deprecated `KeyboardEvent.keyCode` usage from the IME-safe search key handling.

---

## 1.0.6 - 2026-06-08

### Fixed
- Prevented IME composition Enter/Escape events from triggering folder search actions.

---

## 1.0.5 - 2026-05-30

### Fixed
- Removed a CSS `!important` override flagged by Obsidian review.
- Updated the README repository clone URL to the official `1spread/obsidian-folder-focus` repository.

---

## 1.0.4 - 2026-05-30

### Added
- Added explicit badges for Obsidian Base, Python, PowerPoint, Excel, iWork, diagrams, ebooks, databases, design files, fonts, config files, notebooks, archives, audio, and video files.

---

## 1.0.3 - 2026-05-21

### Added
- Added Finder drag and drop import for files and folders into Folder Focus.
- Added recursive folder import with automatic non-overwriting names for conflicts.

---

## 1.0.2 - 2026-05-20

### Added
- Added compact file type badges for Markdown, documents, spreadsheets, PDFs, images, JSON, code files, text files, and Obsidian canvas files.

### Fixed
- Stabilized the focused row spacing so the selection indicator does not shift item content.

---

## 1.0.1 - 2026-05-16

### Fixed
- Addressed Obsidian community plugin automated review findings.
- Updated the minimum Obsidian app version to match the APIs used by the plugin.
- Added GitHub artifact attestations for release assets.

---

## 2026-01-25

### Added
- **Multi-selection**: Cmd+Click to toggle, Shift+Click for range selection
- **New folder button**: Create folders directly from header
- **New note button**: Create notes directly from header
- **Search improvements**:
  - Full-text search (searches file content)
  - Subfolder search (includes all nested files)
  - "Folders only" filter toggle
  - Clear button (×) in search box
- **Context menu enhancements**:
  - Rename folder option
  - Delete folder option
  - Create folder with selection
- **Cmd+Enter**: Open file in new tab
- **Cmd+Double-click**: Open file in new tab
- **Live refresh**: Automatically updates when files change externally (Finder, etc.)

### Changed
- Search now requires Enter key to execute (not real-time)
- Selection styling improved with focus indicator

### Removed
- Drag and drop functionality (removed for simplicity)

---

## 2026-01-23

### Added
- **Sort options**: Name, Modified, Created in header dropdown
- **Sort direction toggle**: Ascending/descending button next to sort dropdown
- Folders always sorted first, then files within selected sort order

### Fixed
- **Keyboard shortcuts scope**: Cmd+Up/Down and Shift+Cmd+N only work when Folder Focus is focused
- Default Obsidian shortcuts (like scroll to top) work normally in notes

### Commits
```
14c12a0 feat: add sort options for folder contents
ee69aae feat: add ascending/descending sort toggle
e60b8a4 fix: restrict keyboard shortcuts to when view is focused
3086734 fix: handle shortcuts in view's keydown instead of global hotkeys
```

---

## Initial Release (2026-01-23)

### Features
- Finder-like folder navigation view in right sidebar
- Keyboard shortcuts (when focused):
  - `⌘↑` / `Ctrl+↑`: Navigate to parent folder
  - `⌘↓` / `Ctrl+↓`: Enter folder / Open file
  - `⇧⌘N` / `Ctrl+Shift+N`: Create new note
  - `↑` / `↓`: Move selection
  - `Enter`: Enter folder / Open file
- Double-click to enter folders or open files
- Folder history preservation (remembers selection when navigating back)
- Context menu "Open in Folder Focus" for folders
- Settings: Open files in new tab toggle

### Technical
- TypeScript + esbuild build system
- MIT License
