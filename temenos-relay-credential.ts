import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { debuglog } from 'node:util';

export class TemenosCredentialError extends Error {
  constructor() { super('Configure TEMENOS_BLOCKFROST_PREPROD_TOKEN_FILE with an owner-only mode 600 token file'); }
}

/** Server-only, lazy and bounded. Never expose the path, token or native fs errors. */
export function readTemenosTokenFile(path: string | undefined): string {
  let fd: number | undefined;
  try {
    // Native HTTP(S) debug output can print outgoing authentication headers.
    if (debuglog('http').enabled || debuglog('https').enabled) throw new TemenosCredentialError();
    if (!path || !isAbsolute(path)) throw new TemenosCredentialError();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o7777) !== 0o600 || info.uid !== process.getuid?.() || info.size > 512 || info.size < 16) {
      throw new TemenosCredentialError();
    }
    // A file growing after fstat must not turn this into an unbounded read.
    const bytes = Buffer.alloc(513);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 512) throw new TemenosCredentialError();
    const token = bytes.subarray(0, length).toString('utf8').replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new TemenosCredentialError();
    return token;
  } catch { throw new TemenosCredentialError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
