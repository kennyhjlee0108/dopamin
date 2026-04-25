// =============================================
// Settings & Constants
// =============================================
let settings = loadSettings();

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('intime_settings') || '{}');
        return {
            focus: s.focus || s.work  || 25,
            break: s.break || s.short || 5,
        };
    } catch { return { focus: 25, break: 5 }; }
}

const RING_C = 2 * Math.PI * 96;
const STREAK_MILESTONES = new Set([3, 7, 14, 21, 30, 60, 100]);
const FOCUS_PICKS = [15 * 60, 25 * 60, 45 * 60, 60 * 60];
const BREAK_PICKS = [5 * 60, 10 * 60, 15 * 60];

// =============================================
// App State (state machine)
// idle | focus_running | focus_paused | break_running | break_paused | awaiting_response | wasted
// =============================================
let appState         = 'idle';
let timerMode        = 'focus';       // 'focus' | 'break'
let timerTotalSecs   = settings.focus * 60;
let timerRemainSecs  = settings.focus * 60;
let timerElapsedSecs = 0;             // seconds accumulated across pauses
let timerStartedAt   = null;          // Date.now() at last start/resume
let timerInterval    = null;

// Wasted state
let wastedStartedAt = null;
let wastedInterval  = null;

// Popup (awaiting_response) state
let popupDeadline   = null;           // Date.now() + 300 000
let popupInterval   = null;
let nextSessionMode = null;           // 'focus' | 'break'
let sepNextSecs     = 25 * 60;        // duration selected in step B

// Wheel Picker state
let _wpCallback = null;
let _wpWheels   = {};                 // { h, m, s } => { getValue, setValue }

// User
let user = { id: null, name: 'Friend', streak: 0, isReturning: false, energyLevel: null, isPro: false };
let tasks = loadTasks();
let activeTaskId      = null;
let doneSectionOpen   = false;
let pendingTimerStart = false;

// Stats (header display)
let sessionsToday = loadTodaySessions();
let minutesToday  = 0;

// Detailed daily tracking (seconds per category)
let todayTracking = loadTodayTracking();

let chatHistory = [];

// Google Sign-In readiness flags (must be declared before restoreSession IIFE below)
let _gsiReady   = false;
let _gsiPending = false;

// =============================================
// Init
// =============================================
applyTheme();
renderTasks();
updateTimerDisplay();
updateRing();
updateStatsDisplay();
loadSettingsUI();
setHeaderDate();
updateLockedUI();
renderTodayTracking();
updateIcons();
updateQuickPicks();
updateNavSessionBadge();
updateModeTabDots();
updateWastedTabLabel();

// Restore session from cookie if one already exists (e.g. page reload, post-Stripe redirect)
(async function restoreSession() {
    const hasSessionHint = !!localStorage.getItem('intime_has_session');
    // No hint → first-time visitor or logged-out user; show button right away.
    if (!hasSessionHint) _initGoogleSignIn();
    try {
        const res = await fetch('/auth/me', { credentials: 'include' });
        if (!res.ok) {
            // Had a hint but the cookie is gone/expired.
            if (hasSessionHint) {
                localStorage.removeItem('intime_has_session');
                _initGoogleSignIn();
            }
            return;
        }
        const { user_id } = await res.json();
        // Valid session — keep the sign-in button hidden.
        localStorage.setItem('intime_has_session', '1');
        // Restore display name from localStorage while profile loads
        user.name = localStorage.getItem('intime_last_user_name') || 'Friend';
        user.id   = user_id;
        document.getElementById('user-avatar').textContent = user.name[0].toUpperCase();
        document.getElementById('user-name').textContent   = user.name;
        document.getElementById('user-badge').style.display = 'flex';
        document.getElementById('google-signin-btn').style.display = 'none';
        updateLockedUI();
        renderTasks();
        // Full profile fetch
        try {
            const pr   = await fetch('/get-profile', { credentials: 'include' });
            const data = await pr.json();
            minutesToday  = data.today_minutes  || 0;
            sessionsToday = data.today_sessions || sessionsToday;
            user.streak      = data.streak      || 0;
            user.isReturning = data.is_returning || false;
            user.isPro       = data.is_pro       || false;
            if (user.isPro && data.timer_work) {
                settings = { focus: data.timer_work || settings.focus, break: data.timer_short || settings.break };
                localStorage.setItem('intime_settings', JSON.stringify(settings));
                loadSettingsUI();
                if (appState === 'idle') {
                    timerTotalSecs  = settings[timerMode] * 60;
                    timerRemainSecs = timerTotalSecs;
                    updateTimerDisplay(); updateRing(); updateQuickPicks();
                }
            }
            enableChat();
            updateLockedUI();
            updateStatsDisplay();
            tasks = loadTasks();
            renderTasks();
            await _loadChatHistory();
        } catch (e) { console.error('Profile restore failed:', e); }
        await _restoreTimerState();
    } catch {}
})();

// Guest timer restore — runs immediately without waiting for auth
(function () {
    if (localStorage.getItem('intime_has_session')) return; // logged-in user handled above
    try {
        const state = JSON.parse(localStorage.getItem('intime_timer_state') || 'null');
        if (state) _applyTimerState(state);
    } catch {}
})();

// Check post-checkout URL params on every page load
(function handleCheckoutReturn() {
    const params = new URLSearchParams(window.location.search);

    if (params.get('checkout') === 'canceled') {
        window.history.replaceState({}, '', '/app');
        showToast('Checkout canceled — no charge made', 'ℹ️');
        return;
    }

    if (params.get('upgraded') !== 'true') return;
    window.history.replaceState({}, '', '/app');

    const savedUid  = sessionStorage.getItem('intime_post_checkout_uid');
    const savedName = sessionStorage.getItem('intime_post_checkout_name');
    sessionStorage.removeItem('intime_post_checkout_uid');
    sessionStorage.removeItem('intime_post_checkout_name');

    if (!savedUid) {
        sessionStorage.setItem('intime_upgraded_pending', '1');
        return;
    }

    user.id   = savedUid;
    user.name = savedName || localStorage.getItem('intime_last_user_name') || 'Friend';

    let polls = 0;
    const checkPro = async () => {
        polls++;
        try {
            const res  = await fetch('/api/user/subscription', { credentials: 'include' });
            const data = await res.json();
            if (data.is_pro) {
                user.isPro = true;
                updateLockedUI();
                updateStatsDisplay();
                showToast('Pro activated! Sign in to access all features ✨', '✨', 6000);
                return;
            }
        } catch (e) { console.error('Post-checkout Pro check failed:', e); }
        if (polls < 15) setTimeout(checkPro, 1000);
        else showToast('Payment received — sign in to activate Pro ✨', '✨', 6000);
    };
    checkPro();
})();

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
// Auth Gate
// =============================================
function showSignInBanner() { openModal('auth-modal'); }
function hideSignInBanner() { closeAllModals(); }

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
});

document.addEventListener('click', function(e) {
    if (user.id) return;
    if (e.target.closest('#theme-btn, #user-area, #auth-modal, .logo, [data-allow-guest], #focus-panel')) return;
    openModal('auth-modal');
    e.preventDefault();
    e.stopPropagation();
}, true);

