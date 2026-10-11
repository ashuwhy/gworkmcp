# gworkmcp

google docs, sheets, drive, gmail, calendar and apps script as one mcp server. 123 tools, for claude or any mcp client.

my fork of [a-bonus/google-docs-mcp](https://github.com/a-bonus/google-docs-mcp). a-bonus and the upstream contributors built the server. what i added:

- local file attachments on gmail `createDraft` and `updateDraft`, only from folders listed in `GMAIL_ATTACHMENT_ROOTS`
- the account's `from` address in the `createDraft` reply, so you know which inbox the draft landed in
- `getDraft` lists a draft's attachments, the way `getMessage` does
- `updateDraft` keeps a reply draft in its thread when you leave out `replyToMessageId`. upstream moves it to a new one
- a `gworkmcp` command. `google-docs-mcp` still works as an alias

the gmail changes are also open upstream as [a-bonus/google-docs-mcp#167](https://github.com/a-bonus/google-docs-mcp/pull/167).

same login, token file and scopes as upstream, so an existing sign-in carries over.

## setup

not on npm. clone it, build it, install the command:

```bash
git clone https://github.com/ashuwhy/gworkmcp.git
cd gworkmcp && npm ci && npm run build && npm install -g .
```

`npm install -g .` links the clone instead of copying it, so updating is just `git pull && npm run build`.

you need a google cloud oauth client first ([steps below](#google-cloud-oauth-client)). then sign in once:

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... gworkmcp auth
```

the token lands in `~/.config/google-docs-mcp/token.json`.

add it to your client. desktop apps don't load nvm, so take absolute paths from `command -v node` and `command -v gworkmcp`:

```json
{
  "mcpServers": {
    "gworkmcp": {
      "command": "/path/to/node",
      "args": ["/path/to/gworkmcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "...",
        "GOOGLE_CLIENT_SECRET": "...",
        "GMAIL_ATTACHMENT_ROOTS": "/Users/you/gmail-outbox"
      }
    }
  }
}
```

claude code: `claude mcp add-json gworkmcp '<the inner object>' -s user`.

## attachments

`attachments` is a list of absolute paths. a file goes in only if its real path, symlinks resolved, sits under one of the roots.

- unset `GMAIL_ATTACHMENT_ROOTS` means every attachment is refused. off until you opt in
- several roots: separate with `:` (`;` on windows)
- a root that contains your home folder is refused, since it would expose `~/.ssh`. `~/gmail-outbox` works, `~` doesn't
- 18 MB combined per message
- `sendEmail` never attaches. `sendDraft` sends an attachment draft straight away, so keep it behind your client's approval prompt
- not available in remote (`httpStream`) mode

the reasoning behind each rule: [src/tools/gmail/README.md](src/tools/gmail/README.md#attachments).

## tools

| group                           | tools | covers                                                                |
| ------------------------------- | ----: | --------------------------------------------------------------------- |
| [docs](src/tools/docs/)         |    39 | text, formatting, tables, tabs, comments, images, smart chips         |
| [sheets](src/tools/sheets/)     |    44 | ranges, formatting, validation, charts, named tables, comments, notes |
| [drive](src/tools/drive/)       |    16 | search, create, move, copy, rename, share, download                   |
| [gmail](src/tools/gmail/)       |    13 | messages, labels, drafts, inbox triage                                |
| [calendar](src/tools/calendar/) |     5 | list, create, update, delete, quick add                               |
| [script](src/tools/script/)     |     3 | create and edit the apps script behind a doc or sheet                 |
| [utils](src/tools/utils/)       |     3 | markdown into docs: replace the doc, replace a range, append          |

123 tool schemas eat a lot of context. `MCP_TOOL_GROUPS=docs,gmail` registers only those groups.

example prompts: [SAMPLE_TASKS.md](SAMPLE_TASKS.md).

## other env vars

| variable                                          | what it does                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GOOGLE_DOCS_MCP_DOWNLOAD_ROOTS`                  | where `downloadFile` may write, `:`-separated. defaults to the working directory   |
| `GOOGLE_MCP_PROFILE`                              | a second google account. its token goes to `~/.config/google-docs-mcp/<profile>/`  |
| `SERVICE_ACCOUNT_PATH`, `GOOGLE_IMPERSONATE_USER` | service account with domain-wide delegation instead of oauth, for workspace admins |

remote mode (cloud run, mcp oauth 2.1, firestore tokens) is untouched from upstream. [their readme](https://github.com/a-bonus/google-docs-mcp#remote-deployment) has the deploy command and its env vars.

## limits

- `sendEmail` is plain text. html arrives as literal text
- `getMessage` lists attachments but can't download them
- `trashMessage` only trashes. permanent delete needs the full `mail.google.com` scope, which this never asks for
- `updateEvent` and `deleteEvent` hit the whole recurring series unless you pass an instance id from `listEvents` with `singleEvents=true`
- comments made through the api show up in the list but aren't anchored to text in the docs ui
- markdown lists nested 3+ levels deep can come out wrong

## google cloud oauth client

1. [console.cloud.google.com](https://console.cloud.google.com/), new project
2. apis & services > library: turn on docs, sheets, drive, gmail and calendar. add apps script api if you want the script tools
3. oauth consent screen: external, add yourself as a test user, add the scopes `documents`, `spreadsheets`, `drive`, `gmail.modify`, `calendar.events`, `script.projects`, `script.external_request`
4. credentials > create oauth client id > desktop app. copy the id and secret

while the consent screen is in testing, google kills the refresh token 7 days after each sign-in, so `gworkmcp auth` becomes a weekly thing. the script tools also need the apps script api switched on for your account at [script.google.com/home/usersettings](https://script.google.com/home/usersettings).

## dev

```bash
npm run build
npm test
npm run format:check
```

ci runs all three. more in [CONTRIBUTING.md](CONTRIBUTING.md).

## license

mit, see [LICENSE](LICENSE). same license as upstream, and the server underneath is a-bonus's work.
