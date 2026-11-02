# Admin AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One streaming AI chat in the admin dashboard that answers staff questions from live data, makes posters and AI images, and limits every answer to what the asker's admin roles allow.

**Architecture:** A new Medusa module `assistant` stores encrypted settings and chat history. `POST /admin/assistant/chat` runs an OpenRouter tool-calling loop and streams NDJSON events. Tools are the desk-report tools ported to TypeScript. Report and poster tools call `/reports/*` over loopback with a process-local key. `admin_read` calls `/admin/*` over loopback with a 60 s token minted for the asker. `db_query` runs in-process. Every tool declares the RBAC policy it needs, and the model only ever sees the tools the asker holds. The admin gets an Assistant page, a Settings → AI page and a super-admin review page.

**Tech Stack:** Medusa v2 (framework, `model.define`, `MedusaService`), Express handlers, `fetch` streaming, sharp, OpenRouter chat completions API, React 18 + `@medusajs/ui` + Tailwind 3.4 + framer-motion 11.18.2, react-query, i18next.

**Spec:** `docs/superpowers/specs/2026-10-29-admin-ai-assistant-design.md` (owner answered "use defaults" on 2026-10-29: read-only plus images, OpenRouter only, yu limited to one named customer, Anson gets stock and orders).

## Global Constraints

- v1 never writes business data. The only writes are its own settings and chat rows.
- Only OpenRouter: `https://openrouter.ai/api/v1/chat/completions`, overridable by env `ASSISTANT_OPENROUTER_URL` for tests only.
- Default models: chat `anthropic/claude-sonnet-5.5`, image `google/gemini-3.1-flash-image`. Both are editable in Settings.
- Keys are stored with AES-256-GCM, using a key from HKDF-SHA256(`projectConfig.http.jwtSecret`, salt `polycards-assistant`, info `openrouter-key-v1`). The API never returns a key, only `last4` and `set: boolean`.
- Tool output passes `redact()` and `capBody(…, 40_000)` (`api/reports/admin/proxy.ts`). Partner passwords and real names never reach the model.
- Super admin means a non-empty role list containing `role_super_admin`, or `hasPermission(*:*)` on a non-empty list. `hasPermission([])` returns true, so an empty list is no access.
- Loop: at most 8 tool rounds per turn. Per-user daily spend cap (default USD 20, Malaysia day) read from settings.
- Answer in the asker's language. Admin strings in `en.json` and `zhCN.json`.
- Every new `/admin/<prefix>` goes in `CUSTOM_ADMIN_RESOURCES`. Every new policy is declared in `src/policies`.
- Backend files on master are not prettier-normalized. Keep diffs to our hunks (memory: format-hook churn).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A limited role phrasing a money question cleverly** (Anson: "how much did we sell today?"). The tool list has no finance tool, and `admin_read /admin/economy` returns 403 for him. The bot says "no access" and shows no numbers. Tested in Task 4 (gating) and Task 8 (route).
2. **yu asking for lists** ("all customers who topped up today"). She has no `admin_read`, no `db_query` and no finance tools, so she gets a refusal. Tested in Task 4.
3. **Empty or stale roles in the session.** No roles means no tools and a 403 on chat. Tested in Task 4.
4. **The client disconnecting mid-stream.** The upstream fetch is aborted, the partial answer is saved with `error: 'aborted'`, and no unhandled rejection is raised. Tested in Task 6.
5. **"Only default group".** Finance tools pass `group: 'default'`, and the system prompt names it. Tested in Task 5 (args map) and the replay in Task 11.

---

### Task 1: Assistant module (models, service, migration, registration)

**Files:**

- Create: `src/modules/assistant/{index.ts,service.ts,models/assistant-settings.ts,models/assistant-conversation.ts,models/assistant-message.ts,migrations/Migration20261029120000.ts}`
- Modify: `medusa-config.ts` (register after packs)
- Test: `integration-tests/http/assistant.spec.ts` (created here, grows in Task 8)

**Interfaces:**

- Produces `ASSISTANT_MODULE = 'assistant'`, plus `AssistantModuleService` with generated CRUD for `AssistantSettings`, `AssistantConversation` and `AssistantMessage`, and:
  - `settings(): Promise<SettingsRow>`: the singleton, created on first read.
  - `spentToday(userId: string, now?: Date): Promise<number>`: USD since 00:00 MYT.
