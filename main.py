import os, re, json, logging, time
from collections import defaultdict, deque
from datetime import datetime, timedelta, date
from typing import Annotated, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Depends, Cookie, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from google import genai
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests
from itsdangerous import URLSafeTimedSerializer, BadSignature
from supabase import create_client, Client
import stripe

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger("intime")

# ── Config ────────────────────────────────────────────────────────────────────

load_dotenv()
IS_PROD       = os.getenv("ENV", "development") == "production"
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

GOOGLE_CLIENT_ID = os.getenv(
    "GOOGLE_CLIENT_ID",
    "121246915230-hrfas5irqhnb8sgg8qoc37ba51dqkg0g.apps.googleusercontent.com",
)

_sess_secret = os.getenv("SESSION_SECRET_KEY", "")
if not _sess_secret:
    if IS_PROD:
        raise RuntimeError("SESSION_SECRET_KEY must be set in production")
    logger.warning("SESSION_SECRET_KEY not set — using insecure dev default")
    _sess_secret = "dev-only-insecure-default-set-SESSION_SECRET_KEY-in-production"

# ── Session cookie management ─────────────────────────────────────────────────

_serializer    = URLSafeTimedSerializer(_sess_secret, salt="intime-session-v1")
SESSION_MAX_AGE = 7 * 24 * 3600  # 7 days

def _make_session(user_id: str) -> str:
    return _serializer.dumps(user_id)

def _verify_session(token: str) -> Optional[str]:
    try:
        return _serializer.loads(token, max_age=SESSION_MAX_AGE)
    except (BadSignature, Exception):
        return None

# Reusable google_requests.Request() — not thread-safe to reuse across async
# workers, so we create one per verification call below.

# ── FastAPI dependency ────────────────────────────────────────────────────────

async def get_current_user(session: Annotated[Optional[str], Cookie()] = None) -> str:
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user_id = _verify_session(session)
    if not user_id:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return user_id

CurrentUser = Annotated[str, Depends(get_current_user)]

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="intime",
    docs_url=None  if IS_PROD else "/docs",
    redoc_url=None if IS_PROD else "/redoc",
    openapi_url=None if IS_PROD else "/openapi.json",
)

# ── Middleware ────────────────────────────────────────────────────────────────

_PROD_ORIGINS = ["https://intimeapp.org", "https://www.intimeapp.org"]
_DEV_ORIGINS  = ["http://localhost:8000", "http://127.0.0.1:8000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_PROD_ORIGINS if IS_PROD else _PROD_ORIGINS + _DEV_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["intimeapp.org", "www.intimeapp.org", "localhost", "127.0.0.1", "*.up.railway.app"],
)

_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com https://js.stripe.com https://fonts.googleapis.com; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data: https:; "
    "frame-src https://accounts.google.com https://js.stripe.com; "
    "connect-src 'self' https://accounts.google.com https://api.stripe.com; "
    "object-src 'none'; base-uri 'self';"
)

@app.middleware("http")
async def request_middleware(request: Request, call_next):
    # Bypass TrustedHostMiddleware for Railway's internal healthcheck.
    # This decorator runs before TrustedHostMiddleware (last-added = outermost),
    # so returning here means the Host header is never validated for /health.
    if request.url.path == "/health":
        return JSONResponse({"status": "ok"})
    start    = time.monotonic()
    response = await call_next(request)
    ms       = int((time.monotonic() - start) * 1000)
    logger.info("request method=%s path=%s status=%d ms=%d",
                request.method, request.url.path, response.status_code, ms)
    response.headers["Content-Security-Policy"] = _CSP
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["Referrer-Policy"]         = "strict-origin-when-cross-origin"
    return response

# ── Rate limiter (in-memory, per-user) ───────────────────────────────────────

_rate_buckets: dict[str, deque] = defaultdict(deque)

def _rate_ok(key: str, max_calls: int, window_secs: int) -> bool:
    now    = time.monotonic()
    bucket = _rate_buckets[key]
    while bucket and bucket[0] < now - window_secs:
        bucket.popleft()
    if len(bucket) >= max_calls:
        return False
    bucket.append(now)
    return True

# ── Clients ───────────────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

