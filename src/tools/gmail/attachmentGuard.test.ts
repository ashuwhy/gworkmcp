// Tests for the Gmail attachment read boundary. The threat is a prompt-injected
// agent attaching ~/.ssh/id_ed25519, so every way of naming a file outside the
// roots gets a case: absolute path, ../ traversal, symlinked file, symlinked
// directory. Each rejection also has to happen before any file is opened, and
// must not tell the agent whether a file outside the roots exists or where a
// symlink points, or the error itself becomes a probe of the disk.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ATTACHMENT_BYTE_LIMIT, loadAttachments, parseAttachmentRoots } from './attachmentGuard.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let base: string;
let root: string;
let outside: string;
let png: string;
let secret: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-attach-')));
  root = path.join(base, 'outbox');
  outside = path.join(base, 'private');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  png = path.join(root, 'checkout.png');
  secret = path.join(outside, 'id_ed25519');
  fs.writeFileSync(png, PNG);
  fs.writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// For the size-cap cases: if the cap regresses, rejects.toThrow would print the
// resolved 18 MB Buffer in its failure message and stall the run.
async function rejectionMessage(pending: Promise<unknown>): Promise<string | null> {
  return pending.then(
    () => null,
    (error: Error) => error.message
  );
}

afterEach(() => {
  delete process.env.GMAIL_ATTACHMENT_ROOTS;
  delete process.env.MCP_TRANSPORT;
  vi.restoreAllMocks();
});

describe('parseAttachmentRoots', () => {
  it('refuses all attachments while GMAIL_ATTACHMENT_ROOTS is unset', () => {
    delete process.env.GMAIL_ATTACHMENT_ROOTS;
    expect(() => parseAttachmentRoots()).toThrow(/GMAIL_ATTACHMENT_ROOTS is not set/);
  });

  it('treats a blank value as unset', () => {
    expect(() => parseAttachmentRoots(` ${path.delimiter}  `)).toThrow(/not set/);
  });

  it('reads the env var and accepts a delimited list', () => {
    process.env.GMAIL_ATTACHMENT_ROOTS = [root, outside].join(path.delimiter);
    expect(parseAttachmentRoots()).toEqual([root, outside]);
  });

  it('canonicalizes a root reached through a symlink', () => {
    const link = path.join(base, 'outbox-link');
    fs.symlinkSync(root, link, 'dir');
    expect(parseAttachmentRoots(link)).toEqual([root]);
  });

  it('rejects relative entries', () => {
    expect(() => parseAttachmentRoots('outbox')).toThrow(/must be absolute/);
  });

  it.each([['/'], [os.homedir()]])('rejects %s because it contains the home directory', (entry) => {
    expect(() => parseAttachmentRoots(entry)).toThrow(/contains the home directory/);
  });

  it('refuses in httpStream mode, where paths name files on the server', () => {
    process.env.MCP_TRANSPORT = 'httpStream';
    expect(() => parseAttachmentRoots(root)).toThrow(/httpStream/);
  });
});

describe('loadAttachments', () => {
  it('reads a file inside a root', async () => {
    const [file] = await loadAttachments([png], [root]);
    expect(file.filename).toBe('checkout.png');
    expect(file.content.equals(PNG)).toBe(true);
  });

  it('follows a symlink that stays inside the root, keeping the given name', async () => {
    const alias = path.join(root, 'alias.png');
    fs.symlinkSync(png, alias);
    const [file] = await loadAttachments([alias], [root]);
    expect(file.filename).toBe('alias.png');
    expect(file.content.equals(PNG)).toBe(true);
  });

  it('accepts files that add up to exactly the limit', async () => {
    const exact = path.join(root, 'exact.bin');
    fs.writeFileSync(exact, '');
    fs.truncateSync(exact, ATTACHMENT_BYTE_LIMIT);
    const [file] = await loadAttachments([exact], [root]);
    expect(file.content.length).toBe(ATTACHMENT_BYTE_LIMIT);
    fs.rmSync(exact);
  });
});

describe('loadAttachments rejections', () => {
  it('rejects a file outside the roots', async () => {
    await expect(loadAttachments([secret], [root])).rejects.toThrow(
      /not found inside GMAIL_ATTACHMENT_ROOTS/
    );
  });

  it('answers the same whether a file outside the roots exists or not', async () => {
    const missing = path.join(outside, 'id_rsa');
    const existing = await rejectionMessage(loadAttachments([secret], [root]));
    const absent = await rejectionMessage(loadAttachments([missing], [root]));
    expect(absent?.replace(missing, '<path>')).toBe(existing?.replace(secret, '<path>'));
  });

  it('rejects ../ traversal out of a root', async () => {
    const traversal = [root, '..', 'private', 'id_ed25519'].join(path.sep);
    expect(traversal).toContain(`${path.sep}..${path.sep}`);
    await expect(loadAttachments([traversal], [root])).rejects.toThrow(/not found inside/);
  });

  it('rejects a symlinked file that points outside the root without naming the target', async () => {
    const link = path.join(root, 'innocent.png');
    fs.symlinkSync(secret, link);
    const message = await rejectionMessage(loadAttachments([link], [root]));
    expect(message).toMatch(/not found inside GMAIL_ATTACHMENT_ROOTS/);
    expect(message).not.toContain(outside);
  });

  it('rejects a file under a symlinked directory that points outside the root', async () => {
    const linkDir = path.join(root, 'notes');
    fs.symlinkSync(outside, linkDir, 'dir');
    const target = path.join(linkDir, 'id_ed25519');
    expect(target.startsWith(root + path.sep)).toBe(true); // passes a naive prefix check
    await expect(loadAttachments([target], [root])).rejects.toThrow(/not found inside/);
  });

  it('rejects a directory', async () => {
    const dir = path.join(root, 'folder');
    fs.mkdirSync(dir);
    await expect(loadAttachments([dir], [root])).rejects.toThrow(/not a regular file/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking on open', async () => {
    const fifo = path.join(root, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    await expect(loadAttachments([fifo], [root])).rejects.toThrow(/not a regular file/);
  });

  it('rejects a missing file', async () => {
    await expect(loadAttachments([path.join(root, 'nope.png')], [root])).rejects.toThrow(
      /not found/
    );
  });

  it('rejects a relative path', async () => {
    await expect(loadAttachments(['outbox/checkout.png'], [root])).rejects.toThrow(
      /must be absolute/
    );
  });

  it('rejects a file over the limit without opening it', async () => {
    const big = path.join(root, 'huge.zip');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, ATTACHMENT_BYTE_LIMIT + 1);
    const open = vi.spyOn(fsp, 'open');

    expect(await rejectionMessage(loadAttachments([big], [root]))).toContain(
      `${ATTACHMENT_BYTE_LIMIT + 1} bytes, over the ${ATTACHMENT_BYTE_LIMIT}-byte limit`
    );
    expect(open).not.toHaveBeenCalled();
    fs.rmSync(big);
  });

  it('applies the limit to the combined size', async () => {
    const half = path.join(root, 'half.bin');
    fs.writeFileSync(half, '');
    fs.truncateSync(half, ATTACHMENT_BYTE_LIMIT / 2 + 1);
    expect(await rejectionMessage(loadAttachments([half, half], [root]))).toMatch(/over the/);
    fs.rmSync(half);
  });

  it('reads nothing when any path in the set is rejected', async () => {
    const open = vi.spyOn(fsp, 'open');
    await expect(loadAttachments([png, secret], [root])).rejects.toThrow(/not found inside/);
    expect(open).not.toHaveBeenCalled();
  });
});