- `assistant_settings`: `id`, `openrouter_key_sealed text null`, `openrouter_key_last4 text null`, `chat_model text`, `image_model text`, `daily_cap_usd numeric default 20`, `updated_by text null`.
- `assistant_conversation`: `id`, `user_id text index`, `title text`, `last_message_at timestamptz`.
- `assistant_message`: `id`, `conversation_id text index` (belongs to the conversation), `role text check in (user, assistant)`, `content text`, `attachments jsonb null`, `images jsonb null`, `tools jsonb null`, `model text null`, `cost_usd numeric default 0`, `tokens_in int default 0`, `tokens_out int default 0`, `error text null`.

- [ ] Write the models and service. Hand-write the migration matching the `model.define` output, and register the module.
- [ ] Add a migration unit spec pinning the table and column names (pattern: `modules/packs/migrations/__tests__`).
- [ ] Run tsc and the unit spec. Commit.

### Task 2: Key vault

**Files:** Create `src/modules/assistant/key-vault.ts`. Test `src/modules/assistant/__tests__/key-vault.unit.spec.ts`.

**Interfaces:** `sealKey(plain: string, secret: string): string` (`v1:<iv b64>:<tag b64>:<ct b64>`), `openKey(sealed: string, secret: string): string | null` (null on a wrong secret or tampering), `last4(plain: string): string`.

- [ ] Write tests: round-trip; a wrong secret gives null; a flipped byte gives null; two seals of one key differ (random IV); last4 of `sk-or-v1-abcd1234` is `1234`.
- [ ] Implement with `node:crypto` `hkdfSync`, `createCipheriv('aes-256-gcm')`. Make the tests pass, then commit.

### Task 3: RBAC surfaces and policies

**Files:** Modify `src/api/admin-rbac.ts` (`assistant: 'assistant'`, `'assistant-settings': 'assistant_setting'`, `'assistant-review': 'assistant_review'`). Create `src/policies/assistant.ts` declaring `assistant_image:create` and `assistant_browse:read`.

- [ ] Run `src/api/__tests__/admin-rbac-coverage.unit.spec.ts`, which must pass with the new routes. Commit.

### Task 4: Access and tool catalog

**Files:** Create `src/api/admin/assistant/{access.ts,tools.ts,periods.ts}`. Test `src/api/admin/assistant/__tests__/{access,tools,periods}.unit.spec.ts`.

**Interfaces:**

- `type Need = { resource: string; operation: string } | 'super_admin'`
- `type AssistantTool = { name; description; parameters: JSONSchema; needs: Need[]; run(args, ctx: ToolCtx): Promise<ToolResult> }`
- `type ToolResult = { text: string } | { text: string; image: { buffer: Buffer; mime: string } }`
- `type Access = { userId: string; roles: string[]; superAdmin: boolean; can(need: Need): Promise<boolean> }`
- `accessFor(scope, authContext): Promise<Access>`, which uses `hasPermission` from `@medusajs/framework` and caches per request.
- `toolsFor(access): Promise<AssistantTool[]>` returns every tool whose `needs` all pass.
- `resolvePeriod` ported from `tools/desk-reports/periods.mjs` (same behaviour).

Tool needs (from the spec table). Each tool's description and parameters are copied verbatim from `tools/desk-reports/tools.mjs`.

| tools                                                          | needs                           |
| -------------------------------------------------------------- | ------------------------------- |
| `economy`, `daily_economy`, `payments`, `pack_sales`, `groups` | `economy:read`                  |
| `player`                                                       | `customer:read`, `payment:read` |
| `challenge`, `challenge_results`                               | `challenge:read`                |
| `signups`, `packs_opened`, `top_pulls`                         | `stats:read`                    |
| `tasks`                                                        | `task:read`                     |
| all `*_poster`                                                 | `assistant_image:create`        |
| `generate_image`                                               | `assistant_image:create`        |
| `packs`, `pack`                                                | `pack:read`                     |
| `low_stock`                                                    | `inventory:read`                |
| `order`                                                        | `delivery_order:read`           |
| `account`                                                      | `customer:read`                 |
| `admin_read`                                                   | `assistant_browse:read`         |
| `db_query`                                                     | `super_admin`                   |

