import { App, TFile, TFolder, TAbstractFile, Notice, normalizePath } from 'obsidian';

type Snapshot = { path: string; data: ArrayBuffer | null }[];
type Step = { from: string | null; to: string | null; snapshot?: Snapshot; emptyFolder?: boolean };
type State = Map<string, Snapshot | null>;
type Entry = { label: string; steps: Step[]; expected: State | null; signature: string; trackedPaths?: string[] };

/** Session-only history. Content snapshots stay in memory, never in synced vault files. */
export class OperationHistory {
  private undoEntries: Entry[] = [];
  private redoEntries: Entry[] = [];
  private active: Entry | null = null;
  busy = false;
  constructor(private app: App) {}
  get undoLabel() { return this.undoEntries[this.undoEntries.length - 1]?.label; }
  get redoLabel() { return this.redoEntries[this.redoEntries.length - 1]?.label; }
  clear() { this.undoEntries = []; this.redoEntries = []; }

  async run(label: string, work: () => Promise<void>) {
    if (this.busy) { new Notice('Another file operation is still running.'); return; }
    this.busy = true;
    const entry: Entry = { label, steps: [], expected: null, signature: '' };
    this.active = entry;
    try { await work(); }
    catch (error) { new Notice(`${label} stopped. Completed items can be undone. ${String(error)}`); }
    finally {
      this.active = null;
      if (entry.steps.length) {
        await this.finalize(entry);
        this.undoEntries.push(entry);
        this.undoEntries = this.undoEntries.slice(-50);
        this.redoEntries = [];
      }
      this.busy = false;
    }
  }
  private paths(entry: Entry) {
    if (entry.trackedPaths) return entry.trackedPaths;
    const paths = [...new Set(entry.steps.flatMap(step => [step.from, step.to]).filter((path): path is string => path !== null))].sort();
    return paths.filter(path => !paths.some(parent => parent !== path && path.startsWith(parent + '/')));
  }
  private signature(entry: Entry): string {
    const visit = (file: TAbstractFile): unknown => file instanceof TFile
      ? [file.path, file.stat.mtime, file.stat.size]
      : [file.path, file instanceof TFolder ? [...file.children].sort((a,b) => a.path.localeCompare(b.path)).map(visit) : null];
    return JSON.stringify(this.paths(entry).map(path => { const file = this.app.vault.getAbstractFileByPath(path); return file ? visit(file) : [path, null]; }));
  }
  private async capture(entry: Entry): Promise<State> {
    const result: State = new Map();
    for (const path of this.paths(entry)) result.set(path, this.app.vault.getAbstractFileByPath(path) ? await this.snapshot(path) : null);
    return result;
  }
  private async finalize(entry: Entry) {
    entry.trackedPaths ??= this.paths(entry);
    entry.signature = this.signature(entry);
    try { entry.expected = await this.capture(entry); }
    catch { entry.expected = null; new Notice('File verification temporarily failed. Undo will retry if these files remain unchanged.'); }
  }
  private async snapshot(path: string): Promise<Snapshot> {
    const item = this.app.vault.getAbstractFileByPath(path);
    if (!item) throw new Error(`Missing item: ${path}`);
    const result: Snapshot = [];
    const visit = async (file: TAbstractFile) => {
      result.push({ path: file.path.slice(path.length), data: file instanceof TFile ? await this.app.vault.readBinary(file) : null });
      if (file instanceof TFolder) for (const child of [...file.children].sort((a, b) => a.path.localeCompare(b.path))) await visit(child);
    };
    await visit(item);
    return result;
  }
  private equal(a: Snapshot, b: Snapshot) {
    return a.length === b.length && a.every((entry, i) => {
      const other = b[i];
      if (entry.path !== other.path || (entry.data === null) !== (other.data === null)) return false;
      if (!entry.data || !other.data) return true;
      const left = new Uint8Array(entry.data), right = new Uint8Array(other.data);
      return left.length === right.length && left.every((value, j) => value === right[j]);
    });
  }
  async move(item: TAbstractFile, to: string) {
    const from = item.path;
    to = normalizePath(to).replace(/^\/+/, '');
    if (from === to) return;
    if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`Already exists: ${to}`);
    await this.app.fileManager.renameFile(item, to);
    this.active?.steps.push({ from, to });
  }
  async created(path: string) {
    path = normalizePath(path).replace(/^\/+/, '');
    const file = this.app.vault.getAbstractFileByPath(path);
    this.active?.steps.push({ from: null, to: path, emptyFolder: file instanceof TFolder && file.children.length === 0 });
  }
  async trash(item: TAbstractFile) {
    // Reading before removal guarantees a failed backup cannot delete the original.
    const snapshot = await this.snapshot(item.path);
    const from = item.path;
    await this.app.fileManager.trashFile(item);
    this.active?.steps.push({ from, to: null, snapshot });
  }
  private async restore(path: string, snapshot: Snapshot) {
    const restored: Snapshot = [];
    try {
      for (const entry of snapshot) {
        const target = path + entry.path;
        if (entry.data === null) await this.app.vault.createFolder(target);
        else await this.app.vault.createBinary(target, entry.data.slice(0));
        restored.push(entry);
      }
    } catch (error) {
      if (restored.length) {
        const current = await this.snapshot(path);
        if (this.equal(current, restored)) await this.app.fileManager.trashFile(this.app.vault.getAbstractFileByPath(path)!);
        else throw new Error(`Restore interrupted at ${path}; externally changed partial content was preserved. ${String(error)}`);
      }
      throw error;
    }
  }
  async replay(redo = false) {
    if (this.busy) return;
    const source = redo ? this.redoEntries : this.undoEntries;
    const destination = redo ? this.undoEntries : this.redoEntries;
    const entry = source[source.length - 1];
    if (!entry) return;
    this.busy = true;
    const steps = redo ? [...entry.steps] : [...entry.steps].reverse();
    try {
      if (!entry.expected) {
        if (this.signature(entry) !== entry.signature) throw new Error('Files changed since verification failed.');
        entry.expected = await this.capture(entry);
      }
      // Validate the final batch state, not individual intermediate move states:
      // Obsidian may have rewritten links in earlier files during later moves.
      const current = await this.capture(entry);
      for (const [path, expected] of entry.expected) {
        const actual = current.get(path);
        if (expected === null ? actual !== null : !actual || !this.equal(expected, actual)) throw new Error(`Item changed or destination occupied: ${path}`);
      }
      const completed: Step[] = [];
      try {
        for (const step of steps) {
          const from = redo ? step.from : step.to, to = redo ? step.to : step.from;
          if (to && this.app.vault.getAbstractFileByPath(to)) throw new Error(`Already exists: ${to}`);
          if (from && to) {
            const file = this.app.vault.getAbstractFileByPath(from);
            if (!file) throw new Error(`Missing item: ${from}`);
            await this.app.fileManager.renameFile(file, to);
          } else if (from) {
            const file = this.app.vault.getAbstractFileByPath(from);
            if (!file) throw new Error(`Missing item: ${from}`);
            if (!redo && step.emptyFolder && file instanceof TFolder && file.children.length) throw new Error(`Folder is no longer empty: ${from}`);
            step.snapshot = await this.snapshot(from);
            await this.app.fileManager.trashFile(file);
          } else if (to && step.snapshot) await this.restore(to, step.snapshot);
          else throw new Error('Missing restoration data.');
          completed.push(step);
          // Checkpoint only after successful work; a failed step must not adopt external changes.
          entry.signature = this.signature(entry);
          entry.expected = null;
          entry.expected = await this.capture(entry);
        }
      } catch (error) {
        entry.steps = entry.steps.filter(step => !completed.includes(step));
        if (completed.length) {
          const partial: Entry = { label: entry.label, steps: redo ? completed : completed.reverse(), expected: null, signature: '' };
          await this.finalize(partial); destination.push(partial);
        }
        if (!entry.steps.length) source.pop();
        throw error;
      }
      await this.finalize(entry);
      source.pop(); destination.push(entry);
      new Notice(`${redo ? 'Redid' : 'Undid'} ${entry.label}`);
    } catch (error) { new Notice(`Cannot ${redo ? 'redo' : 'undo'}: ${String(error)}`); }
    finally { this.busy = false; }
  }
}
