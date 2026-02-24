import os, re, json
from dotenv import load_dotenv #
from datetime import datetime, timedelta
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from google import genai
from google.oauth2 import id_token
from google.auth.transport import requests

# .env 파일의 환경 변수를 시스템에 로드합니다.
load_dotenv()

app = FastAPI()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

# Kenneth's Verified Client ID
GOOGLE_CLIENT_ID = "121246915230-hrfas5irqhnb8sgg8qoc37ba51dqkg0g.apps.googleusercontent.com"

# API 키를 환경 변수에서 안전하게 가져옵니다.
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

class ChatRequest(BaseModel):
    message: str
    history: list = []
    userId: str = "guest"

@app.get("/")
async def read_root():
    return FileResponse(os.path.join(BASE_DIR, "static", "index.html"))

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    instruction = """
    You are 'Neuro-Architect', a stoic cognitive performance coach for Kenneth (Berkeley Econ/DS).
    - NEVER mention internal JSON formats or "API" to the user.
    - Provide concise, elite coaching (2-3 sentences).
    - Tasks ONLY in the hidden JSON block at the very end.
    """
    try:
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=request.message,
            config={"system_instruction": instruction}
        )
        res_text = response.text
        json_match = re.search(r"```json\s*(.*?)\s*```", res_text, re.DOTALL)
        tasks = json.loads(json_match.group(1)).get("tasks", []) if json_match else []
        clean_text = re.sub(r"```json.*?```", "", res_text, flags=re.DOTALL).strip()
        return {"ai_message": clean_text.replace("\n", "<br>"), "tasks": tasks}
    except Exception as e:
        return {"ai_message": f"Link unstable: {str(e)}", "tasks": []}

@app.post("/login")
async def login(data: dict):
    token = data.get("token")
    try:
        idinfo = id_token.verify_oauth2_token(token, requests.Request(), GOOGLE_CLIENT_ID)
        return {"status": "success", "userId": idinfo['sub'], "name": idinfo['name']}
    except: return {"status": "error"}

@app.post("/complete-task")
async def complete_task_api(data: dict):
    # 유저 세션 기록용 (필요 시 구현)
    return {"status": "success"}