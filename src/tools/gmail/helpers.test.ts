// Tests for the Gmail MIME builder. Without attachments the output must stay
// byte for byte what 1.11.3 produced: the expected strings below were
// captured from that build. With attachments it becomes
// multipart/mixed with the text part first.

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { attachmentContentType, buildMimeMessage } from './helpers.js';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function parseMultipart(mime: string) {
  const headerEnd = mime.indexOf('\r\n\r\n');
  const headers = mime.slice(0, headerEnd).split('\r\n');
  const boundary = mime.match(/^Content-Type: multipart\/mixed; boundary="([^"]+)"$/m)?.[1];
  if (!boundary) throw new Error('no multipart/mixed boundary in the top-level headers');

  const body = mime.slice(headerEnd + 4);
  const closing = `--${boundary}--\r\n`;
  expect(body.endsWith(closing)).toBe(true);

  const [preamble, ...chunks] = body.slice(0, -closing.length).split(`--${boundary}\r\n`);
  expect(preamble).toBe('');
  const parts = chunks.map((chunk) => {
    expect(chunk.endsWith('\r\n')).toBe(true);
    const end = chunk.indexOf('\r\n\r\n');
    return { headers: chunk.slice(0, end).split('\r\n'), content: chunk.slice(end + 4, -2) };
  });
  return { boundary, headers, parts };
}

