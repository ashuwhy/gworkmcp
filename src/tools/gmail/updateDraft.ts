import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getGmailClient } from '../../clients.js';
import { attachmentsParameter, prepareMimeRequest } from './helpers.js';

export function register(server: FastMCP) {
  server.addTool({
    name: 'updateDraft',
    description:
      'Replaces the contents of an existing Gmail draft. The new contents fully overwrite the old draft (this is a full replace, not a patch), attachments included: pass attachments again or the draft loses them. The draft stays in its thread unless replyToMessageId names another message. Use this when iterating on an AI-composed draft before sending.',
    parameters: z.strictObject({
      draftId: z.string().describe('The Gmail draft ID to update.'),
      to: z
        .union([z.string(), z.array(z.string()).min(1)])
        .describe('Recipient email address, or an array of recipient email addresses.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('New plain-text body of the draft.'),
      cc: z.array(z.string()).optional().describe('Optional list of Cc recipients.'),
      bcc: z.array(z.string()).optional().describe('Optional list of Bcc recipients.'),
      replyToMessageId: z
        .string()
        .optional()
        .describe('Optional Gmail message ID to thread the draft with.'),
      attachments: attachmentsParameter,
    }),
    execute: async (args, { log }) => {
      const gmail = await getGmailClient();
      log.info(`Updating Gmail draft ${args.draftId}`);

      try {
        const { message, media, toList, attachments } = await prepareMimeRequest(gmail, args);
        for (const { filename, size } of attachments)
          log.info(`Attaching ${filename} (${size} bytes)`);

        const response = await gmail.users.drafts.update({
          userId: 'me',
          id: args.draftId,
          requestBody: { message },
          ...(media ? { media } : {}),
        });

        return JSON.stringify(
          {
            success: true,
            draftId: response.data.id,
            messageId: response.data.message?.id,
            threadId: response.data.message?.threadId,
            to: toList,
            subject: args.subject,
            attachments,
            message: `Draft ${args.draftId} updated.`,
          },
          null,
          2
        );
      } catch (error: any) {
        log.error(`Error updating draft: ${error.message || error}`);
        if (error.code === 404) throw new UserError(`Draft not found (ID: ${args.draftId}).`);
        if (error.code === 403)
          throw new UserError('Permission denied. Confirm the gmail.modify scope was granted.');
        if (error.code === 400)
          throw new UserError(`Gmail rejected the draft update: ${error.message || 'Bad request'}`);
        throw new UserError(`Failed to update draft: ${error.message || 'Unknown error'}`);
      }
    },
  });
}
