// =============================================
// Settings & Constants
// =============================================
let settings = loadSettings();

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('intime_settings') || '{}');
        return { work: s.work || 25, short: s.short || 5, long: s.long || 15 };
    } catch { return { work: 25, short: 5, long: 15 }; }
}

let MODES = buildModes(settings);
const RING_C = 2 * Math.PI * 96; // ≈ 603

function buildModes(s) {
    return {
        work:  { seconds: s.work  * 60, label: 'FOCUS' },
        short: { seconds: s.short * 60, label: 'SHORT BREAK' },
        long:  { seconds: s.long  * 60, label: 'LONG BREAK' },
    };
}

const STREAK_MILESTONES = new Set([3, 7, 14, 21, 30, 60, 100]);

// =============================================
// State
// =============================================
let user = { id: null, name: 'Friend', streak: 0, isReturning: false, energyLevel: null };
let tasks = loadTasks();
let activeTaskId = null;
let doneSectionOpen = false;
let pendingTimerStart = false;

let timer = {
    mode:          'work',
    remaining:     MODES.work.seconds,
    total:         MODES.work.seconds,
    running:       false,
    interval:      null,
    cycleCount:    0,
    sessionsToday: loadTodaySessions(),
    minutesToday:  0,
};

let chatHistory = [];

// =============================================
// Init
// =============================================
applyTheme();
renderTasks();
renderSessionDots();
updateTimerDisplay();
updateStatsDisplay();
loadSettingsUI();
setHeaderDate();

