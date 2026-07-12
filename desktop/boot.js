// 在导入后端之前设置 WIKI_CONTENT_DIR —— store.js 在模块加载时读取它。
export async function bootBackend({ vaultDir }) {
  if (!vaultDir || typeof vaultDir !== 'string') {
    throw new Error('vaultDir is required');
  }
  process.env.WIKI_CONTENT_DIR = vaultDir;
  // 桌面单机版:显式清空公网认证,确保本地无门槛访问。
  delete process.env.WIKI_TOKEN;
  delete process.env.WIKI_PASSWORD;
  // 动态 import 确保上面的 env 已生效后才加载后端。
  const { startServer } = await import('../src/web/server.js');
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  return { server, port: server.address().port };
}
