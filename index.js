import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, generateQuietPrompt, generateRaw, characters } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { registerSlashCommand, sendMessageAs } from '../../../slash-commands.js';
import { findChar } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const EXT_ID = 'xuanshu';

const defaultSettings = {
    deviceName: '玄枢',
    yexuan: '叶玄',
    yinchong: '淫宠',
    sidePersonaExtra: '',
    autoReplyLive: true,
    heartbeatOn: false,
    heartbeatMin: 30,
    deviceLog: [],
    sideLog: [],
    ui: { open: true, tab: 'live', x: null, y: null, minimized: false },
};

extension_settings[EXT_ID] = Object.assign(structuredClone(defaultSettings), extension_settings[EXT_ID] ?? {});
const settings = extension_settings[EXT_ID];
for (const [key, value] of Object.entries(defaultSettings)) {
    if (settings[key] === undefined) settings[key] = value;
}
settings.ui = Object.assign(structuredClone(defaultSettings.ui), settings.ui ?? {});

let busy = false;
let heartbeatTimer = null;
let $root = null;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRegExp = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pushLog(key, entry) {
    settings[key].push(entry);
    const max = key === 'sideLog' ? 300 : 100;
    if (settings[key].length > max) settings[key] = settings[key].slice(-max);
    saveSettingsDebounced();
}

function getChar() {
    return findChar({ name: settings.yinchong }) ?? null;
}

function buildSideSystem(char) {
    const parts = [];
    parts.push(`你是${settings.yinchong}。`);
    if (char) {
        if (char.description) parts.push(`【角色设定】\n${char.description}`);
        if (char.personality) parts.push(`【性格】\n${char.personality}`);
        if (char.scenario) parts.push(`【背景】\n${char.scenario}`);
        if (char.mes_example) parts.push(`【对话示例】\n${char.mes_example}`);
    }
    if (settings.sidePersonaExtra) parts.push(`【补充设定】\n${settings.sidePersonaExtra}`);
    parts.push(`你正通过${settings.deviceName}加密通讯器与${settings.yexuan}进行番外私聊（与主线剧情平行、互不影响）。用第一人称直接输出你发出的讯息正文：像发短讯一样自然，可以撒娇、汇报、挑逗，禁止旁白、禁止动作描写标记、禁止输出除讯息正文以外的任何内容。`);
    return parts.join('\n\n');
}

function currentLog() {
    return settings.ui.tab === 'side' ? settings.sideLog : settings.deviceLog;
}

function setBusy(value) {
    busy = value;
    renderLog();
    const sendBtn = document.getElementById('xuanshu-send');
    if (sendBtn) sendBtn.disabled = busy;
}

function notify() {
    const badge = document.getElementById('xuanshu-launcher-badge');
    if (badge) badge.style.display = 'block';
    if ($root) {
        $root.addClass('xuanshu-glow');
        setTimeout(() => $root.removeClass('xuanshu-glow'), 1600);
    }
}

function renderLog() {
    if (!$root) return;
    const log = currentLog();
    const el = $root.find('.xuanshu-log');
    el.empty();
    for (const m of log) {
        let whoName;
        if (m.who === 'yexuan') whoName = settings.yexuan;
        else if (m.who === 'yinchong') whoName = settings.yinchong;
        else whoName = '系统';
        const cls = m.who === 'yinchong' ? 'yin' : m.who === 'sys' ? 'sys' : 'xuan';
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        el.append($(`<div class="xuanshu-line ${cls}"><span class="xuanshu-meta">${escapeHtml(time)}</span><span class="xuanshu-who">${escapeHtml(whoName)}</span><span class="xuanshu-text">${escapeHtml(m.text)}</span></div>`));
    }
    if (busy) {
        el.append($(`<div class="xuanshu-line sys"><span class="xuanshu-who">▌</span><span class="xuanshu-text xuanshu-blink">接收中…</span></div>`));
    }
    el.scrollTop(el[0] ? el[0].scrollHeight : 0);
}

/* ---------------- 主线（实时）频道 ---------------- */

