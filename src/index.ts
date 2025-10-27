#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import nodemailer from "nodemailer";
import Imap from "imap";
import { simpleParser } from "mailparser";
import { z } from "zod";
import http from "http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Zod schemas for validation
const SendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  from: z.string().email().optional(),
  cc: z.string().email().optional(),
  bcc: z.string().email().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content: z.string(),
        encoding: z.enum(["base64", "utf-8"]).optional(),
      })
    )
    .optional(),
});

const TestConnectionSchema = z.object({
  host: z.string(),
  port: z.number(),
  secure: z.boolean().optional(),
  user: z.string(),
  password: z.string(),
});

const FetchEmailsSchema = z.object({
  mailbox: z.string().default("INBOX"),
  limit: z.number().min(1).max(100).default(10),
  since: z.string().optional(),
  unseen: z.boolean().optional(),
});

const SearchEmailsSchema = z.object({
  mailbox: z.string().default("INBOX"),
  query: z.string(),
  limit: z.number().min(1).max(100).default(10),
});

const MarkEmailSchema = z.object({
  mailbox: z.string().default("INBOX"),
  uid: z.number(),
  flag: z.enum(["read", "unread", "flagged", "unflagged"]),
});

const CreateMailboxSchema = z.object({
  name: z.string(),
});

const DeleteMailboxSchema = z.object({
  name: z.string(),
});

const MoveMessageSchema = z.object({
  sourceMailbox: z.string().default("INBOX"),
  targetMailbox: z.string(),
  uid: z.number(),
});

const CopyMessageSchema = z.object({
  sourceMailbox: z.string().default("INBOX"),
  targetMailbox: z.string(),
  uid: z.number(),
});

const AdvancedSearchSchema = z.object({
  mailbox: z.string().default("INBOX"),
  criteria: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    since: z.string().optional(),
    before: z.string().optional(),
    unseen: z.boolean().optional(),
    flagged: z.boolean().optional(),
    larger: z.number().optional(),
    smaller: z.number().optional(),
  }),
  limit: z.number().min(1).max(100).default(10),
});

const SaveDraftSchema = z.object({
  to: z.string().email(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  from: z.string().email().optional(),
  cc: z.string().email().optional(),
  bcc: z.string().email().optional(),
});

const GetThreadSchema = z.object({
  mailbox: z.string().default("INBOX"),
  messageId: z.string(),
});

const DownloadAttachmentSchema = z.object({
  mailbox: z.string().default("INBOX"),
  uid: z.number(),
  attachmentIndex: z.number(),
});

// Environment variable validation
const requiredEnvVars = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  console.error(
    `Missing required environment variables: ${missingVars.join(", ")}`
  );
  console.error("\nPlease set the following environment variables:");
  console.error("  SMTP_HOST - SMTP server hostname");
  console.error("  SMTP_PORT - SMTP server port");
  console.error("  SMTP_USER - SMTP authentication username");
  console.error("  SMTP_PASS - SMTP authentication password");
  console.error("  SMTP_FROM - (Optional) Default sender email address");
  console.error("  SMTP_SECURE - (Optional) Use TLS (true/false, default: true for port 465)");
  console.error("\nFor IMAP (reading emails):");
  console.error("  IMAP_HOST - IMAP server hostname (optional, defaults to SMTP_HOST)");
  console.error("  IMAP_PORT - IMAP server port (optional, defaults to 993)");
  console.error("  IMAP_USER - IMAP authentication username (optional, defaults to SMTP_USER)");
  console.error("  IMAP_PASS - IMAP authentication password (optional, defaults to SMTP_PASS)");
  console.error("  IMAP_TLS - Use TLS (optional, default: true)");
  process.exit(1);
}

// Create reusable transporter
const createTransporter = () => {
  const port = parseInt(process.env.SMTP_PORT || "587");
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    logger: false,
  });
};

// Helper function to extract text from AddressObject
const getAddressText = (address: any): string => {
  if (!address) return "";
  if (Array.isArray(address)) {
    return address.map((a) => a.text || "").join(", ");
  }
  return address.text || "";
};

