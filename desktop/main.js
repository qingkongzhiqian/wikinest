import { app, BrowserWindow, dialog, Menu, ipcMain } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootBackend } from './boot.js';
import { readSettings, writeSettings } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new Store();

let settingsWin = null;

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
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '打开知识库文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return;
  switchVault(filePaths[0]);
}

// 返回已保存的 Vault 路径;首启时弹目录选择框。选空则退出。
async function resolveVaultDir() {
  const saved = store.get('vaultDir');
  if (saved) { rememberVault(saved); return saved; }
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择一个文件夹作为你的知识库(Vault)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return null;
  store.set('vaultDir', filePaths[0]);
  rememberVault(filePaths[0]);
  return filePaths[0];
}

// 「打开最近」子菜单:列出除当前库外的最近知识库,点击即切换。
function recentVaultsSubmenu() {
  const current = store.get('vaultDir');
  const recent = (store.get('recentVaults') || []).filter((d) => d && d !== current);
  if (!recent.length) return [{ label: '(暂无)', enabled: false }];
  const items = recent.map((dir) => ({
    label: path.basename(dir),
    toolTip: dir,
    click: () => switchVault(dir),
  }));
  items.push({ type: 'separator' });
  items.push({
    label: '清除最近记录',
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
  settingsWin = new BrowserWindow({
    width: 640,
    height: 720,
    title: '设置',
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
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: openVaultDialog },
        { label: '打开最近', submenu: recentVaultsSubmenu() },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: '设置…', accelerator: 'CmdOrCtrl+,', click: openSettings }, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
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
  const { port } = await bootBackend({ vaultDir, settings });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Wikinest — ${path.basename(vaultDir)}`,
    titleBarStyle: 'hiddenInset', // Mac 上更贴合原生;其它平台自动回退
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 让标题固定显示当前知识库名(否则会被前端页面的 <title> 覆盖)。
  win.on('page-title-updated', (e) => e.preventDefault());
  // `?desktop=1` 让前端知道自己跑在 Electron 里,从而为 macOS 交通灯按钮预留
  // 顶部空间,并把顶栏设为可拖拽窗口的区域(浏览器里此标记无副作用)。
  await win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);

  // 首启且未配置大模型时,自动弹出设置,方便用户立刻填 key 启用 AI 功能。
  if (!settings.LLM_API_KEY) openSettings();
}

// --- IPC:设置窗口读写配置 ---
ipcMain.handle('settings:get', () => readSettings(store));
ipcMain.handle('settings:info', () => ({
  vaultDir: store.get('vaultDir') || '',
  version: app.getVersion(),
}));
ipcMain.handle('settings:save', (_e, data) => {
  writeSettings(store, data);
  // 重启应用,让新配置干净生效(重新注入 env、重建后端与所有模块级单例)。
  app.relaunch();
  app.exit(0);
  return { ok: true };
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
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
