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
    autoReplyLive: true,
    heartbeatOn: false,
    heartbeatMin: 30,
    deviceLog: [],
    members: [],
    currentTarget: '',
    ui: { open: true, tab: 'live', x: null, y: null, minimized: false },
};

extension_settings[EXT_ID] = Object.assign(structuredClone(defaultSettings), extension_settings[EXT_ID] ?? {});
const settings = extension_settings[EXT_ID];
for (const [key, value] of Object.entries(defaultSettings)) {
    if (settings[key] === undefined) settings[key] = value;
}
settings.ui = Object.assign(structuredClone(defaultSettings.ui), settings.ui ?? {});

// v1.0 -> v1.1 迁移：旧单宠配置转为成员列表
if (Array.isArray(settings.sideLog)) {
    if (settings.sideLog.length && settings.yinchong) {
        settings.members.push({ name: settings.yinchong, personaExtra: settings.sidePersonaExtra ?? '', heartbeat: true, log: settings.sideLog });
        if (!settings.currentTarget) settings.currentTarget = settings.yinchong;
    }
    delete settings.sideLog;
    delete settings.sidePersonaExtra;
    delete settings.yinchong;
    saveSettingsDebounced();
}
for (const m of settings.members) {
    m.personaExtra = m.personaExtra ?? '';
    m.heartbeat = m.heartbeat ?? true;
    m.log = Array.isArray(m.log) ? m.log : [];
}
if (!settings.currentTarget || !settings.members.some((m) => m.name === settings.currentTarget)) {
    settings.currentTarget = settings.members[0]?.name ?? '';
}

let busy = false;
let heartbeatTimer = null;
let $root = null;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const makeOption = (text, value) => {
    const o = document.createElement('option');
    o.textContent = text;
    o.value = value;
    return o;
};
const escapeRegExp = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function save() {
    saveSettingsDebounced();
}

function pushLog(key, entry) {
    settings[key].push(entry);
    const max = key === 'deviceLog' ? 100 : 300;
    if (settings[key].length > max) settings[key] = settings[key].slice(-max);
    save();
}

function getMember(name) {
    return settings.members.find((m) => m.name === name) ?? null;
}

function getCurrentMember() {
    return getMember(settings.currentTarget);
}

function getCharByName(name) {
    return findChar({ name }) ?? null;
}

function buildSideSystem(member, char) {
    const parts = [];
    parts.push(`你是${member.name}。`);
    if (char) {
        if (char.description) parts.push(`【角色设定】\n${char.description}`);
        if (char.personality) parts.push(`【性格】\n${char.personality}`);
        if (char.scenario) parts.push(`【背景】\n${char.scenario}`);
        if (char.mes_example) parts.push(`【对话示例】\n${char.mes_example}`);
    }
    if (member.personaExtra) parts.push(`【补充设定】\n${member.personaExtra}`);
    parts.push(`你正通过${settings.deviceName}加密通讯器与${settings.yexuan}进行番外私聊（与主线剧情平行、互不影响）。用第一人称直接输出你发出的讯息正文：像发短讯一样自然，可以撒娇、汇报、挑逗，禁止旁白、禁止动作描写标记、禁止输出除讯息正文以外的任何内容。`);
    return parts.join('\n\n');
}

function stripNamePrefix(text, name) {
    return String(text ?? '').trim().replace(new RegExp('^' + escapeRegExp(name) + '\\s*[:：]\\s*'), '').trim();
}