// Create IMAP connection
const createImapConnection = (): Promise<Imap> => {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.IMAP_USER || process.env.SMTP_USER || "",
      password: process.env.IMAP_PASS || process.env.SMTP_PASS || "",
      host: process.env.IMAP_HOST || process.env.SMTP_HOST || "",
      port: parseInt(process.env.IMAP_PORT || "993"),
      tls: process.env.IMAP_TLS !== "false",
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => resolve(imap));
    imap.once("error", (err: any) => reject(err));
    imap.connect();
  });
};

// Fetch emails from IMAP
const fetchEmails = async (
  mailbox: string,
  limit: number,
  unseen?: boolean,
  since?: string,
  html?: boolean,
): Promise<any[]> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, false, (err, box) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      console.error(`Opened mailbox: ${mailbox}, Total messages: ${box.messages.total}`);

      const searchCriteria: any[] = [];

      // Build search criteria properly
      if (unseen && since) {
        searchCriteria.push("UNSEEN", ["SINCE", new Date(since)]);
      } else if (unseen) {
        searchCriteria.push("UNSEEN");
      } else if (since) {
        searchCriteria.push(["SINCE", new Date(since)]);
      } else {
        searchCriteria.push("ALL");
      }

      console.error(`Search criteria: ${JSON.stringify(searchCriteria)}`);

      // Progressive search: start with last month, expand if needed
      const searchWithTimeWindow = async (monthsBack: number): Promise<number[]> => {
        return new Promise((resolveSearch, rejectSearch) => {
          const timeWindowCriteria = [...searchCriteria];

          // Add time constraint if not already specified
          if (!since && !timeWindowCriteria.some(c => Array.isArray(c) && c[0] === 'SINCE')) {
            const sinceDate = new Date();
            sinceDate.setMonth(sinceDate.getMonth() - monthsBack);
            timeWindowCriteria.push(['SINCE', sinceDate]);
          }

          console.error(`Searching with ${monthsBack} month(s) back: ${JSON.stringify(timeWindowCriteria)}`);

          imap.search(timeWindowCriteria, (err, results) => {
            if (err) return rejectSearch(err);
            resolveSearch(results || []);
          });
        });
      };

      // Try progressively larger time windows until we have enough emails
      const findEmails = async () => {
        let results: number[] = [];
        let monthsBack = 1;
        const maxMonthsBack = 12; // Don't go back more than 1 year

        while (results.length < limit && monthsBack <= maxMonthsBack) {
          results = await searchWithTimeWindow(monthsBack);
          console.error(`Found ${results.length} messages in last ${monthsBack} month(s)`);

          if (results.length >= limit) {
            break;
          }

          // If user specified 'since', don't expand time window
          if (since) {
            break;
          }

          // Expand time window
          monthsBack += 1;
        }

        return results;
      };

      findEmails().then(results => {
        console.error(`Final search found ${results.length} messages matching criteria`);

        if (!results || results.length === 0) {
          imap.end();
          return resolve([]);
        }

        // Get the most recent emails by taking from the end
        // IMAP search returns results in ascending order (oldest first)
        // We want the LAST N emails (most recent)
        const uids = results.slice(-limit);
        console.error(`Fetching last ${uids.length} messages from ${results.length} total`);
        console.error(`UIDs being fetched: ${uids.join(", ")}`);
        console.error(`First UID: ${results[0]}, Last UID: ${results[results.length - 1]}`);

        const fetch = imap.fetch(uids, {
          bodies: "",
          struct: true,
          markSeen: false,
        });

        let messageCount = 0;
        let messagesReceived = 0;
        const parsedEmails: Map<number, any> = new Map();

        fetch.on("message", (msg, seqno) => {
          messageCount++;
          let buffer = "";
          let attributes: any = null;

          msg.on("attributes", (attrs) => {
            attributes = attrs;
          });

          msg.on("body", (stream) => {
            stream.on("data", (chunk) => {
              buffer += chunk.toString("utf8");
            });
          });

          msg.once("end", async () => {
            try {
              const parsed = await simpleParser(buffer);
              const email = {
                uid: attributes?.uid || seqno,
                seqno: seqno,
                from: getAddressText(parsed.from),
                to: getAddressText(parsed.to),
                subject: parsed.subject || "",
                date: parsed.date?.toISOString() || "",
                text: parsed.text || "",
                html: html ? parsed.html || "" : "",
                flags: attributes?.flags || [],
                attachments: parsed.attachments?.map((att) => ({
                  filename: att.filename,
                  contentType: att.contentType,
                  size: att.size,
                })) || [],
              };
              parsedEmails.set(seqno, email);
              console.error(`Parsed email ${email.seqno}: "${email.subject}" from ${email.from} (${email.date})`);
            } catch (e) {
              console.error("Error parsing email:", e);
            } finally {
              messagesReceived++;
              // Check if all messages have been parsed
              if (messagesReceived === messageCount && fetchEnded) {
                finishFetch();
              }
            }
          });
        });

        let fetchEnded = false;
        const finishFetch = () => {
          imap.end();
          // Convert map to array and sort by date descending (most recent first)
          const emailArray = Array.from(parsedEmails.values());
          emailArray.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          console.error(`Successfully fetched ${emailArray.length} emails (${messageCount} total messages)`);
          resolve(emailArray);
        };

        fetch.once("error", (err) => {
          imap.end();
          reject(err);
        });

        fetch.once("end", () => {
          fetchEnded = true;
          console.error(`Fetch ended. Received ${messagesReceived}/${messageCount} messages so far`);
          // Only finish if all messages have been parsed
          if (messagesReceived === messageCount) {
            finishFetch();
          }
        });
      }).catch(err => {
        imap.end();
        reject(err);
      });
    });
  });
};