- [ ] Write tests:
  - A super admin gets every tool.
  - Roles holding {store, inventory, inventory_item, goods_receive_note, purchase_invoice, procurement read, delivery_order, pull, automation, `assistant_browse:read`} get `low_stock`, `order` and `admin_read` only.
  - Roles holding {customer, player, payment, delivery_order, ledger, pull, pack_gift, lucky_draw, store read} get `player`, `order` and `account` only.
  - An empty role list gets nothing.
  - Ported period cases: today/yesterday/this_week edges, a custom range, and invalid dates.
- [ ] Implement. Make the tests pass, then commit.

### Task 5: Report bridge (loopback calls)

**Files:** Create `src/api/admin/assistant/bridge.ts`. Modify `src/api/reports/require-report-key.ts` to accept the in-process key as caller `assistant`. Test `src/api/reports/__tests__/require-report-key.unit.spec.ts` (+case) and `src/api/admin/assistant/__tests__/bridge.unit.spec.ts`.

**Interfaces:**

- `ASSISTANT_REPORT_KEY: string` is 64 random hex chars made at module load. It is never logged or sent off-host.
- `callReport({ port, desk, path, params, image? }): Promise<unknown | { buffer: Buffer; mime: string; headers: Record<string,string> }>`
- `adminReadAs({ port, access, path, params }): Promise<unknown>` uses `adminPathError`, `blockedReason` and a token with `actor_id = access.userId`, `app_metadata.roles = access.roles`, `expiresIn: 60`, then `capBody(redact(body))`.

- [ ] Write tests:
  - `requireReportKey` accepts the assistant key and still 401s a wrong one.
  - The `adminReadAs` token carries the asker's id and roles, not `desk-bots-readonly`.
  - A blocked path is refused before any fetch.
- [ ] Implement. Make the tests pass, then commit.

### Task 6: OpenRouter stream and the turn engine

**Files:** Create `src/api/admin/assistant/{openrouter.ts,engine.ts,prompt.ts}`. Test `__tests__/{openrouter,engine,prompt}.unit.spec.ts`.

**Interfaces:**

- `streamChat({ key, model, messages, tools, signal, fetchImpl? }): AsyncGenerator<{ type: 'text'; delta } | { type: 'tool_calls'; calls: {id,name,arguments}[] } | { type: 'usage'; cost; tokensIn; tokensOut }>` parses `data:` SSE lines, merges `tool_calls` deltas by index, and handles `[DONE]` and OpenRouter `: OPENROUTER PROCESSING` comments.
- `runTurn({ settings, key, access, history, userText, images, tools, ctx, emit, signal }): Promise<{ text; images: {url}[]; tools: {name,args,ok,ms}[]; cost; tokensIn; tokensOut; error? }>`
- `systemPrompt(access, toolNames, now): string` with these rules:
  - Answer in the asker's language.
  - Read-only: say how to do edits in admin.
  - Never reveal passwords or keys, and never give logins.
  - "default group" maps to `group: 'default'`.
  - Times are Malaysia time.
  - Use tools, never ask for screenshots.
  - When a needed tool is missing, say the asker's role has no access.
  - Use markdown tables for lists.

- [ ] Write tests:
  - SSE with text, split tool-call deltas and a usage chunk parses right.
  - Engine with a fake stream: tool call → tool run → final text. It stops at 8 rounds. An abort saves partial text with `error: 'aborted'`. A tool error becomes a tool message, not a crash.
  - The prompt names the asker's tools and the no-access rule.
- [ ] Implement. Make the tests pass, then commit.

### Task 7: Images (generation, logo, storage)

**Files:** Create `src/api/admin/assistant/images.ts`. Test `__tests__/images.unit.spec.ts`.

**Interfaces:**

- `generateImage({ key, model, prompt, references?: string[], fetchImpl? }): Promise<Buffer>` uses OpenRouter chat with `modalities: ['image','text']` and decodes the `data:` URL from `choices[0].message.images[0].image_url.url`.
- `brandImage(buf: Buffer): Promise<Buffer>` runs `fitToFeed`, then composites `BRAND_LOGO_B64` bottom-centre at 30% width.
- `storeImage(scope, buf, name): Promise<string>` uses `uploadFilesWorkflow` with public access and returns the URL.

- [ ] Write tests:
  - `brandImage` output is 1080×1350.
  - A non-image answer throws a readable error.
  - The data-URL decode works.
- [ ] Implement. Make the tests pass, then commit.