function currentSideLog() {
    const member = getCurrentMember();
    return member ? member.log : [];
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
    const el = $root.find('.xuanshu-log');
    el.empty();
    const isSide = settings.ui.tab === 'side';
    const member = getCurrentMember();
    if (isSide && !member) {
        el.append($(`<div class="xuanshu-line sys"><span class="xuanshu-text">频道暂无通讯对象——点 ⚙ 打开通讯录，邀请淫宠加入。</span></div>`));
    } else {
        const log = isSide ? member.log : settings.deviceLog;
        for (const m of log) {
            let whoName;
            if (m.who === 'yexuan') whoName = settings.yexuan;
            else if (m.who === 'yinchong') whoName = m.to ?? member?.name ?? '淫宠';
            else whoName = '系统';
            const cls = m.who === 'yinchong' ? 'yin' : m.who === 'sys' ? 'sys' : 'xuan';
            const time = m.ts ? new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
            el.append($(`<div class="xuanshu-line ${cls}"><span class="xuanshu-meta">${escapeHtml(time)}</span><span class="xuanshu-who">${escapeHtml(whoName)}</span><span class="xuanshu-text">${escapeHtml(m.text)}</span></div>`));
        }
    }
    if (busy) {
        el.append($(`<div class="xuanshu-line sys"><span class="xuanshu-who">▌</span><span class="xuanshu-text xuanshu-blink">接收中…</span></div>`));
    }
    el.scrollTop(el[0] ? el[0].scrollHeight : 0);
}

/* ---------------- 成员管理（邀请制） ---------------- */

function inviteMember(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    if (getMember(trimmed)) {
        toastr.info(`${trimmed} 已经在频道里了`);
        return false;
    }
    const char = getCharByName(trimmed);
    settings.members.push({ name: trimmed, personaExtra: '', heartbeat: true, log: [] });
    if (!settings.currentTarget) settings.currentTarget = trimmed;
    if (!char) {
        toastr.warning(`已邀请 ${trimmed}，但角色卡中未找到同名角色，番外回复可能没有人格可用`);
    } else {
        toastr.success(`${trimmed} 已加入${settings.deviceName}频道`);
    }
    save();
    syncTargetUI();
    renderLog();
    return true;
}

function kickMember(name) {
    const idx = settings.members.findIndex((m) => m.name === name);
    if (idx < 0) return false;
    settings.members.splice(idx, 1);
    if (settings.currentTarget === name) {
        settings.currentTarget = settings.members[0]?.name ?? '';
    }
    save();
    syncTargetUI();
    renderLog();
    return true;
}

function refreshRosterUI() {
    if (!$root) return;
    const listEl = $root.find('#xuanshu-members-list');
    if (!listEl.length) return;
    listEl.empty();
    if (!settings.members.length) {
        listEl.append($(`<div class="xuanshu-set-note">尚未邀请任何角色</div>`));
    }
    for (const m of settings.members) {
        const row = $(`<div class="xuanshu-member-row"><span class="xuanshu-member-name">${escapeHtml(m.name)}</span><label class="xuanshu-member-hb"><input type="checkbox" class="xuanshu-member-heartbeat" ${m.heartbeat ? 'checked' : ''} /> 心跳</label><button class="xuanshu-member-kick" title="移出频道">踢出</button></div>`);
        row.find('.xuanshu-member-heartbeat').on('change', function () {
            m.heartbeat = !!this.checked;
            save();
        });
        row.find('.xuanshu-member-kick').on('click', async () => {
            const ok = await callGenericPopup(`要把 ${m.name} 移出频道吗？其番外记录也会一并删除。`, POPUP_TYPE.CONFIRM);
            if (!ok) return;
            kickMember(m.name);
            refreshRosterUI();
        });
        listEl.append(row);
    }
    // 邀请下拉：所有角色卡
    const sel = document.getElementById('xuanshu-invite-select');
    if (sel) {
        const current = sel.value;
        sel.innerHTML = '';
        const names = (Array.isArray(characters) ? characters : []).map((c) => c?.name).filter(Boolean);
        if (!names.length) {
            sel.append(makeOption('（未读取到任何角色卡）', ''));
        } else {
            for (const n of names) sel.append(makeOption(n, n));
        }
        sel.value = current;
    }
}