supabase: Client = create_client(os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_KEY", ""))
_gemini_key      = os.getenv("GEMINI_API_KEY", "")
ai_client        = genai.Client(api_key=_gemini_key) if _gemini_key else None

from stripe_client import (
    create_or_get_customer,
    create_checkout_session_url,
    create_portal_session_url,
    get_user_id_by_customer,
    sync_subscription,
)

_knowledge_path = os.path.join(BASE_DIR, "knowledge.txt")
KNOWLEDGE = open(_knowledge_path).read() if os.path.exists(_knowledge_path) else ""

# ── Pydantic models ───────────────────────────────────────────────────────────
# userId fields are kept for backwards-compat but IGNORED on the server.
# Identity always comes from the verified session cookie (CurrentUser).

class GoogleAuthRequest(BaseModel):
    credential: str

class ChatRequest(BaseModel):
    message:  str
    userName: str
    history:  list = []
    context:  dict = {}
    userId:   Optional[str] = None   # ignored — use CurrentUser

class SessionRequest(BaseModel):
    minutes: int
    userId:  Optional[str] = None    # ignored

class BreakdownRequest(BaseModel):
    task:     str
    userName: str
    userId:   Optional[str] = None   # ignored

class TaskCompletionRequest(BaseModel):
    taskTitle:    str
    minutesSpent: int = 0
    userId:       Optional[str] = None  # ignored

class EstimateRequest(BaseModel):
    task:   str
    userId: Optional[str] = None     # ignored

class CalendarNoteRequest(BaseModel):
    date:    str     # ISO date YYYY-MM-DD
    content: str
    userId:  Optional[str] = None    # ignored

class CheckoutRequest(BaseModel):
    email:  str = ""
    userId: Optional[str] = None     # ignored

class TimerSettingsRequest(BaseModel):
    work:   int
    short:  int
    long:   int
    userId: Optional[str] = None     # ignored

class PortalRequest(BaseModel):
    userId: Optional[str] = None     # ignored

# ── Helpers ───────────────────────────────────────────────────────────────────

def calculate_streak(user_id: str) -> int:
    today = date.today()
    since = (today - timedelta(days=60)).isoformat()
    res   = (
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

def _set_session_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        "session",
        _make_session(user_id),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=IS_PROD,
        samesite="lax",
        path="/",
    )

# ── Auth routes ───────────────────────────────────────────────────────────────

@app.post("/auth/google")
async def auth_google(data: GoogleAuthRequest, response: Response):
    """Verify a Google ID token and issue a session cookie."""
    try:
        info = google_id_token.verify_oauth2_token(
            data.credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as exc:
        logger.warning("Google token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Google credential")
    user_id = info["sub"]
    logger.info("auth event=sign_in user_id=%s", user_id)
    _set_session_cookie(response, user_id)
    return {"user_id": user_id, "status": "ok"}


@app.post("/auth/logout")
async def auth_logout(response: Response):
    """Clear the session cookie."""
    response.delete_cookie("session", path="/", httponly=True, secure=IS_PROD, samesite="lax")
    return {"status": "ok"}


@app.get("/auth/me")
async def auth_me(user_id: CurrentUser):
    """Return the current session's user_id, or 401 if no valid session."""
    return {"user_id": user_id}

# ── App routes ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/")
async def read_root():
    return FileResponse(os.path.join(BASE_DIR, "static", "landing.html"))


@app.get("/app")
async def read_app():
    return FileResponse(os.path.join(BASE_DIR, "static", "index.html"))


@app.get("/pricing")
async def read_pricing():
    return FileResponse(os.path.join(BASE_DIR, "static", "pricing.html"))


@app.get("/get-profile")
async def get_profile(user_id: CurrentUser):
    logger.info("auth event=get_profile user_id=%s", user_id)
    try:
        res = supabase.table("user_profiles").select("*").eq("id", user_id).execute()
        if not res.data:
            supabase.table("user_profiles").insert({"id": user_id, "total_capital": 0}).execute()
            profile = {"total_capital": 0}
        else:
            profile = res.data[0]

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
        profile["today_minutes"]  = sum(r["minutes"] for r in res_today.data) if res_today.data else 0
        profile["today_sessions"] = len(res_today.data) if res_today.data else 0
        profile["streak"]         = calculate_streak(user_id)
        profile["is_returning"]   = (profile.get("total_capital", 0) > 0)
        profile["timer_work"]     = profile.get("timer_work")
        profile["timer_short"]    = profile.get("timer_short")
        profile["timer_long"]     = profile.get("timer_long")

        if not profile.get("is_pro") and profile.get("stripe_customer_id") and stripe.api_key:
            try:
                subs = stripe.Subscription.list(
                    customer=profile["stripe_customer_id"], status="active", limit=1
                )
                if subs.data:
                    sync_subscription(supabase, user_id, subs.data[0])
                    profile["is_pro"] = True
            except Exception as se:
                logger.warning("Stripe check failed in get-profile: %s", se)

        profile["is_pro"] = profile.get("is_pro", False)
        return profile
    except Exception as e:
        logger.error("get-profile error for %s: %s", user_id, e)
        return JSONResponse(
            {"error": str(e), "today_minutes": 0, "today_sessions": 0,
             "streak": 0, "is_returning": False, "is_pro": False},
            status_code=500,
        )


@app.post("/complete-session")
async def complete_session(data: SessionRequest, user_id: CurrentUser):
    if not _rate_ok(f"session:{user_id}", 30, 60):
        return JSONResponse({"error": "rate_limit"}, status_code=429)

    res       = supabase.table("user_profiles").select("total_capital").eq("id", user_id).execute()
    current   = res.data[0]["total_capital"] if res.data else 0
    new_total = current + data.minutes

    supabase.table("user_profiles").upsert({"id": user_id, "total_capital": new_total}).execute()
    supabase.table("focus_sessions").insert({"user_id": user_id, "minutes": data.minutes}).execute()

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


@app.post("/save-timer-settings")
async def save_timer_settings(data: TimerSettingsRequest, user_id: CurrentUser):
    work  = max(1, min(120, data.work))
    short = max(1, min(30,  data.short))
    long  = max(1, min(60,  data.long))
    supabase.table("user_profiles").upsert({
        "id": user_id,
        "timer_work": work, "timer_short": short, "timer_long": long,
    }).execute()
    return {"status": "ok"}


@app.get("/chat/history")
async def get_chat_history(user_id: CurrentUser):
    prof = supabase.table("user_profiles").select("is_pro").eq("id", user_id).execute()
    if not prof.data or not prof.data[0].get("is_pro"):
        return JSONResponse({"error": "pro_required"}, status_code=403)
    res = (
        supabase.table("chat_messages")
        .select("role, content, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=False)
        .limit(50)
        .execute()
    )
    return res.data or []


@app.post("/chat")
async def chat_endpoint(request: ChatRequest, user_id: CurrentUser):
    if not _rate_ok(f"chat:{user_id}", 60, 60):
        return JSONResponse({"error": "rate_limit"}, status_code=429)

    prof = supabase.table("user_profiles").select("is_pro").eq("id", user_id).execute()
    if not prof.data or not prof.data[0].get("is_pro"):
        return JSONResponse({"error": "pro_required"}, status_code=403)

    if not ai_client:
        return JSONResponse({"error": "AI not configured"}, status_code=503)

    try:
        ctx            = request.context
        tasks_list     = ctx.get("tasks", [])
        active_task    = ctx.get("activeTask") or "none"
        timer_mode     = ctx.get("timerMode", "idle")
        timer_running  = ctx.get("timerRunning", False)
        sessions_today = ctx.get("sessionsToday", 0)
        streak         = ctx.get("streak", 0)
        tasks_text     = "\n".join(f"  - {t}" for t in tasks_list) if tasks_list else "  (none added yet)"
        streak_line    = (
            f"{streak}-day streak 🔥" if streak > 1
            else ("first day! 🌱" if sessions_today > 0 else "no sessions yet today")
        )

        instruction = f"""You are 'Study Friend' inside the intime app — a personal focus companion for {request.userName}.

PERSONALITY:
- Warm and personal. You know {request.userName} and address them by name naturally.
- Concise. Keep it short — 2–4 sentences max per response.
- Practical. Always point to the next smallest physical action.
- Non-judgmental. Task paralysis is real — it's not laziness or a character flaw.
- Celebratory. Every session, every checked task is worth acknowledging.

IMPORTANT — WHAT YOU CAN AND CANNOT DO:
- You CANNOT add tasks. Tasks are managed by {request.userName} in the task panel on the left.
- You CAN start the timer by including [START_TIMER] — but ONLY when they explicitly say they're ready.
- You CAN suggest breaking a task down, using the 2-min rule, or starting with just 5 minutes.

SUGGESTION RULES — THIS IS CRITICAL:
Your last line MUST be: Suggestions: [label 1], [label 2], [label 3]
These must be the 3 most natural things {request.userName} would actually type next.
NEVER use generic filler like "Keep going", "Take a break", "I need help" unless genuinely natural.
HARD LIMITS: never suggest browsing the web or opening external apps.

FORMAT: Short paragraphs or bullets. **Bold** key actions. End with Suggestions line.

CURRENT STATE:
- Timer: {timer_mode} {'▶ running' if timer_running else '⏸ paused'}
- Active task: {active_task}
- Sessions today: {sessions_today} | Streak: {streak_line}
- Task list:
{tasks_text}

ADHD SCIENCE (weave in naturally when helpful, never lecture):
{KNOWLEDGE}
"""
        # Sanitize history — skip items missing required keys to avoid KeyError
        safe_history = [h for h in request.history if h.get("role") and h.get("text")]
        contents = [{"role": h["role"], "parts": [{"text": h["text"]}]} for h in safe_history]
        contents.append({"role": "user", "parts": [{"text": request.message}]})

        response = ai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config={"system_instruction": instruction},
        )
        try:
            raw = response.text
        except Exception as safety_err:
            logger.warning("Gemini response blocked for user %s: %s", user_id, safety_err)
            return {"ai_message": "I wasn't able to respond to that — try rephrasing.",
                    "suggestions": ["Start a session", "Add a task", "Help me focus"], "start_timer": False}
        clean = re.sub(r"```[\s\S]*?```|\[START_TIMER\]|\[PAUSE_TIMER\]", "", raw).strip()

        suggestions = None
        clean_lines = []
        for line in clean.split("\n"):
            if line.strip().lower().startswith("suggestions:"):
                parts       = line.split(":", 1)[1].strip().split(",")
                suggestions = [s.strip() for s in parts if s.strip()][:3]
            else:
                clean_lines.append(line)
        clean = "\n".join(clean_lines).strip()

        if not suggestions:
            if timer_running:     suggestions = ["Pause timer", "I got distracted", "How long left?"]
            elif timer_mode == "work": suggestions = ["Start the timer", "Pick a task", "Not ready yet"]
            else:                 suggestions = ["Add a task", "Start focusing", "I need help"]

        try:
            supabase.table("chat_messages").insert([
                {"user_id": user_id, "role": "user",  "content": request.message},
                {"user_id": user_id, "role": "model", "content": clean},
            ]).execute()
        except Exception as db_err:
            logger.warning("chat_messages insert failed: %s", db_err)

        return {"ai_message": clean, "suggestions": suggestions, "start_timer": "[START_TIMER]" in raw}
    except Exception:
        logger.exception("Chat error for user %s", user_id)
        return {"ai_message": "Something went wrong — please try again.",
                "suggestions": ["Try again", "Start timer", "I need help"], "start_timer": False}


@app.post("/breakdown")
async def breakdown_task(request: BreakdownRequest, user_id: CurrentUser):
    if not _rate_ok(f"breakdown:{user_id}", 20, 60):
        return JSONResponse({"error": "rate_limit"}, status_code=429)
    if not ai_client:
        return JSONResponse({"error": "AI not configured"}, status_code=503)
    try:
        resp = ai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[{"role": "user", "parts": [{"text": f"Break down this task: {request.task}"}]}],
            config={"system_instruction": (
                "Break the given task into 3-5 tiny, concrete, physical micro-steps. "
                "Each step must start with an action verb and take under 5 minutes. "
                "Return ONLY a valid JSON array of strings — no other text, no markdown."
            )},
        )
        match = re.search(r'\[[\s\S]*?\]', resp.text)
        steps = json.loads(match.group()) if match else [
            "Open the relevant file or app",
            "Spend 2 minutes reading what you already have",
            "Do just the very first small action",
        ]
        return {"steps": steps[:5], "task": request.task}
    except Exception as e:
        logger.error("Breakdown error: %s", e)
        return {"steps": ["Open the relevant file", "Read what's there", "Do the first small thing"],
                "task": request.task}


@app.post("/record-task-completion")
async def record_task_completion(data: TaskCompletionRequest, user_id: CurrentUser):
    if not _rate_ok(f"task:{user_id}", 30, 60):
        return JSONResponse({"error": "rate_limit"}, status_code=429)
    supabase.table("task_completions").insert({
        "user_id":       user_id,
        "task_title":    data.taskTitle,
        "minutes_spent": data.minutesSpent,
    }).execute()
    return {"status": "ok"}


@app.post("/estimate-task")
async def estimate_task(request: EstimateRequest, user_id: CurrentUser):
    if not _rate_ok(f"estimate:{user_id}", 30, 60):
        return JSONResponse({"error": "rate_limit"}, status_code=429)

    res = (
        supabase.table("task_completions")
        .select("task_title,minutes_spent")
        .eq("user_id", user_id)
        .gte("minutes_spent", 1)
        .execute()
    )
    stop      = {"a","an","the","to","do","my","and","or","with","for","in","of","on","at","is","it"}
    task_words = set(request.task.lower().split()) - stop
    similar   = []
    for row in (res.data or []):
        overlap = len(task_words & (set(row["task_title"].lower().split()) - stop))
        if overlap >= 1:
            similar.append((overlap, row["minutes_spent"]))

    if len(similar) >= 2:
        total_w = sum(s[0] for s in similar)
        return {
            "estimated_minutes": round(sum(s[0] * s[1] for s in similar) / total_w),
            "confidence":        "high" if len(similar) >= 4 else "medium",
            "based_on":          f"{len(similar)} of your past tasks",
        }

    if not ai_client:
        return {"estimated_minutes": 25, "confidence": "low", "based_on": "default"}

    try:
        resp = ai_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[{"role": "user", "parts": [{"text": (
                f'Estimate realistically how many minutes it takes to complete: "{request.task}"\n'
                'Return ONLY valid JSON: {"minutes": <integer>, "reason": "<one short phrase>"}'
            )}]}],
        )
        m = re.search(r'\{[\s\S]*?\}', resp.text)
        if m:
            d = json.loads(m.group())
            return {"estimated_minutes": max(1, int(d.get("minutes", 25))),
                    "confidence": "low", "based_on": "AI estimate"}
    except Exception as e:
        logger.error("Estimate AI error: %s", e)
    return {"estimated_minutes": 25, "confidence": "low", "based_on": "default"}