async function sendLive(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.warning('主线聊天还没有内容，通讯器无法嵌入剧情哦');
        return;
    }
    const mesText = `【${settings.deviceName} · 加密链路】\n${settings.yexuan} → ${settings.yinchong}：\n${trimmed}`;
    await sendMessageAs({ name: settings.deviceName, compact: true }, mesText);
    pushLog('deviceLog', { who: 'yexuan', text: trimmed, ts: Date.now() });
    renderLog();
    if (settings.autoReplyLive) {
        await replyLive();
    }
}

async function replyLive() {
    const last = [...settings.deviceLog].reverse().find((m) => m.who === 'yexuan');
    if (!last || busy) return;
    setBusy(true);
    try {
        const char = getChar();
        let forceChId = null;
        if (char && Array.isArray(characters)) {
            const idx = characters.findIndex((c) => c === char);
            if (idx >= 0) forceChId = idx;
        }
        const quietPrompt = `（你正通过${settings.deviceName}加密通讯器私密回复${settings.yexuan}。保持角色，只输出回复讯息正文，不要旁白、不要格式标记。）\n${settings.yexuan}刚刚发来的讯息：${last.text}`;
        const reply = await generateQuietPrompt({ quietPrompt, quietName: settings.yinchong, forceChId, removeReasoning: true });
        const clean = String(reply ?? '').trim();
        if (!clean) {
            toastr.warning(`${settings.yinchong}没有回应……`);
            return;
        }
        const mesText = `【${settings.deviceName} · 加密链路】\n${settings.yinchong} → ${settings.yexuan}：\n${clean}`;
        await sendMessageAs({ name: settings.deviceName, compact: true }, mesText);
        pushLog('deviceLog', { who: 'yinchong', text: clean, ts: Date.now() });
        renderLog();
        notify();
    } catch (err) {
        console.error('[玄枢] replyLive failed', err);
        toastr.error('实时回复生成失败：' + (err?.message ?? err));
    } finally {
        setBusy(false);
    }
}

/* ---------------- 番外（异步）频道 ---------------- */

async function sendSide(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    pushLog('sideLog', { who: 'yexuan', text: trimmed, ts: Date.now() });
    renderLog();
    if (busy) return;
    setBusy(true);
    try {
        const char = getChar();
        const messages = [{ role: 'system', content: buildSideSystem(char) }];
        for (const m of settings.sideLog) {
            if (m.who === 'yexuan') messages.push({ role: 'user', name: settings.yexuan, content: m.text });
            else if (m.who === 'yinchong') messages.push({ role: 'assistant', name: settings.yinchong, content: m.text });
        }
        messages.push({ role: 'assistant', name: settings.yinchong, content: '' });
        const reply = await generateRaw({ prompt: messages, trimNames: true });
        let clean = String(reply ?? '').trim();
        clean = clean.replace(new RegExp('^' + escapeRegExp(settings.yinchong) + '\\s*[:：]\\s*'), '').trim();
        if (!clean) {
            toastr.warning(`${settings.yinchong}没有回应……`);
            return;
        }
        pushLog('sideLog', { who: 'yinchong', text: clean, ts: Date.now() });
        renderLog();
        notify();
    } catch (err) {
        console.error('[玄枢] sendSide failed', err);
        toastr.error('番外回复生成失败：' + (err?.message ?? err));
    } finally {
        setBusy(false);
    }
}

/* ---------------- 心跳待机 ---------------- */

async function heartbeat() {
    if (busy) return;
    setBusy(true);
    try {
        const char = getChar();
        const instruction = `（现在，随机地给${settings.yexuan}发一条主动的私讯。内容随机选择一种：撒娇想他、汇报近况、分享刚经历的小事、暧昧挑逗、突兀却可爱的碎碎念。语气与性格必须完全符合你的人设。直接输出讯息正文，不要任何旁白或说明。）`;
        const messages = [
            { role: 'system', content: buildSideSystem(char) + '\n\n' + instruction },
            { role: 'assistant', name: settings.yinchong, content: '' },
        ];
        const reply = await generateRaw({ prompt: messages, trimNames: true });
        let clean = String(reply ?? '').trim();
        clean = clean.replace(new RegExp('^' + escapeRegExp(settings.yinchong) + '\\s*[:：]\\s*'), '').trim();
        if (!clean) return;
        pushLog('sideLog', { who: 'yinchong', text: clean, ts: Date.now() });
        renderLog();
        notify();
        if (!settings.ui.open || settings.ui.tab !== 'side') {
            toastr.info(`${settings.deviceName} · 番外频道有新讯息`, `${settings.yinchong} 发来了私讯`, { timeOut: 4000 });
        }
    } catch (err) {
        console.error('[玄枢] heartbeat failed', err);
    } finally {
        setBusy(false);
    }
}

function setupHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    const min = Number(settings.heartbeatMin);
    if (!settings.heartbeatOn || !Number.isFinite(min) || min <= 0) return;
    const tick = () => Math.round(min * 60 * 1000 * (0.8 + Math.random() * 0.4));
    heartbeatTimer = setInterval(async () => {
        if (!settings.heartbeatOn || busy) return;
        await heartbeat();
    }, tick());
}

/* ---------------- UI ---------------- */

function ensureUI() {
    if (document.getElementById('xuanshu-root')) return;
    const html = `
    <div id="xuanshu-launcher" class="xuanshu-launcher" title="玄枢通讯器">
      <span class="xuanshu-launcher-icon">◎</span>
      <span id="xuanshu-launcher-badge" class="xuanshu-launcher-badge" style="display:none"></span>
    </div>
    <div id="xuanshu-root" class="xuanshu-root" style="display:none">
      <div class="xuanshu-bezel">
        <div class="xuanshu-topbar">
          <span class="xuanshu-led"></span>
          <span class="xuanshu-title"></span>
          <span class="xuanshu-sig">▂▄▆█</span>
          <span class="xuanshu-batt">▮▮▮</span>
          <button class="xuanshu-btn xuanshu-gear" title="设置">⚙</button>
          <button class="xuanshu-btn xuanshu-min" title="收起">–</button>
          <button class="xuanshu-btn xuanshu-close" title="关闭">×</button>
        </div>
        <div class="xuanshu-screen">
          <div class="xuanshu-scan"></div>
          <div class="xuanshu-tabs">
            <button class="xuanshu-tab active" data-tab="live">实时频道</button>
            <button class="xuanshu-tab" data-tab="side">番外频道</button>
            <span class="xuanshu-flex"></span>
            <button class="xuanshu-clear" title="清空当前频道记录">⌫ 清空</button>
          </div>
          <div class="xuanshu-log"></div>
          <div class="xuanshu-inputrow">
            <span class="xuanshu-prompt">&gt;</span>
            <textarea id="xuanshu-input" rows="1" placeholder="输入讯息，回车发送，Shift+回车换行"></textarea>
            <button id="xuanshu-send" class="xuanshu-send">发送</button>
          </div>
        </div>
        <div class="xuanshu-settings-pop" style="display:none">
          <div class="xuanshu-set-row"><label>设备名</label><input id="xuanshu-set-device" type="text" /></div>
          <div class="xuanshu-set-row"><label>叶玄名字</label><input id="xuanshu-set-yexuan" type="text" /></div>
          <div class="xuanshu-set-row"><label>淫宠角色卡名</label><input id="xuanshu-set-yinchong" type="text" /></div>
          <div class="xuanshu-set-row"><label>番外补充人设</label><textarea id="xuanshu-set-persona" rows="3"></textarea></div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-autoreply" type="checkbox" /> 实时频道自动回复</label></div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-heartbeat" type="checkbox" /> 心跳待机（番外主动来讯）</label></div>
          <div class="xuanshu-set-row"><label>心跳间隔（分钟）</label><input id="xuanshu-set-heartbeatmin" type="number" min="1" max="1440" /></div>
          <div class="xuanshu-set-note">修改后即时生效，记录自动保存。</div>
        </div>
      </div>
    </div>`;
    $('body').append(html);
    $root = $('#xuanshu-root');
    syncTitles();
    bindEvents();
    makeDraggable();
    renderLog();
    if (settings.ui.open) openDevice(false);
}