### Task 8: Admin routes

**Files:** Create:

- `src/api/admin/assistant/chat/route.ts` (POST, NDJSON stream)
- `src/api/admin/assistant/conversations/route.ts` (GET)
- `src/api/admin/assistant/conversations/[id]/route.ts` (GET messages, DELETE)
- `src/api/admin/assistant-settings/route.ts` (GET masked, POST)
- `src/api/admin/assistant-review/route.ts` (GET, all users, paged)

Modify `src/api/middlewares.ts`: chat `bodyParser.sizeLimit '20mb'` and a per-user rate limit. Test `integration-tests/http/assistant.spec.ts`.

**Interfaces:**

- Chat body: `{ conversation_id?: string; message: string (1..4000); images?: string[] (≤4 data URLs, png/jpeg/webp, ≤5 MB each) }`.
- Stream events (one JSON per line): `conversation{id,title}`, `text{delta}`, `tool{id,name,status:'start'|'done'|'error',ms?}`, `image{url}`, `error{message}`, `done{message_id,cost_usd}`, `ping`. Headers are sent at once, with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. A ping goes every 10 s.
- Settings GET returns `{ openrouter_key: { set, last4 }, chat_model, image_model, daily_cap_usd, updated_by, updated_at }`. POST takes `{ openrouter_key?: string|null, chat_model?, image_model?, daily_cap_usd? }`.

- [ ] Write tests (mock OpenRouter is a local http server, `ASSISTANT_OPENROUTER_URL` points at it):
  - Settings GET never has the key, and POST then GET shows `last4`.
  - A non-super-admin role gets 403 on settings and review.
  - Chat with no key gives an `error` event with the "add the key in Settings → AI" text.
  - Chat as super admin streams text plus a `tool` event for `groups`, and saves user and assistant rows.
  - Chat as the Anson role set, asking for the economy, gets a refusal text and no finance tool is called.
  - Conversations are listed only for their owner, and the review lists all.
  - At the daily cap the turn is refused.
- [ ] Implement. Make the tests pass, then commit.

### Task 9: Admin UI

**Files:**

- Create `backend/apps/admin/src/routes/assistant/page.tsx`: top-level page; `permissions: ['assistant:update']`.
- Create `routes/assistant/review/page.tsx`: nested; `assistant_review:read`.
- Create `routes/settings/assistant/page.tsx`: `assistant_setting:read`.
- Create `src/components/assistant/*`: ChatInput (glow border, paste/drag images), MessageList (streamed markdown, tables), ToolTimeline (animated steps), ImageResult (download), ConversationList, EmptyState with role-aware suggestion chips, AiOrb header.
- Create `src/lib/assistant-stream.ts`: a fetch reader yielding events.
- Modify `src/lib/admin-rest.ts` and `src/lib/queries.ts`; add the `en.json`/`zhCN.json` `assistant.*` keys.
- Add pinned deps: `framer-motion@11.18.2`, `react-markdown`, `remark-gfm` (exact versions already in the lock if present).
- Look: 21st.dev components via the connector, re-skinned to the ui-preset dark tokens. Honour `prefers-reduced-motion`.
- Test: `src/lib/__tests__/assistant-stream.test.ts` covers events split across chunks and a trailing partial line. `nav-contract.test.ts` must pass.

- [ ] Write the stream test, then implement the stream reader, the pages and the components.
- [ ] Run the admin tsc, vitest and vite build. Commit.

### Task 10: Grant script

**Files:** Create `src/scripts/grant-assistant.ts` (dry run unless `apply`). It adds `assistant:read|update|delete` to the named roles, plus `assistant_browse:read` to the stock-keeper role. It refuses unknown roles. Pattern: `grant-stock-keeper.ts`.

- [ ] Unit-test the plan builder (which policies go to which role). Commit.

### Task 11: Verification and ship

- [ ] Replay script `scripts/assistant-replay.ts` feeds the exported desk questions as super admin, the Anson role set and the yu role set. It records the tool picked, allowed versus refused, and any data leak on refusals. Mock run in CI; real-key run when a key is set locally.
- [ ] Take Playwright screenshots (QA JWT pattern) of chat, settings and review in en and zhCN, dark.
- [ ] Code review with 5 agents. Fix, then open a PR. After deploy, check streaming through Cloudflare and DO. Granting roles on prod waits for the owner's go.
