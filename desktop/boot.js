import { applySettingsToEnv } from './config.js';

// 在导入后端之前设置 WIKI_CONTENT_DIR —— store.js 在模块加载时读取它。
export async function bootBackend({ vaultDir, settings = {} }) {
  if (!vaultDir || typeof vaultDir !== 'string') {
    throw new Error('vaultDir is required');
  }
  process.env.WIKI_CONTENT_DIR = vaultDir;
  // 桌面单机版:显式清空公网认证,确保本地无门槛访问。
  delete process.env.WIKI_TOKEN;
  delete process.env.WIKI_PASSWORD;
  // 把用户在「设置」里填的 LLM / Embedding / S3 配置注入 env,
  // 让 src/core/* 无需改动就能读到(等价于 web/docker 版的 .env)。
  applySettingsToEnv(settings);
  // 动态 import 确保上面的 env 已生效后才加载后端。
  const { startServer } = await import('../src/web/server.js');
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  return { server, port: server.address().port };
}