// =============================================
// Feature Gating
// =============================================
function gatedFeature() {
    if (!user.id)    { openModal('auth-modal');    return false; }
    if (!user.isPro) { openModal('upgrade-modal'); return false; }
    return true;
}

function showUpgradeModal() { openModal('upgrade-modal'); }

function triggerGoogleSignIn() {
    closeAllModals();
    hideSignInBanner();
    if (typeof google !== 'undefined') google.accounts.id.prompt();
}

function gatedLofi() {
    if (!gatedFeature()) return;
    window.open('https://lofi.cafe', '_blank', 'noopener');
}

function gatedCalendar() {
    if (!gatedFeature()) return;
    openCalendar();
}

function gatedSettings() {
    if (!user.id) { openModal('auth-modal'); return; }
    openModal('settings-modal');
}

function gatedChat() {
    if (!user.id) { openModal('auth-modal'); return; }
    openModal('upgrade-modal');
}

// =============================================
// Locked UI
// =============================================
function updateLockedUI() {
    const isGuest = !user.id;
    const isFree  = user.id && !user.isPro;

    const taskOverlay = document.getElementById('task-lp-overlay');
    if (taskOverlay) taskOverlay.classList.toggle('visible', isGuest);

    const taskDemo = document.getElementById('task-demo');
    const taskReal = document.getElementById('task-scroll-real');
    if (taskDemo) taskDemo.style.display = isGuest ? '' : 'none';
    if (taskReal) taskReal.style.display = isGuest ? 'none' : '';

    const chatOverlay = document.getElementById('chat-lp-overlay');
    if (chatOverlay) {
        chatOverlay.classList.toggle('visible', isGuest || isFree);
        const heading = document.getElementById('chat-lock-heading');
        const subtext = document.getElementById('chat-lock-subtext');
        const cta     = document.getElementById('chat-lock-cta');
        if (isGuest) {
            if (heading) heading.textContent = 'Unlock your AI Study Friend';
            if (subtext) subtext.textContent = 'Sign in and upgrade to Pro for personalized focus coaching.';
            if (cta) { cta.textContent = 'Sign in to continue'; cta.onclick = () => openModal('auth-modal'); }
        } else if (isFree) {
            if (heading) heading.textContent = 'Upgrade to unlock AI coaching';
            if (subtext) subtext.textContent = 'Get unlimited chat with your Study Friend, personalized support, and session insights.';
            if (cta) { cta.textContent = 'Upgrade to Pro — $9/mo'; cta.onclick = () => openModal('upgrade-modal'); }
        }
    }

    const chatDemo     = document.getElementById('chat-demo');
    const chatMessages = document.getElementById('chat-messages');
    if (chatDemo)     chatDemo.style.display     = (isGuest || isFree) ? '' : 'none';
    if (chatMessages) chatMessages.style.display = (isGuest || isFree) ? 'none' : '';

    updateSoundLocks();
    updateSettingsLocks();
}

function updateSoundLocks() {
    const isGuest = !user.id;
    const isPro   = user.id && user.isPro;

    ['rain', 'brown'].forEach(type => {
        const btn   = document.getElementById(`snd-${type}`);
        const badge = document.getElementById(`snd-${type}-badge`);
        if (btn)   btn.classList.toggle('sound-gated', isGuest);
        if (badge) badge.style.display = isGuest ? '' : 'none';
    });

    ['white', 'lofi'].forEach(type => {
        const btn   = document.getElementById(`snd-${type}`);
        const badge = document.getElementById(`snd-${type}-badge`);
        if (btn)   btn.classList.toggle('sound-gated', !isPro);
        if (badge) badge.style.display = isPro ? 'none' : '';
    });
}

function updateSettingsLocks() {
    const isPro = user.id && user.isPro;
    ['s-work', 's-short'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !isPro;
    });
    document.querySelectorAll('.setting-pro-badge').forEach(b => { b.style.display = isPro ? 'none' : ''; });
    const saveBtn = document.getElementById('settings-save-btn');
    if (saveBtn) saveBtn.textContent = isPro ? 'Save Settings' : 'Upgrade to customize →';

    const manageBtn = document.getElementById('manage-sub-btn');
    if (manageBtn) manageBtn.style.display = isPro ? '' : 'none';
}

function handleSoundClick(type) {
    if (!user.id) { openModal('auth-modal'); return; }
    if (['white', 'lofi'].includes(type) && !user.isPro) { openModal('upgrade-modal'); return; }
    if (type === 'lofi') { window.open('https://lofi.cafe', '_blank', 'noopener'); return; }
    toggleSound(type);
}

// =============================================
// Stripe / Subscription
// =============================================
async function startCheckout() {
    if (!user.id) { openModal('auth-modal'); return; }
    try {
        const res = await fetch('/api/stripe/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email: '' }),
        });
        const data = await res.json();
        if (data.checkout_url) {
            sessionStorage.setItem('intime_post_checkout_uid',  user.id);
            sessionStorage.setItem('intime_post_checkout_name', user.name);
            window.location.href = data.checkout_url;
        } else {
            showToast('Could not start checkout — try again', '⚠️');
        }
    } catch (e) {
        showToast('Could not start checkout — try again', '⚠️');
    }
}

