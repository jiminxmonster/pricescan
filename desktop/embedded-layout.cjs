class EmbeddedLayout {
  constructor(mainWindow, controlsHeight = 112) {
    if (!mainWindow?.contentView) throw new Error('PriceScan 메인 창이 준비되지 않았습니다.');
    this.mainWindow = mainWindow;
    this.controlsHeight = controlsHeight;
    this.active = null;
    this.resize = () => this.resizeActive();
    mainWindow.on('resize', this.resize);
  }
  attach(entry) {
    if (entry.visible) return;
    this.mainWindow.contentView.addChildView(entry.controls);
    this.mainWindow.contentView.addChildView(entry.view);
    entry.visible = true;
  }
  detach(entry) {
    if (!entry?.visible) return;
    this.mainWindow.contentView.removeChildView(entry.view);
    this.mainWindow.contentView.removeChildView(entry.controls);
    entry.visible = false;
  }
  resizeActive() {
    if (!this.active) return;
    const [width, height] = this.mainWindow.getContentSize();
    this.active.controls.setBounds({ x: 0, y: 0, width, height: Math.min(this.controlsHeight, height) });
    this.active.view.setBounds({ x: 0, y: this.controlsHeight, width, height: Math.max(0, height - this.controlsHeight) });
  }
  show(entry) {
    if (this.active !== entry) {
      this.detach(this.active);
      this.attach(entry);
      this.active = entry;
    }
    this.resizeActive();
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
  }
  hide(entry = this.active) {
    if (entry) {
      this.detach(entry);
      if (this.active === entry) this.active = null;
      return;
    }
    this.detach(this.active);
    this.active = null;
  }
  minimize() { this.mainWindow.minimize(); }
  dispose() { this.hide(null); this.mainWindow.removeListener('resize', this.resize); }
}

module.exports = { EmbeddedLayout };
