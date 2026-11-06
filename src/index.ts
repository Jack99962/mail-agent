import { decodePubSubEvent, extractMessage, getMessage, getProfileHistoryId, listNewMessageIds, listRecentMessageIds, renewWatch, verifyPubSubJwt } from "./google";
import { analyzeMail, buildDailyReport, importantMessage, telegram } from "./services";
import type { Analysis, Env, MailEvent } from "./types";

const now = () => Date.now();

async function state(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(key, value, now()).run();
}

async function notifyImportant(env: Env, id: string, mail: { sender: string; subject: string }, analysis: Analysis): Promise<void> {
  const deliveryKey = `important:${id}`;
  const claimedAt = now();
  const claim = await env.DB.prepare(`INSERT INTO deliveries(delivery_key,kind,gmail_message_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(delivery_key) DO UPDATE SET status='sending',error=NULL,updated_at=excluded.updated_at
    WHERE deliveries.status='failed'`).bind(deliveryKey, "important", id, "sending", claimedAt, claimedAt).run();
  if (!claim.meta.changes) return;
  try {
    await telegram(env, importantMessage({ id, ...mail }, analysis));
    const sentAt = now();
    await env.DB.batch([
      env.DB.prepare("UPDATE deliveries SET status='sent',updated_at=? WHERE delivery_key=?").bind(sentAt, deliveryKey),
      env.DB.prepare("UPDATE emails SET notified_at=? WHERE gmail_message_id=?").bind(sentAt, id)
    ]);
  } catch (error) {
    await env.DB.prepare("UPDATE deliveries SET status='failed',error=?,updated_at=? WHERE delivery_key=?").bind(String(error), now(), deliveryKey).run();
    throw error;
  }
}

async function processOne(env: Env, id: string): Promise<void> {
  const exists = await env.DB.prepare("SELECT sender,subject,importance,analysis_json FROM emails WHERE gmail_message_id=?").bind(id).first<{ sender: string; subject: string; importance: string; analysis_json: string }>();
  if (exists) {
    if (exists.importance === "important") await notifyImportant(env, id, exists, JSON.parse(exists.analysis_json) as Analysis);
    return;
  }
  const message = await getMessage(env, id);
  const mail = extractMessage(message);
  const analysis = await analyzeMail(env, mail);
  await env.DB.prepare(`INSERT OR IGNORE INTO emails
    (gmail_message_id,gmail_thread_id,internal_date,sender,subject,category,importance,summary_zh,action_items_json,deadline,suggested_action,processed_at,analysis_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(message.id, message.threadId, Number(message.internalDate), mail.sender, mail.subject, analysis.category, analysis.importance, analysis.summary_zh, JSON.stringify(analysis.action_items), analysis.deadline, analysis.suggested_action, now(), JSON.stringify(analysis)).run();
  if (analysis.importance !== "important") return;
  await notifyImportant(env, id, mail, analysis);
}

async function sync(env: Env, event: MailEvent): Promise<void> {
  let cursor = await state(env, "gmail_history_id");
  if (!cursor) {
    // 首次部署从当前点开始，避免把整个历史邮箱当成新邮件推送。
    cursor = await getProfileHistoryId(env);
    await setState(env, "gmail_history_id", cursor);
    if (BigInt(event.historyId) <= BigInt(cursor)) return;
  }
  const run = await env.DB.prepare("INSERT INTO sync_runs(from_history_id,to_history_id,status,created_at) VALUES(?,?,?,?)").bind(cursor, event.historyId, "running", now()).run();
  const runId = run.meta.last_row_id;
  try {
    const result = await listNewMessageIds(env, cursor);
    for (const id of result.ids) await processOne(env, id);
    // Gmail 返回的 historyId 是当前邮箱最新游标，队列单并发保证不会倒退。
    await setState(env, "gmail_history_id", result.latestHistoryId);
    await env.DB.prepare("UPDATE sync_runs SET status='success',finished_at=? WHERE id=?").bind(now(), runId).run();
  } catch (error) {
    const message = String(error);
    await env.DB.prepare("UPDATE sync_runs SET status='failed',error=?,finished_at=? WHERE id=?").bind(message, now(), runId).run();
    if (message.includes("Gmail API history") && message.includes("404")) {
      const fresh = await getProfileHistoryId(env);
      const recentIds = await listRecentMessageIds(env);
      for (const id of recentIds) await processOne(env, id);
      await setState(env, "gmail_history_id", fresh);
      await telegram(env, `⚠️ Gmail 同步游标曾过期，已补偿检查最近 2 天的 ${recentIds.length} 封收件箱邮件并重置游标。`);
      return;
    }
    if (message.includes("OAuth")) await telegram(env, `🚨 Gmail 授权异常：${message.slice(0, 500)}`).catch(() => undefined);
    throw error;
  }
}

async function sendDaily(env: Env): Promise<void> {
  const beijingDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const deliveryKey = `daily:${beijingDay}`;
  const claimedAt = now();
  const claim = await env.DB.prepare(`INSERT INTO deliveries(delivery_key,kind,status,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(delivery_key) DO UPDATE SET status='sending',error=NULL,updated_at=excluded.updated_at
    WHERE deliveries.status='failed'`).bind(deliveryKey, "daily", "sending", claimedAt, claimedAt).run();
  if (!claim.meta.changes) return;
  try {
    const result = await env.DB.prepare("SELECT sender,subject,importance,category,summary_zh,action_items_json,deadline FROM emails WHERE internal_date>=? ORDER BY internal_date DESC").bind(now() - 86_400_000).all<Record<string, unknown>>();
    await telegram(env, await buildDailyReport(env, result.results));
    await env.DB.prepare("UPDATE deliveries SET status='sent',updated_at=? WHERE delivery_key=?").bind(now(), deliveryKey).run();
  } catch (error) {
    await env.DB.prepare("UPDATE deliveries SET status='failed',error=?,updated_at=? WHERE delivery_key=?").bind(String(error), now(), deliveryKey).run();
    throw error;
  }
}

async function watch(env: Env): Promise<void> {
  const result = await renewWatch(env);
  await setState(env, "watch_expiration", result.expiration);
  if (!(await state(env, "gmail_history_id"))) await setState(env, "gmail_history_id", result.historyId);
}

function authorized(request: Request, env: Env): boolean {
  return !!env.ADMIN_TOKEN && request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/webhooks/gmail") {
        await verifyPubSubJwt(request, env);
        const event = decodePubSubEvent(await request.json());
        await env.MAIL_QUEUE.send(event);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, service: "gmail-ai-mail-agent" });
      if (request.method === "POST" && url.pathname === "/admin/watch" && authorized(request, env)) {
        await watch(env);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/admin/daily" && authorized(request, env)) {
        await sendDaily(env);
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return Response.json({ error: "Request rejected" }, { status: 401 });
    }
  },

  async queue(batch: MessageBatch<MailEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await sync(env, message.body);
        message.ack();
      } catch (error) {
        console.error("Queue processing failed", error);
        message.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "0 1 * * *") ctx.waitUntil(sendDaily(env));
    else if (controller.cron === "0 18 * * *") ctx.waitUntil(watch(env));
    else if (controller.cron === "*/15 * * * *") {
      ctx.waitUntil((async () => {
        const historyId = await getProfileHistoryId(env);
        await env.MAIL_QUEUE.send({ emailAddress: env.GMAIL_USER, historyId, source: "compensation" });
      })());
    }
  }
} satisfies ExportedHandler<Env, MailEvent>;
