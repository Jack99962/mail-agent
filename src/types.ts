export interface Env {
  DB: D1Database;
  MAIL_QUEUE: Queue<MailEvent>;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_USER: string;
  GMAIL_TOPIC_NAME: string;
  OPENROUTER_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  OPENROUTER_APP_URL?: string;
  OPENROUTER_APP_NAME?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  PUBSUB_AUDIENCE: string;
  PUBSUB_SERVICE_ACCOUNT: string;
  ADMIN_TOKEN?: string;
}

export interface MailEvent {
  emailAddress: string;
  historyId: string;
  source: "pubsub" | "compensation" | "manual";
}

export interface Analysis {
  importance: "important" | "normal" | "advertisement";
  category: "work" | "personal" | "finance" | "account" | "newsletter" | "advertisement" | "other";
  summary_zh: string;
  action_items: string[];
  deadline: string | null;
  suggested_action: string;
  reason: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: string[];
  payload: GmailPart;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
