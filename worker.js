/**
 * Prime habit bot - Cloudflare Worker.
 *
 * Two entry points:
 *   - cron (every minute): sends reminders for habits that are due today
 *     according to their schedule, and one evening summary,
 *   - webhook (POST from Telegram): handles /start, Da/Net/Skip button
 *     presses, the follow-up "why not" question, and one-line money entries.
 *
 * Everything it writes goes into this repo as JSON. An hourly Claude Code
 * routine carries answers.json and money_queue.json into Prime's database.
 * Nothing here talks to Prime directly.
 *
 * Bindings it expects:
 *   STATE               - KV namespace (asked flags, chat id, summary flag)
 *   TELEGRAM_BOT_TOKEN  - secret, token from @BotFather
 *   GITHUB_TOKEN        - secret, fine-grained PAT with Contents: read and write
 *
 * The webhook is authenticated with Telegram's secret_token header, whose
 * value is a hash of the bot token - so publishing this file leaks nothing.
 */

const REPO = "Drl3zzy/private_prime_bot";
const TZ = "Europe/Budapest";
const SUMMARY_TIME = "21:30";

// Fallback so reminders work before anyone has sent /start.
// Already public in this repo's history.
const DEFAULT_CHAT_ID = "1057229070";

const REASONS = [
  { code: "forgot", label: "Забыл", text: "забыл" },
  { code: "notime", label: "Не было времени", text: "не было времени" },
  { code: "sick", label: "Болел", text: "болел" },
  { code: "other", label: "Другое", text: "другое" }
];

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

