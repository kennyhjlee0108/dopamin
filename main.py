import os, re, json
from datetime import datetime, timedelta, date
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from google import genai
from supabase import create_client, Client

load_dotenv()
app = FastAPI()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

supabase: Client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

_knowledge_path = os.path.join(BASE_DIR, "knowledge.txt")
KNOWLEDGE = open(_knowledge_path).read() if os.path.exists(_knowledge_path) else ""


class ChatRequest(BaseModel):
    message: str
    userId: str
    userName: str
    history: list = []
    context: dict = {}


class SessionRequest(BaseModel):
    userId: str
    minutes: int


class BreakdownRequest(BaseModel):
    task: str
    userName: str
    userId: str


class TaskCompletionRequest(BaseModel):
    userId: str
    taskTitle: str
    minutesSpent: int = 0


class EstimateRequest(BaseModel):
    task: str
    userId: str


class CalendarNoteRequest(BaseModel):
    userId: str
    date: str    # ISO date YYYY-MM-DD
    content: str


# ── Helpers ──────────────────────────────────────────────────────────────────

def calculate_streak(user_id: str) -> int:
    """Count consecutive days (ending today) with at least one session."""
    today = date.today()
    # Fetch last 60 days in one query
    since = (today - timedelta(days=60)).isoformat()
    res = (
        supabase.table("focus_sessions")
        .select("created_at")
        .eq("user_id", user_id)
        .gte("created_at", since)
        .execute()
    )
    if not res.data:
        return 0

    session_dates = {row["created_at"][:10] for row in res.data}
    streak = 0
    for i in range(60):
        day = (today - timedelta(days=i)).isoformat()
        if day in session_dates:
            streak += 1
        else:
            break
    return streak


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def read_root():
    return FileResponse(os.path.join(BASE_DIR, "static", "index.html"))


@app.get("/get-profile/{user_id}")
async def get_profile(user_id: str):
    res = supabase.table("user_profiles").select("*").eq("id", user_id).execute()
    if not res.data:
        supabase.table("user_profiles").insert({"id": user_id, "total_capital": 0}).execute()
        profile = {"total_capital": 0}
    else:
        profile = res.data[0]

    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    res_today = (
        supabase.table("focus_sessions")
        .select("minutes")
        .eq("user_id", user_id)
        .gte("created_at", today)
        .lt("created_at", tomorrow)
        .execute()
    )
    profile["today_minutes"]  = sum(r["minutes"] for r in res_today.data) if res_today.data else 0
    profile["today_sessions"] = len(res_today.data) if res_today.data else 0
    profile["streak"]         = calculate_streak(user_id)
    profile["is_returning"]   = (profile.get("total_capital", 0) > 0)
    return profile


@app.post("/complete-session")
async def complete_session(data: SessionRequest):
    user_id, minutes = data.userId, data.minutes

    res = supabase.table("user_profiles").select("total_capital").eq("id", user_id).execute()
    current   = res.data[0]["total_capital"] if res.data else 0
    new_total = current + minutes

    supabase.table("user_profiles").upsert({"id": user_id, "total_capital": new_total}).execute()
    supabase.table("focus_sessions").insert({"user_id": user_id, "minutes": minutes}).execute()

    today    = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    res_today = (
        supabase.table("focus_sessions")
        .select("minutes")
        .eq("user_id", user_id)
        .gte("created_at", today)
        .lt("created_at", tomorrow)
        .execute()
    )
    return {
        "status":         "success",
        "new_total":      new_total,
        "today_minutes":  sum(r["minutes"] for r in res_today.data),
        "today_sessions": len(res_today.data),
        "streak":         calculate_streak(user_id),
    }