function syncTitles() {
    if (!$root) return;
    $root.find('.xuanshu-title').text(settings.deviceName);
    $('#xuanshu-launcher').attr('title', `${settings.deviceName}通讯器`);
}

function refreshChatStyle() {
    let styleEl = document.getElementById('xuanshu-chat-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'xuanshu-chat-style';
        document.head.appendChild(styleEl);
    }
    const name = CSS.escape(settings.deviceName);
    styleEl.textContent = `
.mes[ch_name="${name}"] .mes_block {
    background: rgba(2, 16, 2, 0.88) !important;
    border: 1px solid rgba(74, 246, 38, 0.35) !important;
    border-radius: 8px;
    box-shadow: 0 0 14px rgba(74, 246, 38, 0.18), inset 0 0 24px rgba(0, 0, 0, 0.55);
}
.mes[ch_name="${name}"] .mes_text {
    color: #4af626 !important;
    font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
    text-shadow: 0 0 5px rgba(74, 246, 38, 0.65);
    white-space: pre-wrap;
}
.mes[ch_name="${name}"] .name_text {
    color: #9dff8a !important;
    text-shadow: 0 0 6px rgba(74, 246, 38, 0.85);
}
`;
}

function clampPosition() {
    if (!$root) return;
    const rect = $root[0].getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - 80);
    const maxY = Math.max(0, window.innerHeight - 48);
    if (rect.top < 8 || rect.left < 8 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        const x = Math.min(Math.max(0, rect.left), maxX);
        const y = Math.min(Math.max(0, rect.top), maxY);
        $root.css({ left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
        settings.ui.x = x;
        settings.ui.y = y;
    }
}

function openDevice(save = true) {
    if (!$root) return;
    $root.css('display', 'flex');
    if (settings.ui.x != null) {
        $root.css({ left: settings.ui.x + 'px', top: settings.ui.y + 'px', right: 'auto', bottom: 'auto' });
    }
    clampPosition();
    $root.toggleClass('xuanshu-minimized', !!settings.ui.minimized);
    $('#xuanshu-launcher').hide();
    $('#xuanshu-launcher-badge').hide();
    renderLog();
    if (save) {
        settings.ui.open = true;
        saveSettingsDebounced();
    }
}

function closeDevice() {
    if (!$root) return;
    $root.hide();
    $('#xuanshu-launcher').show();
    settings.ui.open = false;
    saveSettingsDebounced();
}

function bindEvents() {
    $('#xuanshu-launcher').on('click', () => openDevice());
    $root.find('.xuanshu-close').on('click', () => closeDevice());
    $root.find('.xuanshu-min').on('click', () => {
        settings.ui.minimized = !settings.ui.minimized;
        $root.toggleClass('xuanshu-minimized', settings.ui.minimized);
        saveSettingsDebounced();
    });
    $root.find('.xuanshu-gear').on('click', () => {
        const pop = $root.find('.xuanshu-settings-pop');
        const showing = pop.is(':visible');
        if (showing) {
            applySettingsFromPanel();
            pop.hide();
        } else {
            fillSettingsPanel();
            pop.show();
        }
    });
    $root.find('.xuanshu-tab').on('click', function () {
        $root.find('.xuanshu-tab').removeClass('active');
        $(this).addClass('active');
        settings.ui.tab = $(this).data('tab');
        saveSettingsDebounced();
        renderLog();
    });
    $root.find('.xuanshu-clear').on('click', async () => {
        const key = settings.ui.tab === 'side' ? 'sideLog' : 'deviceLog';
        if (!settings[key].length) return;
        const ok = await callGenericPopup(`要清空「${settings.ui.tab === 'side' ? '番外频道' : '实时频道'}」的全部记录吗？（主线聊天里的消息不受影响）`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        settings[key] = [];
        saveSettingsDebounced();
        renderLog();
    });
    $('#xuanshu-input').on('input', function () { autoGrow(this); });
    $('#xuanshu-input').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            doSend();
        }
    });
    $('#xuanshu-send').on('click', () => doSend());
}

