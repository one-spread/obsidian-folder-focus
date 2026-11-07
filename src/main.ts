import { OperationHistory } from './operationHistory';
import { Plugin, WorkspaceLeaf, TFolder, Menu, PluginSettingTab, App, type SettingDefinitionItem } from 'obsidian';
import { FolderFocusView, VIEW_TYPE_FOLDER_FOCUS } from './FolderFocusView';
import {
  isSearchMode,
  normalizeFavoriteFolderPaths,
  type FolderFocusSearchMode,
} from './searchUtils';

export interface FolderFocusSettings {
  openInNewTab: boolean;
  favoriteFolderPaths: string[];
  defaultSearchMode: FolderFocusSearchMode;
}

type FolderFocusSettingControlKey = 'openInNewTab' | 'defaultSearchMode';

const DEFAULT_SETTINGS: FolderFocusSettings = {
  openInNewTab: true,
  favoriteFolderPaths: [],
  defaultSearchMode: 'full-text',
};

const HOW_TO_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['Open folder focus', 'Click the folder icon in the left ribbon, or right-click any folder and select "Open in folder focus".'],
  ['Navigate folders', 'Double-click a folder to enter it. Use Cmd+Up to go back to the parent folder.'],
  ['Open files', 'Double-click a file to open it. Use Cmd+Double-click to open in a new tab.'],
  ['Import from Finder', 'Drag files or folders from Finder into the folder focus list to copy them into the current folder.'],
  ['Search', 'Type in the search box and press Enter to search file names and content across all subfolders.'],
  ['Multi-select', 'Hold Cmd and click to select multiple items. Hold Shift and click for range selection.'],
];

const KEYBOARD_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Up / Down', 'Move selection'],
  ['Shift+Up / Down', 'Extend selection'],
  ['Cmd+A', 'Select all'],
  ['Cmd+Up', 'Parent folder'],
  ['Cmd+Down / Cmd+O', 'Enter folder or open file'],
  ['Enter', 'Rename selection'],
  ['Space', 'Preview selection'],
  ['Cmd+Z / Shift+Cmd+Z', 'Undo / redo file operation'],
  ['Cmd+[ / Cmd+]', 'Back / forward'],
  ['Cmd+Delete', 'Move selection to trash'],
  ['Cmd+Enter', 'Open in new tab'],
  ['Shift+Cmd+N', 'Create new folder'],
  ['Escape', 'Clear search'],
];

const MOUSE_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ['Click', 'Select item'],
  ['Cmd+Click', 'Toggle selection'],
  ['Shift+Click', 'Range selection'],
  ['Double-click', 'Enter folder or open file'],
  ['Cmd+Double-click', 'Open in new tab'],
  ['Right-click', 'Context menu'],
];

export default class FolderFocusPlugin extends Plugin {
  settings!: FolderFocusSettings;
  history!: OperationHistory;

  onload(): void {
    this.history = new OperationHistory(this.app);
    this.register(() => this.history.clear());
    this.settings = { ...DEFAULT_SETTINGS };
    void this.loadSettings().then(
      () => {
        this.registerPluginFeatures();
      },
      (e) => {
        console.error('Folder focus: failed to load settings', e);
        this.registerPluginFeatures();
      }
    );
  }

  private registerPluginFeatures(): void {
    // 1. Register the view
    this.registerView(
      VIEW_TYPE_FOLDER_FOCUS,
      (leaf) => new FolderFocusView(leaf, this)
    );

    // 2. Add ribbon icon
    this.addRibbonIcon('folder', 'Open folder focus', () => {
      void this.activateView().catch((e) => {
        console.error('Folder focus: failed to activate view', e);
      });
    });

    // 3. Register commands
    this.addCommand({
      id: 'open-view',
      name: 'Open folder navigation view',
      callback: () => {
        void this.activateView().catch((e) => {
          console.error('Folder focus: failed to activate view', e);
        });
      },
    });

    // Commands without default hotkeys - shortcuts are handled in the view's keydown handler
    this.addCommand({
      id: 'navigate-parent',
      name: 'Navigate to parent folder',
      callback: () => this.getView()?.navigateToParent(),
    });

    this.addCommand({
      id: 'enter-folder-or-open',
      name: 'Enter folder or open file',
      callback: () => this.getView()?.enterOrOpen(),
    });

    this.addCommand({
      id: 'create-new-note',
      name: 'Create new note in current folder',
      callback: () => {
        const view = this.getView();
        if (view) {
          void view.createNewNote().catch((e) => {
            console.error('Folder focus: failed to create note', e);
          });
        }
      },
    });

    this.addCommand({
      id: 'reveal-active-file',
      name: 'Reveal active file',
      callback: () => {
        void (async () => {
          await this.activateView();
          this.getView()?.revealActiveFile();
        })().catch((e) => {
          console.error('Folder focus: failed to reveal active file', e);
        });
      },
    });

    // 4. Add context menu for folders
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file, _source) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Open in folder focus')
              .setIcon('folder')
              .onClick(() => {
                void (async () => {
                  await this.activateView();
                  const view = this.getView();
                  if (view) {
                    view.setFolder(file);
                  }
                })().catch((e) => {
                  console.error('Folder focus: failed to open folder focus from menu', e);
                });
              });
          });
        }
      })
    );

    // 5. Add settings tab
    this.addSettingTab(new FolderFocusSettingTab(this.app, this));
  }

  onunload() {
    // View cleanup handled automatically by Obsidian
  }

  async loadSettings() {
    const loadedData: unknown = await this.loadData();
    const candidate = isFolderFocusSettings(loadedData) ? loadedData : {};

    this.settings = {
      ...DEFAULT_SETTINGS,
      openInNewTab: typeof candidate.openInNewTab === 'boolean'
        ? candidate.openInNewTab
        : DEFAULT_SETTINGS.openInNewTab,
      favoriteFolderPaths: normalizeFavoriteFolderPaths(candidate.favoriteFolderPaths),
      defaultSearchMode: isSearchMode(candidate.defaultSearchMode)
        ? candidate.defaultSearchMode
        : DEFAULT_SETTINGS.defaultSearchMode,
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isFavoriteFolder(path: string): boolean {
    return this.settings.favoriteFolderPaths.includes(path);
  }

  async addFavoriteFolder(path: string): Promise<void> {
    if (this.isFavoriteFolder(path)) return;
    this.settings.favoriteFolderPaths = [...this.settings.favoriteFolderPaths, path];
    await this.saveSettings();
  }

  async removeFavoriteFolder(path: string): Promise<void> {
    this.settings.favoriteFolderPaths = this.settings.favoriteFolderPaths.filter((favoritePath) => favoritePath !== path);
    await this.saveSettings();
  }

  async toggleFavoriteFolder(path: string): Promise<void> {
    if (this.isFavoriteFolder(path)) {
      await this.removeFavoriteFolder(path);
    } else {
      await this.addFavoriteFolder(path);
    }
  }

  getView(): FolderFocusView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FOLDER_FOCUS);
    const view = leaves[0]?.view;
    return view instanceof FolderFocusView ? view : null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_FOLDER_FOCUS)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_FOLDER_FOCUS, active: true });
      }
    }

    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }
}

