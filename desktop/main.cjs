const { app, BrowserWindow, ipcMain, Notification, Menu, dialog } = require('electron');
const path = require('node:path');
const { JobManager } = require('./job-manager.cjs');
const { BrowserDriver } = require('./browser-driver.cjs');
const { APP_URL, API_URL, isAppUrl, isShopUrl } = require('./security.cjs');

app.setName('PriceScan Desktop');
// A new app-owned profile, not Chrome's or the legacy PriceScan profile.
app.setPath('userData', path.join(app.getPath('appData'), 'PriceScan Desktop'));
let mainWindow, manager, driver, ticker;
const notices = new Set();
function showMain() { if (mainWindow && !mainWindow.isDestroyed()) { driver?.hideActive(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } }
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showMain);
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('PriceScan 실행 오류', error.message); app.quit(); });
  app.on('activate', showMain);
  app.on('before-quit', () => { clearInterval(ticker); if (driver) driver.quitting = true; manager?.shutdown(); });
  app.on('window-all-closed', () => app.quit());
}
function notify(job, source, message) {
  if (!mainWindow.isDestroyed()) mainWindow.flashFrame(true);
  app.dock?.setBadge('!');
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title: `PriceScan · ${source === 'naver' ? '네이버' : source} 확인 필요`, body: `${job.query}\n${message}` });
  notices.add(notice);
  notice.on('click', () => { try { driver.focus(job.id, source); } catch { showMain(); } app.dock?.setBadge(''); });
  notice.on('close', () => notices.delete(notice));
  notice.on('failed', () => { notices.delete(notice); /* In-app task card and Dock badge remain available. */ });
  notice.show();
}
async function api(pathname, token, body, signal) {
  if (!token) throw new Error('PriceScan 로그인 필요');
  signal?.throwIfAborted();
  const response = await fetch(`${API_URL}${pathname}`, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`PriceScan 저장 실패 (${response.status})`);
  return response.json();
}
async function save(job, source, token, signal) {
  const task = job.tasks[source];
  const payload = await api('/price-search/desktop-results', token, { collection_id: job.id, query: job.query, sort_mode: job.sortMode,
    approval_scope: 'desktop_supervised', page_urls: { [source]: task.pageUrl }, warnings: task.warnings, items: task.items }, signal);
  await api(`/seller-products/${encodeURIComponent(job.productId)}/search-results`, token, { run_id: payload.run.id, warnings: payload.warnings || [] }, signal);
}
function guard(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error('허용되지 않은 앱 요청입니다.');
}
async function start() {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 860, minHeight: 640, title: 'PriceScan Desktop',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  driver = new BrowserDriver(mainWindow, {
    interpret: (token, observation, signal) => api('/seller-products/assistant/observe', token, observation, signal),
  });
  manager = new JobManager({ directory: path.join(app.getPath('userData'), 'tasks'), driver, save, notify });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  for (const name of ['will-navigate', 'will-redirect']) mainWindow.webContents.on(name, (event, url) => { if (!isAppUrl(url || event.url)) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const source = ['naver', 'danawa', 'enuri', 'coupang'].find(key => isShopUrl(key, url));
    if (source) { const entry = driver.create({ id: `review-${Date.now()}`, query: '상품 원본 검토' }, source); void entry.view.webContents.loadURL(url).catch(() => {}); driver.focus(entry.jobId, source); }
    return { action: 'deny' };
  });
  ipcMain.handle('desktop:start', (event, payload) => {
    guard(event);
    const result = manager.start(payload);
    setImmediate(() => { try { manager.showScroll(result.id); } catch { /* workers may still be creating views */ } });
    return result;
  });
  ipcMain.handle('desktop:list', event => { guard(event); return manager.list(); });
  ipcMain.handle('desktop:authorize', (event, token) => { guard(event); manager.authorize(token); });
  ipcMain.handle('desktop:logout', event => { guard(event); manager.logout(); });
  ipcMain.handle('desktop:login-naver', event => { guard(event); driver.openLogin(); });
  ipcMain.handle('desktop:action', (event, payload) => { guard(event); return manager.action(payload?.jobId, payload?.source, payload?.action); });
  ipcMain.handle('desktop:show-scroll', (event, jobId) => { guard(event); return manager.showScroll(jobId); });
  ipcMain.handle('desktop:capture-all', (event, jobId) => { guard(event); return manager.captureAll(jobId); });
  ipcMain.handle('desktop:window-action', (event, action) => {
    const entry = driver.senderContext(event.sender);
    if (!entry || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith('file:')) throw new Error('허용되지 않은 창입니다.');
    if (action === 'home') { driver.hide(entry.jobId, entry.source); return showMain(); }
    if (action === 'scroll-up' || action === 'scroll-down') return driver.scroll(entry.jobId, action === 'scroll-up' ? 'up' : 'down');
    if (action === 'capture-all') return manager.captureAll(entry.jobId);
    if (action === 'minimize') return driver.minimize();
    if (entry.jobId === 'login' && action === 'cancel') return driver.stop('login', 'naver');
    return manager.action(entry.jobId, entry.source, action);
  });
  manager.on('change', jobs => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('desktop:jobs', jobs);
    for (const job of jobs) if (!job.active) driver.hideScroll(job.id);
  });
  ticker = setInterval(() => manager.pump(), 1000);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'PriceScan', submenu: [{ label: '가격 검색 화면', click: showMain }, { label: '네이버 로그인', click: () => driver.openLogin() }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  mainWindow.on('close', event => { if (!driver.quitting) { event.preventDefault(); mainWindow.hide(); } });
  try { await mainWindow.loadURL(`${APP_URL}?collector=desktop`); }
  catch { await dialog.showMessageBox(mainWindow, { type: 'error', message: 'PriceScan 서비스에 연결하지 못했습니다.', detail: `${APP_URL} 주소와 네트워크 연결을 확인한 후 앱을 다시 실행하세요.` }); }
}