@app.get("/calendar")
async def get_calendar(user_id: CurrentUser, year: int, month: int, tz_offset: int = 0):
    last_day    = date(year, 12, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
    query_start = (date(year, month, 1) - timedelta(days=1)).isoformat()
    query_end   = (last_day + timedelta(days=2)).isoformat()

    sessions_res = (supabase.table("focus_sessions").select("minutes,created_at")
                    .eq("user_id", user_id).gte("created_at", query_start).lt("created_at", query_end).execute())
    tasks_res    = (supabase.table("task_completions").select("task_title,completed_at")
                    .eq("user_id", user_id).gte("completed_at", query_start).lt("completed_at", query_end).execute())
    notes_res    = (supabase.table("calendar_notes").select("date,content")
                    .eq("user_id", user_id)
                    .gte("date", date(year, month, 1).isoformat()).lte("date", last_day.isoformat()).execute())

    month_prefix = f"{year:04d}-{month:02d}"

    def to_local(ts: str) -> str:
        from datetime import datetime as dt
        return (dt.fromisoformat(ts.replace("Z", "+00:00")) + timedelta(minutes=tz_offset)).strftime("%Y-%m-%d")

    daily: dict = {}
    for row in (sessions_res.data or []):
        d = to_local(row["created_at"])
        if not d.startswith(month_prefix): continue
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["minutes"]  += row["minutes"]
        daily[d]["sessions"] += 1
    for row in (tasks_res.data or []):
        d = to_local(row["completed_at"])
        if not d.startswith(month_prefix): continue
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["tasks"].append(row["task_title"])
    for row in (notes_res.data or []):
        d = row["date"]
        daily.setdefault(d, {"minutes": 0, "sessions": 0, "tasks": [], "note": ""})
        daily[d]["note"] = row["content"]

    return {"year": year, "month": month, "days": daily}


@app.post("/calendar/note")
async def save_calendar_note(data: CalendarNoteRequest, user_id: CurrentUser):
    supabase.table("calendar_notes").upsert(
        {"user_id": user_id, "date": data.date, "content": data.content},
        on_conflict="user_id,date",
    ).execute()
    return {"status": "ok"}


@app.post("/api/stripe/create-checkout-session")
async def api_create_checkout_session(data: CheckoutRequest, user_id: CurrentUser):
    if not stripe.api_key:
        return JSONResponse({"error": "STRIPE_SECRET_KEY not configured"}, status_code=503)
    if not os.getenv("STRIPE_PRICE_ID_PRO_MONTHLY"):
        return JSONResponse({"error": "STRIPE_PRICE_ID_PRO_MONTHLY not configured"}, status_code=503)
    try:
        customer_id  = await create_or_get_customer(supabase, user_id, data.email)
        checkout_url = create_checkout_session_url(customer_id, user_id)
        return {"checkout_url": checkout_url}
    except Exception as e:
        logger.error("Checkout session error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/stripe/create-portal-session")
async def api_create_portal_session(data: PortalRequest, user_id: CurrentUser):
    if not stripe.api_key:
        return JSONResponse({"error": "STRIPE_SECRET_KEY not configured"}, status_code=503)
    try:
        res = supabase.table("user_profiles").select("stripe_customer_id").eq("id", user_id).execute()
        customer_id = res.data[0].get("stripe_customer_id") if res.data else None
        if not customer_id:
            return JSONResponse({"error": "No Stripe customer found"}, status_code=404)
        return {"portal_url": create_portal_session_url(customer_id)}
    except Exception as e:
        logger.error("Portal session error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/stripe/webhook")
async def api_stripe_webhook(request: Request):
    payload    = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    secret     = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except stripe.errors.SignatureVerificationError as e:
        logger.warning("Webhook signature failed: %s", e)
        return JSONResponse({"error": "Invalid signature"}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    etype = event["type"]
    obj   = event["data"]["object"]
    logger.info("Stripe webhook event=%s", etype)

    if etype == "checkout.session.completed":
        uid    = obj.get("metadata", {}).get("user_id")
        sub_id = obj.get("subscription")
        if uid and sub_id:
            sync_subscription(supabase, uid, stripe.Subscription.retrieve(sub_id))
            logger.info("Stripe checkout completed user_id=%s", uid)

    elif etype in ("customer.subscription.updated", "customer.subscription.deleted"):
        cid = obj.get("customer")
        uid = get_user_id_by_customer(supabase, cid) if cid else None
        if uid:
            if etype == "customer.subscription.deleted":
                supabase.table("user_profiles").upsert(
                    {"id": uid, "subscription_status": "canceled", "is_pro": False}
                ).execute()
            else:
                sync_subscription(supabase, uid, obj)

    elif etype == "invoice.payment_succeeded":
        cid = obj.get("customer")
        uid = get_user_id_by_customer(supabase, cid) if cid else None
        if uid:
            supabase.table("user_profiles").upsert(
                {"id": uid, "subscription_status": "active", "is_pro": True}
            ).execute()

    elif etype == "invoice.payment_failed":
        cid = obj.get("customer")
        uid = get_user_id_by_customer(supabase, cid) if cid else None
        if uid:
            logger.warning("Payment failed user_id=%s", uid)
            supabase.table("user_profiles").upsert(
                {"id": uid, "subscription_status": "past_due"}
            ).execute()

    return {"received": True}


@app.get("/api/user/subscription")
async def get_user_subscription(user_id: CurrentUser):
    res = (
        supabase.table("user_profiles")
        .select("is_pro,subscription_status,subscription_current_period_end,stripe_subscription_id,stripe_customer_id")
        .eq("id", user_id)
        .execute()
    )
    if not res.data:
        return {"is_pro": False, "status": "free", "current_period_end": None, "cancel_at_period_end": False}
    p = res.data[0]

    if not p.get("is_pro") and p.get("stripe_customer_id") and stripe.api_key:
        try:
            subs = stripe.Subscription.list(customer=p["stripe_customer_id"], limit=5)
            for sub in (subs.data if hasattr(subs, "data") else subs):
                if sub.get("status") in ("active", "trialing"):
                    sync_subscription(supabase, user_id, sub)
                    p.update({"is_pro": True, "subscription_status": sub["status"],
                               "stripe_subscription_id": sub["id"]})
                    break
        except Exception as se:
            logger.warning("Stripe check failed in /api/user/subscription: %s", se)

    cancel_at = False
    if (sub_id := p.get("stripe_subscription_id")) and stripe.api_key:
        try:
            cancel_at = getattr(stripe.Subscription.retrieve(sub_id), "cancel_at_period_end", False)
        except Exception:
            pass

    return {
        "is_pro":               p.get("is_pro", False),
        "status":               p.get("subscription_status", "free"),
        "current_period_end":   p.get("subscription_current_period_end"),
        "cancel_at_period_end": cancel_at,
    }


@app.get("/get-stats")
async def get_stats(user_id: CurrentUser):
    today = datetime.now().date()
    stats = []
    for i in range(-3, 4):
        target = today + timedelta(days=i)
        res    = (
            supabase.table("focus_sessions").select("minutes")
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


# ── Task persistence ─────────────────────────────────────────────────────────

_SAFE_ID = re.compile(r'^[a-zA-Z0-9_-]+$')

class TaskItem(BaseModel):
    id:             str
    title:          str
    done:           bool = False
    estimated_mins: Optional[int] = None
    actual_mins:    int = 0
    position:       int = 0


@app.get("/tasks")
async def get_tasks(user_id: CurrentUser):
    res = (
        supabase.table("tasks")
        .select("id,title,done,estimated_mins,actual_mins,position")
        .eq("user_id", user_id)
        .order("position")
        .execute()
    )
    return res.data or []


@app.put("/tasks")
async def put_tasks(items: list[TaskItem], user_id: CurrentUser):
    for t in items:
        if not _SAFE_ID.match(t.id):
            raise HTTPException(status_code=400, detail=f"Invalid task ID: {t.id!r}")

    if items:
        rows = [
            {
                "id":             t.id,
                "user_id":        user_id,
                "title":          t.title,
                "done":           t.done,
                "estimated_mins": t.estimated_mins,
                "actual_mins":    t.actual_mins,
                "position":       t.position,
            }
            for t in items
        ]
        supabase.table("tasks").upsert(rows, on_conflict="id,user_id").execute()

    # Delete tasks that were removed client-side
    kept = {t.id for t in items}
    existing = (
        supabase.table("tasks").select("id").eq("user_id", user_id).execute()
    )
    to_delete = [row["id"] for row in (existing.data or []) if row["id"] not in kept]
    if to_delete:
        supabase.table("tasks").delete().eq("user_id", user_id).in_("id", to_delete).execute()

    return {"status": "ok", "count": len(items)}


# ── Timer state persistence ───────────────────────────────────────────────────

class TimerStateIn(BaseModel):
    mode: str                        # 'focus' | 'break'
    status: str                      # 'running' | 'paused' | 'wasted'
    duration_secs: int
    started_at: Optional[int] = None # epoch ms; null when paused
    elapsed_secs: int = 0
    wasted_at: Optional[int] = None  # epoch ms when wasted state began


@app.post("/timer/state")
async def save_timer_state(data: TimerStateIn, user_id: CurrentUser):
    supabase.table("timer_state").upsert({
        "user_id":      user_id,
        "mode":         data.mode,
        "status":       data.status,
        "duration_secs": data.duration_secs,
        "started_at":   data.started_at,
        "elapsed_secs": data.elapsed_secs,
        "wasted_at":    data.wasted_at,
        "updated_at":   int(time.time() * 1000),
    }).execute()
    return {"status": "ok"}


@app.get("/timer/state")
async def get_timer_state(user_id: CurrentUser):
    res = supabase.table("timer_state").select("*").eq("user_id", user_id).maybe_single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="No timer state")
    return res.data


@app.delete("/timer/state")
async def delete_timer_state(user_id: CurrentUser):
    supabase.table("timer_state").delete().eq("user_id", user_id).execute()
    return {"status": "ok"}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