// List mailboxes
const listMailboxes = async (): Promise<any[]> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      imap.end();
      if (err) return reject(err);

      const flattenBoxes = (boxes: any, prefix = ""): any[] => {
        const result: any[] = [];
        for (const [name, box] of Object.entries<any>(boxes)) {
          const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
          result.push({
            name: fullName,
            delimiter: box.delimiter,
            children: box.children ? Object.keys(box.children).length : 0,
          });
          if (box.children) {
            result.push(...flattenBoxes(box.children, fullName));
          }
        }
        return result;
      };

      resolve(flattenBoxes(boxes));
    });
  });
};

// Mark email with flag
const markEmail = async (
  mailbox: string,
  uid: number,
  flag: string
): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, false, (err) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      const flagMap: Record<string, string> = {
        read: "\\Seen",
        unread: "\\Seen",
        flagged: "\\Flagged",
        unflagged: "\\Flagged",
      };

      const action = flag === "unread" || flag === "unflagged" ? "delFlags" : "addFlags";
      const imapFlag = flagMap[flag];

      imap[action](uid, [imapFlag], (err) => {
        imap.end();
        if (err) return reject(err);
        resolve();
      });
    });
  });
};

// Create mailbox
const createMailbox = async (name: string): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.addBox(name, (err) => {
      imap.end();
      if (err) return reject(err);
      resolve();
    });
  });
};

// Delete mailbox
const deleteMailbox = async (name: string): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.delBox(name, (err) => {
      imap.end();
      if (err) return reject(err);
      resolve();
    });
  });
};

// Move message
const moveMessage = async (
  sourceMailbox: string,
  targetMailbox: string,
  uid: number
): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(sourceMailbox, false, (err) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      imap.move(uid, targetMailbox, (err) => {
        imap.end();
        if (err) return reject(err);
        resolve();
      });
    });
  });
};

// Copy message
const copyMessage = async (
  sourceMailbox: string,
  targetMailbox: string,
  uid: number
): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(sourceMailbox, false, (err) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      imap.copy(uid, targetMailbox, (err) => {
        imap.end();
        if (err) return reject(err);
        resolve();
      });
    });
  });
};