async function openBillingPortal() {
    if (!user.id) return;
    try {
        const res = await fetch('/api/stripe/create-portal-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.portal_url) window.location.href = data.portal_url;
    } catch (e) { console.error('Portal failed:', e); }
}

async function refreshUserTier() {
    if (!user.id) return;
    try {
        const res  = await fetch('/api/user/subscription', { credentials: 'include' });
        const data = await res.json();
        user.isPro = data.is_pro;
        enableChat();
        updateLockedUI();
        updateStatsDisplay();
    } catch (e) { console.error('Tier refresh failed:', e); }
}

function showToast(message, icon = '✨', duration = 3000, subtitle = null) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    const msgEl = toast.querySelector('.toast-message');
    const icoEl = toast.querySelector('.toast-icon');
    const subEl = toast.querySelector('.toast-sub');
    if (msgEl) msgEl.textContent = message;
    if (icoEl) icoEl.textContent = icon;
    if (subEl) {
        subEl.textContent = subtitle || '';
        subEl.style.display = subtitle ? '' : 'none';
    }
    toast.classList.toggle('toast-warning', icon === '⚠️');
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// =============================================
// Google Sign-In
// =============================================

// Programmatic GSI — avoids the auto-prompt flash on page reload.
// We render the button only after /auth/me confirms no valid session exists.
window.onGoogleLibraryLoad = function () {
    _gsiReady = true;
    if (_gsiPending) { _gsiPending = false; _renderGoogleButton(); }
};

function _initGoogleSignIn() {
    if (!_gsiReady) { _gsiPending = true; return; }
    _renderGoogleButton();
}

function _renderGoogleButton() {
    google.accounts.id.initialize({
        client_id: '121246915230-hrfas5irqhnb8sgg8qoc37ba51dqkg0g.apps.googleusercontent.com',
        callback: handleCredentialResponse,
        auto_select: false,
    });
    const el = document.getElementById('google-signin-btn');
    if (el) {
        el.style.display = '';
        google.accounts.id.renderButton(el, { type: 'standard', size: 'medium' });
    }
}

async function handleCredentialResponse(response) {
    // Verify Google token server-side and establish a signed session cookie.
    try {
        const authRes = await fetch('/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ credential: response.credential }),
        });
        if (!authRes.ok) {
            showToast('Sign-in failed — please try again', '⚠️');
            return;
        }
    } catch {
        showToast('Sign-in failed — please try again', '⚠️');
        return;
    }

    // Decode payload for display only (name, avatar). Auth is already settled above.
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    user.id   = payload.sub;
    user.name = payload.given_name || payload.name || 'Friend';
    localStorage.setItem('intime_last_user_id', user.id);
    localStorage.setItem('intime_last_user_name', user.name);
    localStorage.setItem('intime_has_session', '1');
    closeAllModals();

    document.getElementById('user-avatar').textContent = user.name[0].toUpperCase();
    document.getElementById('user-name').textContent   = user.name;
    document.getElementById('user-badge').style.display = 'flex';
    document.getElementById('google-signin-btn').style.display = 'none';

    updateLockedUI();
    renderTasks();

    try {
        const res  = await fetch('/get-profile', { credentials: 'include' });
        const data = await res.json();
        minutesToday  = data.today_minutes  || 0;
        sessionsToday = data.today_sessions || sessionsToday;
        user.streak       = data.streak       || 0;
        user.isReturning  = data.is_returning || false;
        user.isPro        = data.is_pro       || false;

        if (user.isPro && data.timer_work) {
            settings = {
                focus: data.timer_work  || settings.focus,
                break: data.timer_short || settings.break,
            };
            localStorage.setItem('intime_settings', JSON.stringify(settings));
            loadSettingsUI();
            if (appState === 'idle') {
                timerTotalSecs  = settings[timerMode] * 60;
                timerRemainSecs = timerTotalSecs;
                updateTimerDisplay();
                updateRing();
                updateQuickPicks();
            }
        }

        enableChat();
        updateLockedUI();
        updateStatsDisplay();
    } catch (e) { console.error('Profile load failed:', e); }

    const _upgraded = sessionStorage.getItem('intime_upgraded_pending');
    if (_upgraded) {
        sessionStorage.removeItem('intime_upgraded_pending');
        if (user.isPro) {
            showToast('Welcome to Pro ✨', '✨');
        } else {
            let polls = 0;
            const _poll = setInterval(async () => {
                polls++;
                await refreshUserTier();
                if (user.isPro || polls >= 15) {
                    clearInterval(_poll);
                    if (user.isPro) showToast('Welcome to Pro ✨', '✨');
                    else showToast('Upgrade processing — check back shortly', 'ℹ️');
                }
            }, 1000);
        }
    } else if (user.isPro) {
        showToast('Welcome back ✨', '✨');
    } else {
        showToast('Task list unlocked!', '🎉');
    }

    const userKey = `intime_tasks_${user.id}`;
    if (!localStorage.getItem(userKey)) {
        const anonTasks = localStorage.getItem('intime_tasks_anon') || localStorage.getItem('dopamine_tasks');
        if (anonTasks) localStorage.setItem(userKey, anonTasks);
    }
    tasks = loadTasks();
    renderTasks();
    fetchMissingEstimates();

    if (!user.isPro) return;

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
}
window.handleCredentialResponse = handleCredentialResponse;

// Handle pending credential from sessionStorage (must run after function is defined)
(function () {
    const _pendingCred = sessionStorage.getItem('google_credential');
    if (_pendingCred) {
        sessionStorage.removeItem('google_credential');
        handleCredentialResponse({ credential: _pendingCred });
    }
})();

function enableChat() {
    if (!user.isPro) return;
    document.getElementById('chat-input').disabled = false;
    document.getElementById('send-btn').disabled   = false;
}

async function _loadChatHistory() {
    if (!user.isPro) return;
    try {
        const res = await fetch('/chat/history', { credentials: 'include' });
        if (!res.ok) return;
        const messages = await res.json();
        if (!messages.length) return;
        const box = document.getElementById('chat-messages');
        if (!box) return;
        for (const msg of messages) {
            if (msg.role === 'user') {
                appendUserMessage(msg.content);
            } else {
                appendAiMessage(msg.content, []);
            }
            chatHistory.push({ role: msg.role, text: msg.content });
        }
        if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
        box.scrollTop = box.scrollHeight;
    } catch {}
}

