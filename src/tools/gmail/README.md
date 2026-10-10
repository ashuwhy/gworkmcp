# Gmail

Tools for reading, drafting, sending, deleting, organizing, and triaging Gmail messages on the authenticated user's account. Uses the `gmail.modify` OAuth scope, which covers read, send, draft, label changes, and trash but **not** permanent message deletion.

## Messages

| Tool                  | Description                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `listMessages`        | Lists or searches messages using the full Gmail query syntax (e.g. `is:unread from:foo newer_than:7d`)   |
| `getMessage`          | Fetches a single message with decoded headers, plain-text body, HTML body, and attachment metadata       |
| `sendEmail`           | Sends a plain-text email; supports cc/bcc and threaded replies via `replyToMessageId`. No attachments    |
| `trashMessage`        | Moves a message to Trash (reversible from the Gmail UI Trash folder for 30 days). Not a permanent delete |
| `modifyMessageLabels` | Adds and/or removes labels on a message — used for star, archive, mark read, and custom-label tagging    |
| `listLabels`          | Lists all system and user-created Gmail labels with their IDs, for use with the other tools              |

## Drafts (compose / review / send)

| Tool          | Description                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `createDraft` | Creates a draft instead of sending. Use this when an AI composes an email the user should review |
| `listDrafts`  | Lists drafts with recipients, subject, and snippet                                               |
| `getDraft`    | Fetches one draft with full headers and body                                                     |
| `updateDraft` | Replaces a draft's contents (full replace, not patch). Use to iterate before sending             |
| `sendDraft`   | Sends an existing draft by ID — pairs with `createDraft` for the compose-review-send loop        |
| `deleteDraft` | Permanently deletes a draft. Not moved to Trash — gone                                           |

`createDraft` also returns `from`, the address of the account the draft was created in.

## Attachments

`createDraft` and `updateDraft` take one extra parameter. `updateDraft` is a full replace, so pass `attachments` again or the draft loses them.

| Parameter     | Type       | Description                                                                                                                           |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `attachments` | `string[]` | Optional absolute paths of local files to attach. Each must resolve, after symlinks, to a regular file under `GMAIL_ATTACHMENT_ROOTS` |

A tool that reads local files and mails them is an exfiltration channel if a prompt-injected message can steer it, so the boundary is strict:

- Off until you opt in. Set `GMAIL_ATTACHMENT_ROOTS` in the server's `env` to absolute directories, delimited by `:` (`;` on Windows). While it is unset every attachment is refused. A root that contains your home directory (`/`, `/Users`, or the home folder itself) is refused as well, since it would expose `~/.ssh`. Point it at a folder that only holds files you mean to send.
- Each path goes through `realpath` before the check, so `../` and symlinks cannot leave a root. Directories, FIFOs, and missing files are rejected.
- 18,000,000 bytes combined per message, checked with `stat` before anything is read. Gmail refuses messages over 25 MB and base64 adds about a third.
- Messages with attachments go to Gmail's upload endpoint as `message/rfc822` (documented limit 35 MiB). The API reference gives no limit for the `raw` field in a JSON body, so plain-text messages keep using `raw` exactly as before.
- Content-Type comes from the extension: `png`, `jpg`/`jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`, `zip`. Anything else is `application/octet-stream`. Non-ASCII file names use RFC 2231 (`filename*=UTF-8''...`).
- Logs record file names and sizes, never contents.
- `sendEmail` takes no attachments, because nothing reviews it before it goes out. `sendDraft` can still send an attachment draft immediately, so keep it behind your MCP client's approval prompt.
- Unavailable in remote (`httpStream`) mode, where a path would name a file on the shared server.

## Composite triage

| Tool          | Description                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triageInbox` | One call returns N unread messages with full content + per-message heuristic flags (newsletter detection via `List-Unsubscribe`, meeting reference, contains question, action requested) PLUS aggregate stats (top senders, category breakdown). Designed for AI inbox triage in a single round-trip |

## Common label IDs

System labels you can pass to `modifyMessageLabels` and `listMessages.labelIds` without calling `listLabels` first:

- `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`
- `UNREAD`, `STARRED`, `IMPORTANT`
- `CATEGORY_PERSONAL`, `CATEGORY_SOCIAL`, `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`

Custom labels (anything you created in the Gmail UI) have opaque IDs like `Label_1234567890` — fetch them with `listLabels`.