class FolderFocusSettingTab extends PluginSettingTab {
  plugin: FolderFocusPlugin;

  constructor(app: App, plugin: FolderFocusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem<FolderFocusSettingControlKey>[] {
    const favoriteCount = this.plugin.settings.favoriteFolderPaths.length;
    const favoriteLabel = `${favoriteCount} favorite folder${favoriteCount === 1 ? '' : 's'} saved.`;

    return [
      {
        type: 'group',
        heading: 'How to use',
        cls: 'folder-focus-howto',
        items: HOW_TO_STEPS.map(([name, desc]) => ({ name, desc })),
      },
      {
        type: 'group',
        heading: 'Behavior',
        items: [
          {
            name: 'Open files in new tab',
            desc: 'When enabled, files will open in a new tab instead of the current one.',
            control: {
              type: 'toggle',
              key: 'openInNewTab',
              defaultValue: DEFAULT_SETTINGS.openInNewTab,
            },
          },
          {
            name: 'Default search mode',
            desc: 'Choose whether Folder Focus searches file names only or file names plus Markdown note text by default.',
            control: {
              type: 'dropdown',
              key: 'defaultSearchMode',
              defaultValue: DEFAULT_SETTINGS.defaultSearchMode,
              options: {
                'full-text': 'Names + note text',
                name: 'File names',
              },
              validate: (value) => isSearchMode(value) ? undefined : 'Choose a valid search mode.',
            },
          },
          {
            name: 'Remove missing favorite folders',
            desc: `${favoriteLabel} Remove entries whose folders no longer exist.`,
            action: () => {
              void this.cleanMissingFavoriteFolders().catch((e) => {
                console.error('Folder focus: failed to clean favorite folders', e);
              });
            },
          },
        ],
      },
      {
        type: 'group',
        heading: 'Keyboard shortcuts',
        items: KEYBOARD_SHORTCUTS.map(([name, desc]) => ({ name, desc })),
      },
      {
        type: 'group',
        heading: 'Mouse actions',
        items: MOUSE_ACTIONS.map(([name, desc]) => ({ name, desc })),
      },
      {
        type: 'group',
        heading: 'Support',
        cls: 'folder-focus-support',
        items: [
          {
            name: 'Buy Me a Coffee',
            desc: 'If you find this plugin helpful, consider supporting its development.',
            render: (setting) => {
              setting
                .setName('Buy Me a Coffee')
                .setDesc('If you find this plugin helpful, consider supporting its development.')
                .setClass('folder-focus-support');
              const link = setting.controlEl.createEl('a', { href: 'https://buymeacoffee.com/1spread' });
              const img = link.createEl('img', { cls: 'folder-focus-bmc-img' });
              img.src = 'https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png';
              img.alt = 'Buy Me A Coffee';
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === 'openInNewTab') {
      return this.plugin.settings.openInNewTab;
    }

    if (key === 'defaultSearchMode') {
      return this.plugin.settings.defaultSearchMode;
    }

    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === 'openInNewTab') {
      if (typeof value !== 'boolean') {
        throw new Error('Open in new tab must be a boolean.');
      }
      this.plugin.settings.openInNewTab = value;
      await this.plugin.saveSettings();
      return;
    }

    if (key === 'defaultSearchMode') {
      if (!isSearchMode(value)) {
        throw new Error('Default search mode must be a supported search mode.');
      }
      this.plugin.settings.defaultSearchMode = value;
      await this.plugin.saveSettings();
      return;
    }

    throw new Error(`Unknown Folder Focus setting: ${key}`);
  }

  private async cleanMissingFavoriteFolders(): Promise<void> {
    const existing = this.plugin.settings.favoriteFolderPaths.filter((path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder);
    this.plugin.settings.favoriteFolderPaths = existing;
    await this.plugin.saveSettings();
    this.update();
  }
}

interface FolderFocusSettingsCandidate {
  openInNewTab?: unknown;
  favoriteFolderPaths?: unknown;
  defaultSearchMode?: unknown;
}

function isFolderFocusSettings(value: unknown): value is FolderFocusSettingsCandidate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return true;
}