async function logOut() {
    if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect();
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch {};

    localStorage.removeItem('intime_has_session');
    user = { id: null, name: 'Friend', streak: 0, isReturning: false, energyLevel: null, isPro: false };
    chatHistory = [];
    sessionsToday = 0;
    minutesToday  = 0;

    document.getElementById('user-badge').style.display = 'none';
    // Re-render the sign-in button (clears previous render state first).
    const btnEl = document.getElementById('google-signin-btn');
    if (btnEl) btnEl.innerHTML = '';
    _initGoogleSignIn();

    document.getElementById('chat-messages').innerHTML = '';
    document.getElementById('chat-input').disabled = true;
    document.getElementById('send-btn').disabled   = true;
    document.getElementById('suggestions').innerHTML = '';
    const statusEl = document.getElementById('ai-status');
    if (statusEl) { statusEl.textContent = 'Ready to help'; statusEl.className = 'chat-status'; }

    updateLockedUI();
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
    if (!user.id) { openModal('auth-modal'); return; }
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
    if (!task.done && user.id) recordTaskCompletion(task);
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
            credentials: 'include',
            body:    JSON.stringify({ taskTitle: task.title, minutesSpent: task.actualMins || 0 }),
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
        ? `<span class="task-est" title="double-click to edit" ondblclick="editEstimate('${task.id}')">~${task.estimatedMins}m</span>`
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
// Editable Estimates
// =============================================
function editEstimate(id) {
    const li = document.querySelector(`.task-item[data-id="${id}"]`);
    if (!li) return;
    const span = li.querySelector('.task-est');
    if (!span) return;
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    const input = document.createElement('input');
    input.type = 'number';
    input.min  = '1';
    input.max  = '999';
    input.value = task.estimatedMins || '';
    input.className = 'task-est-edit';

    let saved = false;
    const save = () => {
        if (saved) return;
        saved = true;
        const val = parseInt(input.value);
        if (val > 0) {
            task.estimatedMins  = val;
            task.estimateSource = 'edited by you';
            saveTasks();
        }
        renderTasks();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { saved = true; renderTasks(); }
    });
    input.addEventListener('blur', save);

    span.replaceWith(input);
    input.focus();
    input.select();
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
            credentials: 'include',
            body: JSON.stringify({ task: task.title, userName: user.name }),
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
// Timer — Mode
// =============================================
function setMode(mode) {
    if (mode === 'wasted') {
        if (appState !== 'wasted') showToast('Tracked automatically when you don\'t respond', 'ℹ️');
        return;
    }

    if (appState === 'wasted') return;

    if (appState === 'focus_running' || appState === 'break_running' ||
        appState === 'focus_paused'  || appState === 'break_paused') {
        const running = timerMode === 'focus' ? 'Focus' : 'Break';
        showToast(
            'A session is already running',
            '⚠️',
            4000,
            `Finish or save your current ${running} session before switching`
        );
        return;
    }

    timerMode        = mode;
    timerTotalSecs   = settings[mode] * 60;
    timerRemainSecs  = timerTotalSecs;
    timerElapsedSecs = 0;
    timerStartedAt   = null;
    appState         = 'idle';

    updateTimerDisplay();
    updateRing();
    updateFocusPanelTheme();
    updateIcons();
    updateQuickPicks();
    updateModeTabDots();
    _setActiveModeTab(mode);

    const label = document.getElementById('ring-label');
    if (label) label.textContent = mode === 'focus' ? 'FOCUS' : 'BREAK';
}

function _setActiveModeTab(mode) {
    document.querySelectorAll('.mode-tog').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
}

// =============================================
// Timer — Navbar Session Badge
// =============================================
function updateNavSessionBadge() {
    const badge = document.getElementById('nav-session-badge');
    if (!badge) return;

    const isActive = ['focus_running', 'focus_paused', 'break_running', 'break_paused', 'wasted'].includes(appState);
    badge.style.display = isActive ? 'flex' : 'none';
    if (!isActive) return;

    let icon, modeLabel, timeStr;
    if (appState === 'wasted') {
        icon = '⏳'; modeLabel = 'Wasted';
        if (wastedStartedAt) {
            const e = Math.floor((Date.now() - wastedStartedAt) / 1000);
            const mm = Math.floor(e / 60).toString().padStart(2, '0');
            const ss = (e % 60).toString().padStart(2, '0');
            timeStr = `${mm}:${ss}`;
        } else { timeStr = ''; }
    } else {
        icon = timerMode === 'focus' ? '🎯' : '☕';
        modeLabel = timerMode === 'focus' ? 'Focus' : 'Break';
        const mm = Math.floor(timerRemainSecs / 60).toString().padStart(2, '0');
        const ss = (timerRemainSecs % 60).toString().padStart(2, '0');
        timeStr = `${mm}:${ss}`;
    }

    const lbl = badge.querySelector('.nsb-label');
    if (lbl) lbl.textContent = `${icon} ${modeLabel} · ${timeStr}`;

    const isPulsing = appState === 'focus_running' || appState === 'break_running' || appState === 'wasted';
    badge.classList.toggle('nsb-running', isPulsing);
}

function navBadgeClick() {
    closeAllModals();
    const panel = document.getElementById('focus-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// =============================================
// Timer — Tab Dots & Wasted Label
// =============================================
function updateModeTabDots() {
    document.querySelectorAll('.mode-tog').forEach(btn => {
        const mode = btn.dataset.mode;
        const isRunning =
            (mode === 'focus'  && (appState === 'focus_running'  || appState === 'focus_paused'))  ||
            (mode === 'break'  && (appState === 'break_running'  || appState === 'break_paused'))  ||
            (mode === 'wasted' && appState === 'wasted');
        btn.classList.toggle('running', isRunning);
    });
}

function updateWastedTabLabel() {
    const btn = document.querySelector('.mode-tog[data-mode="wasted"]');
    if (!btn) return;
    const w = todayTracking.wasted || 0;
    if (appState !== 'wasted' && w > 0) {
        btn.textContent = `Wasted · ${fmtDuration(w)}`;
    } else {
        btn.textContent = 'Wasted';
    }
}

// =============================================
// Timer — Quick Picks
// =============================================
function fmtPillDuration(secs) {
    if (secs >= 3600) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function updateQuickPicks() {
    const container = document.getElementById('dp-pills');
    if (!container) return;

    if (appState === 'wasted') { container.innerHTML = ''; return; }

    const picks = timerMode === 'focus' ? FOCUS_PICKS : BREAK_PICKS;
    const isCustom = !picks.includes(timerTotalSecs);

    const pillsHtml = picks.map(secs => {
        const label = secs >= 3600 ? `${secs / 3600}h` : `${secs / 60}m`;
        const isActive = secs === timerTotalSecs;
        return `<button class="dp-pill${isActive ? ' active' : ''}" onclick="selectQuickPick(${secs})">${label}</button>`;
    }).join('');

    const customLabel = isCustom ? `Custom · ${fmtPillDuration(timerTotalSecs)}` : 'Custom';
    const customHtml = `<button class="dp-pill${isCustom ? ' active' : ''}" onclick="openCustomDuration()">${customLabel}</button>`;

    container.innerHTML = pillsHtml + customHtml;
}

function selectQuickPick(secs) {
    if (['focus_running', 'break_running', 'focus_paused', 'break_paused', 'wasted'].includes(appState)) {
        showToast('Pause or save your session to change duration', 'ℹ️');
        return;
    }
    if (appState === 'awaiting_response') return;

    timerTotalSecs   = secs;
    timerRemainSecs  = secs;
    timerElapsedSecs = 0;
    settings[timerMode] = Math.max(1, Math.round(secs / 60));
    localStorage.setItem('intime_settings', JSON.stringify(settings));

    updateTimerDisplay();
    updateRing();
    updateQuickPicks();
}

function openCustomDuration() {
    if (['focus_running', 'break_running', 'focus_paused', 'break_paused', 'wasted'].includes(appState)) {
        showToast('Pause or save your session to change duration', 'ℹ️');
        return;
    }
    if (appState === 'awaiting_response') return;
    openWheelPicker(timerTotalSecs, selectQuickPick);
}

// =============================================
// Timer — Wheel Picker
// =============================================
function buildSimpleWheel(containerId, max, initVal) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    const ITEM_H = 44;
    container.innerHTML = '';
    container.style.cssText = `height:${ITEM_H * 5}px;position:relative;overflow:hidden;user-select:none;`;

    const list = document.createElement('div');
    list.className = 'wp-list';

    const itemEls = [];
    for (let i = 0; i <= max; i++) {
        const item = document.createElement('div');
        item.className = 'wp-item';
        item.textContent = String(i).padStart(2, '0');
        item.addEventListener('click', () => selectIdx(i));
        list.appendChild(item);
        itemEls.push(item);
    }
    container.appendChild(list);

    // Selection lines
    const tl = document.createElement('div');
    tl.className = 'wp-sel-line';
    tl.style.top = (ITEM_H * 2) + 'px';
    const bl = document.createElement('div');
    bl.className = 'wp-sel-line';
    bl.style.top = (ITEM_H * 3) + 'px';
    container.appendChild(tl);
    container.appendChild(bl);

    // Gradient masks
    const tm = document.createElement('div');
    tm.className = 'wp-mask wp-mask-top';
    tm.style.height = (ITEM_H * 2) + 'px';
    const bm = document.createElement('div');
    bm.className = 'wp-mask wp-mask-bot';
    bm.style.height = (ITEM_H * 2) + 'px';
    container.appendChild(tm);
    container.appendChild(bm);

    let selIdx = Math.max(0, Math.min(max, initVal));

    function render(idx, animate) {
        selIdx = Math.max(0, Math.min(max, idx));
        list.style.transition = animate ? 'transform 0.15s ease' : 'none';
        list.style.transform = `translateY(${ITEM_H * 2 - selIdx * ITEM_H}px)`;
        itemEls.forEach((el, i) => {
            const d = Math.abs(i - selIdx);
            el.style.fontSize   = d === 0 ? '22px' : '15px';
            el.style.fontWeight = d === 0 ? '600'  : '400';
            el.style.opacity    = d === 0 ? '1'    : d === 1 ? '0.45' : '0.18';
        });
        _wpUpdateBtn();
    }

    function selectIdx(idx) { render(idx, true); }

    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        render(selIdx + (e.deltaY > 0 ? 1 : -1), true);
    }, { passive: false });

    // Touch drag
    let dragY = null;
    container.addEventListener('touchstart', e => { dragY = e.touches[0].clientY; }, { passive: true });
    container.addEventListener('touchmove',  e => { e.preventDefault(); }, { passive: false });
    container.addEventListener('touchend',   e => {
        if (dragY === null) return;
        const dy = dragY - e.changedTouches[0].clientY;
        dragY = null;
        render(selIdx + Math.round(dy / ITEM_H), true);
    });

    render(selIdx, false);
    return { getValue: () => selIdx, setValue: (v, anim = true) => render(v, anim) };
}

function openWheelPicker(totalSecs, callback) {
    _wpCallback = callback;
    totalSecs = Math.max(1, Math.min(3 * 3600, totalSecs));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;

    _wpWheels.h = buildSimpleWheel('wp-h', 3,  h);
    _wpWheels.m = buildSimpleWheel('wp-m', 59, m);
    _wpWheels.s = buildSimpleWheel('wp-s', 59, s);

    const subtitle = document.getElementById('wp-subtitle');
    if (subtitle) {
        subtitle.textContent =
            timerMode === 'focus' ? 'Focus' :
            timerMode === 'break' ? 'Break' : '';
    }

    document.getElementById('wp-overlay').style.display = 'block';
    document.getElementById('wheel-picker-modal').classList.add('open');
}

function closeWheelPicker() {
    document.getElementById('wp-overlay').style.display = 'none';
    document.getElementById('wheel-picker-modal').classList.remove('open');
    _wpCallback = null;
}

function confirmWheelPicker() {
    const h = _wpWheels.h ? _wpWheels.h.getValue() : 0;
    const m = _wpWheels.m ? _wpWheels.m.getValue() : 0;
    const s = _wpWheels.s ? _wpWheels.s.getValue() : 0;
    const total = h * 3600 + m * 60 + s;
    if (total === 0) return;
    const capped = Math.min(3 * 3600, total);
    closeWheelPicker();
    if (_wpCallback) _wpCallback(capped);
}

function _wpUpdateBtn() {
    const btn = document.getElementById('wp-confirm-btn');
    if (!btn) return;
    const h = _wpWheels.h ? _wpWheels.h.getValue() : 0;
    const m = _wpWheels.m ? _wpWheels.m.getValue() : 0;
    const s = _wpWheels.s ? _wpWheels.s.getValue() : 0;
    btn.disabled = (h === 0 && m === 0 && s === 0);
}

// =============================================
// Timer — Icon Controls
// =============================================
function handlePlay() {
    const s = appState;
    if (s === 'focus_running' || s === 'break_running') {
        pauseTimer();
    } else if (s === 'idle') {
        if (user.isPro && user.energyLevel === null && timerMode === 'focus') {
            pendingTimerStart = true;
            openModal('energy-modal');
            return;
        }
        startTimer();
    }
}

function handleResume() {
    if (appState !== 'focus_paused' && appState !== 'break_paused') return;
    startTimer();
}

function handleSave() {
    if (appState === 'wasted') { saveWasted(); return; }

    let elapsed = timerElapsedSecs;
    if (timerStartedAt) elapsed += Math.floor((Date.now() - timerStartedAt) / 1000);
    if (elapsed < 3) return;

    clearInterval(timerInterval);
    timerInterval = null;

    const mins    = Math.floor(elapsed / 60);
    const apiMins = mins > 0 ? mins : (elapsed >= 30 ? 1 : 0);

    addToTracking(timerMode, elapsed);

    if (user.id && apiMins > 0) {
        if (timerMode === 'focus') {
            sessionsToday++;
            saveTodaySessions(sessionsToday);
            minutesToday += apiMins;
            const activeTask = tasks.find(t => t.id === activeTaskId);
            if (activeTask) { activeTask.actualMins = (activeTask.actualMins || 0) + apiMins; saveTasks(); }
        }
        fetch('/complete-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ minutes: apiMins }),
        }).then(r => r.json()).then(data => {
            minutesToday  = data.today_minutes;
            sessionsToday = data.today_sessions;
            user.streak   = data.streak ?? user.streak;
            updateStatsDisplay();
        }).catch(e => console.error('Session save failed:', e));
    }

    appState         = 'idle';
    timerElapsedSecs = 0;
    timerStartedAt   = null;
    timerRemainSecs  = timerTotalSecs;
    _clearTimerState();

    document.getElementById('focus-panel').classList.remove('timer-running');
    updateTimerDisplay();
    updateRing();
    updateIcons();
    updateQuickPicks();
    updateNavSessionBadge();
    updateModeTabDots();
    updateStatsDisplay();
    launchConfetti('small');
    showToast(`${fmtDuration(elapsed)} session saved!`, '✅');
}

