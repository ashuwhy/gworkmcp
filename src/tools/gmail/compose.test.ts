// Entry points that compose mail. Every tool that takes attachments must run
// the same validator before Gmail is called, so a later edit cannot skip it on
// one tool: add a row to `entryPoints` when another tool gains attachments.
// sendEmail goes out with no review and deliberately takes none. getDraft is
// here too, since it is how an agent checks what updateDraft is about to replace.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from 'fastmcp';

vi.mock('../../clients.js', () => ({
  getGmailClient: vi.fn(),
}));

vi.mock('./attachmentGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./attachmentGuard.js')>();
  return { ...actual, loadAttachments: vi.fn(actual.loadAttachments) };
});

import { getGmailClient } from '../../clients.js';
import { loadAttachments } from './attachmentGuard.js';
import { register as registerCreateDraft } from './createDraft.js';
import { register as registerUpdateDraft } from './updateDraft.js';
import { register as registerGetDraft } from './getDraft.js';
import { register as registerSendEmail } from './sendEmail.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const mockLog = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

let root: string;
let png: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-compose-')));
  png = path.join(root, 'checkout.png');
  fs.writeFileSync(png, PNG);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function captureTool(register: (server: any) => void) {
  let tool: any;
  register({ addTool: (config: any) => (tool = config) });
  return tool as {
    parameters: { safeParse: (args: unknown) => { success: boolean; error?: any } };
    execute: (args: any, context: any) => Promise<string>;
  };
}

function createMockGmail() {
  const gmail = {
    users: {
      getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: 'me@example.com' } }),
      drafts: {
        get: vi.fn().mockResolvedValue({
          data: { id: 'r-1', message: { id: 'm-1', threadId: 't-1', payload: { headers: [] } } },
        }),
        create: vi
          .fn()
          .mockResolvedValue({ data: { id: 'r-1', message: { id: 'm-1', threadId: 't-1' } } }),
        update: vi
          .fn()
          .mockResolvedValue({ data: { id: 'r-1', message: { id: 'm-2', threadId: 't-1' } } }),
      },
      messages: {
        get: vi.fn(),
        send: vi.fn().mockResolvedValue({ data: { id: 'm-3', threadId: 't-2', labelIds: [] } }),
      },
    },
  };
  vi.mocked(getGmailClient).mockResolvedValue(gmail as any);
  return gmail;
}

type MockGmail = ReturnType<typeof createMockGmail>;

const entryPoints = [
  {
    name: 'createDraft',
    register: registerCreateDraft,
    extraArgs: {},
    message: {},
    api: (gmail: MockGmail) => gmail.users.drafts.create,
  },
  {
    name: 'updateDraft',
    register: registerUpdateDraft,
    extraArgs: { draftId: 'r-1' },
    message: { threadId: 't-1' },
    api: (gmail: MockGmail) => gmail.users.drafts.update,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.GMAIL_ATTACHMENT_ROOTS;
});

describe.each(entryPoints)('$name attachments', ({ register, extraArgs, message, api }) => {
  const args = () => ({
    ...extraArgs,
    to: 'support@store.example',
    subject: 'Checkout failed',
    body: 'Screenshot attached.',
    attachments: [png],
  });

  it('runs the validator, then uploads the message as message/rfc822', async () => {
    process.env.GMAIL_ATTACHMENT_ROOTS = root;
    const gmail = createMockGmail();

    const result = JSON.parse(await captureTool(register).execute(args(), { log: mockLog }));

    expect(loadAttachments).toHaveBeenCalledWith([png], [root]);
    expect(api(gmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        requestBody: { message },
        media: {
          mimeType: 'message/rfc822',
          body: expect.stringContaining('Content-Type: multipart/mixed; boundary='),
        },
      })
    );
    expect(result.attachments).toEqual([
      { filename: 'checkout.png', contentType: 'image/png', size: PNG.length },
    ]);
  });

  it('fails before any Gmail call when the validator refuses', async () => {
    const gmail = createMockGmail();

    const error = await captureTool(register)
      .execute(args(), { log: mockLog })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toMatch(/GMAIL_ATTACHMENT_ROOTS is not set/);
    expect(api(gmail)).not.toHaveBeenCalled();
    expect(gmail.users.messages.get).not.toHaveBeenCalled();
    expect(gmail.users.drafts.get).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'replaces control characters in a file name, so Gmail shows the name that was sent',
    async () => {
      process.env.GMAIL_ATTACHMENT_ROOTS = root;
      const gmail = createMockGmail();
      const crafted = path.join(root, 'evil\r\nBcc: probe@example.com.png');
      fs.writeFileSync(crafted, PNG);

      const result = JSON.parse(
        await captureTool(register).execute({ ...args(), attachments: [crafted] }, { log: mockLog })
      );

      expect(result.attachments[0].filename).toBe('evil__Bcc: probe@example.com.png');
      expect(api(gmail).mock.calls[0][0].media.body).toContain(
        'filename="evil__Bcc: probe@example.com.png"'
      );
      fs.rmSync(crafted);
    }
  );

  it('logs file names and sizes, never file contents', async () => {
    process.env.GMAIL_ATTACHMENT_ROOTS = root;
    createMockGmail();

    await captureTool(register).execute(args(), { log: mockLog });

    const logged = [...mockLog.info.mock.calls, ...mockLog.error.mock.calls].flat().join('\n');
    expect(logged).toContain(`checkout.png (${PNG.length} bytes)`);
    expect(logged).not.toContain(PNG.toString('base64').slice(0, 24));
    expect(logged).not.toContain(root);
  });
});