function syncTargetUI() {
    if (!$root) return;
    const sel = $root.find('#xuanshu-target')[0];
    if (!sel) return;
    const current = settings.currentTarget;
    sel.innerHTML = '';
    if (!settings.members.length) {
        sel.append(makeOption('（未邀请角色）', ''));
        sel.disabled = true;
    } else {
        for (const m of settings.members) sel.append(makeOption(m.name, m.name));
        sel.disabled = false;
        sel.value = settings.members.some((m) => m.name === current) ? current : settings.members[0].name;
    }
    $root.find('.xuanshu-target-label').text(settings.ui.tab === 'side' ? '频道对象' : '通讯对象');
}

/* ---------------- 主线（实时）频道 ---------------- */

async function sendLive(text, targetName = null) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    const member = targetName ? getMember(targetName) : getCurrentMember();
    if (!member) {
        toastr.warning('频道里还没有淫宠——请先点 ⚙ 邀请角色加入');
        return;
    }
    if (targetName && targetName !== settings.currentTarget) {
        settings.currentTarget = targetName;
        save();
        syncTargetUI();
    }
    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.warning('主线聊天还没有内容，通讯器无法嵌入剧情哦');
        return;
    }
    const mesText = `【${settings.deviceName} · 加密链路】\n${settings.yexuan} → ${member.name}：\n${trimmed}`;
    await sendMessageAs({ name: settings.deviceName, compact: true }, mesText);
    pushLog('deviceLog', { who: 'yexuan', to: member.name, text: trimmed, ts: Date.now() });
    renderLog();
    if (settings.autoReplyLive) {
        await replyLive();
    }
}