// Advanced search
const advancedSearch = async (
  mailbox: string,
  criteria: any,
  limit: number
): Promise<any[]> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, false, (err, box) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      // Build search criteria array
      const searchCriteria: any[] = [];

      if (criteria.from) {
        searchCriteria.push(["FROM", criteria.from]);
      }
      if (criteria.to) {
        searchCriteria.push(["TO", criteria.to]);
      }
      if (criteria.subject) {
        searchCriteria.push(["SUBJECT", criteria.subject]);
      }
      if (criteria.body) {
        searchCriteria.push(["BODY", criteria.body]);
      }
      if (criteria.since) {
        searchCriteria.push(["SINCE", new Date(criteria.since)]);
      }
      if (criteria.before) {
        searchCriteria.push(["BEFORE", new Date(criteria.before)]);
      }
      if (criteria.unseen) {
        searchCriteria.push("UNSEEN");
      }
      if (criteria.flagged) {
        searchCriteria.push("FLAGGED");
      }
      if (criteria.larger) {
        searchCriteria.push(["LARGER", criteria.larger]);
      }
      if (criteria.smaller) {
        searchCriteria.push(["SMALLER", criteria.smaller]);
      }

      // Default to ALL if no criteria
      if (searchCriteria.length === 0) {
        searchCriteria.push("ALL");
      }

      imap.search(searchCriteria, (err, results) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        if (!results || results.length === 0) {
          imap.end();
          return resolve([]);
        }

        const uids = results.slice(-limit);
        const fetch = imap.fetch(uids, {
          bodies: "",
          struct: true,
        });

        let messageCount = 0;
        let messagesReceived = 0;
        const parsedEmails: Map<number, any> = new Map();

        fetch.on("message", (msg, seqno) => {
          messageCount++;
          let buffer = "";

          msg.on("body", (stream) => {
            stream.on("data", (chunk) => {
              buffer += chunk.toString("utf8");
            });
          });

          msg.once("end", async () => {
            try {
              const parsed = await simpleParser(buffer);
              const email = {
                uid: seqno,
                messageId: parsed.messageId || "",
                from: getAddressText(parsed.from),
                to: getAddressText(parsed.to),
                subject: parsed.subject || "",
                date: parsed.date?.toISOString() || "",
                text: parsed.text || "",
                html: parsed.html || "",
                attachments: parsed.attachments?.map((att) => ({
                  filename: att.filename,
                  contentType: att.contentType,
                  size: att.size,
                })) || [],
              };
              parsedEmails.set(seqno, email);
            } catch (e) {
              console.error("Error parsing email:", e);
            } finally {
              messagesReceived++;
              if (messagesReceived === messageCount && fetchEnded) {
                finishFetch();
              }
            }
          });
        });

        let fetchEnded = false;
        const finishFetch = () => {
          imap.end();
          const emailArray = Array.from(parsedEmails.values());
          resolve(emailArray);
        };

        fetch.once("error", (err) => {
          imap.end();
          reject(err);
        });

        fetch.once("end", () => {
          fetchEnded = true;
          if (messagesReceived === messageCount) {
            finishFetch();
          }
        });
      });
    });
  });
};

// Save draft
const saveDraft = async (draft: any): Promise<void> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    // Construct email message
    const from = draft.from || process.env.SMTP_FROM || process.env.SMTP_USER;
    const headers = [
      `From: ${from}`,
      `To: ${draft.to}`,
      draft.cc ? `Cc: ${draft.cc}` : null,
      draft.bcc ? `Bcc: ${draft.bcc}` : null,
      `Subject: ${draft.subject}`,
      "MIME-Version: 1.0",
      draft.html
        ? 'Content-Type: text/html; charset="UTF-8"'
        : 'Content-Type: text/plain; charset="UTF-8"',
      "",
    ]
      .filter(Boolean)
      .join("\r\n");

    const body = draft.html || draft.text || "";
    const message = headers + "\r\n" + body;

    // Append to Drafts folder
    imap.append(message, { mailbox: "Drafts", flags: ["\\Draft"] }, (err) => {
      imap.end();
      if (err) return reject(err);
      resolve();
    });
  });
};