// =============================================
// Theme
// =============================================
function setHeaderDate() {
    const el = document.getElementById('header-date');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function applyTheme() {
    const isDark = localStorage.getItem('theme') === 'dark';
    document.body.classList.toggle('dark-mode', isDark);
    document.documentElement.classList.toggle('dark-mode', isDark);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

function toggleTheme() {
    const isDark = !document.body.classList.contains('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    applyTheme();
}

// =============================================
// Google Sign-In
// =============================================
window.handleCredentialResponse = async (response) => {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    user.id   = payload.sub;
    user.name = payload.given_name || payload.name || 'Friend';

    document.getElementById('user-avatar').textContent = user.name[0].toUpperCase();
    document.getElementById('user-name').textContent   = user.name;
    document.getElementById('user-badge').style.display = 'flex';
    document.querySelector('.g_id_signin').style.display = 'none';

    enableChat();
    renderTasks(); // re-render to show breakdown buttons

    try {
        const res  = await fetch(`/get-profile/${user.id}`);
        const data = await res.json();
        timer.minutesToday  = data.today_minutes  || 0;
        timer.sessionsToday = data.today_sessions || timer.sessionsToday;
        user.streak         = data.streak         || 0;
        user.isReturning    = data.is_returning   || false;
        updateStatsDisplay();
    } catch (e) { console.error('Profile load failed:', e); }

    document.getElementById('signin-prompt')?.remove();

    // Switch to per-user task storage — migrate from anon if first login on this device
    const userKey = `intime_tasks_${user.id}`;
    if (!localStorage.getItem(userKey)) {
        const anonTasks = localStorage.getItem('intime_tasks_anon') || localStorage.getItem('dopamine_tasks');
        if (anonTasks) localStorage.setItem(userKey, anonTasks);
    }
    tasks = loadTasks();
    renderTasks();
    fetchMissingEstimates();

    // Daily brief for returning users on first open of the day
    if (user.isReturning && shouldShowDailyBrief()) {
        triggerDailyBrief();
    } else if (user.isReturning) {
        const streakLine = user.streak > 1
            ? `You're on a **${user.streak}-day streak** 🔥 — let's keep it going.`
            : 'Good to have you back.';
        appendAiMessage(
            `Welcome back, ${user.name}! 👋 ${streakLine}\n\nWhat are we tackling today?`,
            ['Show me my tasks', 'Start a session', 'I need to plan first']
        );
    } else {
        appendAiMessage(
            `Hey ${user.name}! 👋 I'm your Study Friend inside **intime** — here to help you focus, one step at a time.\n\nWhat are you working on today? Add tasks in the panel on the left, or just tell me and we'll figure it out together.`,
            ['I have a few tasks', "I don't know where to start", 'Help me plan']
        );
    }
};

function enableChat() {
    document.getElementById('chat-input').disabled = false;
    document.getElementById('send-btn').disabled   = false;
}

function logOut() {
    if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect();

    user = { id: null, name: 'Friend', streak: 0, isReturning: false, energyLevel: null };
    chatHistory = [];
    timer.sessionsToday = 0;
    timer.minutesToday  = 0;

    document.getElementById('user-badge').style.display = 'none';
    const signInEl = document.querySelector('.g_id_signin');
    if (signInEl) signInEl.style.display = '';

    document.getElementById('chat-messages').innerHTML = `
        <div class="signin-prompt" id="signin-prompt">
            <div class="signin-icon">🧠</div>
            <p>Sign in to chat with your<br><strong>Study Friend</strong></p>
            <p class="signin-sub">Your ADHD-aware focus companion</p>
        </div>`;
    document.getElementById('chat-input').disabled = true;
    document.getElementById('send-btn').disabled   = true;
    document.getElementById('suggestions').innerHTML = '';
    const statusEl = document.getElementById('ai-status');
    if (statusEl) { statusEl.textContent = 'Ready to help'; statusEl.className = 'chat-status'; }

    tasks = loadTasks();
    renderTasks();
    updateStatsDisplay();
}

// =============================================
// Tasks — per-user storage
// =============================================
function getTasksKey() {
    return user.id ? `intime_tasks_${user.id}` : 'intime_tasks_anon';
}

function loadTasks() {
    const key = getTasksKey();
    try {
        const stored = localStorage.getItem(key);
        if (stored) return JSON.parse(stored);
        // Migration: check legacy key for anonymous / first load
        const legacy = localStorage.getItem('intime_tasks_anon') || localStorage.getItem('dopamine_tasks');
        if (legacy) { localStorage.setItem(key, legacy); return JSON.parse(legacy); }
        return [];
    } catch { return []; }
}

function saveTasks() {
    localStorage.setItem(getTasksKey(), JSON.stringify(tasks));
}

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

document.getElementById('task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('task-input');
    const title = input.value.trim();
    if (!title) return;
    const newTask = { id: genId(), title, done: false, createdAt: Date.now(), estimatedMins: null, actualMins: 0 };
    tasks.unshift(newTask);
    saveTasks();
    renderTasks();
    input.value = '';
    if (user.id) fetchTaskEstimate(newTask.id);
});

function toggleTask(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    if (!task.done && user.id) recordTaskCompletion(task); // fire-and-forget
    task.done = !task.done;
    if (task.done && activeTaskId === id) setActiveTask(null);
    saveTasks();
    renderTasks();
}

async function recordTaskCompletion(task) {
    try {
        await fetch('/record-task-completion', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ userId: user.id, taskTitle: task.title, minutesSpent: task.actualMins || 0 }),
        });
    } catch (e) { console.error('Task completion record failed:', e); }
}

function deleteTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    if (activeTaskId === id) setActiveTask(null);
    saveTasks();
    renderTasks();
}

function setActiveTask(id) {
    activeTaskId = (activeTaskId === id) ? null : id;
    renderTasks();
    const task = tasks.find(t => t.id === activeTaskId);
    document.getElementById('active-task-label').textContent =
        task ? task.title : 'No task selected';
}

function renderTasks() {
    const pending = tasks.filter(t => !t.done);
    const done    = tasks.filter(t =>  t.done);

    document.getElementById('task-count').textContent = pending.length;
    document.getElementById('task-list').innerHTML =
        pending.length
            ? pending.map(taskHtml).join('')
            : `<li class="task-empty"><span class="task-empty-icon">✅</span>No tasks yet<br>Add one above to get started</li>`;

    const doneSection = document.getElementById('done-section');
    if (done.length > 0) {
        doneSection.style.display = 'block';
        document.getElementById('done-count').textContent = done.length;
        document.getElementById('done-list').innerHTML = doneSectionOpen ? done.map(taskHtml).join('') : '';
    } else {
        doneSection.style.display = 'none';
    }
}

