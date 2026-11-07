import { App, Component, MarkdownRenderer, Modal, TAbstractFile, TFile, TFolder, Notice } from 'obsidian';

export class QuickPreviewModal extends Modal {
  private generation = 0;
  private renderer: Component | null = null;
  constructor(app: App, private items: TAbstractFile[], private index: number, private closed: () => void, private selected: (file: TAbstractFile) => void) { super(app); }
  onOpen() {
    this.modalEl.addClass('folder-focus-preview');
    this.scope.register([], ' ', event => { event.preventDefault(); this.close(); return false; });
    this.scope.register([], 'ArrowDown', () => { this.move(1); return false; });
    this.scope.register([], 'ArrowUp', () => { this.move(-1); return false; });
    this.scope.register([], 'ArrowRight', () => { this.move(1); return false; });
    this.scope.register([], 'ArrowLeft', () => { this.move(-1); return false; });
    void this.render();
  }
  private move(delta: number) {
    this.index = Math.max(0, Math.min(this.items.length - 1, this.index + delta));
    this.selected(this.items[this.index]); void this.render();
  }
  private async render() {
    const generation = ++this.generation;
    this.renderer?.unload(); this.renderer = null;
    this.contentEl.empty();
    const item = this.items[this.index];
    this.titleEl.setText(item.name);
    this.contentEl.createDiv({ cls: 'folder-focus-preview-path', text: item.path });
    const body = this.contentEl.createDiv({ cls: 'folder-focus-preview-body', text: 'Loading…' });
    const open = this.contentEl.createEl('button', { text: 'Open' });
    open.onclick = () => { this.close(); if (item instanceof TFile) void this.app.workspace.getLeaf(false).openFile(item).catch(() => new Notice('This file could not be opened.')); };
    if (item instanceof TFolder) { body.setText(`${item.children.length} items`); open.disabled = true; return; }
    if (!(item instanceof TFile)) { body.setText('Preview unavailable.'); return; }
    try {
      if (item.extension === 'md') {
        const text = await this.app.vault.cachedRead(item);
        if (generation !== this.generation) return;
        body.empty();
        const renderer = new Component(); renderer.load(); this.renderer = renderer;
        await MarkdownRenderer.render(this.app, text, body, item.path, renderer);
      } else if (/^(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(item.extension)) {
        body.empty();
        const image = body.createEl('img', { attr: { src: this.app.vault.getResourcePath(item), alt: item.name } });
        image.onerror = () => { if (generation === this.generation) body.setText('Image preview unavailable. Use Open.'); };
      } else if (item.extension.toLowerCase() === 'pdf') {
        body.empty();
        body.createEl('iframe', { attr: { src: this.app.vault.getResourcePath(item), title: item.name } });
      } else body.setText(`${item.extension.toUpperCase() || 'File'} · ${item.stat.size.toLocaleString()} bytes. Preview unavailable. Use Open.`);
    } catch { if (generation === this.generation) body.setText('Preview unavailable. Use Open.'); }
  }
  onClose() { ++this.generation; this.renderer?.unload(); this.renderer = null; this.contentEl.empty(); this.closed(); }
}