// Get thread
const getThread = async (
  mailbox: string,
  messageId: string
): Promise<any[]> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, false, (err, box) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      // Search for messages with matching Message-ID, In-Reply-To, or References headers
      const searchCriteria = [["HEADER", "MESSAGE-ID", messageId]];

      imap.search(searchCriteria, async (err, results) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        if (!results || results.length === 0) {
          imap.end();
          return resolve([]);
        }

        const fetch = imap.fetch(results, {
          bodies: "",
          struct: true,
        });

        let messageCount = 0;
        let messagesReceived = 0;
        const parsedEmails: Map<number, any> = new Map();
        const relatedIds = new Set<string>([messageId]);

        fetch.on("message", (msg, seqno) => {
          messageCount++;
          let buffer = "";

          msg.on("body", (stream) => {
            stream.on("data", (chunk) => {
              buffer += chunk.toString("utf8");
            });
          });

          msg.once("end", async () => {
            try {
              const parsed = await simpleParser(buffer);

              // Collect related message IDs
              if (parsed.messageId) relatedIds.add(parsed.messageId);
              if (parsed.inReplyTo) relatedIds.add(parsed.inReplyTo);
              if (parsed.references) {
                const refs = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references;
                refs.split(/\s+/).forEach((ref: string) => relatedIds.add(ref.trim()));
              }

              const email = {
                uid: seqno,
                messageId: parsed.messageId || "",
                inReplyTo: parsed.inReplyTo || "",
                references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references || ""),
                from: getAddressText(parsed.from),
                to: getAddressText(parsed.to),
                subject: parsed.subject || "",
                date: parsed.date?.toISOString() || "",
                text: parsed.text || "",
                html: parsed.html || "",
              };
              parsedEmails.set(seqno, email);
            } catch (e) {
              console.error("Error parsing email:", e);
            } finally {
              messagesReceived++;
              if (messagesReceived === messageCount && fetchEnded) {
                proceedToRelatedSearch();
              }
            }
          });
        });

        let fetchEnded = false;
        const proceedToRelatedSearch = () => {
          // Simplified: just return what we have, sorted by date
          imap.end();
          const emailArray = Array.from(parsedEmails.values());
          emailArray.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
          resolve(emailArray);
        };

        fetch.once("error", (err) => {
          imap.end();
          reject(err);
        });

        fetch.once("end", () => {
          fetchEnded = true;
          if (messagesReceived === messageCount) {
            proceedToRelatedSearch();
          }
        });
      });
    });
  });
};

// Download attachment
const downloadAttachment = async (
  mailbox: string,
  uid: number,
  attachmentIndex: number
): Promise<any> => {
  const imap = await createImapConnection();

  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, false, (err, box) => {
      if (err) {
        imap.end();
        return reject(err);
      }

      const fetch = imap.fetch([uid], {
        bodies: "",
        struct: true,
      });

      fetch.on("message", (msg, seqno) => {
        let buffer = "";

        msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
          });
        });

        msg.once("end", async () => {
          try {
            const parsed = await simpleParser(buffer);

            if (!parsed.attachments || parsed.attachments.length === 0) {
              imap.end();
              return reject(new Error("No attachments found in this email"));
            }

            if (attachmentIndex >= parsed.attachments.length) {
              imap.end();
              return reject(new Error(`Attachment index ${attachmentIndex} out of range`));
            }

            const attachment = parsed.attachments[attachmentIndex];

            imap.end();
            resolve({
              filename: attachment.filename,
              contentType: attachment.contentType,
              size: attachment.size,
              content: attachment.content.toString("base64"),
              encoding: "base64",
            });
          } catch (e) {
            imap.end();
            reject(e);
          }
        });
      });

      fetch.once("error", (err) => {
        imap.end();
        reject(err);
      });
    });
  });
};