function taskHtml(task) {
    const isActive = task.id === activeTaskId;
    const showBreak = !task.done && user.id;
    const est = (!task.done && task.estimatedMins)
        ? `<span class="task-est" title="${escHtml(task.estimateSource || 'estimated')}">~${task.estimatedMins}m</span>`
        : '';
    return `
    <li class="task-item${isActive ? ' active-task' : ''}" data-id="${task.id}">
        <button class="task-check${task.done ? ' checked' : ''}" onclick="toggleTask('${task.id}')">
            ${task.done ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        </button>
        <span class="task-title${task.done ? ' done' : ''}">${escHtml(task.title)}</span>
        ${est}
        <div class="task-actions">
            ${showBreak ? `<button class="task-break-btn" onclick="breakdownTask('${task.id}')" title="Break it down with AI">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            </button>` : ''}
            ${!task.done ? `<button class="task-focus-btn${isActive ? ' on' : ''}" onclick="setActiveTask('${task.id}')" title="Focus on this">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>` : ''}
            <button class="task-del-btn" onclick="deleteTask('${task.id}')" title="Delete">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    </li>`;
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleDoneSection() {
    doneSectionOpen = !doneSectionOpen;
    renderTasks();
}

// =============================================
// Task Breakdown (AI)
// =============================================
async function breakdownTask(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task || !user.id) return;

    const typingEl = showTyping();
    try {
        const res = await fetch('/breakdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: task.title, userName: user.name, userId: user.id }),
        });
        const data = await res.json();
        typingEl.remove();

        const stepsText = data.steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n');
        appendAiMessage(
            `Here's **"${escHtml(task.title)}"** broken into micro-steps:\n\n${stepsText}\n\nStart with just step 1 — that's the only thing you need to do right now.`,
            ['Focus on step 1', 'Set a 5-min timer', 'Add these as tasks']
        );
    } catch {
        typingEl.remove();
        appendAiMessage("Couldn't break that down right now — try again?", ['Try again']);
    }
}

// =============================================
// Pomodoro Timer
// =============================================
function switchMode(mode) {
    if (timer.running) timerToggle();
    timer.mode      = mode;
    timer.remaining = MODES[mode].seconds;
    timer.total     = MODES[mode].seconds;
    updateTimerDisplay();
    updateRing();
    updateFocusPanelColor();
    document.querySelectorAll('.mode-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
}

function timerToggle() {
    if (!timer.running) {
        // Energy check-in — once per sign-in session
        if (user.id && user.energyLevel === null && timer.mode === 'work') {
            pendingTimerStart = true;
            openModal('energy-modal');
            return;
        }
        startTimer();
    } else {
        pauseTimer();
    }
}

function startTimer() {
    timer.running  = true;
    timer.interval = setInterval(timerTick, 1000);
    const btn = document.getElementById('timer-toggle');
    btn.textContent = 'Pause';
    btn.classList.add('running');
    document.getElementById('focus-panel').classList.add('timer-running');
}

function pauseTimer() {
    timer.running = false;
    clearInterval(timer.interval);
    const btn = document.getElementById('timer-toggle');
    btn.textContent = 'Resume';
    btn.classList.remove('running');
    document.getElementById('focus-panel').classList.remove('timer-running');
}

function timerSkip() {
    if (timer.running) pauseTimer();
    advanceMode(false);
}

function timerTick() {
    timer.remaining--;
    updateTimerDisplay();
    updateRing();
    if (timer.remaining <= 0) timerComplete();
}

async function timerComplete() {
    clearInterval(timer.interval);
    timer.running = false;
    document.getElementById('timer-toggle').textContent = 'Start';
    document.getElementById('timer-toggle').classList.remove('running');
    document.getElementById('focus-panel').classList.remove('timer-running');

    if (timer.mode === 'work') {
        timer.cycleCount++;
        timer.sessionsToday++;
        saveTodaySessions(timer.sessionsToday);
        const mins = Math.floor(MODES.work.seconds / 60);
        timer.minutesToday += mins;

        // Accumulate actual time spent on the active task
        if (activeTaskId) {
            const activeTask = tasks.find(t => t.id === activeTaskId);
            if (activeTask) { activeTask.actualMins = (activeTask.actualMins || 0) + mins; saveTasks(); }
        }

        // Save to Supabase
        if (user.id) {
            try {
                const res  = await fetch('/complete-session', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ userId: user.id, minutes: mins }),
                });
                const data = await res.json();
                timer.minutesToday  = data.today_minutes;
                timer.sessionsToday = data.today_sessions;
                user.streak         = data.streak ?? user.streak;
            } catch (e) { console.error('Session save failed:', e); }
        }

        updateStatsDisplay();

        // Confetti 🎉
        const isStreakMilestone = STREAK_MILESTONES.has(user.streak);
        launchConfetti(isStreakMilestone ? 'big' : 'small');

        // AI celebration
        const activeTask = tasks.find(t => t.id === activeTaskId);
        sendChatInternal(
            `I just completed a ${mins}-minute focus session!` +
            (activeTask ? ` I was working on "${activeTask.title}".` : '') +
            (isStreakMilestone ? ` I'm on a ${user.streak}-day streak!` : '')
        );

        // Advance to break
        const nextMode = timer.cycleCount >= 4 ? 'long' : 'short';
        if (timer.cycleCount >= 4) timer.cycleCount = 0;
        renderSessionDots();
        advanceMode(true, nextMode);

    } else {
        // Break ended
        advanceMode(false, 'work');
        if (user.id) {
            appendAiMessage(
                `Break's over! Ready to get back into it, ${user.name}? 💪\nClick **Start** whenever you're ready.`,
                ['Start focusing', 'Need 5 more min', "What should I work on?"]
            );
        }
    }
}

