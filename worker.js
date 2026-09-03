/**
 * Prime habit bot - Cloudflare Worker.
 *
 * Two entry points:
 *   - cron (every minute): sends a reminder for every habit in habits.json
 *     whose time has come today,
 *   - webhook (POST from Telegram): handles /start and Da/Net button presses
 *     the instant they happen, and appends answers to answers.json.
 *
 * An hourly Claude Code routine then copies answers.json into Prime's
 * habit_logs. Nothing here talks to Prime directly.
 *
 * Bindings it expects:
 *   STATE               - KV namespace (asked flags, chat id)
 *   TELEGRAM_BOT_TOKEN  - secret, token from @BotFather
 *   GITHUB_TOKEN        - secret, fine-grained PAT with Contents: read and write
 *
 * The webhook is authenticated with Telegram's secret_token header, whose
 * value is a hash of the bot token - so publishing this file leaks nothing.
 */

const REPO = "Drl3zzy/private_prime_bot";
const TZ = "Europe/Budapest";

// Fallback so reminders work before anyone has sent /start.
// Already public in this repo's history.
const DEFAULT_CHAT_ID = "1057229070";

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

/** Shared secret for the webhook: derived from the bot token, so it is safe
 *  to keep this code public. Telegram sends it back in a header. */
async function webhookSecret(env) {
  const data = new TextEncoder().encode("prime-habit-webhook:" + env.TELEGRAM_BOT_TOKEN);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  const res = await fetch(
    `https://raw.githubusercontent.com/${REPO}/main/habits.json?t=${Date.now()}`,
    { cf: { cacheTtl: 0 } }
  );
  if (!res.ok) throw new Error("habits.json: HTTP " + res.status);
  return res.json();
}

/** One answer per habit per day wins - pressing the button twice is a no-op. */
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

    const seen = new Set(existing.map((a) => `${a.habitId}|${a.date}`));
    const fresh = [];
    for (const a of added) {
      const key = `${a.habitId}|${a.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(a);
    }
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
    // 409 = someone wrote first; re-read and retry.
  }
  throw new Error("write answers.json: gave up after conflicts");
}

/** Cron job: send whatever is due today and not yet asked. */
async function sendDueReminders(env) {
  const { date, hm } = nowParts();
  const log = [];
  const chatId = (await env.STATE.get("chatId")) || DEFAULT_CHAT_ID;

  let habits = [];
  try {
    habits = await loadHabits();
  } catch (e) {
    log.push("habits load failed: " + e.message);
    return { date, hm, log };
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
  return { date, hm, log };
}

/** Webhook: one update, handled immediately. */
async function handleUpdate(env, update) {
  const msg = update.message;
  if (msg && (msg.text || "").trim() === "/start") {
    await env.STATE.put("chatId", String(msg.chat.id));
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Готово! Буду присылать сюда напоминания по привычкам из Prime.",
    });
    return;
  }

  const cq = update.callback_query;
  if (!cq) return;

  const [habitId, date, answer] = (cq.data || "").split("|");
  if (!habitId || !date || !answer) return;

  // Answer first so the button stops spinning right away.
  await tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: answer === "yes" ? "Отмечено ✅" : "Хорошо, в следующий раз 👍",
  });

  // Replace the buttons with the recorded choice, so it is visible later.
  if (cq.message) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: answer === "yes" ? "✅ Да" : "❌ Нет", callback_data: "done" },
        ]],
      },
    });
  }

  await appendAnswers(env, [{
    habitId,
    date,
    answer,
    answeredAt: new Date().toISOString(),
  }]);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram pushes updates here.
    if (request.method === "POST") {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== (await webhookSecret(env))) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await handleUpdate(env, await request.json());
      } catch (e) {
        console.log("update failed: " + e.message);
      }
      return new Response("ok");
    }

    // Manual reminder tick, handy for testing.
    if (url.searchParams.get("run") === "1") {
      try {
        return Response.json(await sendDueReminders(env));
      } catch (e) {
        return new Response("error: " + e.message, { status: 500 });
      }
    }

    return new Response("Prime habit bot worker. Add ?run=1 to force a tick.");
  },
};
