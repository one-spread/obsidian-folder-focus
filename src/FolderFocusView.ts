import { assertSafeDirectoryImport } from './importSafety';
import { ItemView, WorkspaceLeaf, TFile, TFolder, TAbstractFile, Menu, Modal, Scope, App, setIcon, Notice, Platform, FileSystemAdapter, normalizePath } from 'obsidian';
import { getRenameMenuTitle } from './contextMenuLabels';
import { getFileTypeBadge as getBadgeForExtension } from './fileTypeBadge';
import type { FileTypeBadge } from './fileTypeBadge';
import {
  compareFolderPathMatch,
  folderPathMatches,
  getHighlightSegments,
  isFolderPathSearchQuery,
  normalizeSearchQuery,
  shouldSearchContent,
  type FolderFocusSearchMode,
} from './searchUtils';
import { sortVaultItems, type SortDirection, type SortOrder } from './sortUtils';
import type FolderFocusPlugin from './main';
import { QuickPreviewModal } from './QuickPreviewModal';

export const VIEW_TYPE_FOLDER_FOCUS = 'folder-focus-view';

type FsPromises = typeof import('fs/promises');
type NodePath = typeof import('path');

interface ObsidianDesktopWindow extends Window {
  require?: NodeRequire;
}

interface FolderFocusDragData {
  type: 'folder-focus-items';
  paths: string[];
}

interface ExternalFile extends File {
  path?: string;
}

type ExternalEntrySnapshot = { name: string; file: File } | { name: string; children: ExternalEntrySnapshot[] };

interface ExternalDropSource {
  name: string;
  path?: string;
  file?: File;
  entry?: FileSystemEntry;
}

export class FolderFocusView extends ItemView {
  plugin: FolderFocusPlugin;

  // State
  currentFolder: TFolder | null = null;
  items: TAbstractFile[] = [];
  filteredItems: TAbstractFile[] = [];
  sortOrder: SortOrder = 'name';
  sortDirection: SortDirection = 'asc';
  searchQuery: string = '';
  searchMode: FolderFocusSearchMode;

  // Selection state
  selectedIndices: Set<number> = new Set([0]);  // Multiple selection
  anchorIndex: number = 0;                       // Shift+Click anchor
  focusIndex: number = 0;                        // Keyboard cursor position

  // All files recursively (for search)
  allFilesInFolder: TAbstractFile[] = [];
  searchFoldersOnly: boolean = false;

  // Folder history: remembers selected item path when navigating away
  folderHistory: Map<string, string> = new Map();

  private backPaths: string[] = [];
  private forwardPaths: string[] = [];
  private historyNavigation = false;
  private preview: QuickPreviewModal | null = null;
  private statusEl!: HTMLElement;

  // DOM elements
  headerEl!: HTMLElement;
  searchEl!: HTMLInputElement;
  listEl!: HTMLElement;
  itemElements: HTMLElement[] = [];
  searchInputComposing: boolean = false;
  searchInputCompositionEndedAt: number = 0;
  private filterGeneration = 0;

