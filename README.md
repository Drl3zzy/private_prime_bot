# Prime habit bot

Bridges the Telegram bot for [Prime](https://claude.ai/code/artifact/51acc530-7804-454f-9c45-75cbf17a8e56) habit reminders. Two independent jobs share this repo as a mailbox:

- **GitHub Actions** (`.github/workflows/bot.yml`, every 5 min) — runs `bot.py`, which sends due reminders from `habits.json` to Telegram and records button replies in `answers.json`. Needs the `TELEGRAM_BOT_TOKEN` repository secret.
- **A Claude Code scheduled routine** (hourly, outside this repo) — mirrors the `habits` collection from Prime's database into `habits.json`, and copies new entries from `answers.json` into Prime's `habit_logs`.

Files:
- `habits.json` — list of `{id, name, message, time}`, written by the Claude routine, read by `bot.py`.
- `state.json` — the bot's own memory (Telegram chat id, last processed update, which habits were already asked today). Owned by `bot.py`.
- `answers.json` — append-only log of `{habitId, date, answer, answeredAt}`, written by `bot.py`, read by the Claude routine.

To (re)connect the bot to a chat, message it `/start` on Telegram.
