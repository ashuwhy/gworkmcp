import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { ATTACHMENT_BYTE_LIMIT, loadAttachments, parseAttachmentRoots } from './attachmentGuard.js';

export function findHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string | null {
  if (!headers) return null;
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

export function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for any non-ASCII content in headers.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

export function attachmentContentType(filename: string): string {
  return (
    ATTACHMENT_CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
  );
}

/**
 * `name="value"` for printable ASCII, otherwise RFC 2231 `name*=UTF-8''...`.
 * Control characters take the encoded form too, so a filename containing CRLF
 * cannot inject headers.
 */
function mimeParameter(name: string, value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return `${name}="${value.replace(/[\\"]/g, '\\$&')}"`;
  // encodeURIComponent leaves ' ( ) * alone, but RFC 2231 does not allow them unescaped.
  const encoded = encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${name}*=UTF-8''${encoded}`;
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MimeMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: MimeAttachment[];
}

/**
 * Plain text/plain without attachments (unchanged from upstream, byte for
 * byte). With attachments, multipart/mixed: the text part first, then one
 * base64 part per file.
 */
export function buildMimeMessage(opts: MimeMessageOptions): string {
  const attachments = opts.attachments ?? [];
  const boundary = attachments.length > 0 ? `gworkmcp-${randomBytes(16).toString('hex')}` : null;
  const textHeaders = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];

  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(', ')}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${opts.cc.join(', ')}`);
  if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${opts.bcc.join(', ')}`);
  lines.push(`Subject: ${encodeHeader(opts.subject)}`);
  lines.push('MIME-Version: 1.0');
  if (boundary) lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  else lines.push(...textHeaders);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push('');

  if (!boundary) {
    lines.push(opts.body);
    return lines.join('\r\n');
  }

  lines.push(`--${boundary}`, ...textHeaders, '', opts.body);
  for (const attachment of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; ${mimeParameter('name', attachment.filename)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${mimeParameter('filename', attachment.filename)}`,
      '',
      (attachment.content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

export function encodeRawMessage(mime: string): string {
  return Buffer.from(mime, 'utf-8').toString('base64url');
}

/**
 * Fetches the original message and returns the headers needed to build a
 * threaded reply (Message-Id for In-Reply-To, References chain, threadId).
 */
export async function getReplyContext(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<{ threadId: string | undefined; inReplyTo: string | null; references: string | null }> {
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Message-Id', 'References', 'Subject'],
  });
  const threadId = original.data.threadId ?? undefined;
  const origHeaders = original.data.payload?.headers;
  const inReplyTo = findHeaderValue(origHeaders, 'Message-Id');
  const origRefs = findHeaderValue(origHeaders, 'References');
  const references = [origRefs, inReplyTo].filter(Boolean).join(' ') || null;
  return { threadId, inReplyTo, references };
}

export const attachmentsParameter = z
  .array(z.string())
  .optional()
  .describe(
    'Optional absolute paths of local files to attach, such as a screenshot. Only files under ' +
      'the directories in the GMAIL_ATTACHMENT_ROOTS env var can be attached; while it is unset, ' +
      `attachments are refused. Combined limit ${ATTACHMENT_BYTE_LIMIT} bytes.`
  );

export interface DraftRequestArgs {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyToMessageId?: string;
  attachments?: string[];
}

export interface PreparedMimeRequest {
  message: gmail_v1.Schema$Message;
  media?: { mimeType: 'message/rfc822'; body: string };
  toList: string[];
  attachments: Array<{ filename: string; contentType: string; size: number }>;
}

/**
 * Validates and reads attachments, resolves reply threading context (if any),
 * builds the MIME message, and returns the message (plus upload media when
 * there are attachments) ready for messages.send, drafts.create, or
 * drafts.update. Centralizes the compose pipeline so every call site stays in
 * sync on threading, MIME formatting, and the attachment boundary.
 */
export async function prepareMimeRequest(
  gmail: gmail_v1.Gmail,
  args: DraftRequestArgs
): Promise<PreparedMimeRequest> {
  const toList = Array.isArray(args.to) ? args.to : [args.to];
  let threadId: string | undefined;
  let inReplyTo: string | null = null;
  let references: string | null = null;

  // Before any Gmail call, so a rejected path costs no request.
  const files = args.attachments?.length
    ? await loadAttachments(args.attachments, parseAttachmentRoots())
    : [];
  const attachments = files.map(({ filename, content }) => ({
    filename,
    contentType: attachmentContentType(filename),
    content,
  }));

  if (args.replyToMessageId) {
    const ctx = await getReplyContext(gmail, args.replyToMessageId);
    threadId = ctx.threadId;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
  }

  const mime = buildMimeMessage({
    to: toList,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    inReplyTo,
    references,
    attachments,
  });
  const summary = attachments.map(({ filename, contentType, content }) => ({
    filename,
    contentType,
    size: content.length,
  }));

  if (attachments.length === 0) {
    return {
      message: { raw: encodeRawMessage(mime), ...(threadId ? { threadId } : {}) },
      toList,
      attachments: summary,
    };
  }

  // The API reference gives no size limit for `raw` inside a JSON body (one
  // report puts it at 1 MB), while the upload endpoint documents message/* up
  // to 35 MiB, which covers ATTACHMENT_BYTE_LIMIT after base64.
  return {
    message: threadId ? { threadId } : {},
    media: { mimeType: 'message/rfc822', body: mime },
    toList,
    attachments: summary,
  };
}

export function decodeBase64Url(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf-8');
}

/**
 * Walks a Gmail message payload tree and accumulates all text/plain and
 * text/html parts. Returns both representations so callers can pick the
 * one they want (text for processing, html for display).
 */
export function extractMessageBody(payload?: gmail_v1.Schema$MessagePart): {
  text: string;
  html: string;
} {
  let text = '';
  let html = '';
  if (!payload) return { text, html };
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const mime = part.mimeType ?? '';
    if (mime === 'text/plain' && part.body?.data) text += decodeBase64Url(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decodeBase64Url(part.body.data);
    if (part.parts) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return { text, html };
}

export function extractDomain(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<?([^@<>\s]+)@([^>\s]+)>?/);
  return match ? match[2].toLowerCase() : null;
}
