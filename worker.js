/**
 * Prime habit bot - Cloudflare Worker.
 *
 * Runs every minute (cron trigger) and does the whole Telegram side:
 *   1. reads habits.json from this public repo,
 *   2. sends a reminder for every habit whose time has come today,
 *   3. polls Telegram for /start and for Da/Net button presses,
 *   4. appends new answers to answers.json in this repo.
 *
 * An hourly Claude Code routine then copies answers.json into Prime's
 * habit_logs. Nothing here talks to Prime directly.
 *
 * Bindings it expects:
 *   STATE               - KV namespace (asked flags, chat id, update cursor)
 *   TELEGRAM_BOT_TOKEN  - secret, token from @BotFather
 *   GITHUB_TOKEN        - secret, fine-grained PAT with Contents: read and write
 */

const REPO = "Drl3zzy/private_prime_bot";
const TZ = "Europe/Budapest";

// Fallbacks so the bot works right after deploy, before anything is in KV.
// Both values are already public in this repo's state.json.
const DEFAULT_CHAT_ID = "1057229070";
const DEFAULT_LAST_UPDATE_ID = "31475228";

function nowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

async function tg(env, method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }
  );
  return res.json();
}

function b64ToStr(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function strToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function loadHabits() {
  // Cache-busted so a habit added a minute ago is picked up immediately.
  const res = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/habits.json?t=${Date.now()}`,
    { cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error("habits.json: HTTP " + res.status);
  return res.json();
}

async function appendAnswers(env, added) {
  const url = `https://api.github.com/repos/${REPO}/contents/answers.json`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "prime-habit-worker",
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fetch(`${url}?ref=main&t=${Date.now()}`, { headers });
    if (!cur.ok) throw new Error("read answers.json: HTTP " + cur.status);
    const meta = await cur.json();

    let existing = [];
    try {
      existing = JSON.parse(b64ToStr(meta.content) || "[]");
    } catch (e) {
      existing = [];
    }

    // Skip anything already recorded, so a replayed update can't double-count.
    const seen = new Set(existing.map((a) => `${a.habitId}|${a.date}`));
    const fresh = added.filter((a) => !seen.has(`${a.habitId}|${a.date}`));
    if (!fresh.length) return;

    const body = JSON.stringify(existing.concat(fresh), null, 2) + "\n";
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `answers: ${fresh.map((a) => a.habitId + " " + a.answer).join(", ")}`,
        content: strToB64(body),
        sha: meta.sha,
        branch: "main",
      }),
    });
    if (put.ok) return;
    if (put.status !== 409) throw new Error("write answers.json: HTTP " + put.status);
    // 409 = someone else wrote first; re-read and retry.
  }
  throw new Error("write answers.json: gave up after conflicts");
}

async function tick(env) {
  const { date, hm } = nowParts();
  const log = [];

  const chatId = (await env.STATE.get("chatId")) || DEFAULT_CHAT_ID;

  // 1. Due reminders.
  let habits = [];
  try {
    habits = await loadHabits();
  } catch (e) {
    log.push("habits load failed: " + e.message);
  }

  for (const h of habits) {
    if (!h.time || h.time > hm) continue;
    const key = `asked:${h.id}:${date}`;
    if (await env.STATE.get(key)) continue;

    const sent = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: h.message || "Отметьте: " + h.name,
      reply_markup: {
        inline_keyboard: [[
          { text: "Да", callback_data: `${h.id}|${date}|yes` },
          { text: "Нет", callback_data: `${h.id}|${date}|no` },
        ]],
      },
    });
    if (sent && sent.ok) {
      await env.STATE.put(key, "1", { expirationTtl: 60 * 60 * 24 * 3 });
      log.push("sent " + h.id);
    } else {
      log.push("send failed " + h.id + ": " + JSON.stringify(sent));
    }
  }

  // 2. Incoming updates: /start and button presses.
  const lastId = parseInt(
    (await env.STATE.get("lastUpdateId")) || DEFAULT_LAST_UPDATE_ID, 10
  );
  const updates = await tg(env, "getUpdates", { offset: lastId + 1, timeout: 0 });

  let maxId = lastId;
  const answers = [];

  for (const u of (updates && updates.result) || []) {
    if (u.update_id > maxId) maxId = u.update_id;

    const msg = u.message;
    if (msg && (msg.text || "").trim() === "/start") {
      await env.STATE.put("chatId", String(msg.chat.id));
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: "Готово! Буду присылать сюда напоминания по привычкам из Prime.",
      });
      log.push("start from " + msg.chat.id);
    }

    const cq = u.callback_query;
    if (cq) {
      const [habitId, answerDate, answer] = (cq.data || "").split("|");
      if (habitId && answerDate && answer) {
        answers.push({
          habitId,
          date: answerDate,
          answer,
          answeredAt: new Date().toISOString(),
        });
        await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
        await tg(env, "sendMessage", {
          chat_id: cq.message.chat.id,
          text: answer === "yes" ? "Отмечено ✅" : "Хорошо, в следующий раз 👍",
        });
        log.push("answer " + habitId + " " + answer);
      }
    }
  }

  // Only write when it actually moved - KV free tier allows ~1k writes/day.
  if (maxId !== lastId) await env.STATE.put("lastUpdateId", String(maxId));
  if (answers.length) await appendAnswers(env, answers);

  return { date, hm, log };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  // Opening the worker URL with ?run=1 forces a tick - handy for testing.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("run") !== "1") {
      return new Response("Prime habit bot worker. Add ?run=1 to force a tick.");
    }
    try {
      const result = await tick(env);
      return Response.json(result);
    } catch (e) {
      return new Response("error: " + e.message, { status: 500 });
    }
  },
};
