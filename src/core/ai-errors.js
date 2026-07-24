const KINDS = new Set(['http', 'timeout', 'network', 'interrupted']);
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

class AiUpstreamError extends Error {
  constructor(kind, metadata = {}) {
    super('AI upstream request failed');
    this.kind = KINDS.has(kind) ? kind : 'unknown';

    if (Number.isInteger(metadata.status) && metadata.status >= 100 && metadata.status <= 599) {
      this.status = metadata.status;
    }
    if (
      typeof metadata.providerCode === 'string'
      && PROVIDER_CODE_PATTERN.test(metadata.providerCode)
    ) {
      this.providerCode = metadata.providerCode;
    }
    if (
      Number.isInteger(metadata.retryAfterSeconds)
      && metadata.retryAfterSeconds >= 0
    ) {
      this.retryAfterSeconds = metadata.retryAfterSeconds;
    }
  }
}

export function createAiUpstreamError(kind, metadata) {
  return new AiUpstreamError(kind, metadata);
}

export function classifyAiError(error) {
  if (!(error instanceof AiUpstreamError)) return { code: 'AI_FAILED' };

  let code = 'AI_FAILED';
  const providerCode = error.providerCode?.toLowerCase();
  if (
    error.status === 429
    || providerCode === 'limit_requests'
    || providerCode?.includes('rate_limit')
  ) {
    code = 'RATE_LIMITED';
  } else if (error.status === 401 || error.status === 403) {
    code = 'AUTH_FAILED';
  } else if (
    providerCode === 'model_not_found'
    || providerCode === 'modelnotfound'
    || providerCode === 'invalid_model'
  ) {
    code = 'MODEL_NOT_FOUND';
  } else if (error.status === 400 || error.status === 422) {
    code = 'REQUEST_INVALID';
  } else if (error.kind === 'timeout') {
    code = 'UPSTREAM_TIMEOUT';
  } else if (error.kind === 'network') {
    code = 'NETWORK_ERROR';
  } else if (error.kind === 'interrupted') {
    code = 'STREAM_INTERRUPTED';
  }

  return {
    code,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

export function toPublicAiError(error, requestId) {
  const classified = classifyAiError(error);
  return {
    code: classified.code,
    requestId,
    ...(classified.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: classified.retryAfterSeconds }
      : {}),
  };
}