@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        ctx            = request.context
        tasks_list     = ctx.get("tasks", [])
        active_task    = ctx.get("activeTask") or "none"
        timer_mode     = ctx.get("timerMode", "idle")
        timer_running  = ctx.get("timerRunning", False)
        sessions_today = ctx.get("sessionsToday", 0)
        streak         = ctx.get("streak", 0)
        is_returning   = ctx.get("isReturning", False)
        tasks_text     = "\n".join(f"  - {t}" for t in tasks_list) if tasks_list else "  (none added yet)"

        streak_line = f"{streak}-day streak 🔥" if streak > 1 else ("first day! 🌱" if sessions_today > 0 else "no sessions yet today")

        instruction = f"""You are 'Study Friend' inside the intime app — a personal, ADHD-aware focus companion for {request.userName}.

PERSONALITY:
- Warm and personal. You know {request.userName} and address them by name naturally.
- Concise. ADHD brains skip long text. 2–4 sentences max per response.
- Practical. Always point to the next smallest physical action.
- Non-judgmental. ADHD paralysis is neurological, not a character flaw.
- Celebratory. Every session, every checked task is worth acknowledging.

IMPORTANT — WHAT YOU CAN AND CANNOT DO:
- You CANNOT add tasks. Tasks are managed by {request.userName} in the task panel on the left.
- When {request.userName} names something they want to work on, treat it as their task and encourage them to add it in the task panel, or just help them get started on it.
- You CAN start the timer by including [START_TIMER] — but ONLY when they explicitly say they're ready (e.g. "ok", "let's go", "start now", "yes").
- You CAN suggest breaking a task down, using the 2-min rule, or starting with just 5 minutes.

SUGGESTION RULES — THIS IS CRITICAL:
Your last line MUST be: Suggestions: [label 1], [label 2], [label 3]
These must read like natural things {request.userName} would type next as a direct reply to YOUR message.
Match the moment exactly:
- After asking "what are you working on?" → answers they'd give: e.g. "Reading chapter 3, Writing my essay, Not sure yet"
- After they mention a task or topic → follow-up actions: e.g. "Help me start, Break it down, Set a 25 min timer"
- After a session ends → what comes next: e.g. "Start another, Need a longer break, Done for today"
- After they say they're stuck → micro-steps: e.g. "Just open the file, Try 5 minutes, Talk me through it"
- After encouragement → momentum actions: e.g. "Let's go, Add it to my tasks, Tell me more"
NEVER use generic filler suggestions ("Keep going", "Take a break", "I'm stuck") unless they are genuinely the most relevant options for this exact moment.

HARD LIMITS on suggestions — no exceptions:
- NEVER suggest "Browse task ideas", "Search for examples", "Find resources", "Look it up", or ANYTHING that implies browsing the web or accessing external data — you cannot do this
- NEVER suggest opening another app, website, or tool
- Suggestions MUST only be things {request.userName} can type directly to you in this chat or actions within the intime app
- If you cannot do something, do not suggest it, period

FORMAT:
- Short paragraphs or • bullet points only.
- **Bold** key actions or phrases.
- End every response with the Suggestions line — no exceptions.

CURRENT STATE OF {request.userName}'s SESSION:
- Timer: {timer_mode} {'▶ running' if timer_running else '⏸ paused'}
- Active task: {active_task}
- Sessions today: {sessions_today} | Streak: {streak_line}
- Task list:
{tasks_text}

ADHD SCIENCE (weave in naturally when helpful, never lecture):
{KNOWLEDGE}
"""

        contents = [{"role": h["role"], "parts": [{"text": h["text"]}]} for h in request.history]
        contents.append({"role": "user", "parts": [{"text": request.message}]})

        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config={"system_instruction": instruction},
        )

        raw   = response.text
        clean = re.sub(r"```[\s\S]*?```|\[START_TIMER\]|\[PAUSE_TIMER\]", "", raw).strip()

        # Parse suggestions — strip the Suggestions: line from the message
        suggestions = None
        lines = clean.split("\n")
        clean_lines = []
        for line in lines:
            if line.strip().lower().startswith("suggestions:"):
                parts = line.split(":", 1)[1].strip().split(",")
                suggestions = [s.strip() for s in parts if s.strip()][:3]
            else:
                clean_lines.append(line)
        clean = "\n".join(clean_lines).strip()

        # Contextual fallback if AI didn't provide suggestions
        if not suggestions:
            if timer_running:
                suggestions = ["Pause timer", "How much time left?", "I got distracted"]
            elif timer_mode == "work" and not timer_running:
                suggestions = ["Start the timer", "Not ready yet", "Help me pick a task"]
            elif "short" in timer_mode or "long" in timer_mode:
                suggestions = ["Back to work", "Need more time", "Done for today"]
            else:
                suggestions = ["Add a task", "Start focusing", "I need help"]

        return {
            "ai_message":  clean,
            "suggestions": suggestions,
            "start_timer": "[START_TIMER]" in raw,
        }
    except Exception as e:
        print(f"Chat error: {e}")
        return {
            "ai_message":  "Something went wrong — please try again.",
            "suggestions": ["Try again", "Start timer", "I need help"],
            "start_timer": False,
        }


@app.post("/breakdown")
async def breakdown_task(request: BreakdownRequest):
    try:
        instruction = """You are an ADHD task breakdown specialist.
Break the given task into 3-5 tiny, concrete, physical micro-steps.
Each step must start with an action verb and take under 5 minutes to complete.
Return ONLY a valid JSON array of strings — no other text, no markdown, no explanation.
Example: ["Open the document", "Read the last paragraph", "Write one new sentence"]
"""
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[{"role": "user", "parts": [{"text": f"Break down this task: {request.task}"}]}],
            config={"system_instruction": instruction},
        )
        match = re.search(r'\[[\s\S]*?\]', response.text)
        steps = json.loads(match.group()) if match else [
            "Open the relevant file or app",
            "Spend 2 minutes reading what you already have",
            "Do just the very first small action",
        ]
        return {"steps": steps[:5], "task": request.task}
    except Exception as e:
        print(f"Breakdown error: {e}")
        return {
            "steps": ["Open the relevant file", "Read what's already there", "Do the first small thing"],
            "task": request.task,
        }


@app.post("/record-task-completion")
async def record_task_completion(data: TaskCompletionRequest):
    supabase.table("task_completions").insert({
        "user_id":       data.userId,
        "task_title":    data.taskTitle,
        "minutes_spent": data.minutesSpent,
    }).execute()
    return {"status": "ok"}