function decodeBase64Part(content: string): Buffer {
  for (const line of content.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
  return Buffer.from(content.replace(/\r\n/g, ''), 'base64');
}

describe('buildMimeMessage without attachments', () => {
  const before = {
    minimal: {
      opts: {
        to: ['support@store.example'],
        subject: 'Checkout failed',
        body: 'Hi,\nThe card step errors out.',
      },
      expected: [
        'To: support@store.example',
        'Subject: Checkout failed',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        'Hi,\nThe card step errors out.',
      ].join('\r\n'),
    },
    threaded: {
      opts: {
        to: ['a@example.com', 'b@example.com'],
        cc: ['c@example.com'],
        bcc: ['d@example.com'],
        subject: 'Ré: commande №42',
        body: 'Line one\r\nLine two ünïcödé',
        inReplyTo: '<orig@mail.example>',
        references: '<root@mail.example> <orig@mail.example>',
      },
      expected: [
        'To: a@example.com, b@example.com',
        'Cc: c@example.com',
        'Bcc: d@example.com',
        'Subject: =?UTF-8?B?UsOpOiBjb21tYW5kZSDihJY0Mg==?=',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        'In-Reply-To: <orig@mail.example>',
        'References: <root@mail.example> <orig@mail.example>',
        '',
        'Line one\r\nLine two ünïcödé',
      ].join('\r\n'),
    },
    emptyLists: {
      opts: { to: ['a@example.com'], cc: [], bcc: [], subject: '', body: '' },
      expected: [
        'To: a@example.com',
        'Subject: ',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        '',
      ].join('\r\n'),
    },
  };

  it.each(Object.entries(before))('matches the 1.11.3 output: %s', (_, { opts, expected }) => {
    expect(buildMimeMessage(opts)).toBe(expected);
  });

  it.each(Object.entries(before))(
    'treats an empty attachments array as none: %s',
    (_, { opts, expected }) => {
      expect(buildMimeMessage({ ...opts, attachments: [] })).toBe(expected);
    }
  );
});

describe('buildMimeMessage with attachments', () => {
  it('puts the text part first and the PNG second, base64 at 76 columns', () => {
    const mime = buildMimeMessage({
      to: ['support@store.example'],
      subject: 'Checkout failed',
      body: 'Screenshot attached.',
      attachments: [{ filename: 'checkout.png', contentType: 'image/png', content: PNG }],
    });
    const { boundary, headers, parts } = parseMultipart(mime);

    expect(headers).toEqual([
      'To: support@store.example',
      'Subject: Checkout failed',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      headers: ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit'],
      content: 'Screenshot attached.',
    });
    expect(parts[1].headers).toEqual([
      'Content-Type: image/png; name="checkout.png"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="checkout.png"',
    ]);
    expect(decodeBase64Part(parts[1].content).equals(PNG)).toBe(true);
  });

  it('adds one part per file and each decodes back to its bytes', () => {
    const pdf = randomBytes(1000);
    const mime = buildMimeMessage({
      to: ['a@example.com'],
      subject: 'Two files',
      body: 'See attached.',
      inReplyTo: '<orig@mail.example>',
      references: '<orig@mail.example>',
      attachments: [
        { filename: 'checkout.png', contentType: 'image/png', content: PNG },
        { filename: 'receipt.pdf', contentType: 'application/pdf', content: pdf },
      ],
    });
    const { boundary, headers, parts } = parseMultipart(mime);

    expect(headers).toContain('In-Reply-To: <orig@mail.example>');
    expect(headers).toContain('References: <orig@mail.example>');
    expect(parts).toHaveLength(3);
    expect(parts[2].headers[0]).toBe('Content-Type: application/pdf; name="receipt.pdf"');

    // 1000 bytes is 1336 base64 characters: 17 full lines of 76 and one of 44.
    const lines = parts[2].content.split('\r\n');
    expect(lines).toHaveLength(18);
    expect(lines.slice(0, -1).every((line) => line.length === 76)).toBe(true);
    expect(decodeBase64Part(parts[1].content).equals(PNG)).toBe(true);
    expect(decodeBase64Part(parts[2].content).equals(pdf)).toBe(true);

    expect(parts.some((part) => part.content.includes(boundary))).toBe(false);
  });

  it('uses a fresh boundary per message', () => {
    const opts = {
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
      attachments: [{ filename: 'a.png', contentType: 'image/png', content: PNG }],
    };
    expect(parseMultipart(buildMimeMessage(opts)).boundary).not.toBe(
      parseMultipart(buildMimeMessage(opts)).boundary
    );
  });

  it('encodes a non-ASCII filename with RFC 2231', () => {
    const filename = "Résumé (final) l'été*.pdf";
    const mime = buildMimeMessage({
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
      attachments: [{ filename, contentType: 'application/pdf', content: PNG }],
    });
    const [, attachment] = parseMultipart(mime).parts;

    const disposition = attachment.headers[2].match(
      /^Content-Disposition: attachment; filename\*=UTF-8''(.+)$/
    );
    const name = attachment.headers[0].match(
      /^Content-Type: application\/pdf; name\*=UTF-8''(.+)$/
    );
    expect(disposition?.[1]).toMatch(/^[A-Za-z0-9%!._~-]+$/);
    expect(decodeURIComponent(disposition![1])).toBe(filename);
    expect(decodeURIComponent(name![1])).toBe(filename);
  });

  it('escapes quotes and cannot be used to inject headers through a filename', () => {
    const mime = buildMimeMessage({
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
      attachments: [
        { filename: 'say "hi".txt', contentType: 'text/plain', content: PNG },
        { filename: 'x.png\r\nBcc: attacker@example.com', contentType: 'image/png', content: PNG },
      ],
    });
    const { parts } = parseMultipart(mime);

    expect(parts[1].headers[2]).toBe(
      'Content-Disposition: attachment; filename="say \\"hi\\".txt"'
    );
    expect(mime.split('\r\n')).not.toContain('Bcc: attacker@example.com');
    expect(parts[2].headers[2]).toBe(
      "Content-Disposition: attachment; filename*=UTF-8''x.png%0D%0ABcc%3A%20attacker%40example.com"
    );
  });
});

describe('attachmentContentType', () => {
  it.each([
    ['checkout.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.jpeg', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['shot.webp', 'image/webp'],
    ['receipt.pdf', 'application/pdf'],
    ['notes.txt', 'text/plain'],
    ['orders.csv', 'text/csv'],
    ['logs.zip', 'application/zip'],
    ['SCREENSHOT.PNG', 'image/png'],
    ['backup.tar.gz', 'application/octet-stream'],
    ['id_ed25519', 'application/octet-stream'],
    ['.png', 'application/octet-stream'],
  ])('%s -> %s', (filename, expected) => {
    expect(attachmentContentType(filename)).toBe(expected);
  });
});