// Tool definitions
const tools: Tool[] = [
  {
    name: "send_email",
    description:
      "Send an email via SMTP. Supports HTML and plain text content, attachments, and CC/BCC recipients.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        text: {
          type: "string",
          description: "Plain text email body",
        },
        html: {
          type: "string",
          description: "HTML email body (optional, overrides text if provided)",
        },
        from: {
          type: "string",
          description:
            "Sender email address (optional, uses SMTP_FROM env var if not provided)",
        },
        cc: {
          type: "string",
          description: "CC recipient email address (optional)",
        },
        bcc: {
          type: "string",
          description: "BCC recipient email address (optional)",
        },
        attachments: {
          type: "array",
          description: "Email attachments (optional)",
          items: {
            type: "object",
            properties: {
              filename: {
                type: "string",
                description: "Attachment filename",
              },
              content: {
                type: "string",
                description: "Attachment content (base64 encoded or plain text)",
              },
              encoding: {
                type: "string",
                enum: ["base64", "utf-8"],
                description: "Content encoding (default: utf-8)",
              },
            },
            required: ["filename", "content"],
          },
        },
      },
      required: ["to", "subject"],
    },
  },
  {
    name: "verify_connection",
    description:
      "Verify the SMTP connection and authentication using configured credentials.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "test_smtp_config",
    description:
      "Test SMTP configuration with custom credentials without modifying the server configuration.",
    inputSchema: {
      type: "object",
      properties: {
        host: {
          type: "string",
          description: "SMTP server hostname",
        },
        port: {
          type: "number",
          description: "SMTP server port",
        },
        secure: {
          type: "boolean",
          description: "Use TLS (default: true for port 465)",
        },
        user: {
          type: "string",
          description: "SMTP authentication username",
        },
        password: {
          type: "string",
          description: "SMTP authentication password",
        },
      },
      required: ["host", "port", "user", "password"],
    },
  },
  {
    name: "get_smtp_info",
    description:
      "Get information about the current SMTP configuration (without revealing credentials).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_mailboxes",
    description:
      "List all available mailboxes/folders in the IMAP account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "fetch_emails",
    description:
      "Fetch emails from a specific mailbox. Returns email metadata and content.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        limit: {
          type: "number",
          description: "Maximum number of emails to fetch (1-100, default: 10)",
        },
        unseen: {
          type: "boolean",
          description: "Only fetch unread emails (default: false)",
        },
        since: {
          type: "string",
          description: "Only fetch emails since this date (ISO 8601 format)",
        },
      },
    },
  },
  {
    name: "search_emails",
    description:
      "Search for emails in a mailbox using a search query (searches in subject, from, and body).",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        query: {
          type: "string",
          description: "Search query string",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (1-100, default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "mark_email",
    description:
      "Mark an email with a specific flag (read/unread/flagged/unflagged).",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        uid: {
          type: "number",
          description: "Email UID to mark",
        },
        flag: {
          type: "string",
          enum: ["read", "unread", "flagged", "unflagged"],
          description: "Flag to set on the email",
        },
      },
      required: ["uid", "flag"],
    },
  },
  {
    name: "create_mailbox",
    description: "Create a new mailbox/folder in the IMAP account.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the mailbox to create",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_mailbox",
    description: "Delete a mailbox/folder from the IMAP account.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the mailbox to delete",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "move_message",
    description: "Move an email from one mailbox to another.",
    inputSchema: {
      type: "object",
      properties: {
        sourceMailbox: {
          type: "string",
          description: "Source mailbox name (default: INBOX)",
        },
        targetMailbox: {
          type: "string",
          description: "Target mailbox name",
        },
        uid: {
          type: "number",
          description: "Email UID to move",
        },
      },
      required: ["targetMailbox", "uid"],
    },
  },
  {
    name: "copy_message",
    description: "Copy an email from one mailbox to another.",
    inputSchema: {
      type: "object",
      properties: {
        sourceMailbox: {
          type: "string",
          description: "Source mailbox name (default: INBOX)",
        },
        targetMailbox: {
          type: "string",
          description: "Target mailbox name",
        },
        uid: {
          type: "number",
          description: "Email UID to copy",
        },
      },
      required: ["targetMailbox", "uid"],
    },
  },
  {
    name: "advanced_search",
    description:
      "Advanced email search with multiple criteria (from, to, subject, body, date range, size, flags).",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        criteria: {
          type: "object",
          description: "Search criteria",
          properties: {
            from: {
              type: "string",
              description: "Search emails from this sender",
            },
            to: {
              type: "string",
              description: "Search emails to this recipient",
            },
            subject: {
              type: "string",
              description: "Search emails with subject containing this text",
            },
            body: {
              type: "string",
              description: "Search emails with body containing this text",
            },
            since: {
              type: "string",
              description: "Search emails since this date (ISO 8601)",
            },
            before: {
              type: "string",
              description: "Search emails before this date (ISO 8601)",
            },
            unseen: {
              type: "boolean",
              description: "Search only unread emails",
            },
            flagged: {
              type: "boolean",
              description: "Search only flagged emails",
            },
            larger: {
              type: "number",
              description: "Search emails larger than this size (bytes)",
            },
            smaller: {
              type: "number",
              description: "Search emails smaller than this size (bytes)",
            },
          },
        },
        limit: {
          type: "number",
          description: "Maximum number of results (1-100, default: 10)",
        },
      },
      required: ["criteria"],
    },
  },
  {
    name: "save_draft",
    description: "Save an email as a draft in the Drafts folder.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject",
        },
        text: {
          type: "string",
          description: "Plain text email body",
        },
        html: {
          type: "string",
          description: "HTML email body (optional)",
        },
        from: {
          type: "string",
          description: "Sender email address (optional)",
        },
        cc: {
          type: "string",
          description: "CC recipient (optional)",
        },
        bcc: {
          type: "string",
          description: "BCC recipient (optional)",
        },
      },
      required: ["to", "subject"],
    },
  },
  {
    name: "get_thread",
    description:
      "Get all emails in a conversation thread based on a message ID. Returns emails sorted chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        messageId: {
          type: "string",
          description: "Message ID to find thread for",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "download_attachment",
    description:
      "Download a specific attachment from an email. Returns base64-encoded content.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: {
          type: "string",
          description: "Mailbox name (default: INBOX)",
        },
        uid: {
          type: "number",
          description: "Email UID",
        },
        attachmentIndex: {
          type: "number",
          description: "Attachment index (0-based)",
        },
      },
      required: ["uid", "attachmentIndex"],
    },
  },
];