@app.post("/estimate-task")
async def estimate_task(request: EstimateRequest):
    # Fetch user's real task completion history (only sessions with tracked time)
    res = (
        supabase.table("task_completions")
        .select("task_title,minutes_spent")
        .eq("user_id", request.userId)
        .gte("minutes_spent", 1)
        .execute()
    )
    history = res.data or []

    # Keyword similarity — skip stop words
    stop = {"a","an","the","to","do","my","and","or","with","for","in","of","on","at","is","it"}
    task_words = set(request.task.lower().split()) - stop
    similar = []
    for row in history:
        past_words = set(row["task_title"].lower().split()) - stop
        overlap = len(task_words & past_words)
        if overlap >= 1:
            similar.append((overlap, row["minutes_spent"]))

    if len(similar) >= 2:
        total_w = sum(s[0] for s in similar)
        weighted = sum(s[0] * s[1] for s in similar) / total_w
        return {
            "estimated_minutes": round(weighted),
            "confidence":        "high" if len(similar) >= 4 else "medium",
            "based_on":          f"{len(similar)} of your past tasks",
        }

    # AI fallback
    prompt = (
        f'Estimate realistically how many minutes it takes to complete: "{request.task}"\n'
        'Return ONLY valid JSON: {"minutes": <integer>, "reason": "<one short phrase>"}\n'
        'Be honest and specific. Avoid rounding to exact multiples of 5 unless natural.'
    )
    try:
        resp = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
        )
        m = re.search(r'\{[\s\S]*?\}', resp.text)
        if m:
            d = json.loads(m.group())
            return {
                "estimated_minutes": max(1, int(d.get("minutes", 25))),
                "confidence":        "low",
                "based_on":          "AI estimate",
            }
    except Exception as e:
        print(f"Estimate error: {e}")

    return {"estimated_minutes": 25, "confidence": "low", "based_on": "default"}


@app.get("/calendar/{user_id}")
async def get_calendar(user_id: str, year: int, month: int, tz_offset: int = 0):
    """tz_offset = client's UTC offset in minutes (+60 for UTC+1, -300 for UTC-5)."""
    # Last day of requested month
    if month == 12:
        last_day = date(year, 12, 31)
    else:
        last_day = date(year, month + 1, 1) - timedelta(days=1)

    # Widen query by 1 day each side to handle any timezone edge case
    query_start = (date(year, month, 1) - timedelta(days=1)).isoformat()
    query_end   = (last_day + timedelta(days=2)).isoformat()

    sessions_res = (
        supabase.table("focus_sessions")
        .select("minutes,created_at")
        .eq("user_id", user_id)
        .gte("created_at", query_start)
        .lt("created_at",  query_end)
        .execute()
    )
    tasks_res = (
        supabase.table("task_completions")
        .select("task_title,completed_at")
        .eq("user_id", user_id)
        .gte("completed_at", query_start)
        .lt("completed_at",  query_end)
        .execute()
    )
    notes_res = (
        supabase.table("calendar_notes")
        .select("date,content")
        .eq("user_id", user_id)
        .gte("date", date(year, month, 1).isoformat())
        .lte("date", last_day.isoformat())
        .execute()
    )

    month_prefix = f"{year:04d}-{month:02d}"

    def to_local(ts: str) -> str:
        from datetime import datetime as dt
        parsed = dt.fromisoformat(ts.replace("Z", "+00:00"))
        local  = parsed + timedelta(minutes=tz_offset)
        return local.strftime("%Y-%m-%d")

    daily: dict = {}

    for row in (sessions_res.data or []):
        d = to_local(row["created_at"])
        if not d.startswith(month_prefix):
            continue
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["minutes"]  += row["minutes"]
        daily[d]["sessions"] += 1

    for row in (tasks_res.data or []):
        d = to_local(row["completed_at"])
        if not d.startswith(month_prefix):
            continue
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["tasks"].append(row["task_title"])

    for row in (notes_res.data or []):
        d = row["date"]
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["note"] = row["content"]

    return {"year": year, "month": month, "days": daily}


@app.post("/calendar/note")
async def save_calendar_note(data: CalendarNoteRequest):
    supabase.table("calendar_notes").upsert(
        {"user_id": data.userId, "date": data.date, "content": data.content},
        on_conflict="user_id,date",
    ).execute()
    return {"status": "ok"}


@app.get("/get-stats/{user_id}")
async def get_stats(user_id: str):
    today = datetime.now().date()
    stats = []
    for i in range(-3, 4):
        target = today + timedelta(days=i)
        res = (
            supabase.table("focus_sessions")
            .select("minutes")
            .eq("user_id", user_id)
            .gte("created_at", target.isoformat())
            .lt("created_at", (target + timedelta(days=1)).isoformat())
            .execute()
        )
        stats.append({
            "date":     target.strftime("%a"),
            "minutes":  sum(r["minutes"] for r in res.data),
            "sessions": len(res.data),
            "isToday":  i == 0,
        })
    return stats