  constructor(leaf: WorkspaceLeaf, plugin: FolderFocusPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.searchMode = plugin.settings.defaultSearchMode;
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, event => {
      if (!this.listEl?.contains(event.target as Node)) return;
      this.handleKeyDown(event);
      if (event.defaultPrevented) return false;
    });
  }

  getViewType(): string {
    return VIEW_TYPE_FOLDER_FOCUS;
  }

  getDisplayText(): string {
    return 'Folder focus';
  }

  getIcon(): string {
    return 'folder';
  }

  onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('folder-focus-container');

    // Header section
    this.headerEl = container.createDiv({ cls: 'folder-focus-header' });

    // List section
    this.listEl = container.createDiv({ cls: 'folder-focus-list' });
    this.listEl.setAttribute('role', 'listbox');
    this.listEl.setAttribute('aria-multiselectable', 'true');
    this.statusEl = container.createDiv({ cls: 'folder-focus-status' });

    this.registerDomEvent(this.listEl, 'focusin', () => {
      this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
      queueMicrotask(() => {
        if (this.listEl.contains(this.listEl.ownerDocument.activeElement)) this.app.workspace.setActiveLeaf(this.leaf, { focus: false });
      });
    });

    // Register keyboard navigation within the view
    this.registerDomEvent(this.listEl, 'keydown', (event: KeyboardEvent) => {
      this.handleKeyDown(event);
    });
    this.registerExternalDropOnList();

    // Listen to vault changes for live updates
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (this.isInCurrentFolder(file)) {
          void this.refreshCurrentFolder().catch((e) => {
            console.error('Folder focus: failed to refresh after create', e);
          });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.isInCurrentFolder(file) || this.wasInCurrentFolder(file.path)) {
          void this.refreshCurrentFolder().catch((e) => {
            console.error('Folder focus: failed to refresh after delete', e);
          });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.isInCurrentFolder(file) || this.wasInCurrentFolder(oldPath)) {
          void this.refreshCurrentFolder().catch((e) => {
            console.error('Folder focus: failed to refresh after rename', e);
          });
        }
      })
    );

    // Initialize with current file's folder
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.parent) {
      this.setFolder(activeFile.parent, activeFile.path);
    } else {
      // Fallback to vault root
      this.setFolder(this.app.vault.getRoot());
    }

    return Promise.resolve();
  }

  onClose(): Promise<void> {
    // Cleanup
    this.filterGeneration++;
    this.folderHistory.clear();
    this.preview?.close();

    return Promise.resolve();
  }

  // --- State Management ---

  setFolder(folder: TFolder, selectPath?: string) {
    this.filterGeneration++;
    if (this.currentFolder && this.currentFolder.path !== folder.path && !this.historyNavigation) {
      this.backPaths.push(this.currentFolder.path);
      this.forwardPaths = [];
    }
    this.currentFolder = folder;
    this.items = this.getSortedChildren(folder);
    this.allFilesInFolder = this.getAllFilesRecursively(folder);

    // Clear search when changing folders
    this.searchQuery = '';
    this.filteredItems = this.items;

    // Determine which item to select
    let targetIndex = 0;

    if (selectPath) {
      // Select specific item by path
      const index = this.filteredItems.findIndex(item => item.path === selectPath);
      if (index >= 0) targetIndex = index;
    } else {
      // Check folder history for previously selected item
      const historyPath = this.folderHistory.get(folder.path);
      if (historyPath) {
        const index = this.filteredItems.findIndex(item => item.path === historyPath);
        if (index >= 0) targetIndex = index;
      }
    }

    // Initialize selection state
    this.selectedIndices.clear();
    this.selectedIndices.add(targetIndex);
    this.anchorIndex = targetIndex;
    this.focusIndex = targetIndex;

    this.renderAll();
  }

  getSortedChildren(folder: TFolder): TAbstractFile[] {
    return this.getSortedItems(folder.children);
  }

  private getSortedItems(items: TAbstractFile[]): TAbstractFile[] {
    return sortVaultItems(items, {
      sortOrder: this.sortOrder,
      sortDirection: this.sortDirection,
      isFolder: (item) => item instanceof TFolder,
      getModifiedTime: (item) => item instanceof TFile ? item.stat.mtime : 0,
      getCreatedTime: (item) => item instanceof TFile ? item.stat.ctime : 0,
    });
  }

  syncToFile(file: TFile) {
    if (file.parent && file.parent !== this.currentFolder) {
      this.setFolder(file.parent, file.path);
    } else {
      // Just select the file in current list
      const index = this.items.findIndex(item => item.path === file.path);
      if (index >= 0) {
        this.selectedIndices.clear();
        this.selectedIndices.add(index);
        this.anchorIndex = index;
        this.focusIndex = index;
        this.updateSelection();
      }
    }
  }

  revealActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.parent) {
      this.setFolder(activeFile.parent, activeFile.path);
    }
  }

  getFileTypeBadge(file: TFile): FileTypeBadge {
    return getBadgeForExtension(file.extension);
  }

  private getExistingFavoriteFolders(): TFolder[] {
    return this.plugin.settings.favoriteFolderPaths
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFolder => file instanceof TFolder);
  }

  private async toggleCurrentFolderFavorite(): Promise<void> {
    if (!this.currentFolder) return;
    await this.plugin.toggleFavoriteFolder(this.currentFolder.path);
    this.renderHeader();
  }

  private async copyCurrentFolderPath(): Promise<void> {
    if (!this.currentFolder) return;
    const folderPath = this.currentFolder.path || '/';
    await navigator.clipboard.writeText(folderPath);
    new Notice(`Copied folder path: ${folderPath}`);
  }

  private async setSearchMode(mode: FolderFocusSearchMode): Promise<void> {
    this.searchQuery = this.searchEl?.value ?? this.searchQuery;
    this.searchMode = mode;
    this.plugin.settings.defaultSearchMode = mode;
    await this.plugin.saveSettings();
    this.renderHeader();
    if (this.searchQuery.trim()) {
      if (!await this.applyFilter()) return;
      this.renderList();
    }
  }

  private renderItemName(nameEl: HTMLElement, itemName: string): void {
    nameEl.empty();
    const segments = this.searchQuery.trim()
      ? getHighlightSegments(itemName, this.searchQuery)
      : [{ text: itemName, match: false }];

    for (const segment of segments) {
      if (segment.match) {
        nameEl.createSpan({ cls: 'folder-focus-search-highlight', text: segment.text });
      } else {
        nameEl.createSpan({ text: segment.text });
      }
    }
  }

  private clearDragFeedback(): void {
    this.listEl.removeClass('is-folder-focus-dragging');
    this.listEl.removeClass('is-external-drop-target');
    this.listEl.removeAttribute('data-drop-label');
    this.itemElements.forEach((el) => {
      el.removeClass('is-dragging');
      el.removeClass('is-drop-target');
      el.removeClass('is-drop-invalid');
      el.removeAttribute('data-drop-label');
    });
  }

  // --- Rendering ---

  renderAll() {
    this.renderHeader();
    this.renderList();
  }

  renderHeader() {
    this.headerEl.empty();
    if (!this.currentFolder) return;

    // Top row: name and sort selector
    const topRow = this.headerEl.createDiv({ cls: 'folder-focus-header-top' });

    for (const [label, icon, direction] of [['Back', 'arrow-left', -1], ['Forward', 'arrow-right', 1]] as const) {
      const button = topRow.createEl('button', { cls: 'folder-focus-nav', attr: { 'aria-label': label } });
      setIcon(button, icon);
      button.disabled = !(direction < 0 ? this.backPaths : this.forwardPaths).length;
      button.onclick = () => this.navigateHistory(direction);
    }
    const nameEl = topRow.createDiv({ cls: 'folder-focus-name' });
    nameEl.setText(this.currentFolder.name || 'Vault root');

    const crumbs = this.headerEl.createDiv({ cls: 'folder-focus-breadcrumbs' });
    const parts = this.currentFolder.path.split('/').filter(Boolean);
    ['', ...parts].forEach((part, index) => {
      const path = parts.slice(0, index).join('/');
      const button = crumbs.createEl('button', { text: part || 'Vault', attr: { title: path || 'Vault root' } });
      button.onclick = () => { const folder = this.app.vault.getAbstractFileByPath(path); if (folder instanceof TFolder) this.setFolder(folder); };
    });

    // Sort dropdown
    const sortEl = topRow.createDiv({ cls: 'folder-focus-sort' });
    const sortSelect = sortEl.createEl('select', { cls: 'folder-focus-sort-select' });

    const options: { value: SortOrder; label: string }[] = [
      { value: 'name', label: 'Name' },
      { value: 'modified', label: 'Modified' },
      { value: 'created', label: 'Created' },
    ];

    options.forEach(opt => {
      const optionEl = sortSelect.createEl('option', { value: opt.value, text: opt.label });
      if (opt.value === this.sortOrder) {
        optionEl.selected = true;
      }
    });

    sortSelect.addEventListener('change', () => {
      // Keep the listener synchronous; ignore unknown values safely.
      void (async () => {
        const v = sortSelect.value;
        if (v === 'name' || v === 'modified' || v === 'created') {
          this.sortOrder = v;
        }
        if (!this.currentFolder) return;
        this.items = this.getSortedChildren(this.currentFolder);
        if (!await this.applyFilter()) return;
        this.renderList();
      })().catch((e) => {
        console.error('Folder focus: failed to change sort order', e);
      });
    });

    // Sort direction toggle button
    const dirBtn = sortEl.createEl('button', { cls: 'folder-focus-sort-dir' });
    setIcon(dirBtn, this.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down');
    dirBtn.setAttribute('aria-label', this.sortDirection === 'asc' ? 'Ascending' : 'Descending');

    dirBtn.addEventListener('click', () => {
      void (async () => {
        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        dirBtn.empty();
        setIcon(dirBtn, this.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down');
        dirBtn.setAttribute('aria-label', this.sortDirection === 'asc' ? 'Ascending' : 'Descending');
        if (!this.currentFolder) return;
        this.items = this.getSortedChildren(this.currentFolder);
        if (!await this.applyFilter()) return;
        this.renderList();
      })().catch((e) => {
        console.error('Folder focus: failed to toggle sort direction', e);
      });
    });

    // New folder button
    const newFolderBtn = sortEl.createEl('button', { cls: 'folder-focus-new-folder' });
    setIcon(newFolderBtn, 'folder-plus');
    newFolderBtn.setAttribute('aria-label', 'New folder');
    newFolderBtn.addEventListener('click', () => {
      void this.createNewFolder().catch((e) => {
        console.error('Folder focus: failed to create folder', e);
      });
    });

    // New note button
    const newNoteBtn = sortEl.createEl('button', { cls: 'folder-focus-new-note' });
    setIcon(newNoteBtn, 'file-plus');
    newNoteBtn.setAttribute('aria-label', 'New note');
    newNoteBtn.addEventListener('click', () => {
      void this.createNewNote().catch((e) => {
        console.error('Folder focus: failed to create note', e);
      });
    });

    const pathRowEl = this.headerEl.createDiv({ cls: 'folder-focus-path-row' });
    const pathEl = pathRowEl.createDiv({ cls: 'folder-focus-path' });
    pathEl.setText(this.currentFolder.path || '/');

    const copyPathBtn = pathRowEl.createEl('button', { cls: 'folder-focus-copy-path' });
    setIcon(copyPathBtn, 'copy');
    copyPathBtn.setAttribute('aria-label', 'Copy current folder path');
    copyPathBtn.addEventListener('click', () => {
      void this.copyCurrentFolderPath().catch((e) => {
        console.error('Folder focus: failed to copy current folder path', e);
        new Notice('Failed to copy folder path.');
      });
    });

    const favoriteBtn = pathRowEl.createEl('button', { cls: 'folder-focus-favorite-toggle' });
    const isFavorite = this.plugin.isFavoriteFolder(this.currentFolder.path);
    setIcon(favoriteBtn, isFavorite ? 'star' : 'star-off');
    favoriteBtn.setAttribute('aria-label', isFavorite ? 'Remove current folder from favorites' : 'Add current folder to favorites');
    favoriteBtn.toggleClass('is-favorite', isFavorite);
    favoriteBtn.addEventListener('click', () => {
      void this.toggleCurrentFolderFavorite().catch((e) => {
        console.error('Folder focus: failed to toggle favorite folder', e);
      });
    });

    const favoriteFolders = this.getExistingFavoriteFolders();
    if (favoriteFolders.length > 0) {
      const favoritesEl = this.headerEl.createDiv({ cls: 'folder-focus-favorites' });
      favoritesEl.createDiv({ cls: 'folder-focus-favorites-label', text: 'Favorites' });
      const favoriteListEl = favoritesEl.createDiv({ cls: 'folder-focus-favorites-list' });

      for (const folder of favoriteFolders) {
        const favoriteItem = favoriteListEl.createEl('button', { cls: 'folder-focus-favorite-item' });
        setIcon(favoriteItem, 'folder');
        favoriteItem.createSpan({ text: folder.name || '/' });
        favoriteItem.setAttribute('aria-label', `Open favorite folder ${folder.path || '/'}`);
        favoriteItem.addEventListener('click', () => this.setFolder(folder));
      }
    }

    // Search box with clear button
    const searchContainer = this.headerEl.createDiv({ cls: 'folder-focus-search' });
    const searchWrapper = searchContainer.createDiv({ cls: 'folder-focus-search-wrapper' });

    this.searchEl = searchWrapper.createEl('input', {
      type: 'text',
      placeholder: 'Search in folder...',
      cls: 'folder-focus-search-input',
    });
    this.searchEl.value = this.searchQuery;

    // Clear button
    const clearBtn = searchWrapper.createEl('button', { cls: 'folder-focus-search-clear' });
    setIcon(clearBtn, 'x');
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.toggleClass('is-hidden', !this.searchQuery);

    clearBtn.addEventListener('click', () => {
      void (async () => {
        this.searchQuery = '';
        this.searchEl.value = '';
        clearBtn.addClass('is-hidden');
        if (!await this.applyFilter()) return;
        this.renderList();
        this.searchEl.focus();
      })().catch((e) => {
        console.error('Folder focus: failed to clear search', e);
      });
    });

    // Update clear button visibility on input
    this.searchEl.addEventListener('input', () => {
      clearBtn.toggleClass('is-hidden', !this.searchEl.value);
    });

    this.searchEl.addEventListener('compositionstart', () => {
      this.searchInputComposing = true;
      this.searchInputCompositionEndedAt = 0;
    });

    this.searchEl.addEventListener('compositionend', () => {
      this.searchInputComposing = false;
      this.searchInputCompositionEndedAt = Date.now();
      clearBtn.toggleClass('is-hidden', !this.searchEl.value);
    });

    // Enter key to search, Escape to clear
    this.searchEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (this.isSearchInputComposing(event)) return;

      void (async () => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.searchQuery = this.searchEl.value;
          if (this.openBestFolderPathMatch(this.searchQuery)) {
            return;
          }
          if (!await this.applyFilter()) return;
          this.renderList();
          this.listEl.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (this.searchQuery || this.searchEl.value) {
            this.searchQuery = '';
            this.searchEl.value = '';
            clearBtn.addClass('is-hidden');
            if (!await this.applyFilter()) return;
            this.renderList();
          }
          this.listEl.focus();
        }
      })().catch((e) => {
        console.error('Folder focus: failed to handle search keydown', e);
      });
    });

    // Folders only toggle
    const toggleContainer = searchContainer.createDiv({ cls: 'folder-focus-search-toggle' });
    const toggleLabel = toggleContainer.createEl('label', { cls: 'folder-focus-toggle-label' });
    const toggleCheckbox = toggleLabel.createEl('input', { type: 'checkbox' });
    toggleCheckbox.checked = this.searchFoldersOnly;
    toggleLabel.appendText(' Folders only');

    toggleCheckbox.addEventListener('change', () => {
      void (async () => {
        this.searchFoldersOnly = toggleCheckbox.checked;
        if (this.searchQuery) {
          if (!await this.applyFilter()) return;
          this.renderList();
        }
      })().catch((e) => {
        console.error('Folder focus: failed to toggle folders-only filter', e);
      });
    });

    const searchModeEl = searchContainer.createDiv({ cls: 'folder-focus-search-mode' });
    const nameModeBtn = searchModeEl.createEl('button', { text: 'File names', cls: 'folder-focus-search-mode-button' });
    const fullTextModeBtn = searchModeEl.createEl('button', { text: 'Names + note text', cls: 'folder-focus-search-mode-button' });

    nameModeBtn.toggleClass('is-active', this.searchMode === 'name');
    fullTextModeBtn.toggleClass('is-active', this.searchMode === 'full-text');

    nameModeBtn.addEventListener('click', () => {
      void this.setSearchMode('name').catch((e) => {
        console.error('Folder focus: failed to set search mode', e);
      });
    });

    fullTextModeBtn.addEventListener('click', () => {
      void this.setSearchMode('full-text').catch((e) => {
        console.error('Folder focus: failed to set search mode', e);
      });
    });
  }

  async applyFilter(): Promise<boolean> {
    const generation = ++this.filterGeneration;
    const rawQuery = this.searchQuery;
    const mode = this.searchMode;
    const foldersOnly = this.searchFoldersOnly;
    const candidates = [...this.allFilesInFolder];
    let filtered: TAbstractFile[];
    if (!rawQuery.trim()) {
      filtered = this.items;
    } else {
      const query = normalizeSearchQuery(rawQuery);
      const matchedItems: TAbstractFile[] = [];

      // Search all files recursively (including subfolders)
      for (const item of candidates) {
        if (generation !== this.filterGeneration) return false;
        // If folders only, skip files
        if (foldersOnly && !(item instanceof TFolder)) {
          continue;
        }

        // Match folder path for path-like queries.
        if (
          item instanceof TFolder
          && isFolderPathSearchQuery(rawQuery)
          && folderPathMatches(item.path, rawQuery)
        ) {
          matchedItems.push(item);
          continue;
        }

        // Match by name
        if (item.name.toLowerCase().includes(query)) {
          matchedItems.push(item);
          continue;
        }

        // Match by file content (for markdown files only, skip if folders only)
        if (
          shouldSearchContent(mode)
          && !foldersOnly
          && item instanceof TFile
          && item.extension === 'md'
        ) {
          try {
            const content = await this.app.vault.cachedRead(item);
            if (generation !== this.filterGeneration) return false;
            if (content.toLowerCase().includes(query)) {
              matchedItems.push(item);
            }
          } catch {
            // Skip if can't read
          }
        }
      }

      filtered = this.getSortedItems(matchedItems);
    }

    if (generation !== this.filterGeneration) return false;
    this.filteredItems = filtered;

    // Reset selection to first item
    this.selectedIndices.clear();
    if (this.filteredItems.length > 0) {
      this.selectedIndices.add(0);
    }
    this.anchorIndex = 0;
    this.focusIndex = 0;
    return true;
  }

  private openBestFolderPathMatch(query: string): boolean {
    if (!isFolderPathSearchQuery(query)) return false;

    const folders = this.allFilesInFolder
      .filter((item): item is TFolder => item instanceof TFolder)
      .filter((folder) => folderPathMatches(folder.path, query))
      .sort((a, b) => compareFolderPathMatch(a.path, b.path, query));

    const folder = folders[0];
    if (!folder) return false;

    this.setFolder(folder);
    return true;
  }

  renderList() {
    this.listEl.empty();
    this.listEl.setAttribute('tabindex', '0');
    this.itemElements = [];

    this.filteredItems.forEach((item, index) => {
      const isFolder = item instanceof TFolder;
      const itemEl = this.listEl.createDiv({
        cls: `folder-focus-item ${isFolder ? 'is-folder' : 'is-file'}`,
      });
      itemEl.dataset.index = String(index);
      itemEl.setAttribute('role', 'option');
      itemEl.setAttribute('aria-selected', String(this.selectedIndices.has(index)));

      if (this.selectedIndices.has(index)) {
        itemEl.addClass('is-selected');
      }
      if (index === this.focusIndex) {
        itemEl.addClass('is-focused');
      }

      // Icon
      const iconEl = itemEl.createSpan({ cls: 'folder-focus-item-icon' });
      if (isFolder) {
        setIcon(iconEl, 'folder');
      } else if (item instanceof TFile) {
        const badge = this.getFileTypeBadge(item);
        iconEl.addClass('is-file-type');
        iconEl.addClass(`is-${badge.type}`);
        iconEl.setAttribute('aria-label', badge.title);
        iconEl.setAttribute('title', badge.title);
        iconEl.createSpan({
          cls: 'folder-focus-file-badge',
          text: badge.label,
        });
      } else {
        setIcon(iconEl, 'file');
      }

      // Name
      const nameEl = itemEl.createSpan({ cls: 'folder-focus-item-name' });
      this.renderItemName(nameEl, item.name);

      const meta = itemEl.createSpan({ cls: 'folder-focus-item-meta' });
      meta.createSpan({ cls: 'folder-focus-item-date', text: item instanceof TFile ? new Date(item.stat.mtime).toLocaleDateString() : '' });
      meta.createSpan({ cls: 'folder-focus-item-kind', text: item instanceof TFile ? item.extension.toUpperCase() : 'Folder' });
      meta.createSpan({ cls: 'folder-focus-item-size', text: item instanceof TFile ? formatFileSize(item.stat.size) : '—' });

      // Chevron for folders
      if (isFolder) {
        const chevronEl = itemEl.createSpan({ cls: 'folder-focus-item-chevron' });
        setIcon(chevronEl, 'chevron-right');
      }

      // Click handler - select with modifier key support
      itemEl.addEventListener('click', (event: MouseEvent) => {
        const isMod = event.metaKey || event.ctrlKey;
        const isShift = event.shiftKey;

        if (isMod && !isShift) {
          // Cmd/Ctrl+Click: Toggle selection
          if (this.selectedIndices.has(index)) {
            if (this.selectedIndices.size > 1) {
              this.selectedIndices.delete(index);
            }
          } else {
            this.selectedIndices.add(index);
          }
          this.focusIndex = index;
        } else if (isShift) {
          // Shift+Click: Range selection
          this.selectedIndices.clear();
          const start = Math.min(this.anchorIndex, index);
          const end = Math.max(this.anchorIndex, index);
          for (let i = start; i <= end; i++) {
            this.selectedIndices.add(i);
          }
          this.focusIndex = index;
        } else {
          // Normal click: Single selection
          this.selectedIndices.clear();
          this.selectedIndices.add(index);
          this.anchorIndex = index;
          this.focusIndex = index;
        }

        this.updateSelection();
        this.listEl.focus();
      });

      // Double-click handler - enter folder or open file
      itemEl.addEventListener('dblclick', (event: MouseEvent) => {
        this.focusIndex = index;
        if (item instanceof TFolder) {
          this.enterFolder(item);
          return;
        }
        if (item instanceof TFile) {
          const openInNewTab = event.metaKey || event.ctrlKey;
          this.openFile(item, openInNewTab);
        }
      });

      // Right-click handler - context menu
      itemEl.addEventListener('contextmenu', (event: MouseEvent) => {
        event.preventDefault();

        // If right-clicked item is not selected, select only it
        if (!this.selectedIndices.has(index)) {
          this.selectedIndices.clear();
          this.selectedIndices.add(index);
          this.anchorIndex = index;
          this.focusIndex = index;
          this.updateSelection();
        }

        // Show context menu
        const menu = new Menu();

        for (const redo of [false, true]) {
          const label = redo ? this.plugin.history.redoLabel : this.plugin.history.undoLabel;
          menu.addItem(i => i.setTitle(`${redo ? 'Redo' : 'Undo'}${label ? ' ' + label : ''}`).setDisabled(!label || this.plugin.history.busy).onClick(() => this.replayHistory(redo)));
        }
        menu.addItem(i => i.setTitle('Quick preview').onClick(() => this.showPreview()));
        menu.addSeparator();
        // Folder-specific options
        if (isFolder) {
          menu.addItem((menuItem) => {
          menuItem
            .setTitle(getRenameMenuTitle('folder'))
            .setIcon('pencil')
            .onClick(() => {
              void this.renameItem(item).catch((e) => {
                console.error('Folder focus: failed to rename item', e);
              });
            });
          });

          menu.addItem((menuItem) => {
            menuItem
              .setTitle('Delete folder')
              .setIcon('trash')
              .onClick(() => {
                void this.deleteItem(item).catch((e) => {
                  console.error('Folder focus: failed to delete item', e);
                });
              });
          });

          const favoriteTitle = this.plugin.isFavoriteFolder(item.path) ? 'Remove from favorites' : 'Add to favorites';
          const favoriteIcon = this.plugin.isFavoriteFolder(item.path) ? 'star-off' : 'star';
          menu.addItem((menuItem) => {
            menuItem
              .setTitle(favoriteTitle)
              .setIcon(favoriteIcon)
              .onClick(() => {
                void this.plugin.toggleFavoriteFolder(item.path).then(() => {
                  this.renderHeader();
                }).catch((e) => {
                  console.error('Folder focus: failed to toggle folder favorite', e);
                });
              });
          });

          menu.addSeparator();
        } else {
          // File-specific options
          menu.addItem((menuItem) => {
          menuItem
            .setTitle(getRenameMenuTitle('file'))
            .setIcon('pencil')
            .onClick(() => {
              void this.renameItem(item).catch((e) => {
                console.error('Folder focus: failed to rename item', e);
              });
            });
          });

          menu.addItem((menuItem) => {
          menuItem
            .setTitle('Delete file')
            .setIcon('trash')
            .onClick(() => {
              void this.deleteItem(item).catch((e) => {
                console.error('Folder focus: failed to delete item', e);
              });
            });
          });

          menu.addSeparator();
        }

        // Copy path(s)
        const selectedItems = Array.from(this.selectedIndices)
          .map(i => this.filteredItems[i])
          .filter(Boolean);
        const copyItems = selectedItems.length > 1 ? selectedItems : [item];
        menu.addItem((menuItem) => {
          menuItem
            .setTitle(copyItems.length > 1 ? `Copy paths (${copyItems.length})` : 'Copy path')
            .setIcon('copy')
            .onClick(() => {
              void (async () => {
                const paths = copyItems.map((i) => i.path).join('\n');
                await navigator.clipboard.writeText(paths);
              })().catch((e) => {
                console.error('Folder focus: failed to copy paths', e);
              });
            });
        });

        menu.addSeparator();

        // Custom item: Create folder with selection
        menu.addItem((menuItem) => {
        menuItem
          .setTitle('Create folder with selection')
          .setIcon('folder-plus')
          .onClick(() => {
            void this.createFolderWithSelection().catch((e) => {
              console.error('Folder focus: failed to create folder from selection', e);
            });
          });
        });

        menu.addSeparator();

        // Add Obsidian's standard file menu items
        this.app.workspace.trigger('file-menu', menu, item, 'folder-focus-view', this.leaf);
        menu.showAtMouseEvent(event);
      });

      // Finder / external file drops. Folder rows import into that folder; file rows import into the current folder.
      itemEl.addEventListener('dragover', (event: DragEvent) => {
        if (!this.isExternalFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        const targetFolder = item instanceof TFolder ? item : this.currentFolder;
        itemEl.setAttribute('data-drop-label', `Import to ${targetFolder?.name || '/'}`);
        itemEl.addClass('is-drop-target');
      });

      itemEl.addEventListener('dragenter', (event: DragEvent) => {
        if (!this.isExternalFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const targetFolder = item instanceof TFolder ? item : this.currentFolder;
        itemEl.setAttribute('data-drop-label', `Import to ${targetFolder?.name || '/'}`);
        itemEl.addClass('is-drop-target');
      });

      itemEl.addEventListener('dragleave', (event: DragEvent) => {
        if (!this.isExternalFileDrag(event)) return;
        const rt = event.relatedTarget;
        if (rt instanceof Node && !itemEl.contains(rt)) {
          itemEl.removeClass('is-drop-target');
          itemEl.removeAttribute('data-drop-label');
        }
      });

      itemEl.addEventListener('drop', (event: DragEvent) => {
        if (!this.isExternalFileDrag(event)) return;
        void (async () => {
          event.preventDefault();
          event.stopPropagation();
          this.clearDragFeedback();
          const targetFolder = item instanceof TFolder ? item : this.currentFolder;
          if (!targetFolder) return;
          await this.importExternalDrop(event, targetFolder);
        })().catch((e) => {
          console.error('Folder focus: failed to import external drop', e);
          new Notice('Failed to import dropped item.');
        });
      });

      // Drag and drop - make item draggable
      itemEl.setAttribute('draggable', 'true');

      itemEl.addEventListener('dragstart', (event: DragEvent) => {
        // If dragged item is not selected, select only it
        if (!this.selectedIndices.has(index)) {
          this.selectedIndices.clear();
          this.selectedIndices.add(index);
          this.anchorIndex = index;
          this.focusIndex = index;
          this.updateSelection();
        }

        // Store selected item paths in DataTransfer
        const selectedPaths = Array.from(this.selectedIndices)
          .map((i) => this.filteredItems[i]?.path)
          .filter((p): p is string => typeof p === 'string');

        const dt = event.dataTransfer;
        if (!dt) return;
        dt.setData('application/json', JSON.stringify({
          type: 'folder-focus-items',
          paths: selectedPaths,
        }));
        dt.effectAllowed = 'move';
        this.listEl.addClass('is-folder-focus-dragging');

        // Add visual feedback
        this.selectedIndices.forEach(i => {
          this.itemElements[i]?.addClass('is-dragging');
        });
      });

      itemEl.addEventListener('dragend', () => {
        // Clean up drag visual state
        this.clearDragFeedback();
      });

      // Drop target events - only for folders
      if (isFolder) {
        itemEl.addEventListener('dragover', (event: DragEvent) => {
          event.preventDefault();

          const dragData = this.getDragData(event);
          if (!dragData) return;

          if (!(item instanceof TFolder)) return;
          const targetFolder = item;
          const isInvalidTarget = this.isInvalidDropTarget(dragData.paths, targetFolder);

          if (isInvalidTarget) {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
            itemEl.setAttribute('data-drop-label', 'Cannot drop here');
            itemEl.removeClass('is-drop-target');
            itemEl.addClass('is-drop-invalid');
          } else {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            itemEl.setAttribute('data-drop-label', `Move to ${targetFolder.name || '/'}`);
            itemEl.addClass('is-drop-target');
            itemEl.removeClass('is-drop-invalid');
          }
        });

        itemEl.addEventListener('dragenter', (event: DragEvent) => {
          event.preventDefault();
        });

        itemEl.addEventListener('dragleave', (event: DragEvent) => {
          const rt = event.relatedTarget;
          if (rt instanceof Node && !itemEl.contains(rt)) {
            itemEl.removeClass('is-drop-target');
            itemEl.removeClass('is-drop-invalid');
            itemEl.removeAttribute('data-drop-label');
          }
        });

        itemEl.addEventListener('drop', (event: DragEvent) => {
          void (async () => {
            event.preventDefault();
            this.clearDragFeedback();

            const dragData = this.getDragData(event);
            if (!dragData) return;
            if (!(item instanceof TFolder)) return;
            const targetFolder = item;

            if (this.isInvalidDropTarget(dragData.paths, targetFolder)) {
              return;
            }

            await this.moveItemsToFolder(dragData.paths, targetFolder);
          })().catch((e) => {
            console.error('Folder focus: failed to drop items', e);
          });
        });
      }

      this.itemElements.push(itemEl);
    });

    this.updateStatus();
    // Scroll focused item into view
    this.scrollToFocused();
  }

  updateSelection() {
    this.updateStatus();
    // Update all item elements with current selection state
    this.itemElements.forEach((el, index) => {
      el.toggleClass('is-selected', this.selectedIndices.has(index));
      el.toggleClass('is-focused', index === this.focusIndex);
      el.setAttribute('aria-selected', String(this.selectedIndices.has(index)));
    });

    this.scrollToFocused();
  }

  scrollToFocused() {
    const focusedEl = this.itemElements[this.focusIndex];
    if (focusedEl) {
      // Use scrollIntoView with 'nearest' to minimize scrolling
      focusedEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  // --- Keyboard Navigation ---

  private isSearchInputComposing(event: KeyboardEvent): boolean {
    const compositionJustEnded = Date.now() - this.searchInputCompositionEndedAt < 50;
    return this.searchInputComposing || compositionJustEnded || event.isComposing || event.key === 'Process';
  }

  handleKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.isComposing || ((event.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]'))) return;
    const isMod = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    if (isMod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopPropagation(); void this.replayHistory(isShift); return; }
    if (isMod && (event.key === '[' || event.key === ']')) { event.preventDefault(); this.navigateHistory(event.key === '[' ? -1 : 1); return; }
    if (isMod && event.key.toLowerCase() === 'o') { event.preventDefault(); this.enterOrOpen(); return; }
    if (isMod && (event.key === 'Backspace' || event.key === 'Delete')) { event.preventDefault(); void this.deleteSelection(); return; }
    if (event.key === ' ' && !isMod && !event.altKey) { event.preventDefault(); this.showPreview(); return; }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        if (isMod) {
          this.navigateToParent();
        } else if (isShift) {
          this.extendSelectionUp();
        } else {
          this.moveFocusUp();
        }
        break;
      case 'ArrowDown':
        event.preventDefault();
        if (isMod) {
          this.enterOrOpen();
        } else if (isShift) {
          this.extendSelectionDown();
        } else {
          this.moveFocusDown();
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (isMod) {
          // Cmd+Enter: Open in new tab
          this.enterOrOpenInNewTab();
        } else {
          const item = this.filteredItems[this.focusIndex];
          if (item && this.selectedIndices.size === 1) void this.renameItem(item);
        }
        break;
      case 'n':
      case 'N':
        if (isMod && isShift) {
          event.preventDefault();
          void this.createNewFolder().catch((e) => {
            console.error('Folder focus: failed to create folder from shortcut', e);
          });
        }
        break;
      case 'a':
      case 'A':
        if (isMod) {
          event.preventDefault();
          this.selectAll();
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.collapseSelectionToFocus();
        break;
    }
  }

  moveFocusUp() {
    if (this.focusIndex > 0) {
      this.focusIndex--;
      this.selectedIndices.clear();
      this.selectedIndices.add(this.focusIndex);
      this.anchorIndex = this.focusIndex;
      this.updateSelection();
    }
  }

  moveFocusDown() {
    if (this.focusIndex < this.filteredItems.length - 1) {
      this.focusIndex++;
      this.selectedIndices.clear();
      this.selectedIndices.add(this.focusIndex);
      this.anchorIndex = this.focusIndex;
      this.updateSelection();
    }
  }

  extendSelectionUp() {
    if (this.focusIndex > 0) {
      this.focusIndex--;
      this.selectRange(this.anchorIndex, this.focusIndex);
      this.updateSelection();
    }
  }

  extendSelectionDown() {
    if (this.focusIndex < this.filteredItems.length - 1) {
      this.focusIndex++;
      this.selectRange(this.anchorIndex, this.focusIndex);
      this.updateSelection();
    }
  }

  selectRange(fromIndex: number, toIndex: number) {
    this.selectedIndices.clear();
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    for (let i = start; i <= end; i++) {
      this.selectedIndices.add(i);
    }
  }

  selectAll() {
    for (let i = 0; i < this.filteredItems.length; i++) {
      this.selectedIndices.add(i);
    }
    this.updateSelection();
  }

  collapseSelectionToFocus() {
    this.selectedIndices.clear();
    this.selectedIndices.add(this.focusIndex);
    this.anchorIndex = this.focusIndex;
    this.updateSelection();
  }

  // --- Commands ---

  navigateToParent() {
    if (!this.currentFolder?.parent) return;

    // Save current focus to history before navigating
    const currentItem = this.filteredItems[this.focusIndex];
    if (currentItem) {
      this.folderHistory.set(this.currentFolder.path, currentItem.path);
    }

    // Navigate to parent, selecting current folder
    this.setFolder(this.currentFolder.parent, this.currentFolder.path);
  }

  enterFolder(folder: TFolder) {
    // Save current focus before entering
    const currentItem = this.filteredItems[this.focusIndex];
    if (currentItem && this.currentFolder) {
      this.folderHistory.set(this.currentFolder.path, currentItem.path);
    }

    this.setFolder(folder);
  }

  openFile(file: TFile, forceNewTab?: boolean) {
    // Use forceNewTab if provided, otherwise respect the setting
    const openInNewTab = forceNewTab ?? this.plugin.settings.openInNewTab;
    const leaf = this.app.workspace.getLeaf(openInNewTab ? 'tab' : false);
    void leaf.openFile(file).catch((e) => {
      console.error('Folder focus: failed to open file', e);
    });
  }

  enterOrOpen() {
    const focused = this.filteredItems[this.focusIndex];
    if (!focused) return;

    if (focused instanceof TFolder) {
      this.enterFolder(focused);
    } else if (focused instanceof TFile) {
      this.openFile(focused);
    }
  }

  enterOrOpenInNewTab() {
    const focused = this.filteredItems[this.focusIndex];
    if (!focused) return;

    if (focused instanceof TFolder) {
      this.enterFolder(focused);
    } else if (focused instanceof TFile) {
      this.openFile(focused, true); // force new tab
    }
  }

  async createNewFolder() {
    await this.plugin.history.run('Create folder', () => this.createNewFolderImpl());
  }

  private async createNewFolderImpl() {
    if (!this.currentFolder) return;

    let folderName = 'New Folder';
    let counter = 1;
    const parentPath = this.currentFolder.path || '';

    while (this.app.vault.getAbstractFileByPath(
      parentPath ? `${parentPath}/${folderName}` : folderName
    )) {
      folderName = `New Folder ${counter}`;
      counter++;
    }

    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    await this.app.vault.createFolder(folderPath);
    await this.plugin.history.created(folderPath);
    // Vault event will trigger refresh automatically
  }

  async createNewNote() {
    await this.plugin.history.run('Create note', () => this.createNewNoteImpl());
  }

  private async createNewNoteImpl() {
    if (!this.currentFolder) return;

    const baseName = 'Untitled';
    let fileName = `${baseName}.md`;
    let counter = 1;

    while (this.app.vault.getAbstractFileByPath(
      this.currentFolder.path ? `${this.currentFolder.path}/${fileName}` : fileName
    )) {
      fileName = `${baseName} ${counter}.md`;
      counter++;
    }

    const filePath = this.currentFolder.path
      ? `${this.currentFolder.path}/${fileName}`
      : fileName;

    const newFile = await this.app.vault.create(filePath, '');
    await this.plugin.history.created(filePath);
    const openInNewTab = this.plugin.settings.openInNewTab;
    const leaf = this.app.workspace.getLeaf(openInNewTab ? 'tab' : false);
    await leaf.openFile(newFile);

    // Refresh and select the new file
    this.setFolder(this.currentFolder, newFile.path);
  }

  async createFolderWithSelection() {
    await this.plugin.history.run('Group selection', () => this.createFolderWithSelectionImpl());
  }

  private async createFolderWithSelectionImpl() {
    const selectedItems = Array.from(this.selectedIndices)
      .map(i => this.filteredItems[i])
      .filter(Boolean);

    if (selectedItems.length === 0 || !this.currentFolder) return;

    const parentPath = this.currentFolder.path || '';

    // Generate unique folder name
    let folderName = 'New Folder';
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(
      parentPath ? `${parentPath}/${folderName}` : folderName
    )) {
      folderName = `New Folder ${counter}`;
      counter++;
    }

    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;

    // Create folder
    await this.app.vault.createFolder(folderPath);
    await this.plugin.history.created(folderPath);

    // Move selected items into folder
    for (const item of selectedItems) {
      const newPath = `${folderPath}/${item.name}`;
      await this.plugin.history.move(item, newPath);
    }

    // Refresh view
    this.setFolder(this.currentFolder);
  }

  // --- Recursive file retrieval ---

  getAllFilesRecursively(folder: TFolder): TAbstractFile[] {
    const results: TAbstractFile[] = [];

    const traverse = (f: TFolder) => {
      for (const child of f.children) {
        results.push(child);
        if (child instanceof TFolder) {
          traverse(child);
        }
      }
    };

    traverse(folder);
    return results;
  }

  // --- Vault change helpers ---

  isInCurrentFolder(file: TAbstractFile): boolean {
    if (!this.currentFolder) return false;
    return file.parent?.path === this.currentFolder.path;
  }

  wasInCurrentFolder(oldPath: string): boolean {
    if (!this.currentFolder) return false;
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '';
    return parentPath === this.currentFolder.path;
  }

  async refreshCurrentFolder() {
    if (this.currentFolder && !this.app.vault.getAbstractFileByPath(this.currentFolder.path)) {
      this.setFolder(this.app.vault.getRoot());
      return;
    }
    if (this.currentFolder) {
      this.items = this.getSortedChildren(this.currentFolder);
      this.allFilesInFolder = this.getAllFilesRecursively(this.currentFolder);
      if (!await this.applyFilter()) return;
      this.renderList();
    }
  }

  // --- Rename and Delete ---

  async renameItem(item: TAbstractFile) {
    if (this.plugin.history.busy) return;
    const row = this.itemElements[this.filteredItems.indexOf(item)];
    const name = row?.querySelector<HTMLElement>('.folder-focus-item-name');
    if (!name || name.querySelector('input')) return;
    const input = name.ownerDocument.createElement('input');
    input.value = item.name;
    name.empty(); name.appendChild(input); input.focus();
    input.setSelectionRange(0, item instanceof TFile && item.extension ? item.name.length - item.extension.length - 1 : item.name.length);
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== item.name) {
        if (/[\\/:]/.test(value) || value === '.' || value === '..') new Notice('Use a file name without path separators.');
        else await this.plugin.history.run('Rename', () => this.plugin.history.move(item, item.parent?.path ? `${item.parent.path}/${value}` : value));
      }
      await this.refreshCurrentFolder(); this.listEl.focus();
    };
    input.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    };
    input.onblur = () => { void finish(false); };
  }

  async deleteItem(item: TAbstractFile) {
    const selected = this.getSelectedItems();
    await this.deleteSelection(selected.includes(item) ? selected : [item]);
  }

  private getSelectedItems() {
    return [...this.selectedIndices].sort((a,b) => a-b).map(i => this.filteredItems[i]).filter((i): i is TAbstractFile => !!i);
  }

  private async deleteSelection(items = this.getSelectedItems()) {
    const roots = items.filter(i => !items.some(parent => parent !== i && i.path.startsWith(parent.path + '/')));
    await this.plugin.history.run('Delete', async () => { for (const item of roots) await this.plugin.history.trash(item); });
    await this.refreshCurrentFolder(); this.listEl.focus();
  }

  private updateStatus() {
    if (this.statusEl) this.statusEl.setText(`${this.filteredItems.length} items · ${this.getSelectedItems().length} selected`);
  }

  private async replayHistory(redo: boolean) {
    await this.plugin.history.replay(redo);
    if (this.currentFolder && !this.app.vault.getAbstractFileByPath(this.currentFolder.path)) this.setFolder(this.app.vault.getRoot());
    else await this.refreshCurrentFolder();
    this.listEl.focus();
  }

  private navigateHistory(direction: number) {
    const source = direction < 0 ? this.backPaths : this.forwardPaths;
    const destination = direction < 0 ? this.forwardPaths : this.backPaths;
    while (source.length) {
      const path = source.pop()!;
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder)) continue;
      if (this.currentFolder) {
        const item = this.filteredItems[this.focusIndex];
        if (item) this.folderHistory.set(this.currentFolder.path, item.path);
        destination.push(this.currentFolder.path);
      }
      this.historyNavigation = true;
      try { this.setFolder(folder); } finally { this.historyNavigation = false; }
      this.listEl.focus(); return;
    }
    this.renderHeader();
  }

  private showPreview() {
    if (this.preview) { this.preview.close(); return; }
    const items = this.getSelectedItems();
    if (!items.length) return;
    const candidates = items.length > 1 ? items : [...this.filteredItems];
    const focused = this.filteredItems[this.focusIndex];
    this.preview = new QuickPreviewModal(this.app, candidates, Math.max(0, candidates.indexOf(focused)), () => {
      this.preview = null; this.listEl.focus();
    }, item => {
      const index = this.filteredItems.indexOf(item);
      if (index >= 0) { this.focusIndex = index; if (items.length === 1) { this.selectedIndices = new Set([index]); this.anchorIndex = index; } this.updateSelection(); }
    });
    this.preview.open();
  }

  async promptForName(currentName: string, title: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new RenameModal(this.app, currentName, title, (result) => {
        resolve(result);
      });
      modal.open();
    });
  }

  // --- Drag and Drop helpers ---

  private registerExternalDropOnList(): void {
    this.registerDomEvent(this.listEl, 'dragover', (event: DragEvent) => {
      if (!this.isExternalFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.listEl.setAttribute('data-drop-label', 'Drop to import into current folder');
      this.listEl.addClass('is-external-drop-target');
    });

    this.registerDomEvent(this.listEl, 'dragenter', (event: DragEvent) => {
      if (!this.isExternalFileDrag(event)) return;
      event.preventDefault();
      this.listEl.setAttribute('data-drop-label', 'Drop to import into current folder');
      this.listEl.addClass('is-external-drop-target');
    });

    this.registerDomEvent(this.listEl, 'dragleave', (event: DragEvent) => {
      if (!this.isExternalFileDrag(event)) return;
      const rt = event.relatedTarget;
      if (rt instanceof Node && !this.listEl.contains(rt)) {
        this.clearDragFeedback();
      }
    });

    this.registerDomEvent(this.listEl, 'drop', (event: DragEvent) => {
      if (!this.isExternalFileDrag(event)) return;
      void (async () => {
        event.preventDefault();
        this.clearDragFeedback();
        if (!this.currentFolder) return;
        await this.importExternalDrop(event, this.currentFolder);
      })().catch((e) => {
        console.error('Folder focus: failed to import external drop', e);
        new Notice('Failed to import dropped item.');
      });
    });
  }

  private isExternalFileDrag(event: DragEvent): boolean {
    const dt = event.dataTransfer;
    if (!dt) return false;
    return Array.from(dt.types).includes('Files') || dt.files.length > 0;
  }

  private getDragData(event: DragEvent): FolderFocusDragData | null {
    try {
      const data = event.dataTransfer?.getData('application/json');
      if (!data) return null;
      const parsed: unknown = JSON.parse(data);
      if (!this.isFolderFocusDragData(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private isFolderFocusDragData(value: unknown): value is FolderFocusDragData {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as { type?: unknown; paths?: unknown };
    return candidate.type === 'folder-focus-items'
      && Array.isArray(candidate.paths)
      && candidate.paths.every((path): path is string => typeof path === 'string');
  }

  private isInvalidDropTarget(sourcePaths: string[], targetFolder: TFolder): boolean {
    for (const sourcePath of sourcePaths) {
      // Cannot drop on itself
      if (sourcePath === targetFolder.path) {
        return true;
      }

      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);

      // Already in target folder
      if (sourceFile?.parent?.path === targetFolder.path) {
        return true;
      }

      // Cannot drop folder into its own descendant (circular reference)
      if (sourceFile instanceof TFolder) {
        if (targetFolder.path.startsWith(sourcePath + '/')) {
          return true;
        }
      }

      // Check for name conflict
      const sourceFileName = sourceFile?.name;
      if (sourceFileName) {
        const existingPath = targetFolder.path
          ? `${targetFolder.path}/${sourceFileName}`
          : sourceFileName;
        if (this.app.vault.getAbstractFileByPath(existingPath)) {
          return true;
        }
      }
    }
    return false;
  }

  private async moveItemsToFolder(sourcePaths: string[], targetFolder: TFolder): Promise<void> {
    await this.plugin.history.run('Move', () => this.moveItemsToFolderImpl(sourcePaths, targetFolder));
  }
  private async moveItemsToFolderImpl(sourcePaths: string[], targetFolder: TFolder): Promise<void> {
    for (const sourcePath of sourcePaths) {
      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!sourceFile) continue;

      const newPath = targetFolder.path
        ? `${targetFolder.path}/${sourceFile.name}`
        : sourceFile.name;

      try {
        await this.plugin.history.move(sourceFile, newPath);
      } catch (error) {
        console.error(`Failed to move ${sourcePath}:`, error);
        new Notice(`Could not move ${sourcePath}: ${String(error)}`);
      }
    }

    // Clear selection after move
    this.selectedIndices.clear();
    if (this.filteredItems.length > 0) {
      this.selectedIndices.add(0);
    }
    this.anchorIndex = 0;
    this.focusIndex = 0;
  }

  private async importExternalDrop(event: DragEvent, targetFolder: TFolder): Promise<void> {
    await this.plugin.history.run('Import', () => this.importExternalDropImpl(event, targetFolder));
  }
  private async importExternalDropImpl(event: DragEvent, targetFolder: TFolder): Promise<void> {
    const sources = await this.getExternalDropSources(event);
    if (sources.length === 0) {
      new Notice('No files found in drop.');
      return;
    }

    let imported = 0;
    let failed = 0;
    for (const source of sources) {
      try {
        if (source.path && Platform.isDesktopApp) {
          imported += await this.importExternalPath(source.path, targetFolder);
        } else if (source.entry) {
          imported += await this.importExternalEntry(source.entry, targetFolder);
        } else if (source.file) {
          await this.importExternalFile(source.file, targetFolder, source.name);
          imported++;
        }
      } catch (error) {
        failed++;
        console.error(`Folder focus: failed to import ${source.path ?? source.name}`, error);
      }
    }

    if (imported > 0) {
      await this.refreshCurrentFolder();
      const failedText = failed > 0 ? ` ${failed} failed.` : '';
      new Notice(`Imported ${imported} item${imported === 1 ? '' : 's'}.${failedText}`);
    } else {
      new Notice('Failed to import dropped item.');
    }
  }

  private async getExternalDropSources(event: DragEvent): Promise<ExternalDropSource[]> {
    const dt = event.dataTransfer;
    if (!dt) return [];

    const sources: ExternalDropSource[] = [];
    const seenPaths = new Set<string>();

    for (const file of Array.from(dt.files) as ExternalFile[]) {
      if (file.path) {
        if (seenPaths.has(file.path)) continue;
        seenPaths.add(file.path);
      }

      sources.push({
        name: file.name,
        path: file.path,
        file,
      });
    }

    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const entry = typeof item.webkitGetAsEntry === 'function'
        ? item.webkitGetAsEntry()
        : null;
      if (entry?.isDirectory && Platform.isDesktopApp) {
        const file: ExternalFile | null = item.getAsFile();
        if (file?.path) {
          if (seenPaths.has(file.path)) continue;
          seenPaths.add(file.path);
          sources.push({
            name: entry.name || file.name,
            path: file.path,
            file,
          });
        } else {
          sources.push({
            name: entry.name,
            entry,
          });
        }
      }
    }

    return sources;
  }

  private async importExternalPath(sourcePath: string, targetFolder: TFolder): Promise<number> {
    const { fs, nodePath } = this.getDesktopModules();
    const stat = await fs.stat(sourcePath);
    if (stat.isDirectory()) {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) throw new Error('Cannot verify the directory import destination.');
      const targetPath = nodePath.join(adapter.getBasePath(), targetFolder.path === '/' ? '' : targetFolder.path);
      await assertSafeDirectoryImport(sourcePath, targetPath, fs, nodePath);
      const folderName = nodePath.basename(sourcePath);
      const destinationFolderPath = this.getUniqueVaultPath(targetFolder.path, folderName, true);
      await this.ensureVaultFolder(destinationFolderPath);
      try {
        await this.copyDirectoryContents(sourcePath, destinationFolderPath, fs, nodePath);
      } catch (error) {
        await this.trashCreatedPath(destinationFolderPath);
        throw error;
      }
      await this.plugin.history.created(destinationFolderPath);
      return 1;
    }

    if (stat.isFile()) {
      const fileName = nodePath.basename(sourcePath);
      const destinationPath = this.getUniqueVaultPath(targetFolder.path, fileName, false);
      const data = await fs.readFile(sourcePath);
      await this.app.vault.createBinary(destinationPath, this.toArrayBuffer(data));
      await this.plugin.history.created(destinationPath);
      return 1;
    }

    return 0;
  }

  private async importExternalEntry(entry: FileSystemEntry, targetFolder: TFolder): Promise<number> {
    if (entry.isDirectory) {
      const directoryEntry = entry as FileSystemDirectoryEntry;
      // Freeze the source tree before creating output; pathless browser entries
      // can otherwise discover a newly-created destination inside their source.
      const snapshot = await this.snapshotDirectoryEntry(directoryEntry);
      const destinationFolderPath = this.getUniqueVaultPath(targetFolder.path, directoryEntry.name, true);
      await this.ensureVaultFolder(destinationFolderPath);
      try {
        await this.copyDirectoryEntryContents(snapshot, destinationFolderPath);
      } catch (error) {
        await this.trashCreatedPath(destinationFolderPath);
        throw error;
      }
      await this.plugin.history.created(destinationFolderPath);
      return 1;
    }

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await this.getFileFromEntry(fileEntry);
      await this.importExternalFile(file, targetFolder, file.name);
      return 1;
    }

    return 0;
  }

  private async copyDirectoryContents(sourceDirectoryPath: string, destinationFolderPath: string, fs: FsPromises, nodePath: NodePath): Promise<void> {
    const entries = await fs.readdir(sourceDirectoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = nodePath.join(sourceDirectoryPath, entry.name);

      if (entry.isDirectory()) {
        const childFolderPath = this.getUniqueVaultPath(destinationFolderPath, entry.name, true);
        await this.ensureVaultFolder(childFolderPath);
        await this.copyDirectoryContents(sourcePath, childFolderPath, fs, nodePath);
        continue;
      }

      if (entry.isFile()) {
        const destinationPath = this.getUniqueVaultPath(destinationFolderPath, entry.name, false);
        const data = await fs.readFile(sourcePath);
        await this.app.vault.createBinary(destinationPath, this.toArrayBuffer(data));
      }
    }
  }

  private async importExternalFile(file: File, targetFolder: TFolder, fileName: string): Promise<void> {
    const destinationPath = this.getUniqueVaultPath(targetFolder.path, fileName, false);
    await this.app.vault.createBinary(destinationPath, await file.arrayBuffer());
    await this.plugin.history.created(destinationPath);
  }

  private async snapshotDirectoryEntry(directoryEntry: FileSystemDirectoryEntry): Promise<ExternalEntrySnapshot[]> {
    const snapshot: ExternalEntrySnapshot[] = [];
    for (const entry of await this.readAllDirectoryEntries(directoryEntry)) {
      if (entry.isDirectory) snapshot.push({ name: entry.name, children: await this.snapshotDirectoryEntry(entry as FileSystemDirectoryEntry) });
      else if (entry.isFile) snapshot.push({ name: entry.name, file: await this.getFileFromEntry(entry as FileSystemFileEntry) });
    }
    return snapshot;
  }

  private async copyDirectoryEntryContents(snapshot: ExternalEntrySnapshot[], destinationFolderPath: string): Promise<void> {
    for (const entry of snapshot) {
      if ('children' in entry) {
        const childFolderPath = this.getUniqueVaultPath(destinationFolderPath, entry.name, true);
        await this.ensureVaultFolder(childFolderPath);
        await this.copyDirectoryEntryContents(entry.children, childFolderPath);
      } else {
        const destinationPath = this.getUniqueVaultPath(destinationFolderPath, entry.name, false);
        await this.app.vault.createBinary(destinationPath, await entry.file.arrayBuffer());
      }
    }
  }

  private async readAllDirectoryEntries(directoryEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = directoryEntry.createReader();
    const entries: FileSystemEntry[] = [];

    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });

      if (batch.length === 0) {
        break;
      }

      entries.push(...batch);
    }

    return entries;
  }

  private async getFileFromEntry(fileEntry: FileSystemFileEntry): Promise<File> {
    return new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
  }

  private async trashCreatedPath(path: string): Promise<void> {
    const created = this.app.vault.getAbstractFileByPath(path);
    if (!created) return;

    try {
      await this.app.fileManager.trashFile(created);
    } catch (error) {
      console.error(`Folder focus: failed to clean up partial import at ${path}`, error);
    }
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const normalizedPath = normalizePath(folderPath);
    if (!normalizedPath) return;

    const parts = normalizedPath.split('/').filter(Boolean);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing) {
        throw new Error(`Cannot create folder because a file already exists at ${currentPath}`);
      }

      await this.app.vault.createFolder(currentPath);
    }
  }

  private getUniqueVaultPath(parentPath: string, name: string, isFolder: boolean): string {
    const parsed = this.splitName(name, isFolder);
    let counter = 0;
    let candidateName = name;
    let candidatePath = this.joinVaultPath(parentPath, candidateName);

    while (this.app.vault.getAbstractFileByPath(candidatePath)) {
      counter++;
      candidateName = `${parsed.base} ${counter}${parsed.extension}`;
      candidatePath = this.joinVaultPath(parentPath, candidateName);
    }

    return candidatePath;
  }

  private splitName(name: string, isFolder: boolean): { base: string; extension: string } {
    if (isFolder) {
      return { base: name, extension: '' };
    }

    const extensionIndex = name.lastIndexOf('.');
    if (extensionIndex <= 0) {
      return { base: name, extension: '' };
    }

    return {
      base: name.substring(0, extensionIndex),
      extension: name.substring(extensionIndex),
    };
  }

  private joinVaultPath(parentPath: string, name: string): string {
    return normalizePath(parentPath ? `${parentPath}/${name}` : name);
  }

  private toArrayBuffer(data: Buffer): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }

  private getDesktopModules(): { fs: FsPromises; nodePath: NodePath } {
    const nodeRequire = (window as ObsidianDesktopWindow).require;
    if (!nodeRequire) {
      throw new Error('Desktop file system API is not available.');
    }

    return {
      fs: nodeRequire('fs/promises') as FsPromises,
      nodePath: nodeRequire('path') as NodePath,
    };
  }
}

// --- Rename Modal ---

class RenameModal extends Modal {
  currentName: string;
  title: string;
  onSubmit: (result: string | null) => void;

  constructor(app: App, currentName: string, title: string, onSubmit: (result: string | null) => void) {
    super(app);
    this.currentName = currentName;
    this.title = title;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createDiv({ cls: 'folder-focus-modal-title', text: this.title });

    const inputEl = contentEl.createEl('input', {
      type: 'text',
      value: this.currentName,
      cls: 'folder-focus-modal-input',
    });
    inputEl.select();

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    buttonContainer.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => {
        this.close();
        this.onSubmit(null);
      });

    buttonContainer.createEl('button', { text: 'Rename', cls: 'mod-cta' })
      .addEventListener('click', () => {
        this.close();
        this.onSubmit(inputEl.value);
      });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.close();
        this.onSubmit(inputEl.value);
      } else if (e.key === 'Escape') {
        this.close();
        this.onSubmit(null);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
