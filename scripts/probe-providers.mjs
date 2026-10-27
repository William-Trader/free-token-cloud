#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 15000);
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);

async function probe(provider) {
  const started = Date.now();
  try {
    const response = await fetch(provider.healthUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    await response.body?.cancel();
    const status = response.status;
    let result = 'failed';
    if (status >= 200 && status < 400) result = 'public';
    else if ([401, 403].includes(status)) result = 'auth-required';
    else if (status === 429) result = 'rate-limited';
    else if ([400, 404, 405].includes(status)) result = 'unverified';
    return {
      id: provider.id,
      result,
      status,
      latency_ms: Date.now() - started,
      health_url: provider.healthUrl
    };
  } catch (error) {
    return {
      id: provider.id,
      result: 'unreachable',
      status: null,
      latency_ms: Date.now() - started,
      health_url: provider.healthUrl,
      error: String(error.message || error)
    };
  }
}

const providers = config.providers.filter(provider =>
  provider.healthUrl && (!only || provider.id === only)
);
const results = [];
for (const provider of providers) {
  results.push(await probe(provider));
}

const summary = {
  checked: results.length,
  public: results.filter(item => item.result === 'public').length,
  authRequired: results.filter(item => item.result === 'auth-required').length,
  rateLimited: results.filter(item => item.result === 'rate-limited').length,
  unverified: results.filter(item => item.result === 'unverified').length,
  failed: results.filter(item => ['failed', 'unreachable'].includes(item.result)).length,
  results
};

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
if (summary.failed) process.exitCode = 1;