function updateIcons() {
    const s         = appState;
    const isWasted  = s === 'wasted';
    const isRunning = s === 'focus_running' || s === 'break_running';
    const isPaused  = s === 'focus_paused'  || s === 'break_paused';
    const isIdle    = s === 'idle';

    const btnPlay   = document.getElementById('btn-play');
    const btnResume = document.getElementById('btn-resume');
    const btnSave   = document.getElementById('btn-save');
    if (!btnPlay) return;

    if (isWasted) {
        btnPlay.style.display   = 'none';
        btnResume.style.display = 'none';
        btnSave.style.display   = '';
        btnSave.classList.remove('t-icon-dim');
        return;
    }
    if (s === 'awaiting_response') {
        btnPlay.style.display = btnResume.style.display = btnSave.style.display = '';
        btnPlay.classList.add('t-icon-dim');
        btnResume.classList.add('t-icon-dim');
        btnSave.classList.add('t-icon-dim');
        return;
    }

    btnPlay.style.display = btnResume.style.display = btnSave.style.display = '';

    const iconPlay  = btnPlay.querySelector('.icon-play');
    const iconPause = btnPlay.querySelector('.icon-pause');
    if (iconPlay)  iconPlay.style.display  = isRunning ? 'none' : '';
    if (iconPause) iconPause.style.display = isRunning ? '' : 'none';
    btnPlay.classList.toggle('t-icon-dim', isPaused);
    btnPlay.title = isRunning ? 'Pause' : 'Start';

    btnResume.classList.toggle('t-icon-dim', !isPaused);

    const hasElapsed = timerElapsedSecs > 0 ||
        (timerStartedAt !== null && Date.now() - timerStartedAt > 5000);
    btnSave.classList.toggle('t-icon-dim', isIdle || (!isRunning && !isPaused) || !hasElapsed);
}

// =============================================
// Timer — Persistence
// =============================================

async function _saveTimerState() {
    const state = {
        mode:          timerMode,
        status:        appState.startsWith('focus_') || appState.startsWith('break_')
                           ? (appState.endsWith('_running') ? 'running' : 'paused')
                           : appState,   // 'wasted'
        duration_secs: timerTotalSecs,
        started_at:    timerStartedAt,
        elapsed_secs:  timerElapsedSecs,
        wasted_at:     wastedStartedAt,
    };
    if (!user.id) {
        localStorage.setItem('intime_timer_state', JSON.stringify(state));
        return;
    }
    try {
        await fetch('/timer/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(state),
        });
    } catch {}
}

