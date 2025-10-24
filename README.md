# Mail MCP Server

A Model Context Protocol (MCP) server for SMTP and IMAP-based email handling. This server enables AI assistants to send and read emails, manage mailboxes, and handle email configurations securely.

## Features

### Sending Emails (SMTP)
- **Send Emails**: Send emails with HTML/plain text content, attachments, and CC/BCC support
- **Connection Verification**: Test SMTP connection and authentication
- **Configuration Testing**: Test custom SMTP configurations without modifying server settings

### Reading Emails (IMAP)

- **Fetch Emails**: Retrieve emails from any mailbox with filtering options
- **Search Emails**: Simple search by subject, sender, or content
- **Advanced Search**: Complex queries with multiple criteria (sender, recipient, date range, size, flags)
- **List Mailboxes**: Browse all available folders/mailboxes
- **Mark Emails**: Mark emails as read/unread or flagged/unflagged

### Email Organization

- **Create/Delete Mailboxes**: Manage folder structure
- **Move Messages**: Organize emails between folders
- **Copy Messages**: Duplicate emails to multiple folders
- **Save Drafts**: Store draft emails for later editing

### Advanced Features

- **Thread View**: Get entire conversation threads with chronological ordering
- **Download Attachments**: Retrieve specific attachments with base64 encoding
- **Message Relationships**: Track reply chains via Message-ID, In-Reply-To, and References headers

### Security

- **Secure**: All credentials managed via environment variables
- **TLS Support**: Encrypted connections for both SMTP and IMAP

## Installation

```bash
npm install
npm run build
```

## Configuration

### Required Environment Variables

```bash
# SMTP Configuration (for sending emails)
export SMTP_HOST="smtp.gmail.com"          # SMTP server hostname
export SMTP_PORT="587"                      # SMTP server port (587 or 465)
export SMTP_USER="your-email@gmail.com"    # SMTP username
export SMTP_PASS="your-app-password"       # SMTP password
export SMTP_FROM="your-email@gmail.com"    # (Optional) Default sender address
export SMTP_SECURE="false"                 # (Optional) Use TLS (true for port 465)
```

### Optional IMAP Configuration (for reading emails)

If not provided, IMAP settings default to SMTP values:

```bash
export IMAP_HOST="imap.gmail.com"          # IMAP server (defaults to SMTP_HOST)
export IMAP_PORT="993"                      # IMAP port (default: 993)
export IMAP_USER="your-email@gmail.com"    # IMAP username (defaults to SMTP_USER)
export IMAP_PASS="your-app-password"       # IMAP password (defaults to SMTP_PASS)
export IMAP_TLS="true"                     # Use TLS (default: true)
```

## Usage

### Running the Server

#### Stdio Transport (Default)

For use with Claude Desktop or other stdio-based clients:

```bash
# Without .env
npm run dev

# With .env file
npm run dev:env
```

#### SSE Transport (HTTP/Server-Sent Events)

For web-based clients or remote connections:

```bash
# Start SSE server on port 3000
TRANSPORT=sse npm run dev:sse:env

# Or custom port
TRANSPORT=sse PORT=8080 npm run dev:sse:env
```

The server will be available at:

- **MCP endpoint**: `http://localhost:3000/mcp`
- **SSE endpoint**: `http://localhost:3000/sse`

**Environment Variables for SSE:**

- `TRANSPORT=sse` - Enable SSE transport
- `PORT=3000` - HTTP server port (default: 3000)
- `SSE_PATH=/sse` - SSE endpoint path (default: /sse)