function advanceMode(autoStartBreak, forceMode = null) {
    const nextMode = forceMode || (timer.mode === 'work' ? 'short' : 'work');
    switchMode(nextMode);
    if (autoStartBreak && nextMode !== 'work') startTimer();
}

function updateFocusPanelColor() {
    const panel = document.getElementById('focus-panel');
    panel.className = 'panel focus-panel';
    if (timer.mode !== 'work') panel.classList.add(`mode-${timer.mode}`);
    document.getElementById('ring-label').textContent = MODES[timer.mode].label;
}

function updateTimerDisplay() {
    const m = Math.floor(timer.remaining / 60).toString().padStart(2, '0');
    const s = (timer.remaining % 60).toString().padStart(2, '0');
    document.getElementById('timer-display').textContent = `${m}:${s}`;
}

function updateRing() {
    const offset = RING_C * (1 - timer.remaining / timer.total);
    document.getElementById('ring-fill').style.strokeDashoffset = offset;
}

function renderSessionDots() {
    const container = document.getElementById('session-dots');
    container.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const dot = document.createElement('span');
        dot.className = 's-dot' + (i < timer.cycleCount ? ' filled' : '');
        container.appendChild(dot);
    }
}

function updateStatsDisplay() {
    document.getElementById('stat-sessions').textContent = timer.sessionsToday;
    document.getElementById('stat-minutes').textContent  = timer.minutesToday;
    document.getElementById('stat-streak').textContent   = user.id ? (user.streak || 0) : '—';
}

function loadTodaySessions() {
    try {
        const s = JSON.parse(localStorage.getItem('dopamine_day') || '{}');
        if (s.date === new Date().toDateString()) return s.sessions || 0;
    } catch {}
    return 0;
}

function saveTodaySessions(count) {
    localStorage.setItem('dopamine_day', JSON.stringify({
        date: new Date().toDateString(), sessions: count,
    }));
}

// =============================================
// Settings
// =============================================
function loadSettingsUI() {
    document.getElementById('s-work').value  = settings.work;
    document.getElementById('s-short').value = settings.short;
    document.getElementById('s-long').value  = settings.long;
}

