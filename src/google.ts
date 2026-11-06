import type { Env, GmailMessage, MailEvent } from "./types";

let tokenCache: { token: string; expiresAt: number } | undefined;

export async function gmailToken(env: Env): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!response.ok) throw new Error(`Gmail OAuth refresh failed (${response.status}): ${await response.text()}`);
  const data = await response.json<{ access_token: string; expires_in: number }>();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function gmailFetch<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const token = await gmailToken(env);
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(env.GMAIL_USER)}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) throw new Error(`Gmail API ${path} failed (${response.status}): ${await response.text()}`);
  return response.json<T>();
}

export async function renewWatch(env: Env): Promise<{ historyId: string; expiration: string }> {
  return gmailFetch(env, "watch", { method: "POST", body: JSON.stringify({ topicName: env.GMAIL_TOPIC_NAME, labelIds: ["INBOX"] }) });
}

export async function getProfileHistoryId(env: Env): Promise<string> {
  const profile = await gmailFetch<{ historyId: string }>(env, "profile");
  return profile.historyId;
}

export async function listNewMessageIds(env: Env, startHistoryId: string): Promise<{ ids: string[]; latestHistoryId: string }> {
  let pageToken: string | undefined;
  let latestHistoryId = startHistoryId;
  const ids = new Set<string>();
  do {
    const query = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "500" });
    if (pageToken) query.set("pageToken", pageToken);
    const data = await gmailFetch<{
      historyId: string;
      nextPageToken?: string;
      history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>;
    }>(env, `history?${query}`);
    latestHistoryId = data.historyId || latestHistoryId;
    for (const history of data.history || []) {
      for (const added of history.messagesAdded || []) {
        if (!added.message.labelIds || added.message.labelIds.includes("INBOX")) ids.add(added.message.id);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return { ids: [...ids], latestHistoryId };
}

export function getMessage(env: Env, id: string): Promise<GmailMessage> {
  return gmailFetch(env, `messages/${encodeURIComponent(id)}?format=full`);
}

export async function listRecentMessageIds(env: Env): Promise<string[]> {
  let pageToken: string | undefined;
  const ids: string[] = [];
  do {
    const query = new URLSearchParams({ q: "in:inbox newer_than:2d", maxResults: "500" });
    if (pageToken) query.set("pageToken", pageToken);
    const data = await gmailFetch<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(env, `messages?${query}`);
    for (const message of data.messages || []) ids.push(message.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

function base64UrlDecode(value: string): string {
  const raw = value.replace(/-/g, "+").replace(/_/g, "/");
  const normalized = raw.padEnd(Math.ceil(raw.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function extractMessage(message: GmailMessage): { sender: string; subject: string; body: string } {
  const headers = message.payload.headers || [];
  const header = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (part: typeof message.payload) => {
    // attachmentId 存在时绝不请求附件；这里只读取消息正文内联 data。
    if (part.body?.data && !part.filename) {
      const decoded = base64UrlDecode(part.body.data);
      if (part.mimeType === "text/plain") plain.push(decoded);
      else if (part.mimeType === "text/html") html.push(decoded);
    }
    for (const child of part.parts || []) visit(child);
  };
  visit(message.payload);
  let body = plain.join("\n");
  if (!body && html.length) body = html.join("\n").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  body = body.replace(/\s+/g, " ").trim().slice(0, 20_000);
  return { sender: header("From"), subject: header("Subject") || "（无主题）", body };
}

type GoogleJwk = JsonWebKey & { kid?: string };
let googleJwksCache: { expiresAt: number; keys: GoogleJwk[] } | undefined;

export async function verifyPubSubJwt(request: Request, env: Env): Promise<void> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) throw new Error("Missing Pub/Sub bearer token");
  const jwt = auth.slice(7);
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed Pub/Sub JWT");
  const header = JSON.parse(base64UrlDecode(parts[0])) as { kid?: string; alg?: string };
  const claims = JSON.parse(base64UrlDecode(parts[1])) as { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean };
  const now = Math.floor(Date.now() / 1000);
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss || "")) throw new Error("Invalid JWT issuer");
  if (claims.aud !== env.PUBSUB_AUDIENCE || !claims.exp || claims.exp < now) throw new Error("Invalid JWT audience or expiry");
  if (claims.email !== env.PUBSUB_SERVICE_ACCOUNT || claims.email_verified !== true) throw new Error("Invalid Pub/Sub service account");
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported JWT signature");
  if (!googleJwksCache || googleJwksCache.expiresAt < Date.now()) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) throw new Error("Unable to load Google signing keys");
    const data = await response.json<{ keys: GoogleJwk[] }>();
    googleJwksCache = { keys: data.keys, expiresAt: Date.now() + 3_600_000 };
  }
  const jwk = googleJwksCache.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown Google signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signatureValue = parts[2].replace(/-/g, "+").replace(/_/g, "/");
  const signature = Uint8Array.from(atob(signatureValue.padEnd(Math.ceil(signatureValue.length / 4) * 4, "=")), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("Invalid Pub/Sub JWT signature");
}

export function decodePubSubEvent(payload: { message?: { data?: string } }): MailEvent {
  if (!payload.message?.data) throw new Error("Missing Pub/Sub message data");
  const data = JSON.parse(base64UrlDecode(payload.message.data)) as { emailAddress?: string; historyId?: string };
  if (!data.emailAddress || !data.historyId) throw new Error("Invalid Gmail notification");
  return { emailAddress: data.emailAddress, historyId: data.historyId, source: "pubsub" };
}
