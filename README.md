# Prime habit bot

Telegram reminders for the habits tracked in
[Prime](https://claude.ai/code/artifact/51acc530-7804-454f-9c45-75cbf17a8e56).

Two independent jobs use this repo as a mailbox:

- **A Cloudflare Worker** (`worker.js`, cron every minute) sends a reminder for
  every habit in `habits.json` whose time has come, and records Da/Net button
  presses into `answers.json`. It holds the Telegram bot token and a GitHub PAT
  as Cloudflare secrets - nothing sensitive lives in this repo.
- **An hourly Claude Code routine** (outside this repo) copies new entries from
  `answers.json` into Prime's `habit_logs`, which is what moves a habit's streak.

`habits.json` is written by hand (via Claude) when a habit is added in Prime;
Prime's database stays the source of truth for everything else.

Files:
- `habits.json` - list of `{id, name, message, time}`, read by the Worker.
  `time` is when the *reminder* fires, which may be earlier than the habit's own
  time in Prime.
- `answers.json` - log of `{habitId, date, answer, answeredAt}`, one entry per
  habit per day, written by the Worker and read by the Claude routine.
- `state.json` - leftover from the old GitHub Actions version; the Worker keeps
  its state in Cloudflare KV instead.

To (re)connect the bot to a chat, message it `/start` on Telegram.

## History

The first version ran `bot.py` on a GitHub Actions cron. GitHub throttled the
schedule down to roughly one run every few hours, which is useless for
time-of-day reminders, so the job moved to Cloudflare Workers.