function applySettings() {
    const work  = Math.max(1, Math.min(120, parseInt(document.getElementById('s-work').value)  || 25));
    const short = Math.max(1, Math.min(30,  parseInt(document.getElementById('s-short').value) || 5));
    const long  = Math.max(1, Math.min(60,  parseInt(document.getElementById('s-long').value)  || 15));
    settings = { work, short, long };
    localStorage.setItem('intime_settings', JSON.stringify(settings));
    MODES = buildModes(settings);
    if (!timer.running) switchMode(timer.mode); // reset to new duration
    closeAllModals();
}

// =============================================
// Energy Check-in
// =============================================
function setEnergy(level) {
    user.energyLevel = level;
    closeAllModals();

    // Inform AI about energy level once
    if (user.id) {
        sendChatInternal(
            `My energy level right now is ${level}. Adjust your coaching style accordingly — ${
                level === 'low'    ? 'suggest shorter sprints and easier starting tasks' :
                level === 'medium' ? 'keep a balanced, normal pace' :
                                     'I can handle harder tasks and longer sessions'
            }.`
        );
    }

    // Start the timer if it was pending
    if (pendingTimerStart) {
        pendingTimerStart = false;
        startTimer();
    }
}

// =============================================
// Sounds (Web Audio API)
// =============================================
let audioCtx   = null;
let noiseNode  = null;
let gainNode   = null;
let activeSound = null;

function ensureCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function toggleSound(type) {
    if (activeSound === type) {
        stopSound();
    } else {
        startSound(type);
    }
    ['rain', 'brown', 'white'].forEach(t =>
        document.getElementById(`snd-${t}`)?.classList.toggle('active', activeSound === t)
    );
}

function startSound(type) {
    stopSound();
    activeSound = type;
    const ctx = ensureCtx();
    const rate = ctx.sampleRate;
    const buf  = ctx.createBuffer(1, rate * 3, rate); // 3s looped buffer
    const data = buf.getChannelData(0);

    if (type === 'white') {
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    } else if (type === 'brown') {
        let last = 0;
        for (let i = 0; i < data.length; i++) {
            const w = Math.random() * 2 - 1;
            data[i] = (last + 0.02 * w) / 1.02;
            last = data[i];
            data[i] *= 3.5;
        }
    } else if (type === 'rain') {
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }

    noiseNode = ctx.createBufferSource();
    noiseNode.buffer = buf;
    noiseNode.loop   = true;

    gainNode = ctx.createGain();
    gainNode.gain.value = type === 'white' ? 0.12 : type === 'rain' ? 0.1 : 0.4;

    if (type === 'rain') {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1200;
        noiseNode.connect(filter);
        filter.connect(gainNode);
    } else {
        noiseNode.connect(gainNode);
    }
    gainNode.connect(ctx.destination);
    noiseNode.start();
}

function stopSound() {
    if (noiseNode) { try { noiseNode.stop(); } catch {} noiseNode = null; }
    activeSound = null;
    ['rain', 'brown', 'white'].forEach(t =>
        document.getElementById(`snd-${t}`)?.classList.remove('active')
    );
}

