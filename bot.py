"""Telegram side of the Prime habit reminders.

Runs every 5 minutes via GitHub Actions (which has normal internet access).
It never talks to the Prime artifact directly - it only reads/writes JSON
files in this repo. A separate hourly Claude Code routine mirrors
habits.json out of Prime and answers.json back into Prime.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TZ = ZoneInfo("Europe/Budapest")
API = "https://api.telegram.org/bot" + TOKEN


def api_call(method, params=None, timeout=10):
    url = API + "/" + method
    data = json.dumps(params).encode("utf-8") if params is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main():
    habits = load_json("habits.json", [])
    state = load_json("state.json", {"chatId": None, "lastUpdateId": 0, "asked": {}})
    answers = load_json("answers.json", [])

    now = datetime.now(TZ)
    today = now.strftime("%Y-%m-%d")
    now_hm = now.strftime("%H:%M")

    # 1. Send any reminders that are due and not yet asked today.
    if state.get("chatId"):
        for h in habits:
            key = h["id"] + "_" + today
            if state["asked"].get(key):
                continue
            if h.get("time", "") and h["time"] <= now_hm:
                text = h.get("message") or ("Отметьте: " + h["name"])
                try:
                    api_call("sendMessage", {
                        "chat_id": state["chatId"],
                        "text": text,
                        "reply_markup": {"inline_keyboard": [[
                            {"text": "Да", "callback_data": h["id"] + "|" + today + "|yes"},
                            {"text": "Нет", "callback_data": h["id"] + "|" + today + "|no"},
                        ]]},
                    })
                    state["asked"][key] = True
                except Exception as e:
                    print("send failed for " + h.get("id", "?") + ": " + str(e), file=sys.stderr)

    # 2. Poll for new messages / button presses.
    params = {"timeout": 0}
    if state.get("lastUpdateId"):
        params["offset"] = state["lastUpdateId"] + 1
    try:
        url = API + "/getUpdates?" + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=10) as resp:
            updates = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print("getUpdates failed: " + str(e), file=sys.stderr)
        updates = {"ok": False, "result": []}

    for u in updates.get("result", []):
        uid = u.get("update_id", 0)
        if uid > state.get("lastUpdateId", 0):
            state["lastUpdateId"] = uid

        msg = u.get("message")
        if msg and (msg.get("text") or "").strip() == "/start":
            state["chatId"] = msg["chat"]["id"]
            try:
                api_call("sendMessage", {
                    "chat_id": state["chatId"],
                    "text": "Готово! Буду присылать сюда напоминания по привычкам из Prime.",
                })
            except Exception as e:
                print("welcome message failed: " + str(e), file=sys.stderr)

        cq = u.get("callback_query")
        if cq:
            data = (cq.get("data") or "").split("|")
            if len(data) == 3:
                habit_id, date, answer = data
                answers.append({
                    "habitId": habit_id, "date": date, "answer": answer,
                    "answeredAt": now.isoformat(),
                })
                try:
                    api_call("answerCallbackQuery", {"callback_query_id": cq["id"]})
                    api_call("sendMessage", {
                        "chat_id": cq["message"]["chat"]["id"],
                        "text": "Отмечено ✅" if answer == "yes" else "Хорошо, в следующий раз 👍",
                    })
                except Exception as e:
                    print("callback reply failed: " + str(e), file=sys.stderr)

    save_json("state.json", state)
    save_json("answers.json", answers)


if __name__ == "__main__":
    main()