### Using with Claude Desktop (Stdio)

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mail": {
      "command": "node",
      "args": ["/absolute/path/to/mail-mcp/dist/index.js"],
      "env": {
        "SMTP_HOST": "smtp.provider.com",
        "SMTP_PORT": "587",
        "SMTP_USER": "your-email@provider.com",
        "SMTP_PASS": "your-mail-password",
        "SMTP_FROM": "your-email@provider.com",
        "IMAP_HOST": "imap.provider.com",
        "IMAP_PORT": "993",
        "IMAP_USER": "your-email@provider.com",
        "IMAP_PASS": "your-mail-password"
      }
    }
  }
}
```

## Available Tools

### SMTP Tools (Sending Emails)

#### send_email

Send an email via SMTP.

**Parameters:**

- `to` (required): Recipient email address
- `subject` (required): Email subject line
- `text` (optional): Plain text email body
- `html` (optional): HTML email body
- `from` (optional): Sender email address (uses SMTP_FROM if not provided)
- `cc` (optional): CC recipient email address
- `bcc` (optional): BCC recipient email address
- `attachments` (optional): Array of attachments with `filename`, `content`, and `encoding` (base64 or utf-8)

**Example:**

```typescript
{
  "to": "recipient@example.com",
  "subject": "Hello from MCP",
  "text": "This is a test email",
  "html": "<h1>This is a test email</h1>"
}
```

#### verify_connection

Verify the SMTP connection and authentication using configured credentials.

**Parameters:** None

#### test_smtp_config

Test SMTP configuration with custom credentials without modifying the server configuration.

**Parameters:**

- `host` (required): SMTP server hostname
- `port` (required): SMTP server port
- `user` (required): SMTP authentication username
- `password` (required): SMTP authentication password
- `secure` (optional): Use TLS (default: true for port 465)

#### get_smtp_info

Get information about the current SMTP configuration (without revealing credentials).

**Parameters:** None

### IMAP Tools (Reading Emails)

#### list_mailboxes

List all available mailboxes/folders in the IMAP account.

**Parameters:** None

**Example Response:**

```json
{
  "success": true,
  "mailboxes": [
    {"name": "INBOX", "delimiter": "/", "children": 0},
    {"name": "Sent", "delimiter": "/", "children": 0},
    {"name": "Drafts", "delimiter": "/", "children": 0}
  ],
  "count": 3
}
```

#### fetch_emails

Fetch emails from a specific mailbox with optional filters.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `limit` (optional): Maximum emails to fetch, 1-100 (default: 10)
- `unseen` (optional): Only fetch unread emails (default: false)
- `since` (optional): Only fetch emails since date (ISO 8601 format)

**Example:**

```typescript
{
  "mailbox": "INBOX",
  "limit": 5,
  "unseen": true
}
```

#### search_emails

Search for emails in a mailbox by subject, sender, or content.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `query` (required): Search query string
- `limit` (optional): Maximum results, 1-100 (default: 10)

**Example:**

```typescript
{
  "query": "meeting",
  "limit": 10
}
```

#### mark_email

Mark an email with a specific flag.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `uid` (required): Email UID to mark
- `flag` (required): Flag to set ("read", "unread", "flagged", "unflagged")

**Example:**

```typescript
{
  "uid": 123,
  "flag": "read"
}
```

### Advanced IMAP Tools

#### create_mailbox

Create a new mailbox/folder in your email account.

**Parameters:**

- `name` (required): Name of the mailbox to create

**Example:**

```typescript
{
  "name": "Projects"
}
```

#### delete_mailbox

Delete a mailbox/folder from your email account.

**Parameters:**

- `name` (required): Name of the mailbox to delete

**Example:**

```typescript
{
  "name": "OldFolder"
}
```

#### move_message

Move an email from one mailbox to another.

**Parameters:**

- `sourceMailbox` (optional): Source mailbox (default: "INBOX")
- `targetMailbox` (required): Target mailbox name
- `uid` (required): Email UID to move

**Example:**

```typescript
{
  "sourceMailbox": "INBOX",
  "targetMailbox": "Archive",
  "uid": 123
}
```

#### copy_message

Copy an email from one mailbox to another.

**Parameters:**

- `sourceMailbox` (optional): Source mailbox (default: "INBOX")
- `targetMailbox` (required): Target mailbox name
- `uid` (required): Email UID to copy

**Example:**

```typescript
{
  "targetMailbox": "Important",
  "uid": 456
}
```

#### advanced_search

Search emails with multiple criteria including sender, recipient, subject, body, date range, size, and flags.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `criteria` (required): Search criteria object with fields:
  - `from`: Search by sender
  - `to`: Search by recipient
  - `subject`: Search by subject text
  - `body`: Search by body text
  - `since`: Date filter (ISO 8601)
  - `before`: Date filter (ISO 8601)
  - `unseen`: Only unread emails (boolean)
  - `flagged`: Only flagged emails (boolean)
  - `larger`: Minimum size in bytes
  - `smaller`: Maximum size in bytes
- `limit` (optional): Maximum results, 1-100 (default: 10)

**Example:**

```typescript
{
  "criteria": {
    "from": "boss@company.com",
    "since": "2025-01-01",
    "unseen": true
  },
  "limit": 20
}
```

#### save_draft

Save an email as a draft in the Drafts folder without sending it.

**Parameters:**

- `to` (required): Recipient email address
- `subject` (required): Email subject
- `text` (optional): Plain text body
- `html` (optional): HTML body
- `from` (optional): Sender address
- `cc` (optional): CC recipient
- `bcc` (optional): BCC recipient

**Example:**

```typescript
{
  "to": "colleague@company.com",
  "subject": "Draft: Project Update",
  "text": "This is a draft email..."
}
```

#### get_thread

Get all emails in a conversation thread based on a message ID. Returns emails sorted chronologically with reply relationships.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `messageId` (required): Message ID to find thread for

**Example:**

```typescript
{
  "messageId": "<abc123@mail.example.com>"
}
```

**Response includes:**

- `messageId`: Unique message identifier
- `inReplyTo`: Parent message ID
- `references`: All related message IDs
- Full email content sorted by date

#### download_attachment

Download a specific attachment from an email. Returns the attachment content as base64-encoded data.

**Parameters:**

- `mailbox` (optional): Mailbox name (default: "INBOX")
- `uid` (required): Email UID
- `attachmentIndex` (required): Attachment index (0-based)

**Example:**

```typescript
{
  "uid": 789,
  "attachmentIndex": 0
}
```

**Response:**

```json
{
  "success": true,
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "size": 102400,
  "content": "JVBERi0xLjQKJeLjz9MKM...",
  "encoding": "base64"
}
```

## Development

```bash
# Build the project
npm run build

# Watch for changes
npm run watch

# Run in development mode
npm run dev
```

## Security Notes

- Never commit credentials to version control
- Use environment variables for sensitive data
- Consider using App Passwords instead of regular passwords
- Use TLS/SSL for secure connections (port 465 or STARTTLS on 587)

## Common Email Providers

| Provider | SMTP Host | SMTP Port | IMAP Host | IMAP Port |
|----------|-----------|-----------|-----------|-----------|
| Gmail | smtp.gmail.com | 587/465 | imap.gmail.com | 993 |
| Outlook | smtp-mail.outlook.com | 587 | outlook.office365.com | 993 |
| Yahoo | smtp.mail.yahoo.com | 587 | imap.mail.yahoo.com | 993 |
| iCloud | smtp.mail.me.com | 587 | imap.mail.me.com | 993 |
| SendGrid | smtp.sendgrid.net | 587 | N/A | N/A |

**Notes:**

- Port 587: Use with STARTTLS (set `SMTP_SECURE="false"`)
- Port 465: Use with SSL/TLS (set `SMTP_SECURE="true"`)
- Port 993: Standard IMAP over SSL/TLS

## License

MIT