// =============================================
// Distraction Dump
// =============================================
function saveDump() {
    const input = document.getElementById('dump-input');
    const text  = input.value.trim();
    if (!text) return;

    const dumps = JSON.parse(localStorage.getItem('intime_dumps') || '[]');
    dumps.unshift({ text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    localStorage.setItem('intime_dumps', JSON.stringify(dumps.slice(0, 20)));

    input.value = '';
    renderDumps();
}

function renderDumps() {
    const dumps     = JSON.parse(localStorage.getItem('intime_dumps') || '[]');
    const container = document.getElementById('dump-list');
    const today     = dumps.filter(d => d.time); // all recent ones

    if (!today.length) {
        container.innerHTML = '<p class="dump-empty">No thoughts saved yet.</p>';
        return;
    }
    container.innerHTML = today.slice(0, 8).map(d =>
        `<div class="dump-item">
            <span class="dump-item-text">${escHtml(d.text)}</span>
            <span class="dump-item-time">${d.time}</span>
         </div>`
    ).join('');
}

// =============================================
// Daily Brief
// =============================================
function shouldShowDailyBrief() {
    return localStorage.getItem('last_brief_date') !== new Date().toDateString();
}

async function triggerDailyBrief() {
    localStorage.setItem('last_brief_date', new Date().toDateString());
    const pending    = tasks.filter(t => !t.done);
    const taskLine   = pending.length
        ? `They have ${pending.length} task${pending.length > 1 ? 's' : ''}: ${pending.slice(0, 3).map(t => `"${t.title}"`).join(', ')}${pending.length > 3 ? '…' : ''}.`
        : 'They have no tasks added yet — ask them what they want to work on today.';
    const streakLine = user.streak > 0 ? ` They're on a ${user.streak}-day streak.` : '';

    await sendChatInternal(
        `Give ${user.name} a brief, warm, energising daily briefing. It's a new day. ${taskLine}${streakLine} Suggest the best task to start with (or ask them to add one). Keep it to 2–3 sentences. Be personal and encouraging — no generic fluff.`
    );
}

// =============================================
// Confetti
// =============================================
function launchConfetti(size = 'small') {
    const canvas = document.getElementById('confetti-canvas');
    const ctx    = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.display = 'block';

    const count  = size === 'big' ? 160 : 70;
    const colors = ['#6366F1','#818CF8','#10B981','#34D399','#F59E0B','#FBBF24','#EC4899','#F472B6','#3B82F6'];
    const pieces = Array.from({ length: count }, () => ({
        x:    Math.random() * canvas.width,
        y:    -Math.random() * 200,
        vx:   (Math.random() - 0.5) * 6,
        vy:   Math.random() * 3 + 1,
        w:    Math.random() * 12 + 5,
        h:    Math.random() * 7  + 3,
        rot:  Math.random() * 360,
        rSpd: (Math.random() - 0.5) * 10,
        col:  colors[Math.floor(Math.random() * colors.length)],
        a:    1,
    }));

    const end = Date.now() + (size === 'big' ? 4500 : 2500);

    (function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const now = Date.now();
        const fading = now > end - 600;
        pieces.forEach(p => {
            if (p.y > canvas.height + 20) return;
            p.x   += p.vx;
            p.y   += p.vy;
            p.vy  += 0.04;
            p.rot += p.rSpd;
            if (fading) p.a = Math.max(0, p.a - 0.025);
            ctx.save();
            ctx.globalAlpha = p.a;
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rot * Math.PI) / 180);
            ctx.fillStyle = p.col;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        });
        if (now < end) requestAnimationFrame(draw);
        else { canvas.style.display = 'none'; }
    })();
}

// =============================================
// Chat
// =============================================
const chatInputEl = document.getElementById('chat-input');
chatInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatInputEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});

async function sendChat(customMsg = null) {
    const msg = customMsg || chatInputEl.value.trim();
    if (!msg || !user.id) return;

    appendUserMessage(msg);
    chatInputEl.value = '';
    chatInputEl.style.height = 'auto';

    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = true;
    const typingEl = showTyping();

    try {
        const res  = await fetch('/chat', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                message:  msg,
                userId:   user.id,
                userName: user.name,
                history:  chatHistory,
                context:  buildChatContext(),
            }),
        });
        const data = await res.json();
        typingEl.remove();

        if (data.start_timer && !timer.running) timerToggle();
        appendAiMessage(data.ai_message, data.suggestions);
        chatHistory.push({ role: 'user', text: msg }, { role: 'model', text: data.ai_message });
        if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    } catch {
        typingEl.remove();
        appendAiMessage('Connection issue — please try again.', ['Try again']);
    } finally {
        sendBtn.disabled = false;
    }
}

// Internal AI message (no user bubble shown — used for session complete, daily brief, energy)
async function sendChatInternal(msg) {
    if (!user.id) return;
    const typingEl = showTyping();
    try {
        const res  = await fetch('/chat', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                message:  msg,
                userId:   user.id,
                userName: user.name,
                history:  chatHistory,
                context:  buildChatContext(),
            }),
        });
        const data = await res.json();
        typingEl.remove();
        appendAiMessage(data.ai_message, data.suggestions);
        chatHistory.push({ role: 'user', text: msg }, { role: 'model', text: data.ai_message });
        if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    } catch {
        typingEl.remove();
    }
}