async function replyLive() {
    const last = [...settings.deviceLog].reverse().find((m) => m.who === 'yexuan');
    if (!last || busy) return;
    const target = last.to ?? settings.currentTarget;
    const member = getMember(target) ?? getCurrentMember();
    if (!member) return;
    setBusy(true);
    try {
        const char = getCharByName(member.name);
        let forceChId = null;
        if (char && Array.isArray(characters)) {
            const idx = characters.findIndex((c) => c === char);
            if (idx >= 0) forceChId = idx;
        }
        const quietPrompt = `（你是${member.name}，正通过${settings.deviceName}加密通讯器私密回复${settings.yexuan}。保持角色，只输出回复讯息正文，不要旁白、不要格式标记。）\n${settings.yexuan}刚刚发来的讯息：${last.text}`;
        const reply = await generateQuietPrompt({ quietPrompt, quietName: member.name, forceChId, removeReasoning: true });
        const clean = String(reply ?? '').trim();
        if (!clean) {
            toastr.warning(`${member.name}没有回应……`);
            return;
        }
        const mesText = `【${settings.deviceName} · 加密链路】\n${member.name} → ${settings.yexuan}：\n${clean}`;
        await sendMessageAs({ name: settings.deviceName, compact: true }, mesText);
        pushLog('deviceLog', { who: 'yinchong', to: member.name, text: clean, ts: Date.now() });
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

async function sendSide(text, targetName = null) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    const member = targetName ? getMember(targetName) : getCurrentMember();
    if (!member) {
        toastr.warning('频道里还没有淫宠——请先点 ⚙ 邀请角色加入');
        return;
    }
    if (targetName && targetName !== settings.currentTarget) {
        settings.currentTarget = targetName;
        save();
        syncTargetUI();
    }
    member.log.push({ who: 'yexuan', text: trimmed, ts: Date.now() });
    if (member.log.length > 300) member.log = member.log.slice(-300);
    save();
    renderLog();
    if (busy) return;
    setBusy(true);
    try {
        const char = getCharByName(member.name);
        const messages = [{ role: 'system', content: buildSideSystem(member, char) }];
        for (const m of member.log) {
            if (m.who === 'yexuan') messages.push({ role: 'user', name: settings.yexuan, content: m.text });
            else if (m.who === 'yinchong') messages.push({ role: 'assistant', name: member.name, content: m.text });
        }
        messages.push({ role: 'assistant', name: member.name, content: '' });
        const reply = await generateRaw({ prompt: messages, trimNames: true });
        const clean = stripNamePrefix(reply, member.name);
        if (!clean) {
            toastr.warning(`${member.name}没有回应……`);
            return;
        }
        member.log.push({ who: 'yinchong', text: clean, ts: Date.now() });
        if (member.log.length > 300) member.log = member.log.slice(-300);
        save();
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
    const pool = settings.members.filter((m) => m.heartbeat);
    if (!pool.length) return;
    const member = pool[Math.floor(Math.random() * pool.length)];
    setBusy(true);
    try {
        const char = getCharByName(member.name);
        const instruction = `（现在，随机地给${settings.yexuan}发一条主动的私讯。内容随机选择一种：撒娇想他、汇报近况、分享刚经历的小事、暧昧挑逗、突兀却可爱的碎碎念。语气与性格必须完全符合你的人设。直接输出讯息正文，不要任何旁白或说明。）`;
        const messages = [
            { role: 'system', content: buildSideSystem(member, char) + '\n\n' + instruction },
            { role: 'assistant', name: member.name, content: '' },
        ];
        const reply = await generateRaw({ prompt: messages, trimNames: true });
        const clean = stripNamePrefix(reply, member.name);
        if (!clean) return;
        member.log.push({ who: 'yinchong', text: clean, ts: Date.now() });
        if (member.log.length > 300) member.log = member.log.slice(-300);
        save();
        renderLog();
        notify();
        if (!settings.ui.open || settings.ui.tab !== 'side' || settings.currentTarget !== member.name) {
            toastr.info(`${settings.deviceName} · 番外频道有新讯息`, `${member.name} 发来了私讯`, { timeOut: 4000 });
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
          <button class="xuanshu-btn xuanshu-gear" title="设置与通讯录">⚙</button>
          <button class="xuanshu-btn xuanshu-min" title="收起">–</button>
          <button class="xuanshu-btn xuanshu-close" title="关闭">×</button>
        </div>
        <div class="xuanshu-screen">
          <div class="xuanshu-scan"></div>
          <div class="xuanshu-targetrow">
            <span class="xuanshu-target-label">通讯对象</span>
            <select id="xuanshu-target" class="xuanshu-target"></select>
          </div>
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
          <div class="xuanshu-set-title">▍设备</div>
          <div class="xuanshu-set-row"><label>设备名</label><input id="xuanshu-set-device" type="text" /></div>
          <div class="xuanshu-set-row"><label>叶玄名字</label><input id="xuanshu-set-yexuan" type="text" /></div>
          <div class="xuanshu-set-title">▍通讯录（邀请制）</div>
          <div class="xuanshu-set-row"><label>角色卡</label><select id="xuanshu-invite-select"></select></div>
          <div class="xuanshu-set-row"><button id="xuanshu-invite-btn" class="xuanshu-invite-btn">邀请加入频道</button></div>
          <div id="xuanshu-members-list"></div>
          <div class="xuanshu-set-title">▍行为</div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-autoreply" type="checkbox" /> 实时频道自动回复</label></div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-heartbeat" type="checkbox" /> 心跳待机（成员随机主动来讯）</label></div>
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
    syncTargetUI();
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

function openDevice(saveSetting = true) {
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
    if (saveSetting) {
        settings.ui.open = true;
        save();
    }
}

function closeDevice() {
    if (!$root) return;
    $root.hide();
    $('#xuanshu-launcher').show();
    settings.ui.open = false;
    save();
}

function bindEvents() {
    $('#xuanshu-launcher').on('click', () => openDevice());
    $root.find('.xuanshu-close').on('click', () => closeDevice());
    $root.find('.xuanshu-min').on('click', () => {
        settings.ui.minimized = !settings.ui.minimized;
        $root.toggleClass('xuanshu-minimized', settings.ui.minimized);
        save();
    });
    $root.find('.xuanshu-gear').on('click', () => {
        const pop = $root.find('.xuanshu-settings-pop');
        const showing = pop.is(':visible');
        if (showing) {
            applySettingsFromPanel();
            pop.hide();
        } else {
            fillSettingsPanel();
            refreshRosterUI();
            pop.show();
        }
    });
    $root.find('.xuanshu-target').on('change', function () {
        settings.currentTarget = String(this.value);
        save();
        renderLog();
    });
    $('#xuanshu-invite-btn').on('click', () => {
        const sel = document.getElementById('xuanshu-invite-select');
        if (sel && sel.value) {
            inviteMember(sel.value);
            refreshRosterUI();
        } else {
            toastr.info('请先选择一个角色卡');
        }
    });
    $root.find('.xuanshu-tab').on('click', function () {
        $root.find('.xuanshu-tab').removeClass('active');
        $(this).addClass('active');
        settings.ui.tab = $(this).data('tab');
        save();
        syncTargetUI();
        renderLog();
    });
    $root.find('.xuanshu-clear').on('click', async () => {
        const isSide = settings.ui.tab === 'side';
        const member = getCurrentMember();
        const count = isSide ? (member?.log.length ?? 0) : settings.deviceLog.length;
        if (!count) return;
        const ok = await callGenericPopup(`要清空「${isSide ? ('番外频道 · ' + member.name) : '实时频道'}」的全部记录吗？（主线聊天里的消息不受影响）`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        if (isSide) {
            member.log = [];
        } else {
            settings.deviceLog = [];
        }
        save();
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
            save();
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
    setChk('xuanshu-set-autoreply', !!settings.autoReplyLive);
    setChk('xuanshu-set-heartbeat', !!settings.heartbeatOn);
    setVal('xuanshu-set-heartbeatmin', settings.heartbeatMin);
}

function applySettingsFromPanel() {
    const getVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
    const getChk = (id) => { const el = document.getElementById(id); return el ? !!el.checked : false; };
    settings.deviceName = getVal('xuanshu-set-device') || '玄枢';
    settings.yexuan = getVal('xuanshu-set-yexuan') || '叶玄';
    settings.autoReplyLive = getChk('xuanshu-set-autoreply');
    settings.heartbeatOn = getChk('xuanshu-set-heartbeat');
    const min = Number(getVal('xuanshu-set-heartbeatmin'));
    settings.heartbeatMin = Number.isFinite(min) && min > 0 ? min : 30;
    save();
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
        if (sub === 'invite') {
            if (!text) { toastr.info('用法：/comm invite 角色名'); return ''; }
            inviteMember(text);
            return '';
        }
        if (sub === 'kick') {
            if (!text) { toastr.info('用法：/comm kick 角色名'); return ''; }
            kickMember(text);
            return '';
        }
        if (sub === 'members') {
            const list = settings.members.map((m) => m.name).join('、') || '（空）';
            toastr.info(`${settings.deviceName}频道成员：` + list);
            return '';
        }
        if (sub === 'target') {
            if (!text) { toastr.info('用法：/comm target 角色名'); return ''; }
            if (!getMember(text)) {
                toastr.warning(`${text} 不在频道里，请先 /comm invite ${text}`);
                return '';
            }
            settings.currentTarget = text;
            save();
            syncTargetUI();
            renderLog();
            toastr.success(`通讯对象已切换为 ${text}`);
            return '';
        }
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
        toastr.info(`${settings.deviceName}：/comm 消息 | side 消息 | target 名 | invite 名 | kick 名 | members | reply | open | close`);
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
    registerSlashCommand('comm', commCallback, ['xlink', '玄枢'], `${settings.deviceName}通讯器：/comm 消息 | side 消息 | target 名 | invite 名 | kick 名 | members | reply | open | close`);
}

jQuery(async () => {
    init();
    console.log('[玄枢通讯器] 已启动。主人，随时可以使用通讯器了。');
});