async function _clearTimerState() {
    localStorage.removeItem('intime_timer_state');
    if (!user.id) return;
    try { await fetch('/timer/state', { method: 'DELETE', credentials: 'include' }); } catch {}
}

async function _restoreTimerState() {
    let state = null;
    if (user.id) {
        try {
            const res = await fetch('/timer/state', { credentials: 'include' });
            if (res.ok) state = await res.json();
        } catch {}
    } else {
        try { state = JSON.parse(localStorage.getItem('intime_timer_state') || 'null'); } catch {}
    }
    if (!state || !state.status) return;
    _applyTimerState(state);
}

async function _applyTimerState(state) {
    if (state.status === 'wasted') {
        enterWastedState();                                        // does UI + save (wastedStartedAt wrong here)
        wastedStartedAt = state.wasted_at || wastedStartedAt;     // correct the timestamp
        _saveTimerState();                                         // re-save with correct wasted_at
        return;
    }

    timerMode      = state.mode || 'focus';
    timerTotalSecs = state.duration_secs || settings[timerMode] * 60;

    if (state.status === 'paused') {
        timerElapsedSecs = state.elapsed_secs || 0;
        timerRemainSecs  = Math.max(0, timerTotalSecs - timerElapsedSecs);
        timerStartedAt   = null;
        appState = timerMode === 'focus' ? 'focus_paused' : 'break_paused';
        _setActiveModeTab(timerMode);
        updateFocusPanelTheme();
        updateTimerDisplay(); updateRing(); updateIcons(); updateModeTabDots();
        updateNavSessionBadge(); updateQuickPicks();
        return;
    }

    // status === 'running': calculate actual elapsed including time since last save
    const nowMs = Date.now();
    const runMs = state.started_at ? (nowMs - state.started_at) : 0;
    const totalElapsed = (state.elapsed_secs || 0) + Math.floor(runMs / 1000);

    if (totalElapsed >= timerTotalSecs) {
        // Timer completed while page was closed/refreshed
        const completedAtMs   = state.started_at + (timerTotalSecs - (state.elapsed_secs || 0)) * 1000;
        const secsSinceComplete = Math.floor((nowMs - completedAtMs) / 1000);

        if (secsSinceComplete < 300) {
            // Popup window still open — simulate completion (timerComplete clears state)
            timerElapsedSecs = timerTotalSecs;
            timerRemainSecs  = 0;
            appState = timerMode === 'focus' ? 'focus_running' : 'break_running';
            await timerComplete();
        } else {
            // Popup expired → wasted state, counting from when popup closed
            enterWastedState();                         // UI + save (wastedStartedAt = now-300s, wrong)
            wastedStartedAt = completedAtMs + 300000;   // correct: wasted since popup expired
            _saveTimerState();                          // re-save with correct timestamp, do NOT clear
        }
        return;
    }

    // Timer still running — resume with corrected elapsed
    timerElapsedSecs = totalElapsed;
    timerStartedAt   = Date.now();
    timerRemainSecs  = Math.max(0, timerTotalSecs - timerElapsedSecs);
    appState = timerMode === 'focus' ? 'focus_running' : 'break_running';

    timerInterval = setInterval(timerTick, 500);
    document.getElementById('focus-panel').classList.add('timer-running');
    _setActiveModeTab(timerMode);
    updateFocusPanelTheme();
    updateTimerDisplay(); updateRing(); updateIcons(); updateModeTabDots();
    updateNavSessionBadge(); updateQuickPicks();
}

// =============================================
// Timer — Core
// =============================================
function startTimer() {
    timerStartedAt = Date.now();
    appState = timerMode === 'focus' ? 'focus_running' : 'break_running';
    timerInterval = setInterval(timerTick, 500);
    document.getElementById('focus-panel').classList.add('timer-running');
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();
    _saveTimerState();
}

function pauseTimer() {
    if (timerStartedAt) {
        timerElapsedSecs += Math.floor((Date.now() - timerStartedAt) / 1000);
    }
    timerRemainSecs = Math.max(0, timerTotalSecs - timerElapsedSecs);
    timerStartedAt  = null;
    clearInterval(timerInterval);
    timerInterval = null;
    appState = timerMode === 'focus' ? 'focus_paused' : 'break_paused';
    document.getElementById('focus-panel').classList.remove('timer-running');
    updateTimerDisplay();
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();
    _saveTimerState();
}

function timerTick() {
    const runElapsed   = timerStartedAt ? Math.floor((Date.now() - timerStartedAt) / 1000) : 0;
    const totalElapsed = timerElapsedSecs + runElapsed;
    timerRemainSecs    = Math.max(0, timerTotalSecs - totalElapsed);
    updateTimerDisplay();
    updateRing();
    updateNavSessionBadge();
    if (timerRemainSecs <= 0) timerComplete();
}

async function timerComplete() {
    clearInterval(timerInterval);
    timerInterval = null;
    document.getElementById('focus-panel').classList.remove('timer-running');

    const completedMode = timerMode;
    const mins = Math.round(timerTotalSecs / 60);

    addToTracking(completedMode, timerTotalSecs);
    if (completedMode === 'focus') {
        sessionsToday++;
        saveTodaySessions(sessionsToday);
        minutesToday += mins;
        const activeTask = tasks.find(t => t.id === activeTaskId);
        if (activeTask) { activeTask.actualMins = (activeTask.actualMins || 0) + mins; saveTasks(); }
    }

    if (user.id) {
        try {
            const res  = await fetch('/complete-session', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ minutes: mins }),
            });
            const data = await res.json();
            minutesToday  = data.today_minutes;
            sessionsToday = data.today_sessions;
            user.streak   = data.streak ?? user.streak;
        } catch (e) { console.error('Session save failed:', e); }
    }

    updateStatsDisplay();
    const isStreakMilestone = STREAK_MILESTONES.has(user.streak);
    launchConfetti(isStreakMilestone ? 'big' : 'small');

    if (user.isPro && completedMode === 'focus') {
        const activeTask = tasks.find(t => t.id === activeTaskId);
        sendChatInternal(
            `I just completed a ${mins}-minute focus session!` +
            (activeTask ? ` I was working on "${activeTask.title}".` : '') +
            (isStreakMilestone ? ` I'm on a ${user.streak}-day streak!` : '')
        );
    }

    timerElapsedSecs = 0;
    timerStartedAt   = null;
    timerRemainSecs  = timerTotalSecs;
    appState = 'awaiting_response';
    _clearTimerState();
    updateTimerDisplay();
    updateRing();
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();

    showSessionEndPopup(completedMode);
}

// =============================================
// Timer — Display Helpers
// =============================================
function updateTimerDisplay() {
    const el = document.getElementById('timer-display');
    if (!el || el.classList.contains('count-up')) return;
    if (timerRemainSecs >= 3600) {
        const h = Math.floor(timerRemainSecs / 3600);
        const m = Math.floor((timerRemainSecs % 3600) / 60).toString().padStart(2, '0');
        const s = (timerRemainSecs % 60).toString().padStart(2, '0');
        el.textContent = `${h}:${m}:${s}`;
        el.classList.add('ring-time-long');
    } else {
        const m = Math.floor(timerRemainSecs / 60).toString().padStart(2, '0');
        const s = (timerRemainSecs % 60).toString().padStart(2, '0');
        el.textContent = `${m}:${s}`;
        el.classList.remove('ring-time-long');
    }
}

