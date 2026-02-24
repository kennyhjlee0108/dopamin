// 1. 전역 변수 초기화
let dopamineChart, chatHistory = [], sessionInterval, startTime, targetMinutes, accumulatedTime = 0, isPaused = false, currentUserId = "guest";

// 2. 핵심 함수 선언 (Hoisting 보장)
function updateUI() {
    if (isPaused) return;
    const now = Date.now();
    const elapsedMs = (now - startTime) + accumulatedTime;
    const totalSec = Math.floor(elapsedMs / 1000);
    
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    
    const timerElem = document.getElementById('session-timer');
    if (timerElem) timerElem.innerText = `${h}:${m}:${s}`;
}

function startWorkSession(mins) {
    console.log("Session starting:", mins);
    targetMinutes = mins; accumulatedTime = 0; isPaused = false;
    startTime = Date.now();
    
    const focusArea = document.getElementById('focus-area');
    if (focusArea) focusArea.style.display = 'block';
    
    clearInterval(sessionInterval);
    sessionInterval = setInterval(updateUI, 100); // 0.1초마다 갱신 에러 해결
    
    const chatBox = document.getElementById('chat-box');
    if (chatBox) chatBox.innerHTML += `<div class="ai-bubble" style="background:#F1F5F9; padding:15px; border-radius:15px; margin-bottom:10px;"><b>Architect:</b> ${mins}m protocol active. Kenneth, optimize your focus.</div>`;
    scrollToBottom();
}

function togglePause() {
    const btn = document.getElementById('btn-pause-resume');
    if (!isPaused) {
        accumulatedTime += (Date.now() - startTime);
        isPaused = true; if (btn) btn.innerText = "Resume";
    } else {
        startTime = Date.now();
        isPaused = false; if (btn) btn.innerText = "Pause";
    }
}

async function finishSession() {
    clearInterval(sessionInterval);
    const totalMs = (isPaused ? 0 : (Date.now() - startTime)) + accumulatedTime;
    const elapsedMins = Math.floor(totalMs / 60000);
    const focusArea = document.getElementById('focus-area');
    if (focusArea) focusArea.style.display = 'none';
    
    await fetch('/complete-task', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({userId: currentUserId, type: "work", minutes: elapsedMins})
    });
}

async function sendChat(customMsg = null) {
    const input = document.getElementById('user-input');
    const msg = customMsg || input.value;
    if (!msg) return;
    
    const display = document.getElementById('chat-box');
    if (!customMsg && display) display.innerHTML += `<div class="user-bubble" style="background:#6366F1; color:white; align-self:flex-end; padding:12px; border-radius:15px; margin-bottom:10px; margin-left:auto; max-width:80%;">${msg}</div>`;
    if (input) input.value = ''; scrollToBottom();

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({message: msg, history: chatHistory, userId: currentUserId})
        });
        const data = await res.json();
        if (display) display.innerHTML += `<div class="ai-bubble" style="background:#F1F5F9; padding:15px; border-radius:15px; margin-bottom:10px; max-width:90%;"><b>Architect:</b> ${data.ai_message}</div>`;
        
        const container = document.getElementById('task-container');
        if (container) {
            container.innerHTML = '';
            data.tasks.forEach(t => {
                const btn = document.createElement('button');
                btn.className = 'task-btn'; btn.innerText = `✦ ${t.action}`;
                btn.style = "background:white; border:1px solid #ddd; padding:8px 15px; border-radius:10px; cursor:pointer; font-weight:600; font-size:0.8rem;";
                btn.onclick = () => t.type === "work" ? startWorkSession(t.minutes) : sendChat(t.action);
                container.appendChild(btn);
            });
        }
        scrollToBottom();
    } catch (e) { console.error("Chat error:", e); }
}

async function handleCredentialResponse(response) {
    const res = await fetch('/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: response.credential}) });
    const data = await res.json();
    if (data.status === "success") {
        currentUserId = data.userId;
        const disp = document.getElementById('user-display');
        if (disp) { disp.innerText = `Protocol: ${data.name}`; disp.style.display = 'block'; }
        const gBtn = document.querySelector('.g_id_signin');
        if (gBtn) gBtn.style.display = 'none';
    }
}

function initChart() {
    const ctx = document.getElementById('dopamineChart').getContext('2d');
    dopamineChart = new Chart(ctx, {
        type: 'line',
        data: { labels: ['M','T','W','T','F','S','S'], datasets: [{ label: 'Focus', data: [0,0,0,0,0,0,0], borderColor: '#6366F1', tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    document.getElementById('theme-toggle').innerText = isDark ? '☀️' : '🌙';
}

function scrollToBottom() { const box = document.getElementById('chat-box'); if (box) box.scrollTop = box.scrollHeight; }

// 3. 실행 시점 제어
window.onload = () => {
    initChart();
    const chatBox = document.getElementById('chat-box');
    if (chatBox) chatBox.innerHTML = `<div class="ai-bubble" style="background:#F1F5F9; padding:15px; border-radius:15px;"><b>Architect:</b> Systems online. Kenneth, ready to optimize your cognitive baseline?</div>`;
};