function buildChatContext() {
    const activeTask = tasks.find(t => t.id === activeTaskId);
    return {
        tasks:         tasks.filter(t => !t.done).map(t => t.title),
        activeTask:    activeTask?.title || null,
        timerMode:     timer.mode,
        timerRunning:  timer.running,
        sessionsToday: timer.sessionsToday,
        streak:        user.streak,
        isReturning:   user.isReturning,
        energyLevel:   user.energyLevel,
    };
}

function appendUserMessage(text) {
    const box = document.getElementById('chat-messages');
    const el  = document.createElement('div');
    el.className = 'user-bubble';
    el.innerHTML = `<small class="bubble-sender">${escHtml(user.name)}</small><div>${escHtml(text)}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

function appendAiMessage(text, suggestions = []) {
    const statusEl = document.getElementById('ai-status');
    if (statusEl) { statusEl.textContent = 'Ready to help'; statusEl.className = 'chat-status'; }
    const box = document.getElementById('chat-messages');
    const el  = document.createElement('div');
    el.className = 'ai-bubble';
    el.innerHTML = `<small class="bubble-sender">Study Friend</small><div>${formatMsg(text)}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    renderSuggestions(suggestions);
}

function showTyping() {
    const statusEl = document.getElementById('ai-status');
    if (statusEl) { statusEl.textContent = 'Thinking…'; statusEl.className = 'chat-status thinking'; }
    const box = document.getElementById('chat-messages');
    const el  = document.createElement('div');
    el.className = 'typing-indicator';
    el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
}

function renderSuggestions(sugs) {
    const container = document.getElementById('suggestions');
    container.innerHTML = '';
    sugs.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'sug-btn';
        btn.textContent = s;
        btn.addEventListener('click', () => sendChat(s));
        container.appendChild(btn);
    });
}

function formatMsg(text) {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n/g, '<br>');
}

// =============================================
// Task Time Estimates
// =============================================
async function fetchTaskEstimate(taskId) {
    if (!user.id) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.estimatedMins !== null) return;
    try {
        const res  = await fetch('/estimate-task', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ task: task.title, userId: user.id }),
        });
        const data = await res.json();
        task.estimatedMins   = data.estimated_minutes;
        task.estimateSource  = data.based_on;
        saveTasks();
        renderTasks();
    } catch (e) { console.error('Estimate failed:', e); }
}

async function fetchMissingEstimates() {
    if (!user.id) return;
    const unestimated = tasks
        .filter(t => !t.done && (t.estimatedMins === undefined || t.estimatedMins === null))
        .slice(0, 6);
    for (const task of unestimated) {
        await fetchTaskEstimate(task.id);
        await new Promise(r => setTimeout(r, 250));
    }
}

// =============================================
// Calendar
// =============================================
let calState = {
    year:         new Date().getFullYear(),
    month:        new Date().getMonth() + 1,
    data:         {},
    selectedDate: null,
};

function openCalendar() {
    openModal('calendar-modal');
    loadCalendarMonth();
}

async function loadCalendarMonth() {
    document.getElementById('cal-title').textContent = new Date(calState.year, calState.month - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('cal-grid').innerHTML = '';

    if (user.id) {
        try {
            const tzOffset = -new Date().getTimezoneOffset(); // JS offset is inverted vs server
            const res  = await fetch(`/calendar/${user.id}?year=${calState.year}&month=${calState.month}&tz_offset=${tzOffset}`);
            const data = await res.json();
            calState.data = data.days || {};
        } catch (e) { console.error('Calendar load failed:', e); calState.data = {}; }
    } else {
        calState.data = {};
    }

    renderCalendarGrid();
}

function renderCalendarGrid() {
    const grid = document.getElementById('cal-grid');
    if (!grid) return;

    const { year, month } = calState;
    const firstDay     = new Date(year, month - 1, 1).getDay();
    const daysInMonth  = new Date(year, month, 0).getDate();
    const today        = new Date();
    const todayStr     = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    grid.innerHTML = '';

    // Empty padding cells before first day
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'cal-cell cal-cell-empty';
        grid.appendChild(empty);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dd      = calState.data[dateStr] || {};
        const isToday    = dateStr === todayStr;
        const isSelected = dateStr === calState.selectedDate;

        const cell = document.createElement('div');
        cell.className = 'cal-cell'
            + (isToday    ? ' today'    : '')
            + (isSelected ? ' selected' : '')
            + (dd.minutes > 0 ? ' has-data' : '');

        cell.innerHTML =
            `<span class="cal-day-num">${d}</span>` +
            (dd.minutes  > 0           ? `<span class="cal-minutes-badge">${dd.minutes}m</span>` : '') +
            (dd.tasks?.length > 0      ? `<span class="cal-tasks-badge">✓${dd.tasks.length}</span>` : '') +
            (dd.note                   ? '<span class="cal-note-dot">●</span>' : '');

        cell.addEventListener('click', () => {
            calState.selectedDate = dateStr;
            renderCalendarGrid();
            renderDayPanel(dateStr);
        });
        grid.appendChild(cell);
    }
}