async function doSend() {
    const input = document.getElementById('xuanshu-input');
    if (!input || busy) return;
    const text = input.value;
    if (!String(text).trim()) return;
    input.value = '';
    autoGrow(input);
    if (settings.ui.tab === 'side') {
        await sendSide(text);
    } else {
        await sendLive(text);
    }
}

function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
}

function makeDraggable() {
    const handle = $root.find('.xuanshu-topbar');
    handle.on('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const rect = $root[0].getBoundingClientRect();
        const offX = e.clientX - rect.left;
        const offY = e.clientY - rect.top;
        const move = (ev) => {
            const x = Math.min(Math.max(0, ev.clientX - offX), window.innerWidth - 80);
            const y = Math.min(Math.max(0, ev.clientY - offY), window.innerHeight - 48);
            $root.css({ left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
        };
        const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            settings.ui.x = parseFloat($root.css('left'));
            settings.ui.y = parseFloat($root.css('top'));
            saveSettingsDebounced();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
    });
}

function fillSettingsPanel() {
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    setVal('xuanshu-set-device', settings.deviceName);
    setVal('xuanshu-set-yexuan', settings.yexuan);
    setVal('xuanshu-set-yinchong', settings.yinchong);
    setVal('xuanshu-set-persona', settings.sidePersonaExtra);
    setChk('xuanshu-set-autoreply', !!settings.autoReplyLive);
    setChk('xuanshu-set-heartbeat', !!settings.heartbeatOn);
    setVal('xuanshu-set-heartbeatmin', settings.heartbeatMin);
}

function applySettingsFromPanel() {
    const getVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
    const getChk = (id) => { const el = document.getElementById(id); return el ? !!el.checked : false; };
    settings.deviceName = getVal('xuanshu-set-device') || '玄枢';
    settings.yexuan = getVal('xuanshu-set-yexuan') || '叶玄';
    settings.yinchong = getVal('xuanshu-set-yinchong') || '淫宠';
    settings.sidePersonaExtra = getVal('xuanshu-set-persona');
    settings.autoReplyLive = getChk('xuanshu-set-autoreply');
    settings.heartbeatOn = getChk('xuanshu-set-heartbeat');
    const min = Number(getVal('xuanshu-set-heartbeatmin'));
    settings.heartbeatMin = Number.isFinite(min) && min > 0 ? min : 30;
    saveSettingsDebounced();
    syncTitles();
    refreshChatStyle();
    setupHeartbeat();
    renderLog();
}

/* ---------------- 斜杠命令 ---------------- */

async function commCallback(args, value) {
    const sub = String(args ?? '').trim().toLowerCase();
    const text = String(value ?? '').trim();
    try {
        if (sub === 'open') { openDevice(); return ''; }
        if (sub === 'close') { closeDevice(); return ''; }
        if (sub === 'reply') { await replyLive(); return ''; }
        if (sub === 'side') {
            if (!text) { toastr.info('用法：/comm side 消息内容'); return ''; }
            await sendSide(text);
            return '';
        }
        if (sub) {
            await sendLive(text ? `${sub} ${text}` : sub);
            return '';
        }
        if (text) {
            await sendLive(text);
            return '';
        }
        toastr.info(`${settings.deviceName}：/comm 消息 | /comm side 消息 | /comm reply | /comm open | /comm close`);
    } catch (err) {
        console.error('[玄枢]', err);
        toastr.error(`${settings.deviceName}出错了：` + (err?.message ?? err));
    }
    return '';
}

/* ---------------- 启动 ---------------- */

function init() {
    ensureUI();
    refreshChatStyle();
    setupHeartbeat();
    registerSlashCommand('comm', commCallback, ['xlink', '玄枢'], `${settings.deviceName}通讯器：/comm 消息 | /comm side 消息 | /comm reply | /comm open | /comm close`);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!getChar()) {
            toastr.info(`${settings.deviceName}：当前角色卡中没有找到「${settings.yinchong}」，番外频道可能没有人格可用。`, undefined, { timeOut: 6000 });
        }
    });
}

jQuery(async () => {
    init();
    console.log('[玄枢通讯器] 已启动。主人，随时可以使用通讯器了。');
});
