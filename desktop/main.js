import { app, BrowserWindow, dialog, Menu, ipcMain } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootBackend } from './boot.js';
import { readSettings, writeSettings, syncSettingsToEnv } from './config.js';
import { desktopLabels, readLocale, writeLocale, syncLocaleToEnv } from './preferences.js';
import { MESSAGES } from '../src/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();
const DESKTOP_PORT = Number(process.env.WIKINEST_DESKTOP_PORT) || 4321;

let settingsWin = null;
let mainWin = null;

// 打开设置:优先复用主窗口里「样式一致」的页内弹窗(点左下角齿轮那个),
// 只有在主窗口不可用时才退回独立的设置窗口。
function openSettingsInApp() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('open-settings');
    mainWin.focus();
    return;
  }
  openSettings();
}

const MAX_RECENT_VAULTS = 8;

// 把某个知识库路径记入「最近打开」:去重、置顶、限量。
function rememberVault(dir) {
  if (!dir) return;
  const recent = (store.get('recentVaults') || []).filter((d) => d && d !== dir);
  recent.unshift(dir);
  store.set('recentVaults', recent.slice(0, MAX_RECENT_VAULTS));
}

// 切换到另一个知识库:写入新路径 + 记入最近,然后重启应用让新的
// WIKI_CONTENT_DIR 干净生效(store.js 在模块加载时读取它)。
function switchVault(dir) {
  if (!dir) return;
  if (dir === store.get('vaultDir')) { rememberVault(dir); return; }
  store.set('vaultDir', dir);
  rememberVault(dir);
  app.relaunch();
  app.exit(0);
}

// 弹目录选择框,选中后切换知识库。
async function openVaultDialog() {
  const labels = desktopLabels(readLocale(store));
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: labels.openVaultTitle,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return;
  switchVault(filePaths[0]);
}

// 返回已保存的 Vault 路径;首启时弹目录选择框。选空则退出。
async function resolveVaultDir() {
  const saved = store.get('vaultDir');
  if (saved) { rememberVault(saved); return saved; }
  const labels = desktopLabels(readLocale(store));
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: labels.chooseVaultTitle,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return null;
  store.set('vaultDir', filePaths[0]);
  rememberVault(filePaths[0]);
  return filePaths[0];
}

// 「打开最近」子菜单:列出除当前库外的最近知识库,点击即切换。
function recentVaultsSubmenu() {
  const labels = desktopLabels(readLocale(store));
  const current = store.get('vaultDir');
  const recent = (store.get('recentVaults') || []).filter((d) => d && d !== current);
  if (!recent.length) return [{ label: labels.noRecent, enabled: false }];
  const items = recent.map((dir) => ({
    label: path.basename(dir),
    toolTip: dir,
    click: () => switchVault(dir),
  }));
  items.push({ type: 'separator' });
  items.push({
    label: labels.clearRecent,
    click: () => {
      store.set('recentVaults', current ? [current] : []);
      buildMenu();
    },
  });
  return items;
}

// 打开(或聚焦)设置窗口。
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  const labels = desktopLabels(readLocale(store));
  settingsWin = new BrowserWindow({
    width: 640,
    height: 720,
    title: labels.settingsTitle,
    resizable: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// 应用菜单:提供「设置…」入口(Cmd/Ctrl+,)并保留常用编辑/视图快捷键。
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const labels = desktopLabels(readLocale(store));
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: labels.settings, accelerator: 'CmdOrCtrl+,', click: openSettingsInApp },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: labels.file,
      submenu: [
        { label: labels.openFolder, accelerator: 'CmdOrCtrl+O', click: openVaultDialog },
        { label: labels.openRecent, submenu: recentVaultsSubmenu() },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: labels.settings, accelerator: 'CmdOrCtrl+,', click: openSettingsInApp }, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: labels.view,
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const vaultDir = await resolveVaultDir();
  if (!vaultDir) { app.quit(); return; }

  const settings = readSettings(store);
  syncLocaleToEnv(readLocale(store));
  const { port } = await bootBackend({ vaultDir, settings, port: DESKTOP_PORT });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Wikinest — ${path.basename(vaultDir)}`,
    // Keep native macOS traffic lights but let the web page render the rest of
    // the titlebar (drag region + sidebar toggle).
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 复用设置窗口的 preload,把 wikiSettings IPC 桥暴露给前端页面,
      // 让页内(左下角齿轮)的设置弹窗可以读写配置、更换知识库。
      preload: path.join(__dirname, 'settings-preload.cjs'),
    },
  });
  mainWin = win;
  win.on('closed', () => { if (mainWin === win) mainWin = null; });
  // 让标题固定显示当前知识库名(否则会被前端页面的 <title> 覆盖)。
  win.on('page-title-updated', (e) => e.preventDefault());
  // `?desktop=1` 让前端知道自己跑在 Electron 里,从而为 macOS 交通灯按钮预留
  // 顶部空间,并把顶栏设为可拖拽窗口的区域(浏览器里此标记无副作用)。
  await win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);

  // 首启且未配置大模型时,自动弹出页内设置弹窗,方便用户立刻填 key 启用 AI 功能。
  if (!settings.LLM_API_KEY) {
    win.webContents.once('did-finish-load', () => win.webContents.send('open-settings'));
  }
}

// --- IPC:设置窗口读写配置 ---
ipcMain.handle('settings:get', () => readSettings(store));
ipcMain.handle('settings:info', () => ({
  vaultDir: store.get('vaultDir') || '',
  version: app.getVersion(),
  locale: readLocale(store),
  messages: MESSAGES[readLocale(store)],
}));
ipcMain.handle('settings:save', async (_e, data) => {
  const previousLocale = readLocale(store);
  const clean = writeSettings(store, data);
  const locale = writeLocale(store, data?.locale ?? previousLocale);
  syncLocaleToEnv(locale);
  // 热更新,无需重启:后端 express 就跑在本进程里,LLM / Embedding 每次请求都
  // 实时读 process.env,所以刷新 env 即可立即生效;更换 env 后再重置 S3 客户端
  // 单例,让存储配置也生效。(更换知识库走 chooseVault,那条路径才需要重启。)
  syncSettingsToEnv(clean);
  try {
    const { resetStorageClient } = await import('../src/core/storage.js');
    resetStorageClient();
  } catch (err) {
    console.error('reset storage client failed:', err.message);
  }
  const localeChanged = locale !== previousLocale;
  if (localeChanged) buildMenu();
  // 通知前端重新拉取各能力状态,刷新按钮/入口的显隐。
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('settings-updated', { localeChanged });
  }
  return { ok: true, localeChanged };
});
ipcMain.handle('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});
// 从设置窗口发起「更换知识库」:弹目录框并切换(会重启应用)。
ipcMain.handle('settings:chooseVault', async () => {
  await openVaultDialog();
  return { ok: true };
});

app.whenReady().then(() => {
  syncLocaleToEnv(readLocale(store));
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
