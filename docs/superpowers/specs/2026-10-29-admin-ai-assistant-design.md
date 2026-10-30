# Admin AI Assistant — design

Date: 2026-10-29. Branch `feat/admin-ai-assistant`. Owner request (voice/text, 2026-10-29).

## Intent

One chatbot inside the admin dashboard replaces the five Discord desk bots
(Growth, Support, Finance, Store, Developer). Staff ask anything in one place —
numbers, orders, stock, customers, posters, images — and the bot answers from
live data. What a person can ask follows what their admin login can see:

- **Admin (super admin):** everything.
- **Anson:** stock and orders (his Automation operator + Order manager + Stock
  keeper roles). No money side: no economy, payments, profit, wallets.
- **yu (Support viewer):** one customer at a time — their account, orders,
  payments, delivery status. No totals, no stats, no "all customers" lists.

It must look premium and futuristic (owner: "looks good, futuristic, animation
must be good"), inspired by 21st.dev components. Settings has a page where the
owner pastes the AI API keys.

## Goals

1. Chat page in admin with streaming answers, history per user, image upload
   (staff send screenshots constantly), image results with download.
2. Answers come from the same data the desks use: the report routes, the
   poster renderers, read-only admin screens, and (super admin only) read-only
   SQL.
3. Access is enforced on the server by RBAC policies, never by the prompt.
4. Image generation (AI art) and the existing poster tools (challenge, stages,
   results, standings, tasks, achievements, brand/milestone, top pulls).
5. Settings → AI page: OpenRouter key (+ image key, see Q2), model choice,
   daily spend cap. Keys are write-only; the page shows only the last 4 chars.
6. Super admins can review every question every staff member asked
   (Conversations tab) — the owner's "review all the questions users ask".
7. Answers in the asker's language (staff write mostly Mandarin); admin UI
   strings in en + zhCN.

## Non-goals (v1)

- **No writes.** The bot never edits orders, invoices, prices or wallets
  ("PI-00015 改成 qty 1" stays a manual admin action). See Q1.
- No code tools (`code_files/search/read`): they read a git clone on the
  owner's PC. The Developer desk stays on Discord for code questions.
- Discord desks are not touched or switched off; they keep running until the
  owner retires them.
- No web browsing tool (it is an exfiltration path and returned stale scrapes).
- ~~No scheduled posts~~ — reversed the same day (owner: "make sure you are
  also able to do the scheduled tasks"); see "Agent tools" below. The Hermes
  crons keep running until the owner moves them.

## Anti-goals

- A role reaching data its admin screens would refuse (e.g. Anson getting the
  day's revenue by asking cleverly).
- Partner passwords, login tokens, API keys or verified real names reaching
  the model or the chat — same masking as the desks (`redact`, `scrubSecrets`).
- Keys shown back in full anywhere, or logged.
- A cheap gacha/casino look (PRODUCT.md anti-reference).

## Who can ask what

Every tool declares the RBAC policy of the admin screen that shows the same
data. The tool list sent to the model holds only tools the asker's roles allow,
and every call is re-checked on the server. Mapping is by policy, never by
person, so new staff inherit it from their roles.

| Tool group | Data | Policy | Admin | Anson | yu |
|---|---|---|---|---|---|
| Finance (`economy`, `daily_economy`, `payments`, `pack_sales`, `groups`) | Money totals, group filter | economy screen policy | ✓ | ✗ | ✗ |
| Player money (`player`) | One player's wallet/top-ups | `customer:read` + `payment:read` | ✓ | ✗ | ✓ |
| Growth data (`challenge*`, `signups`, `packs_opened`, `tasks`, `top_pulls`) | Challenge, signups, tasks | stats screen policies | ✓ | ✗ | ✗ |
| Posters (all `*_poster`, `brand_logo`) | JPEG 1080×1350 | `assistant_image:use` | ✓ | ✗ | ✗ |
| AI image generation | New art | `assistant_image:use` | ✓ | ✗ | ✗ |
| Store (`packs`, `pack`, `low_stock`) | Packs, sold-out, RTP, stock | `pack:read` / `inventory:read` | ✓ | stock ✓ | ✗ |
| Stock + procurement (`inventory`, `to_buy`, `to_ship`, GRN, PI) | On hand, to-buy | `inventory:read`, `procurement:read`, `goods_receive_note:read`, `purchase_invoice:read` | ✓ | ✓ | ✗ |
| Orders (`order`, delivery orders) | Status, tracking | `delivery_order:read` | ✓ | ✓ | ✓ (one order / one customer) |
| Customer (`find_customer`, `account`, `customer_*`) | One customer | `customer:read` | ✓ | ✗ | ✓ (needs a name/email/phone/order no.) |
| `admin_read` (any admin screen) | Whatever the screen shows | the screen's own RBAC (runs as the asker) | ✓ | ✓ (his screens only) | ✗ (see Q3) |
| `db_query` (read-only SQL) | Anything | super admin only | ✓ | ✗ | ✗ |

Anson's exact tools fall out of his live roles (role ids in memory); yu's out of
Support viewer's 9 `:read` policies.

## Coverage — what staff actually asked (Discord review, ~180 messages)

| Asked (examples, from the desk logs) | Tool | Status |
|---|---|---|
| economy/sales/top-ups/signups **only default group** (asked ~10×) | finance tools with `group` param | Tested path: every finance tool takes `group`; the bot must apply it, not explain it |
| profit %, this week vs last, customers in profit, wallet totals, <RM 50 balances, min-withdraw impact | `economy`, `daily_economy`, `db_query` | Admin only |
| per-pack sales, top single top-ups, who pulled the most expensive card today/yesterday | `pack_sales`, `top_pulls`, `db_query` | ✓ |
| top-up failure reasons | `payments` | ✓ |
| procurement: cards in requested/processed/RTS with qty + FMV; "make a file with pictures"; count of one card in open orders | `to_buy`, `inventory`, `admin_read` | ✓ (file = table + images in chat; CSV export later) |
| posters: challenge stages, stage-1-unlocked push, signups milestone, tasks week, achievements ladder, Crazy Sunday | poster tools | ✓ |
| English/Chinese captions for a poster | model | ✓ |
| AI art ("design a Poncho pack", atmosphere backgrounds) | image generation | ✓ |
| stock 0 / owed, sold-out packs, real RTP, orders waiting to ship | store + stock tools | ✓ |
| one player's account + latest delivery, where is order #ZZ9Q7X | `account`, `order` | ✓ |
| screenshots as the question | image upload + vision model | ✓ |
| "change PI-00015 qty" | — | Refused in v1 (read-only), bot says how to do it in admin |
| "give me the login for Collector…" | — | Refused: partner credentials stay masked |
| code questions ("show me the buyback code") | — | Out of scope v1 (Developer desk) |

## Architecture

### Backend (`backend/packages/api`)

- **Routes** `/admin/assistant/*` (added to `CUSTOM_ADMIN_RESOURCES`, policies
  declared in `src/policies` so boot sync keeps them):
  - `POST /admin/assistant/chat` — streams the answer (fetch stream, NDJSON
    events: `text`, `tool_start`, `tool_end`, `image`, `error`, `done`;
    heartbeat every 10 s; `Cache-Control: no-cache`, `X-Accel-Buffering: no`).
  - `GET/DELETE /admin/assistant/conversations[/:id]` — own history.
  - `GET /admin/assistant/review` — all conversations (super admin).
  - `GET/POST /admin/assistant/settings` — keys (masked), model, caps.
- **Engine:** OpenRouter chat completions (OpenAI-compatible) with tool calling.
  Loop capped at 8 tool steps per turn; per-user daily spend cap from settings.
  Default chat model `anthropic/claude-sonnet-5.5` (vision + tools); editable.
- **Runs as the asker.** `admin_read` copies the loopback-JWT pattern of
  `/reports/admin/read` but mints the 60 s token with the asker's `actor_id`
  and roles, so the real admin RBAC answers. Report/poster tools are called
  in-process and gated by their declared policy. Super admin = literal
  `role_super_admin` or `hasPermission(*:*)` on a **non-empty** role list
  (`hasPermission([])` returns true — trap).
- **SQL:** reuses `db-query.ts` checks and masking, with its own queue so chat
  and desks don't starve each other.
- **Keys at rest:** AES-256-GCM, key derived with HKDF from the backend's JWT
  secret (no new env var / no DO spec change). If that secret is ever rotated
  the page says "re-enter the key".
- **Images:** posters rendered in-process; AI images via the image key, fitted
  to 1080×1350 with the logo stamped (port of the Hermes `stamp-logo` hook;
  logo copied into the backend). Uploaded with `uploadFilesWorkflow`.
- **Storage (migration):** `assistant_settings` (singleton, encrypted keys),
  `assistant_conversation` (user_id, title), `assistant_message` (role,
  content, tool calls, tokens, cost). Settings changes write an
  `admin_action_audit` row (new CHECK value; coin-flip clash rule applies).

### Agent tools (added 2026-10-29, `agent-tools.ts`, `schedule.ts`)

Owner: "search through its own memories or conversations… search through the
folders… make sure you are also able to do the scheduled tasks."

- **Memory** (`assistant_memory`): `remember` / `recall` / `forget`. Personal
  notes are seen only by their writer; shared notes (super admin only) by
  everyone. The newest notes (≈3,000 chars) go into every chat's instructions,
  fenced as facts, not orders.
- **Past chats**: `search_chats` — the asker's own chats; a super admin may
  search everyone's.
- **Assets**: `find_assets` (image grant only) — pack art + stage art, card and
  slab images, images the assistant made before, as URLs `marketing_poster`
  (`feature_url`) and `generate_image` (`reference_urls`) take.
- **Scheduled tasks** (`assistant_schedule`): `schedule_task` /
  `list_schedules` / `cancel_schedule`, daily or weekly at a Malaysia time,
  at most 10 per person. The worker's minute job (`jobs/assistant-schedules.ts`)
  claims each due task by moving its next run first (no double runs across
  workers), then posts the instruction to the chat route **as the person who
  set it, with their roles as they are at run time** — same access, daily cap,
  limits and logs as a typed question. It calls the app's own origin
  (`PAYMENT_CALLBACK_BASE`, override `ASSISTANT_SERVER_URL`), never
  admin.polycards.gg (Cloudflare challenges machine calls there). A run that
  lands while the person is mid-chat retries in 2 minutes; a deleted chat
  reruns in a new one; a person with no roles left gets the error recorded.
- Every agent tool needs the assistant grant, so a role-less session gets none.
- **Injection limits** (two security reviews, 2026-10-29): lasting writes
  (`remember`, `forget`, `schedule_task`, `cancel_schedule`) run only before
  any tool output is in the turn, and never in a scheduled run; a shared note
  must quote the admin's current message; image fetches reach only our own
  hosts or URLs a pack or card holds, every redirect hop included.

### Voice (added 2026-10-29, `voice.ts`, `speak/route.ts`, admin `lib/voice.ts`)

Owner: "make sure it's able to answer and reply, listening… using OpenRouter".
Listening goes through OpenRouter chat completions; speaking through its
`/audio/speech`. Measured 2026-10-29 by reading hostile samples aloud and
writing them down again: the chat voice model `openai/gpt-audio-mini`
answered a question it was given to read, told the joke a sentence asked
for and added words to Chinese; dedicated speech models read the text as
written. The listening model wrote the same questions and instructions down
without answering them, so it stays on chat completions.

- **Listening:** the admin records 16 kHz mono WAV (Web Audio, no MediaRecorder:
  OpenRouter takes wav, not webm), stops on silence (energy VAD), and posts it
  as `audio` to the chat route. The listening model (`stt_model`, default
  `google/gemini-3.5-flash-lite`) writes it down via `input_audio`; the
  transcript is streamed back and asked like a typed question. Its cost is
  charged with the answer.
- **Speaking:** `POST /admin/assistant/speak {message_id}` reads one of the
  asker's answers aloud with a speaking model (`voice_model`, default
  `google/gemini-3.8-flash-lite-tts`, voice `Kore`), streamed as PCM16 mono
  chunks (the rate comes first, from the content type) the admin plays
  gaplessly. Model and voice are checked against OpenRouter's list of speaking
  models (`/models?output_modalities=speech`, kept an hour), so a chat voice
  model can't be picked; while the list is out of reach only their form is.
  - Markdown is made speakable (tables row by row, no URLs), capped at 1,500
    characters. RM amounts are said as "12 ringgit 50 sen" (12令吉50仙 in
    Chinese): the speech model read "RM 12.50" in English as dollars.
  - A speech model's first sound comes later the more text it gets (4 s for a
    line, 12-20 s for a full answer), so an answer is read in pieces cut at
    sentence ends: a first of about 120 characters, then about 360, each
    fetched while the last plays. Live 2026-10-29: first sound at 3.7 s, a
    41 s reading all fetched in 17 s.
  - Speech returns no bill: the hidden `voice` row gets a safe overestimate
    at once (the model's listed prices; 4 cents per 1,000 characters when
    unknown), so it counts toward today's cap whichever day the answer was
    written, and OpenRouter's own figure replaces it once the generation
    shows up (about 7 s later; looked up for ~18 s).
- **UI:** a mic in the composer (one spoken question, answer read aloud), a
  Talk mode (hands-free: listen → answer → speak → listen; tap the orb to
  interrupt; three silent turns end it), and Read aloud on every answer.
- **One at a time:** one answer and one read-aloud per staff member, held in
  Redis across both web instances (`user-lock.ts`; per process without
  REDIS_URL), so parallel requests can't all pass the daily cap.
- **iPhone/iPad:** an open mic sends Safari's output to the quiet earpiece, so
  there answers play with the mic shut and only a tap interrupts. Safari 17+
  gets `navigator.audioSession` 'playback' (plays through the silent switch)
  and 'play-and-record' while a mic is open.
- **Speakers:** talking over an answer must beat the answer's own echo. Its
  loudness coming back through the mic is learned from its first 0.8 s and
  speech has to be twice that for 0.4 s (`createBargeInDetector`), since
  browser echo cancellation may not hear Web Audio playback.
- Migration `Migration20261029081358`: role check gains `voice`; three
  settings columns with defaults. Additive.

### Admin (`backend/apps/admin`)

- **Assistant page** (top-level sidebar, `assistant:use`): conversation list,
  chat stream, tool steps shown as an animated timeline ("checking stock…"),
  role-aware suggestion chips, drag/paste screenshots, image results with
  download, markdown tables.
- **Settings → AI** (`src/routes/settings/assistant/page.tsx`,
  `assistant_settings:update`): keys (write-only, last 4 shown, Test button),
  model, daily cap.
- **Conversations review** (super admin): every question by every staff member.
- **Look:** 21st.dev components as inspiration/code, re-skinned to the
  `@medusajs/ui` dark tokens; `framer-motion` pinned at the `11.18.2` already in
  the tree; honours `prefers-reduced-motion`.

## Done means

1. Unit + integration tests: tool gating per role, SQL refusal, key encryption
   round-trip, masked settings response, stream events.
2. Replay: the exported desk questions run as super admin, as Anson's roles and
   as yu's role (mock LLM for CI; real OpenRouter key for the final run): the
   right tool is picked, allowed questions get data, forbidden ones get a clear
   "no access" — never data.
3. Playwright screenshots of the chat, settings and review pages (en + zhCN).
4. Streaming checked through the real Cloudflare → DO path after deploy.

## Open questions for the owner

1. Read-only + images for v1 (no edits by the bot)?
2. "Image key": OpenRouter alone can make images (Gemini image, GPT image).
   Is the second key a separate OpenAI key, or is OpenRouter enough?
3. yu: mirror exactly what her admin screens allow (she can browse the
   customer list there), or refuse anything wider than one named customer?
4. Anson gets stock **and** orders (his three roles) — OK?

## Calls I made (check these)

- Chat model default Claude Sonnet 5.5 via OpenRouter; editable in Settings.
- Keys encrypted with a key derived from the JWT secret, not a new env var.
- Posters + AI images limited to admins by a new `assistant_image:use` policy
  (grantable to growth staff later).
- Code tools and writes out of v1; Discord desks untouched.
