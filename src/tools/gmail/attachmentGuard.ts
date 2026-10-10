// Read boundary for Gmail attachments.
//
// createDraft and updateDraft read local files and mail them, on behalf of an
// agent that routinely reads untrusted content (inbox messages, Docs, web
// pages). Unconstrained, one injected instruction turns them into an
// exfiltration channel for ~/.ssh or ~/.aws. Reads are confined to directories
// the operator lists in GMAIL_ATTACHMENT_ROOTS, and attachments are refused
// outright while it is unset. Same canonicalize-then-compare approach as
// drive/savePathGuard.ts, but fail-closed rather than defaulting to the cwd.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Gmail refuses messages over 25 MB. Base64 grows a file by 4/3 and the CRLF
// every 76 characters adds another 2.6%, so 18,000,000 raw bytes encode to
// about 24.63 MB: under the limit whether Gmail counts in MB or MiB.
export const ATTACHMENT_BYTE_LIMIT = 18_000_000;

export interface AttachmentFile {
  filename: string;
  content: Buffer;
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function canonicalize(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Parses GMAIL_ATTACHMENT_ROOTS: absolute directories, delimited by `:` (`;` on
 * Windows), that attachments may be read from. Returns them canonicalized, so a
 * root behind a symlink (macOS `/tmp` -> `/private/tmp`) still compares.
 *
 * @throws Error when unset, in remote mode, or when an entry is relative or
 *   covers the home directory.
 */
export function parseAttachmentRoots(value = process.env.GMAIL_ATTACHMENT_ROOTS): string[] {
  if (process.env.MCP_TRANSPORT === 'httpStream') {
    // In remote mode a path names a file on the shared server, not the caller's machine.
    throw new Error('Attachments are not available when the server runs in httpStream mode.');
  }

  const entries = (value ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(
      'Attachments are disabled because GMAIL_ATTACHMENT_ROOTS is not set. Set it in the MCP ' +
        'server env to the absolute directories attachments may be read from, delimited by ":" ' +
        '(";" on Windows).'
    );
  }

  const home = canonicalize(os.homedir());
  return entries.map((entry) => {
    if (!path.isAbsolute(entry)) {
      throw new Error(`GMAIL_ATTACHMENT_ROOTS entries must be absolute paths, got "${entry}".`);
    }
    const root = canonicalize(entry);
    if (isInside(home, root)) {
      throw new Error(
        `GMAIL_ATTACHMENT_ROOTS entry "${entry}" contains the home directory, which would expose ` +
          'SSH keys and cloud credentials. List a folder that holds only files meant to be sent.'
      );
    }
    return root;
  });
}

/**
 * Checks every path against the roots and the size cap, then reads them.
 * Nothing is read until all paths pass, so a rejected set costs no file reads.
 *
 * Comparison happens after realpath, which rejects `../` traversal and
 * symlinks that point out of a root alike.
 *
 * @throws Error naming the offending path.
 */
export async function loadAttachments(
  filePaths: string[],
  roots: string[]
): Promise<AttachmentFile[]> {
  const checked: Array<{ filePath: string; realPath: string; stat: fs.Stats }> = [];

  for (const filePath of filePaths) {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`Attachment paths must be absolute, got "${filePath}".`);
    }

    let realPath: string;
    try {
      realPath = await fsp.realpath(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') throw new Error(`Attachment not found: "${filePath}".`);
      throw new Error(`Cannot resolve attachment "${filePath}": ${error.code || error.message}.`);
    }

    if (!roots.some((root) => isInside(realPath, root))) {
      throw new Error(
        `Attachment "${filePath}" resolves to "${realPath}", which is outside ` +
          `GMAIL_ATTACHMENT_ROOTS (${roots.map((root) => `"${root}"`).join(', ')}).`
      );
    }

    // Checked before open(): opening a FIFO blocks until a writer shows up.
    const stat = await fsp.stat(realPath);
    if (!stat.isFile()) {
      throw new Error(`Attachment "${filePath}" is not a regular file.`);
    }
    checked.push({ filePath, realPath, stat });
  }

  const total = checked.reduce((sum, file) => sum + file.stat.size, 0);
  if (total > ATTACHMENT_BYTE_LIMIT) {
    throw new Error(
      `Attachments total ${total} bytes, over the ${ATTACHMENT_BYTE_LIMIT}-byte limit per ` +
        'message (Gmail refuses messages over 25 MB once base64 encoded).'
    );
  }

  return Promise.all(
    checked.map(async ({ filePath, realPath, stat }) => {
      // O_NOFOLLOW plus the inode and length checks pin the read to the file
      // that passed the checks above, not one swapped in or grown since.
      const handle = await fsp.open(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        const content =
          opened.ino === stat.ino && opened.dev === stat.dev ? await handle.readFile() : null;
        if (!content || content.length !== stat.size) {
          throw new Error(`Attachment "${filePath}" changed while it was being read.`);
        }
        return { filename: path.basename(filePath), content };
      } finally {
        await handle.close();
      }
    })
  );
}