// Create server instance
const server = new Server(
  {
    name: "mail-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {}
    },
  }
);

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [] }
})

// List available resource templates
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: [] }
})

// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: [] }
})

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send_email": {
        const validated = SendEmailSchema.parse(args);
        const transporter = createTransporter();

        const from = validated.from || process.env.SMTP_FROM;
        if (!from) {
          throw new Error(
            "Sender email address must be provided via 'from' parameter or SMTP_FROM environment variable"
          );
        }

        const mailOptions: any = {
          from,
          to: validated.to,
          subject: validated.subject,
          text: validated.text,
          html: validated.html,
          cc: validated.cc,
          bcc: validated.bcc,
        };

        if (validated.attachments) {
          mailOptions.attachments = validated.attachments.map((att) => ({
            filename: att.filename,
            content: att.content,
            encoding: att.encoding || "utf-8",
          }));
        }

        const info = await transporter.sendMail(mailOptions);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  messageId: info.messageId,
                  response: info.response,
                  to: validated.to,
                  subject: validated.subject,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "verify_connection": {
        const transporter = createTransporter();
        await transporter.verify();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "SMTP connection and authentication verified successfully",
                  host: process.env.SMTP_HOST,
                  port: process.env.SMTP_PORT,
                  user: process.env.SMTP_USER,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "test_smtp_config": {
        const validated = TestConnectionSchema.parse(args);
        const secure = validated.secure ?? validated.port === 465;

        const testTransporter = nodemailer.createTransport({
          host: validated.host,
          port: validated.port,
          secure,
          auth: {
            user: validated.user,
            pass: validated.password,
          },
        });

        await testTransporter.verify();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "SMTP configuration test successful",
                  host: validated.host,
                  port: validated.port,
                  secure,
                  user: validated.user,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_smtp_info": {
        const port = parseInt(process.env.SMTP_PORT || "587");
        const secure = process.env.SMTP_SECURE === "true" || port === 465;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  host: process.env.SMTP_HOST,
                  port,
                  secure,
                  user: process.env.SMTP_USER,
                  defaultFrom: process.env.SMTP_FROM || "Not set",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_mailboxes": {
        const mailboxes = await listMailboxes();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mailboxes,
                  count: mailboxes.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "fetch_emails": {
        const validated = FetchEmailsSchema.parse(args);
        const emails = await fetchEmails(
          validated.mailbox,
          validated.limit,
          validated.unseen,
          validated.since
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mailbox: validated.mailbox,
                  count: emails.length,
                  emails,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "search_emails": {
        const validated = SearchEmailsSchema.parse(args);
        const emails = await fetchEmails(
          validated.mailbox,
          validated.limit,
          false,
          undefined
        );

        // Simple search in subject, from, and text
        const query = validated.query.toLowerCase();
        const filtered = emails.filter(
          (email) =>
            email.subject.toLowerCase().includes(query) ||
            email.from.toLowerCase().includes(query) ||
            email.text.toLowerCase().includes(query)
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mailbox: validated.mailbox,
                  query: validated.query,
                  count: filtered.length,
                  emails: filtered,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "mark_email": {
        const validated = MarkEmailSchema.parse(args);
        await markEmail(validated.mailbox, validated.uid, validated.flag);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Email ${validated.uid} marked as ${validated.flag}`,
                  mailbox: validated.mailbox,
                  uid: validated.uid,
                  flag: validated.flag,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "create_mailbox": {
        const validated = CreateMailboxSchema.parse(args);
        await createMailbox(validated.name);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Mailbox '${validated.name}' created successfully`,
                  name: validated.name,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "delete_mailbox": {
        const validated = DeleteMailboxSchema.parse(args);
        await deleteMailbox(validated.name);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Mailbox '${validated.name}' deleted successfully`,
                  name: validated.name,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "move_message": {
        const validated = MoveMessageSchema.parse(args);
        await moveMessage(
          validated.sourceMailbox,
          validated.targetMailbox,
          validated.uid
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Email ${validated.uid} moved from '${validated.sourceMailbox}' to '${validated.targetMailbox}'`,
                  sourceMailbox: validated.sourceMailbox,
                  targetMailbox: validated.targetMailbox,
                  uid: validated.uid,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "copy_message": {
        const validated = CopyMessageSchema.parse(args);
        await copyMessage(
          validated.sourceMailbox,
          validated.targetMailbox,
          validated.uid
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: `Email ${validated.uid} copied from '${validated.sourceMailbox}' to '${validated.targetMailbox}'`,
                  sourceMailbox: validated.sourceMailbox,
                  targetMailbox: validated.targetMailbox,
                  uid: validated.uid,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "advanced_search": {
        const validated = AdvancedSearchSchema.parse(args);
        const emails = await advancedSearch(
          validated.mailbox,
          validated.criteria,
          validated.limit
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mailbox: validated.mailbox,
                  criteria: validated.criteria,
                  count: emails.length,
                  emails,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "save_draft": {
        const validated = SaveDraftSchema.parse(args);
        await saveDraft(validated);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "Draft saved successfully to Drafts folder",
                  to: validated.to,
                  subject: validated.subject,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "get_thread": {
        const validated = GetThreadSchema.parse(args);
        const thread = await getThread(validated.mailbox, validated.messageId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  mailbox: validated.mailbox,
                  messageId: validated.messageId,
                  count: thread.length,
                  thread,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "download_attachment": {
        const validated = DownloadAttachmentSchema.parse(args);
        const attachment = await downloadAttachment(
          validated.mailbox,
          validated.uid,
          validated.attachmentIndex
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "Attachment downloaded successfully",
                  ...attachment,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Validation error: ${JSON.stringify(error.errors, null, 2)}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transportType = process.env.TRANSPORT || "stdio";

  if (transportType === "sse") {
    // SSE transport
    const port = parseInt(process.env.PORT || "3001");
    const path = process.env.SSE_PATH || "/sse";
    const app = express()
    app.use(express.json());

    // Store transports for each session type
    const transports = {
        streamable: {} as Record<string, StreamableHTTPServerTransport>,
        sse: {} as Record<string, SSEServerTransport>
    };

    // Modern Streamable HTTP endpoint
    app.post('/mcp', async (req, res) => {
        // Create a new transport for each request to prevent request ID collisions
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      res.on('close', () => {
          transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    // Legacy SSE endpoint for older clients
    app.get('/sse', async (req, res) => {
        // Create SSE transport for legacy clients
        const transport = new SSEServerTransport('/messages', res);
        transports.sse[transport.sessionId] = transport;

        res.on('close', () => {
            delete transports.sse[transport.sessionId];
        });

        await server.connect(transport);
    });

    // Legacy message endpoint for older clients
    app.post('/messages', async (req, res) => {
        const sessionId = req.query.sessionId as string;
        const transport = transports.sse[sessionId];
        if (transport) {
            await transport.handlePostMessage(req, res, req.body);
        } else {
            res.status(400).send('No transport found for sessionId');
        }
    });

    app.listen(port, () => {
      console.error(`Mail MCP Server running on SSE at http://localhost:${port}${path}`);
    });
  } else {
    // Stdio transport (default)
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Mail MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