function updateRing() {
    const fill = document.getElementById('ring-fill');
    if (!fill) return;
    const pct = timerTotalSecs > 0 ? timerRemainSecs / timerTotalSecs : 1;
    fill.style.strokeDashoffset = RING_C * (1 - pct);
}

function updateFocusPanelTheme() {
    const panel = document.getElementById('focus-panel');
    if (!panel) return;
    panel.classList.remove('mode-short', 'mode-long', 'mode-break');
    if (timerMode === 'break') panel.classList.add('mode-break');
}

function updateStatsDisplay() {
    const sesEl = document.getElementById('stat-sessions');
    const minEl = document.getElementById('stat-minutes');
    const strEl = document.getElementById('stat-streak');
    if (sesEl) sesEl.textContent = sessionsToday;
    if (minEl) minEl.textContent = minutesToday;
    if (strEl) strEl.textContent = user.id ? (user.streak || 0) : '—';
}

// Returns "Xm Ys", "Xm", or "Ys" from a raw seconds value
function fmtDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m > 0 && s > 0) return `${m}m ${s}s`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}

// =============================================
// Session End Popup
// =============================================
function showSessionEndPopup(completedMode) {
    const stepA = document.getElementById('sep-step-a');
    const stepB = document.getElementById('sep-step-b');
    if (!stepA || !stepB) return;
    stepA.style.display = '';
    stepB.style.display = 'none';

    const emoji   = document.getElementById('sep-emoji');
    const title   = document.getElementById('sep-title');
    const sub     = document.getElementById('sep-sub');
    const choices = document.getElementById('sep-choices');

    if (completedMode === 'focus') {
        if (emoji)   emoji.textContent = '🎯';
        if (title)   title.textContent = 'Focus session complete';
        if (sub)     sub.textContent   = "What's next?";
        if (choices) choices.innerHTML = `
            <button class="sep-choice-primary"   onclick="handlePopupChoice('focus')">Start another focus session</button>
            <button class="sep-choice-secondary" onclick="handlePopupChoice('break')">Take a break</button>`;
    } else {
        if (emoji)   emoji.textContent = '☕';
        if (title)   title.textContent = "Break's over";
        if (sub)     sub.textContent   = 'Ready to get back to it?';
        if (choices) choices.innerHTML = `
            <button class="sep-choice-primary"   onclick="handlePopupChoice('focus')">Back to focus</button>
            <button class="sep-choice-secondary" onclick="handlePopupChoice('break')">Keep resting</button>`;
    }

    popupDeadline = Date.now() + 300000;
    updatePopupCountdown();
    popupInterval = setInterval(updatePopupCountdown, 1000);

    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById('session-end-modal').classList.add('open');
}

function updatePopupCountdown() {
    const el = document.getElementById('sep-countdown');
    if (!el || !popupDeadline) return;
    const secsLeft = Math.max(0, Math.ceil((popupDeadline - Date.now()) / 1000));
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    el.textContent = secsLeft > 0
        ? `Auto-tracking as wasted time in ${m}:${String(s).padStart(2, '0')}…`
        : '';
    if (secsLeft <= 0) {
        clearInterval(popupInterval);
        popupInterval = null;
        _closePopupInternal();
        enterWastedState();
    }
}

function handlePopupChoice(mode) {
    nextSessionMode = mode;
    sepNextSecs = settings[mode] * 60;

    const stepA = document.getElementById('sep-step-a');
    const stepB = document.getElementById('sep-step-b');
    if (stepA) stepA.style.display = 'none';
    if (stepB) stepB.style.display = '';

    const titleB = document.getElementById('sep-title-b');
    if (titleB) titleB.textContent = mode === 'focus' ? 'How long will you focus?' : 'How long will you rest?';

    _renderSepStepB(mode);
}

function _renderSepStepB(mode) {
    const display = document.getElementById('sep-dur-display');
    if (display) display.textContent = fmtDuration(sepNextSecs);

    const picks    = document.getElementById('sep-quick-picks');
    const pickVals = mode === 'focus' ? [15 * 60, 25 * 60, 45 * 60, 60 * 60] : [5 * 60, 10 * 60, 15 * 60];
    if (picks) picks.innerHTML = pickVals.map(secs => {
        const label = secs >= 3600 ? `${secs / 3600}h` : `${secs / 60}m`;
        const isActive = sepNextSecs === secs;
        return `<button class="sep-qpick${isActive ? ' active' : ''}" onclick="setSepDuration(${secs})">${label}</button>`;
    }).join('') + `<button class="sep-qpick" onclick="openWheelPicker(sepNextSecs, setSepDuration)">Custom</button>`;
}

function setSepDuration(secs) {
    sepNextSecs = secs;
    _renderSepStepB(nextSessionMode || 'focus');
}

function startNextSession() {
    const secs = Math.max(1, Math.min(3 * 3600, sepNextSecs || 25 * 60));
    const mode  = nextSessionMode || 'focus';
    settings[mode] = Math.max(1, Math.round(secs / 60));
    localStorage.setItem('intime_settings', JSON.stringify(settings));

    _closePopupInternal();

    timerMode        = mode;
    timerTotalSecs   = secs;
    timerRemainSecs  = secs;
    timerElapsedSecs = 0;
    timerStartedAt   = null;
    appState         = 'idle';

    _setActiveModeTab(mode);
    const label = document.getElementById('ring-label');
    if (label) label.textContent = mode === 'focus' ? 'FOCUS' : 'BREAK';

    updateFocusPanelTheme();
    updateTimerDisplay();
    updateRing();
    updateQuickPicks();
    startTimer();
}

function cancelSessionPopup() {
    _closePopupInternal();
    appState = 'idle';
    _clearTimerState();
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();
}

function _closePopupInternal() {
    clearInterval(popupInterval);
    popupInterval = null;
    popupDeadline = null;
    const overlay = document.getElementById('modal-overlay');
    const modal   = document.getElementById('session-end-modal');
    if (overlay) overlay.classList.remove('open');
    if (modal)   modal.classList.remove('open');
}

// =============================================
// Wasted Time State
// =============================================
function enterWastedState() {
    appState = 'wasted';
    wastedStartedAt = Date.now() - 300000;
    _saveTimerState();

    const panel = document.getElementById('focus-panel');
    if (panel) { panel.classList.add('wasted'); panel.classList.remove('timer-running'); }

    const label = document.getElementById('ring-label');
    if (label) label.textContent = 'WASTED TIME';

    const display = document.getElementById('timer-display');
    if (display) display.classList.add('count-up');

    wastedInterval = setInterval(wastedTick, 1000);
    _setActiveModeTab('wasted');
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();
    updateWastedTabLabel();
    updateQuickPicks();
}

