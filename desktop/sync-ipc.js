import { createS3Adapter } from '../src/core/sync/s3-client.js';
import { openSyncMeta } from '../src/core/sync/crypto.js';

const PAYLOAD_FIELDS = Object.freeze([
  'enabled',
  'bucket',
  'prefix',
  'endpoint',
  'region',
  'forcePathStyle',
  'accessKeyId',
  'secretAccessKey',
  'password',
  'clearSecretAccessKey',
  'clearPassword',
]);

function isNotFound(error) {
  return error?.code === 'NotFound'
    || error?.code === 'NoSuchKey'
    || error?.name === 'NotFound'
    || error?.name === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404
    || error?.statusCode === 404;
}

function allowedPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sync payload must be an object');
  }
  const unknown = Object.keys(value).filter((field) => !PAYLOAD_FIELDS.includes(field));
  if (unknown.length) throw new Error(`sync payload has invalid field: ${unknown[0]}`);
  for (const field of ['clearSecretAccessKey', 'clearPassword']) {
    if (field in value && typeof value[field] !== 'boolean') {
      throw new TypeError(`${field} must be a boolean`);
    }
  }
  return Object.fromEntries(PAYLOAD_FIELDS.filter((field) => field in value).map((field) => [
    field,
    value[field],
  ]));
}

function s3Config(config) {
  return {
    bucket: config.bucket,
    prefix: config.prefix,
    endpoint: config.endpoint || undefined,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
}

export async function validateRemoteSyncConfig(config, {
  createRemote = createS3Adapter,
} = {}) {
  const remote = createRemote(s3Config(config));
  await remote.testConnection();
  let body;
  try {
    body = await remote.get('v1/meta.json');
  } catch (error) {
    if (isNotFound(error)) return { ok: true, mode: 'uninitialized' };
    throw error;
  }
  let meta;
  try {
    meta = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch (error) {
    throw new Error('invalid remote metadata JSON', { cause: error });
  }
  const opened = await openSyncMeta(meta, config.password);
  return { ok: true, mode: opened.meta.encrypted ? 'encrypted' : 'plaintext' };
}

function restorationInput(config) {
  return {
    ...config,
    clearSecretAccessKey: !config.secretAccessKey,
    clearPassword: !config.password,
  };
}

export function createSyncIpcHandlers({
  ipcMain,
  getVaultDir,
  repository,
  runtime,
  validate = validateRemoteSyncConfig,
  assertTrustedSender = () => {},
} = {}) {
  let saveTransaction = Promise.resolve();
  const vaultDir = () => {
    const value = getVaultDir();
    if (typeof value !== 'string' || !value) throw new Error('no active vault');
    return value;
  };

  ipcMain.handle('sync:get', (event) => {
    assertTrustedSender(event);
    return {
      ...repository.readForRenderer(vaultDir()),
      status: runtime.getStatus(),
    };
  });

  ipcMain.handle('sync:test', async (event, payload) => {
    assertTrustedSender(event);
    const candidate = repository.preview(vaultDir(), allowedPayload(payload));
    return validate(candidate);
  });

  ipcMain.handle('sync:save', (event, payload) => {
    assertTrustedSender(event);
    const clean = allowedPayload(payload);
    const transaction = saveTransaction.then(async () => {
      const activeVault = vaultDir();
      const previous = repository.read(activeVault);
      const candidate = repository.preview(activeVault, clean);
      if (candidate.enabled) await validate(candidate);
      repository.save(activeVault, clean);
      try {
        await runtime.reconfigure({ vaultDir: activeVault, config: candidate });
      } catch (error) {
        const rollbackErrors = [];
        try {
          repository.save(activeVault, restorationInput(previous));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await runtime.reconfigure({ vaultDir: activeVault, config: previous });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            'sync save failed and rollback was incomplete',
          );
        }
        throw error;
      }
      return {
        ok: true,
        config: repository.readForRenderer(activeVault),
        status: runtime.getStatus(),
      };
    });
    saveTransaction = transaction.catch(() => {});
    return transaction;
  });

  ipcMain.handle('sync:now', async (event) => {
    assertTrustedSender(event);
    return {
      ok: true,
      result: await runtime.syncNow(),
      status: runtime.getStatus(),
    };
  });
}
