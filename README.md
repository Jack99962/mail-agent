# Gmail AI 邮件管家

基于 Cloudflare Workers、Queues、D1、Gmail Push Notifications、OpenRouter 和 Telegram Bot 的邮件管家。

## 已实现

- Pub/Sub OIDC JWT 验签后的 Gmail Webhook 接收
- Gmail History 增量同步、D1 游标、消息 ID 去重
- Queue 单并发消费、失败重试与死信队列
- 不读取附件；正文仅发送给 AI，不长期落库
- AI 重要性、摘要、待办、截止时间与分类分析
- 重要邮件 Telegram 即时通知及 Gmail 原文链接
- 北京时间每天 09:00 AI 日报
- 每日自动续订 Gmail Watch；每 15 分钟补偿同步
- OAuth、游标过期告警；Watch 状态持久化

## 1. 前置资源

1. Google Cloud 中启用 Gmail API 和 Pub/Sub API。
2. 创建 Pub/Sub Topic，例如 `gmail-push`。
3. 给 Gmail 系统服务账号 `gmail-api-push@system.gserviceaccount.com` 授予该 Topic 的 `Pub/Sub Publisher`。
4. 创建用于 Pub/Sub Push 身份认证的服务账号，例如 `pubsub-push@PROJECT_ID.iam.gserviceaccount.com`。
5. 创建 Telegram Bot，取得 Bot Token 和目标 Chat ID。
6. 安装 Node.js 20+，执行 `npm install`，并登录 `npx wrangler login`。

Gmail OAuth refresh token 必须含 `https://www.googleapis.com/auth/gmail.readonly` 权限。生产环境建议在 Google OAuth Playground 或自有一次性授权脚本中取得；不要提交到 Git。

## 2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create mail-agent-db
npx wrangler queues create gmail-mail-events
npx wrangler queues create gmail-mail-events-dlq
```

把 D1 返回的 `database_id` 写入 `wrangler.toml`，并替换其中所有 `YOUR_*` / `REPLACE_*` 值。然后执行：

```bash
npm run db:migrate:remote
```

## 3. 写入 Secrets

逐项运行 `npx wrangler secret put NAME`：

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`
- `OPENROUTER_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ADMIN_TOKEN`（生成一个高强度随机值）

在 [OpenRouter Keys](https://openrouter.ai/settings/keys) 创建 API Key。默认接口为 `https://openrouter.ai/api/v1`，默认模型为 `openai/gpt-4.1-mini`。可修改 `wrangler.toml` 中的 `AI_MODEL`，使用任意 OpenRouter `author/model-slug` 模型标识。`OPENROUTER_APP_URL` 和 `OPENROUTER_APP_NAME` 用于请求来源标识。

## 4. 部署并连接 Pub/Sub

```bash
npm run deploy
```

创建 Push Subscription：

```bash
gcloud pubsub subscriptions create gmail-push-to-worker \
  --topic=gmail-push \
  --push-endpoint=https://YOUR-WORKER.workers.dev/webhooks/gmail \
  --push-auth-service-account=pubsub-push@PROJECT_ID.iam.gserviceaccount.com \
  --push-auth-token-audience=https://YOUR-WORKER.workers.dev/webhooks/gmail \
  --ack-deadline=30
```

确保 `PUBSUB_AUDIENCE` 与 `--push-auth-token-audience` 完全一致，`PUBSUB_SERVICE_ACCOUNT` 与 Push 身份服务账号一致。

## 5. 首次启动 Watch

```bash
curl -X POST https://YOUR-WORKER.workers.dev/admin/watch \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

之后 Worker 会在北京时间每天 02:00 自动续订。Gmail Watch 通常最长约 7 天，但这里每天续订。

## 6. 验收

1. `GET /health` 应返回 `ok: true`。
2. 给 Gmail 发一封明确要求回复的测试邮件，确认 Queue 消费和 Telegram 推送。
3. 重投同一 Pub/Sub 消息，确认不会重复通知。
4. 用 `/admin/daily`（同样带 Admin Bearer Token）手动验证日报。
5. 在 Cloudflare Dashboard 检查 Worker Logs、Queue 重试/DLQ 和 D1 数据。

## 隐私与运维

- D1 只保存邮件元数据、AI 摘要和结构化分析，不保存完整正文。
- 邮件正文会传给所配置的 AI 服务，请按组织合规要求选择供应商和数据保留策略。
- `emails` 可配置生命周期清理；当前 V1 不自动删除结构化历史，以保证 24 小时日报完整。
- DLQ 中的失败消息需设置告警并人工重放。