function wastedTick() {
    if (!wastedStartedAt) return;
    const elapsed = Math.floor((Date.now() - wastedStartedAt) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    const el = document.getElementById('timer-display');
    if (el) el.textContent = `${m}:${s}`;
    updateNavSessionBadge();
}

function saveWasted() {
    if (!wastedStartedAt) return;
    const elapsed = Math.floor((Date.now() - wastedStartedAt) / 1000);

    clearInterval(wastedInterval);
    wastedInterval  = null;
    wastedStartedAt = null;

    addToTracking('wasted', elapsed);
    showToast(`Logged ${fmtDuration(elapsed)} of wasted time`, '⏳');

    appState         = 'idle';
    timerMode        = 'focus';
    timerTotalSecs   = settings.focus * 60;
    timerRemainSecs  = timerTotalSecs;
    timerElapsedSecs = 0;
    timerStartedAt   = null;
    _clearTimerState();

    const panel   = document.getElementById('focus-panel');
    const display = document.getElementById('timer-display');
    const label   = document.getElementById('ring-label');
    if (panel)   panel.classList.remove('wasted');
    if (display) display.classList.remove('count-up');
    if (label)   label.textContent = 'FOCUS';

    _setActiveModeTab('focus');
    updateFocusPanelTheme();
    updateTimerDisplay();
    updateRing();
    updateIcons();
    updateModeTabDots();
    updateNavSessionBadge();
    updateWastedTabLabel();
    updateQuickPicks();
}

// =============================================
// Today's Time Tracking
// =============================================
function getTodayKey() {
    return 'intime_tracking_' + new Date().toDateString();
}

function loadTodayTracking() {
    try {
        const d = JSON.parse(localStorage.getItem(getTodayKey()) || 'null');
        if (d && typeof d === 'object') return { focus: d.focus || 0, break: d.break || 0, wasted: d.wasted || 0 };
    } catch {}
    return { focus: 0, break: 0, wasted: 0 };
}

function saveTodayTracking() {
    localStorage.setItem(getTodayKey(), JSON.stringify(todayTracking));
}

function addToTracking(category, secs) {
    if (typeof todayTracking[category] !== 'number') todayTracking[category] = 0;
    todayTracking[category] += secs;
    saveTodayTracking();
    renderTodayTracking();
    updateWastedTabLabel();
}

function renderTodayTracking() {
    const rowsEl  = document.getElementById('today-track-rows');
    const totalEl = document.getElementById('today-track-total');
    if (!rowsEl || !totalEl) return;

    const { focus: f, break: b, wasted: w } = todayTracking;
    const total = f + b + w;

    const fmt = (secs) => {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
        return `${s}s`;
    };

    if (total === 0) {
        rowsEl.innerHTML = '';
        totalEl.textContent = 'No sessions yet today — start your first focus session above';
        ['focus', 'break', 'wasted'].forEach(c => {
            const el = document.getElementById(`ttb-${c}`);
            if (el) el.style.flex = '0';
        });
        return;
    }

    const cats = [
        { key: 'focus',  label: 'Study',  color: '#6C63FF', secs: f },
        { key: 'break',  label: 'Break',  color: '#10B981', secs: b },
        { key: 'wasted', label: 'Wasted', color: '#EF4444', secs: w },
    ];

    rowsEl.innerHTML = cats
        .filter(c => c.secs > 0)
        .map(c => `
            <div class="ttr-row">
                <span class="ttr-dot" style="background:${c.color}"></span>
                <span class="ttr-label">${c.label}</span>
                <span class="ttr-val">${fmt(c.secs)}</span>
            </div>`).join('');

    cats.forEach(c => {
        const el = document.getElementById(`ttb-${c.key}`);
        if (el) el.style.flex = String(c.secs / total);
    });

    totalEl.textContent = `Total: ${fmt(total)} today`;
}

// =============================================
// Daily/Session Persistence
// =============================================
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
    const sWork  = document.getElementById('s-work');
    const sShort = document.getElementById('s-short');
    if (sWork)  sWork.value  = settings.focus;
    if (sShort) sShort.value = settings.break;
}

function applySettings() {
    if (!user.isPro) { openModal('upgrade-modal'); return; }
    const focusMins = Math.max(1, Math.min(180, parseInt(document.getElementById('s-work')?.value)  || 25));
    const breakMins = Math.max(1, Math.min(60,  parseInt(document.getElementById('s-short')?.value) || 5));
    settings = { focus: focusMins, break: breakMins };
    localStorage.setItem('intime_settings', JSON.stringify(settings));
    if (appState === 'idle') {
        timerTotalSecs  = settings[timerMode] * 60;
        timerRemainSecs = timerTotalSecs;
        updateTimerDisplay();
        updateRing();
        updateQuickPicks();
    }
    if (user.id) {
        fetch('/save-timer-settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ work: focusMins, short: breakMins, long: breakMins }),
        }).catch(e => console.error('Timer settings save failed:', e));
    }
    closeAllModals();
}

// =============================================
// Energy Check-in
// =============================================
function setEnergy(level) {
    user.energyLevel = level;
    closeAllModals();

    if (user.id) {
        sendChatInternal(
            `My energy level right now is ${level}. Adjust your coaching style accordingly — ${
                level === 'low'    ? 'suggest shorter sprints and easier starting tasks' :
                level === 'medium' ? 'keep a balanced, normal pace' :
                                     'I can handle harder tasks and longer sessions'
            }.`
        );
    }

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
    const buf  = ctx.createBuffer(1, rate * 3, rate);
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
    const today     = dumps.filter(d => d.time);

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
    if (!msg) return;
    if (!user.id) { openModal('auth-modal'); return; }

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
            credentials: 'include',
            body:    JSON.stringify({
                message:  msg,
                userName: user.name,
                history:  chatHistory,
                context:  buildChatContext(),
            }),
        });

        if (res.status === 401) { showToast('Session expired — please sign in again', '⚠️'); return; }
        if (res.status === 403) {
            const data = await res.json();
            typingEl.remove();
            if (data.error === 'pro_required') openModal('upgrade-modal');
            return;
        }

        const data = await res.json();
        typingEl.remove();

        if (data.start_timer && appState === 'idle') handlePlay();
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

async function sendChatInternal(msg) {
    if (!user.id) return;
    const typingEl = showTyping();
    try {
        const res  = await fetch('/chat', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body:    JSON.stringify({
                message:  msg,
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
    const isRunning  = appState === 'focus_running' || appState === 'break_running';
    return {
        tasks:         tasks.filter(t => !t.done).map(t => t.title),
        activeTask:    activeTask?.title || null,
        timerMode:     timerMode,
        timerRunning:  isRunning,
        sessionsToday: sessionsToday,
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
            credentials: 'include',
            body:    JSON.stringify({ task: task.title }),
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
            const tzOffset = -new Date().getTimezoneOffset();
            const res  = await fetch(`/calendar?year=${calState.year}&month=${calState.month}&tz_offset=${tzOffset}`, { credentials: 'include' });
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
    if (!user.id) { alert('Sign in to save notes.'); return; }
    const content = document.getElementById('cal-note-input')?.value || '';
    try {
        await fetch('/calendar/note', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body:    JSON.stringify({ date: dateStr, content }),
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
    if (document.getElementById('session-end-modal')?.classList.contains('open')) return;
    document.getElementById('modal-overlay').classList.remove('open');
    document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
}
