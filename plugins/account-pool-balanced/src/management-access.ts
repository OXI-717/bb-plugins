import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ManagementGrant, ManagementScope } from './management-wire.js';

export class PoolManagementLocked extends Error {
  readonly code = 'pool-management-locked';
  constructor() { super('Pool management is locked. An operator-issued access grant is required.'); }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_GRANTS = 64;

export class ManagementAccess {
  private rootHash: string | null = null;
  private readonly grants = new Map<string, Omit<ManagementGrant, 'token'>>();
  private failedAttempts: number[] = [];
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    this.rootHash = null;
    this.grants.clear();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new PoolManagementLocked();
    const filename = path.join(this.directory, 'operator.env');
    try {
      const file = await fs.open(filename, 'wx', 0o600);
      try { await file.writeFile(`POOL_MANAGEMENT_KEY=${randomBytes(32).toString('base64url')}\n`); }
      finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 256) throw new PoolManagementLocked();
      const match = /^POOL_MANAGEMENT_KEY=([A-Za-z0-9_-]{43})\n?$/.exec(await file.readFile('utf8'));
      if (!match) throw new PoolManagementLocked();
      this.rootHash = digest(match[1]!);
    } finally { await file.close(); }
  }

  unlock(key: string, scope: ManagementScope = 'manage', ttlSeconds = 900): ManagementGrant {
    const now = this.now();
    this.failedAttempts = this.failedAttempts.filter(time => now - time < 300_000);
    if (this.failedAttempts.length >= 5) throw new PoolManagementLocked();
    if (!this.rootHash || typeof key !== 'string' || key.length > 256 || !timingSafeEqual(Buffer.from(digest(key), 'hex'), Buffer.from(this.rootHash, 'hex'))) {
      this.failedAttempts.push(now);
      throw new PoolManagementLocked();
    }
    if (!['read', 'manage'].includes(scope) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) throw new PoolManagementLocked();
    this.prune();
    if (this.grants.size >= MAX_GRANTS) throw new PoolManagementLocked();
    const grant = { token: randomBytes(32).toString('base64url'), scope, expiresAt: now + ttlSeconds * 1000 };
    this.grants.set(digest(grant.token), { scope, expiresAt: grant.expiresAt });
    return grant;
  }

  assert(token: string | undefined, scope: ManagementScope): void {
    this.prune();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new PoolManagementLocked();
    const grant = this.grants.get(digest(token));
    if (!grant || (scope === 'manage' && grant.scope !== 'manage')) throw new PoolManagementLocked();
  }

  revoke(token: string): void {
    this.assert(token, 'read');
    this.grants.delete(digest(token));
  }

  close(): void {
    this.grants.clear();
    this.rootHash = null;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
  }
}
