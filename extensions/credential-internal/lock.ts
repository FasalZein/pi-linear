import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactError } from '../redact';

type CredentialLockOwner = { pid: number; token: string };

function invalidCredentialLock(): never {
  throw new Error('Invalid Linear credential lock. Repair or remove it before changing stored credentials.');
}

async function readCredentialLockRecord(lockPath: string, fileName: string): Promise<CredentialLockOwner> {
  const lockStat = await fs.lstat(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!lockStat) throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) invalidCredentialLock();
  const changed = async (): Promise<never> => {
    const current = await fs.lstat(lockPath).catch(() => undefined);
    if (!current || current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
      throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
    }
    invalidCredentialLock();
  };
  const recordPath = path.join(lockPath, fileName);
  const recordStat = await fs.lstat(recordPath).catch(() => undefined);
  if (!recordStat) return changed();
  if (!recordStat.isFile() || recordStat.isSymbolicLink()) invalidCredentialLock();
  let record: unknown;
  try {
    record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return changed();
    invalidCredentialLock();
  }
  const current = await fs.lstat(lockPath).catch(() => undefined);
  if (!current || current.dev !== lockStat.dev || current.ino !== lockStat.ino) {
    throw Object.assign(new Error('Credential lock changed.'), { code: 'ENOENT' });
  }
  if (!isRecord(record) || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 || typeof record.token !== 'string') {
    invalidCredentialLock();
  }
  return { pid: Number(record.pid), token: record.token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCredentialLockOwner(lockPath: string): Promise<CredentialLockOwner> {
  return readCredentialLockRecord(lockPath, 'owner.json');
}

function readCredentialRecoveryClaim(lockPath: string): Promise<CredentialLockOwner> {
  return readCredentialLockRecord(lockPath, 'recovery.json');
}

function ownerProcessIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

async function moveAndRemoveCredentialLock(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const movedPath = `${lockPath}.remove-${process.pid}-${randomUUID()}`;
  await fs.rename(lockPath, movedPath);
  const moved = await readCredentialLockOwner(movedPath);
  if (moved.pid !== expected.pid || moved.token !== expected.token) invalidCredentialLock();
  await fs.rm(movedPath, { recursive: true });
}

function sameCredentialLockOwner(left: CredentialLockOwner, right: CredentialLockOwner): boolean {
  return left.pid === right.pid && left.token === right.token;
}

async function restoreCredentialRecoveryClaim(movedPath: string, recoveryPath: string): Promise<void> {
  try {
    await fs.link(movedPath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
  }
  await fs.rm(movedPath, { force: true });
}

async function removeCredentialRecoveryClaim(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const recoveryPath = path.join(lockPath, 'recovery.json');
  const movedName = `recovery.remove-${process.pid}-${randomUUID()}.json`;
  const movedPath = path.join(lockPath, movedName);
  try {
    await fs.rename(recoveryPath, movedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readCredentialLockRecord(lockPath, movedName).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!moved || sameCredentialLockOwner(moved, expected)) {
    await fs.rm(movedPath, { force: true });
    return;
  }
  await restoreCredentialRecoveryClaim(movedPath, recoveryPath);
}

async function recoverCredentialLock(lockPath: string, expected: CredentialLockOwner): Promise<void> {
  const recoveryPath = path.join(lockPath, 'recovery.json');
  const recovery = { pid: process.pid, token: randomUUID() };
  try {
    await fs.writeFile(recoveryPath, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: CredentialLockOwner;
    try {
      existing = await readCredentialRecoveryClaim(lockPath);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw readError;
    }
    if (!ownerProcessIsGone(existing.pid)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return;
    }
    let current: CredentialLockOwner;
    try {
      current = await readCredentialLockOwner(lockPath);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw readError;
    }
    if (!sameCredentialLockOwner(current, expected) || !ownerProcessIsGone(current.pid)) return;

    const abandonedName = `recovery.abandoned-${process.pid}-${randomUUID()}.json`;
    const abandonedPath = path.join(lockPath, abandonedName);
    try {
      await fs.rename(recoveryPath, abandonedPath);
    } catch (moveError) {
      if ((moveError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw moveError;
    }
    const abandoned = await readCredentialLockRecord(lockPath, abandonedName).catch((readError) => {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw readError;
    });
    if (!abandoned) return;
    if (!sameCredentialLockOwner(abandoned, existing)) {
      await restoreCredentialRecoveryClaim(abandonedPath, recoveryPath);
      return;
    }
    try {
      await fs.writeFile(recoveryPath, JSON.stringify(recovery), { flag: 'wx', mode: 0o600 });
    } catch (claimError) {
      await fs.rm(abandonedPath, { force: true });
      if ((claimError as NodeJS.ErrnoException).code === 'EEXIST' || (claimError as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw claimError;
    }
    await fs.rm(abandonedPath, { force: true });
  }

  let current: CredentialLockOwner;
  let claim: CredentialLockOwner;
  try {
    [current, claim] = await Promise.all([readCredentialLockOwner(lockPath), readCredentialRecoveryClaim(lockPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!sameCredentialLockOwner(current, expected) || !ownerProcessIsGone(current.pid) || !sameCredentialLockOwner(claim, recovery)) {
    await removeCredentialRecoveryClaim(lockPath, recovery);
    return;
  }
  await moveAndRemoveCredentialLock(lockPath, expected);
}

export async function withCredentialLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  const owner = { pid: process.pid, token: randomUUID() };
  await fs.mkdir(directory, { recursive: true });

  while (true) {
    const candidate = `${lockPath}-${owner.pid}-${randomUUID()}`;
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      await fs.rename(candidate, lockPath);
      break;
    } catch (error) {
      await fs.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') invalidCredentialLock();
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw redactError(error);
      let existing: CredentialLockOwner;
      try {
        existing = await readCredentialLockOwner(lockPath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw redactError(readError);
      }
      if (ownerProcessIsGone(existing.pid)) {
        await recoverCredentialLock(lockPath, existing);
        continue;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  try {
    return await work();
  } finally {
    const current = await readCredentialLockOwner(lockPath);
    if (current.pid !== owner.pid || current.token !== owner.token) invalidCredentialLock();
    await moveAndRemoveCredentialLock(lockPath, owner);
  }
}
