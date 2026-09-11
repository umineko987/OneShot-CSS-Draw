import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

// Pi's auth.json format, without loading any Pi settings or resources.
export class FileCredentials {
  constructor(file) { this.file = file; }

  async load(signal) {
    signal?.throwIfAborted();
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async read(id, { signal } = {}) { return (await this.load(signal))[id]; }
  async list({ signal } = {}) {
    return Object.entries(await this.load(signal)).map(([providerId, value]) => ({ providerId, type: value.type }));
  }

  async update(change, signal) {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // A whole-file lock also protects updates to different providers.
    const release = await lockfile.lock(this.file, {
      realpath: false, retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
    });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const data = await this.load(signal);
      const before = JSON.stringify(data);
      const result = await change(data);
      signal?.throwIfAborted();
      if (JSON.stringify(data) === before) return result;
      await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.file);
      return result;
    } finally {
      await fs.rm(temporary, { force: true });
      await release();
    }
  }

  async modify(id, fn, { signal } = {}) {
    return this.update(async (data) => {
      const next = await fn(data[id]);
      if (next !== undefined) data[id] = next;
      return data[id];
    }, signal);
  }

  async delete(id, { signal } = {}) {
    await this.update((data) => { delete data[id]; }, signal);
  }
}

// Request headers are never logged. Also mask known credentials if an upstream
// error or a tool result happens to echo them.
export function createRedactor() {
  const secrets = new Set();
  const remember = (value) => { if (typeof value === 'string' && value) secrets.add(value); };
  for (const [key, value] of Object.entries(process.env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) remember(value);
  }
  const redact = (text) => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.replaceAll(secret, '[REDACTED]');
      text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
    }
    return text;
  };
  return { remember, redact };
}