describe('createDraft', () => {
  it('sends the same raw request as before when there are no attachments', async () => {
    const gmail = createMockGmail();

    await captureTool(registerCreateDraft).execute(
      { to: 'a@example.com', subject: 'Hi', body: 'Plain.' },
      { log: mockLog }
    );

    expect(loadAttachments).not.toHaveBeenCalled();
    expect(gmail.users.drafts.create).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { message: { raw: expect.any(String) } },
    });
    const { raw } = gmail.users.drafts.create.mock.calls[0][0].requestBody.message;
    expect(Buffer.from(raw, 'base64url').toString('utf-8')).toContain(
      'Content-Type: text/plain; charset="UTF-8"'
    );
  });

  it('returns the From address of the account the draft is in', async () => {
    createMockGmail();

    const result = JSON.parse(
      await captureTool(registerCreateDraft).execute(
        { to: 'a@example.com', subject: 'Hi', body: 'Plain.' },
        { log: mockLog }
      )
    );

    expect(result.from).toBe('me@example.com');
    expect(result.draftId).toBe('r-1');
  });

  it('still reports the created draft when the profile lookup fails', async () => {
    const gmail = createMockGmail();
    gmail.users.getProfile.mockRejectedValue(new Error('quota'));

    const result = JSON.parse(
      await captureTool(registerCreateDraft).execute(
        { to: 'a@example.com', subject: 'Hi', body: 'Plain.' },
        { log: mockLog }
      )
    );

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('r-1');
    expect(result.from).toBeNull();
  });
});

describe('updateDraft threading', () => {
  const update = { draftId: 'r-1', to: 'a@example.com', subject: 'Re: Invoice', body: 'Revised.' };

  it('keeps a reply draft in its thread when replyToMessageId is left out', async () => {
    const gmail = createMockGmail();
    gmail.users.drafts.get.mockResolvedValue({
      data: {
        id: 'r-1',
        message: {
          id: 'm-1',
          threadId: 't-9',
          payload: {
            headers: [
              { name: 'In-Reply-To', value: '<orig@mail.example>' },
              { name: 'References', value: '<first@mail.example> <orig@mail.example>' },
            ],
          },
        },
      },
    });

    await captureTool(registerUpdateDraft).execute(update, { log: mockLog });

    const { message } = gmail.users.drafts.update.mock.calls[0][0].requestBody;
    expect(message.threadId).toBe('t-9');
    const mime = Buffer.from(message.raw, 'base64url').toString('utf-8');
    expect(mime).toContain('In-Reply-To: <orig@mail.example>');
    expect(mime).toContain('References: <first@mail.example> <orig@mail.example>');
  });

  it('threads with replyToMessageId, not the old draft, when one is given', async () => {
    const gmail = createMockGmail();
    gmail.users.messages.get.mockResolvedValue({
      data: {
        threadId: 't-5',
        payload: { headers: [{ name: 'Message-Id', value: '<new@mail.example>' }] },
      },
    });

    await captureTool(registerUpdateDraft).execute(
      { ...update, replyToMessageId: 'm-5' },
      { log: mockLog }
    );

    expect(gmail.users.drafts.get).not.toHaveBeenCalled();
    expect(gmail.users.drafts.update.mock.calls[0][0].requestBody.message.threadId).toBe('t-5');
  });

  it('reports a missing draft without trying to update it', async () => {
    const gmail = createMockGmail();
    gmail.users.drafts.get.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));

    const error = await captureTool(registerUpdateDraft)
      .execute(update, { log: mockLog })
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe('Draft not found (ID: r-1).');
    expect(gmail.users.drafts.update).not.toHaveBeenCalled();
  });
});

describe('getDraft', () => {
  it('lists the attachments on the draft, as getMessage does', async () => {
    const gmail = createMockGmail();
    gmail.users.drafts.get.mockResolvedValue({
      data: {
        id: 'r-1',
        message: {
          id: 'm-1',
          threadId: 't-1',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [{ name: 'Subject', value: 'Checkout failed' }],
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                filename: '',
                body: { data: Buffer.from('See attached.').toString('base64url') },
              },
              {
                partId: '1',
                mimeType: 'image/png',
                filename: 'checkout.png',
                body: { attachmentId: 'att-1', size: 70 },
              },
            ],
          },
        },
      },
    });

    const result = JSON.parse(
      await captureTool(registerGetDraft).execute({ draftId: 'r-1' }, { log: mockLog })
    );

    expect(result.body.text).toBe('See attached.');
    expect(result.attachments).toEqual([
      {
        partId: '1',
        filename: 'checkout.png',
        mimeType: 'image/png',
        size: 70,
        attachmentId: 'att-1',
      },
    ]);
  });
});

describe('sendEmail', () => {
  it('stays plain text: its schema refuses attachments', () => {
    const parsed = captureTool(registerSendEmail).parameters.safeParse({
      to: 'a@example.com',
      subject: 'Hi',
      body: 'Plain.',
      attachments: [png],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['attachments'],
    });
  });

  it('sends the same raw request as before', async () => {
    const gmail = createMockGmail();

    await captureTool(registerSendEmail).execute(
      { to: 'a@example.com', subject: 'Hi', body: 'Plain.' },
      { log: mockLog }
    );

    expect(gmail.users.messages.send).toHaveBeenCalledWith({
      userId: 'me',
      requestBody: { raw: expect.any(String) },
    });
  });
});