function renderDayPanel(dateStr) {
    const panel   = document.getElementById('cal-day-panel');
    const dd      = calState.data[dateStr] || {};
    const [y,m,d] = dateStr.split('-').map(Number);
    const cellDate = new Date(y, m - 1, d);
    const today    = new Date(); today.setHours(0,0,0,0);
    const isPastOrToday = cellDate <= today;

    const dateLabel = cellDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    panel.innerHTML = `
        <div class="cal-selected-title">${dateLabel}</div>
        ${dd.minutes > 0 ? `
        <div class="cal-stats-row">
            <span class="cal-stat-pill">⏱ ${dd.minutes} min</span>
            <span class="cal-stat-pill">🎯 ${dd.sessions} session${dd.sessions !== 1 ? 's' : ''}</span>
        </div>` : (isPastOrToday ? '<p class="cal-no-data">No study sessions recorded</p>' : '')}
        ${dd.tasks?.length > 0 ? `
        <div>
            <div class="cal-note-label">Completed tasks</div>
            <div class="cal-tasks-list">${dd.tasks.map(t => `<div class="cal-task-item">${escHtml(t)}</div>`).join('')}</div>
        </div>` : ''}
        <div class="cal-note-section">
            <div class="cal-note-label">${isPastOrToday ? 'Notes' : 'Notes / Todos for this day'}</div>
            <textarea id="cal-note-input" placeholder="${isPastOrToday ? 'Add a note about this day…' : 'Plan ahead — add todos or reminders…'}" rows="4">${escHtml(dd.note || '')}</textarea>
            <button class="cal-save-note-btn" onclick="saveCalendarNote('${dateStr}')">Save Note</button>
        </div>`;
}

async function saveCalendarNote(dateStr) {
    if (!user.id) {
        alert('Sign in to save notes.');
        return;
    }
    const content = document.getElementById('cal-note-input')?.value || '';
    try {
        await fetch('/calendar/note', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ userId: user.id, date: dateStr, content }),
        });
        if (!calState.data[dateStr]) calState.data[dateStr] = { minutes: 0, sessions: 0, tasks: [], note: '' };
        calState.data[dateStr].note = content;
        renderCalendarGrid();
        const btn = document.querySelector('.cal-save-note-btn');
        if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn) btn.textContent = 'Save Note'; }, 1600); }
    } catch (e) { console.error('Note save failed:', e); }
}

function calPrev() {
    calState.month--;
    if (calState.month < 1)  { calState.month = 12; calState.year--; }
    calState.selectedDate = null;
    loadCalendarMonth();
}

function calNext() {
    calState.month++;
    if (calState.month > 12) { calState.month = 1;  calState.year++; }
    calState.selectedDate = null;
    loadCalendarMonth();
}

function calToday() {
    const now = new Date();
    calState.year  = now.getFullYear();
    calState.month = now.getMonth() + 1;
    calState.selectedDate = null;
    loadCalendarMonth();
}

// =============================================
// Modal Helpers
// =============================================
function openModal(id) {
    if (id === 'dump-modal') renderDumps();
    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById(id).classList.add('open');
}

function closeAllModals() {
    document.getElementById('modal-overlay').classList.remove('open');
    document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
}