function dateFromStr(s) { const p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function shiftDate(s, days) {
  const d = dateFromStr(s);
  d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}
function weekStartOf(s) {
  const d = dateFromStr(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
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

async function loadRepoJson(path, fallback) {
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${REPO}/main/${path}?t=${Date.now()}`,
      { cf: { cacheTtl: 0 } }
    );
    if (!res.ok) return fallback;
    return await res.json();
  } catch (e) {
    return fallback;
  }
}

/** Read-modify-write of a JSON array file in the repo, with retry on conflict. */
async function updateRepoJson(env, path, mutate) {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "prime-habit-worker",
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await fetch(`${url}?ref=main&t=${Date.now()}`, { headers });
    let existing = [], sha = undefined;
    if (cur.ok) {
      const meta = await cur.json();
      sha = meta.sha;
      try { existing = JSON.parse(b64ToStr(meta.content) || "[]"); } catch (e) { existing = []; }
    } else if (cur.status !== 404) {
      throw new Error("read " + path + ": HTTP " + cur.status);
    }

    const next = mutate(existing);
    if (!next) return; // nothing to write

    const put = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "bot: " + path,
        content: strToB64(JSON.stringify(next, null, 2) + "\n"),
        sha: sha,
        branch: "main",
      }),
    });
    if (put.ok) return;
    if (put.status !== 409) throw new Error("write " + path + ": HTTP " + put.status);
  }
  throw new Error("write " + path + ": gave up after conflicts");
}

// ---------- расписание привычек (те же правила, что в приложении) ----------

function scheduleType(h) {
  return (h.scheduleType === "days" || h.scheduleType === "week") ? h.scheduleType : "daily";
}
function scheduleDays(h) {
  return (h.scheduleDays && h.scheduleDays.length) ? h.scheduleDays : [1, 2, 3, 4, 5];
}
function weeklyTarget(h) { return Math.max(1, Math.min(7, Number(h.weeklyTarget) || 3)); }

function isScheduledOn(h, date) {
  if (scheduleType(h) === "days") return scheduleDays(h).indexOf(dateFromStr(date).getDay()) !== -1;
  return true;
}
function weekYesCount(answers, habitId, date) {
  const start = weekStartOf(date);
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(start, i);
    if (answers.some((a) => a.habitId === habitId && a.date === d && a.answer === "yes")) n++;
  }
  return n;
}
/** Надо ли сегодня вообще спрашивать про эту привычку. */
function shouldAskToday(h, answers, date) {
  if (!isScheduledOn(h, date)) return false;
  if (scheduleType(h) === "week" && weekYesCount(answers, h.id, date) >= weeklyTarget(h)) return false;
  return true;
}

function reminderKeyboard(habitId, date) {
  return {
    inline_keyboard: [[
      { text: "Да", callback_data: `${habitId}|${date}|yes` },
      { text: "Нет", callback_data: `${habitId}|${date}|no` },
      { text: "⏸", callback_data: `${habitId}|${date}|skip` },
    ]],
  };
}

// ---------- крон ----------

async function sendDueReminders(env) {
  const { date, hm } = nowParts();
  const log = [];
  const chatId = (await env.STATE.get("chatId")) || DEFAULT_CHAT_ID;
  const habits = await loadRepoJson("habits.json", []);
  const answers = await loadRepoJson("answers.json", []);

  for (const h of habits) {
    if (!h.time || h.time > hm) continue;
    if (!shouldAskToday(h, answers, date)) continue;
    const key = `asked:${h.id}:${date}`;
    if (await env.STATE.get(key)) continue;

    const sent = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: h.message || "Отметьте: " + h.name,
      reply_markup: reminderKeyboard(h.id, date),
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

/** Вечерняя сводка: что отмечено за день, один раз в сутки. */
async function sendEveningSummary(env, date, hm) {
  if (hm < SUMMARY_TIME) return null;
  const key = `summary:${date}`;
  if (await env.STATE.get(key)) return null;

  const habits = await loadRepoJson("habits.json", []);
  const answers = await loadRepoJson("answers.json", []);
  const due = habits.filter((h) => shouldAskToday(h, answers, date) || answers.some((a) => a.habitId === h.id && a.date === date));
  if (!due.length) {
    await env.STATE.put(key, "1", { expirationTtl: 60 * 60 * 36 });
    return null;
  }

  const done = [], missing = [];
  for (const h of due) {
    const a = answers.find((x) => x.habitId === h.id && x.date === date);
    if (a && a.answer === "yes") done.push(h.name);
    else if (a && a.answer === "skip") continue;
    else missing.push(h.name);
  }

  let text = "Итог дня: " + done.length + " из " + (done.length + missing.length) + " ✅";
  if (done.length) text += "\nСделано: " + done.join(", ");
  if (missing.length) text += "\nОсталось: " + missing.join(", ");

  const chatId = (await env.STATE.get("chatId")) || DEFAULT_CHAT_ID;
  await tg(env, "sendMessage", { chat_id: chatId, text: text });
  await env.STATE.put(key, "1", { expirationTtl: 60 * 60 * 36 });
  return "summary sent";
}

/** Запасной опрос, пока вебхук не настроен. При активном вебхуке getUpdates
 *  возвращает 409 и функция тихо ничего не делает. */
async function pollUpdates(env) {
  const log = [];
  const lastId = parseInt((await env.STATE.get("lastUpdateId")) || "0", 10);
  const res = await tg(env, "getUpdates", { offset: lastId + 1, timeout: 0 });
  if (!res || !res.ok) return log;

  let maxId = lastId;
  for (const u of res.result || []) {
    if (u.update_id > maxId) maxId = u.update_id;
    try {
      await handleUpdate(env, u);
      log.push("polled " + u.update_id);
    } catch (e) {
      log.push("update " + u.update_id + " failed: " + e.message);
    }
  }
  if (maxId !== lastId) await env.STATE.put("lastUpdateId", String(maxId));
  return log;
}

async function tick(env) {
  const result = await sendDueReminders(env);
  try {
    const s = await sendEveningSummary(env, result.date, result.hm);
    if (s) result.log.push(s);
  } catch (e) {
    result.log.push("summary failed: " + e.message);
  }
  try {
    result.log.push(...(await pollUpdates(env)));
  } catch (e) {
    result.log.push("poll failed: " + e.message);
  }
  return result;
}

// ---------- обработка сообщений ----------

async function recordAnswer(env, habitId, date, answer) {
  await updateRepoJson(env, "answers.json", (list) => {
    const i = list.findIndex((a) => a.habitId === habitId && a.date === date);
    const entry = { habitId, date, answer, answeredAt: new Date().toISOString() };
    if (i >= 0) {
      if (list[i].answer === answer) return null; // ничего не изменилось
      if (list[i].reason) entry.reason = list[i].reason;
      list[i] = entry;
    } else {
      list.push(entry);
    }
    return list;
  });
}

async function recordReason(env, habitId, date, reason) {
  await updateRepoJson(env, "answers.json", (list) => {
    const i = list.findIndex((a) => a.habitId === habitId && a.date === date);
    if (i < 0) return null;
    if (list[i].reason === reason) return null;
    list[i] = Object.assign({}, list[i], { reason: reason });
    return list;
  });
}

/** Строка вида "-250 продукты" или "+3000 зарплата". */
function parseMoney(text) {
  const m = String(text).trim().match(/^([+-])\s*(\d+(?:[.,]\d{1,2})?)\s*(.*)$/);
  if (!m) return null;
  return {
    direction: m[1] === "-" ? "out" : "in",
    amount: parseFloat(m[2].replace(",", ".")),
    note: (m[3] || "").trim(),
  };
}

async function queueMoney(env, parsed, date) {
  const id = "q_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  await updateRepoJson(env, "money_queue.json", (list) => {
    list.push({
      id: id,
      direction: parsed.direction,
      amount: parsed.amount,
      note: parsed.note,
      date: date,
      createdAt: new Date().toISOString(),
    });
    return list;
  });
  return id;
}

const HELP_TEXT =
  "Что я умею:\n\n" +
  "/список — показать напоминания\n" +
  "/добавить 07:00 Чистка зубов — новое напоминание\n" +
  "/время 1 08:30 — поменять время у №1\n" +
  "/удалить 1 — убрать №1\n\n" +
  "Ещё записываю деньги одной строкой: «-250 продукты» или «+3000 зарплата».";

function habitLine(h, i) {
  let when = "каждый день";
  if (h.scheduleType === "days") {
    const names = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
    when = (h.scheduleDays || [1, 2, 3, 4, 5]).map((n) => names[n]).join(", ");
  } else if (h.scheduleType === "week") {
    when = (h.weeklyTarget || 3) + " раз в неделю";
  }
  return (i + 1) + ". " + (h.time || "--:--") + " — " + h.name + " (" + when + ")";
}

async function habitsListText(habits) {
  if (!habits.length) return "Напоминаний пока нет.\n\nДобавить: /добавить 07:00 Чистка зубов";
  return "Напоминания бота:\n\n" + habits.map(habitLine).join("\n") +
    "\n\nПоменять время: /время 1 08:30\nУбрать: /удалить 1";
}

/** Команды управления напоминаниями. Возвращает true, если сообщение обработано. */
async function handleCommand(env, chatId, text) {
  const raw = text.trim();
  if (raw.charAt(0) !== "/") return false;
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, "");
  const say = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t });

  if (cmd === "/помощь" || cmd === "/help") { await say(HELP_TEXT); return true; }

  if (cmd === "/список" || cmd === "/list") {
    const habits = await loadRepoJson("habits.json", []);
    await say(await habitsListText(habits));
    return true;
  }

  if (cmd === "/добавить" || cmd === "/add") {
    const time = parts[1] || "";
    const name = parts.slice(2).join(" ").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time) || !name) {
      await say("Формат: /добавить 07:00 Чистка зубов");
      return true;
    }
    const hhmm = ("0" + time).slice(-5);
    const id = "tg_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    await updateRepoJson(env, "habits.json", (list) => {
      list.push({ id, name, message: "Отметьте: " + name, time: hhmm, scheduleType: "daily", identity: "" });
      return list;
    });
    await say("Добавил: " + hhmm + " — " + name + ".\nВ Prime появится в течение часа.");
    return true;
  }

  if (cmd === "/время" || cmd === "/time") {
    const idx = parseInt(parts[1], 10) - 1;
    const time = parts[2] || "";
    if (!(idx >= 0) || !/^\d{1,2}:\d{2}$/.test(time)) {
      await say("Формат: /время 1 08:30\nНомер смотрите в /список");
      return true;
    }
    const hhmm = ("0" + time).slice(-5);
    let changed = null;
    await updateRepoJson(env, "habits.json", (list) => {
      if (!list[idx]) return null;
      list[idx].time = hhmm;
      changed = list[idx].name;
      return list;
    });
    await say(changed ? ("Готово: «" + changed + "» теперь в " + hhmm + ".") : "Нет напоминания с таким номером — посмотрите /список");
    return true;
  }

  if (cmd === "/удалить" || cmd === "/del") {
    const idx = parseInt(parts[1], 10) - 1;
    if (!(idx >= 0)) { await say("Формат: /удалить 1\nНомер смотрите в /список"); return true; }
    let removed = null;
    await updateRepoJson(env, "habits.json", (list) => {
      if (!list[idx]) return null;
      removed = list[idx].name;
      list.splice(idx, 1);
      return list;
    });
    await say(removed
      ? ("Убрал напоминание «" + removed + "». В Prime сама привычка и её история остаются — удалите её там, если она больше не нужна.")
      : "Нет напоминания с таким номером — посмотрите /список");
    return true;
  }

  return false;
}

async function handleUpdate(env, update) {
  const { date } = nowParts();
  const msg = update.message;

  if (msg && (msg.text || "").trim() === "/start") {
    await env.STATE.put("chatId", String(msg.chat.id));
    await tg(env, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Готово! Буду присылать сюда напоминания по привычкам.\n\n" + HELP_TEXT,
    });
    return;
  }

  if (msg && msg.text) {
    if (await handleCommand(env, msg.chat.id, msg.text)) return;

    const money = parseMoney(msg.text);
    if (money && money.amount > 0) {
      await queueMoney(env, money, date);
      await tg(env, "sendMessage", {
        chat_id: msg.chat.id,
        text: (money.direction === "out" ? "Записал трату " : "Записал доход ") +
          money.amount + (money.note ? " — " + money.note : "") +
          ".\nВ Prime появится в течение часа.",
      });
      return;
    }
  }

  const cq = update.callback_query;
  if (!cq) return;

  const parts = (cq.data || "").split("|");

  // Причина пропуска: r|habitId|date|code
  if (parts[0] === "r" && parts.length === 4) {
    const reason = (REASONS.find((r) => r.code === parts[3]) || {}).text || parts[3];
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Понял" });
    await recordReason(env, parts[1], parts[2], reason);
    if (cq.message) {
      await tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: "❌ Нет — " + reason, callback_data: "done" }]] },
      });
    }
    return;
  }

  if (parts.length !== 3) return;
  const [habitId, answerDate, answer] = parts;
  if (["yes", "no", "skip"].indexOf(answer) === -1) return;

  const reply = { yes: "Отмечено ✅", no: "Хорошо, бывает", skip: "День заморожен ⏸" }[answer];
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: reply });
  await recordAnswer(env, habitId, answerDate, answer);

  if (cq.message) {
    if (answer === "no") {
      // Спрашиваем причину — данные для разбора недели.
      await tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: {
          inline_keyboard: [
            REASONS.slice(0, 2).map((r) => ({ text: r.label, callback_data: `r|${habitId}|${answerDate}|${r.code}` })),
            REASONS.slice(2).map((r) => ({ text: r.label, callback_data: `r|${habitId}|${answerDate}|${r.code}` })),
          ],
        },
      });
    } else {
      const mark = answer === "yes" ? "✅ Да" : "⏸ Заморожено";
      await tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: mark, callback_data: "done" }]] },
      });
    }
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram пушит апдейты сюда.
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

    if (url.searchParams.get("run") === "1") {
      try {
        return Response.json(await tick(env));
      } catch (e) {
        return new Response("error: " + e.message, { status: 500 });
      }
    }

    return new Response("Prime habit bot worker. Add ?run=1 to force a tick.");
  },
};
