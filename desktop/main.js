import { app, BrowserWindow, dialog } from 'electron';
import Store from 'electron-store';
import { bootBackend } from './boot.js';

const store = new Store();

// 返回已保存的 Vault 路径;首启时弹目录选择框。选空则退出。
async function resolveVaultDir() {
  const saved = store.get('vaultDir');
  if (saved) return saved;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择一个文件夹作为你的知识库(Vault)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths?.[0]) return null;
  store.set('vaultDir', filePaths[0]);
  return filePaths[0];
}

async function createWindow() {
  const vaultDir = await resolveVaultDir();
  if (!vaultDir) { app.quit(); return; }

  const { port } = await bootBackend({ vaultDir });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset', // Mac 上更贴合原生;其它平台自动回退
    webPreferences: { contextIsolation: true },
  });
  await win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
