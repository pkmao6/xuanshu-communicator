import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, generateQuietPrompt, generateRaw, characters, name1 } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { registerSlashCommand, sendMessageAs } from '../../../slash-commands.js';
import { world_info } from '../../../world-info.js';
import { findChar } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const EXT_ID = 'xuanshu';

const DEFAULT_WORKFLOW = JSON.stringify({
    '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 25, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'xuanshu', images: ['8', 0] } },
});

const defaultSettings = {
    deviceName: '玄枢',
    ownerName: null,
    api: { enabled: false, baseUrl: '', apiKey: '', model: '', temperature: 1, maxTokens: 300 },
    comfy: {
        baseUrl: 'http://127.0.0.1:8188',
        workflow: DEFAULT_WORKFLOW,
        width: 512, height: 768, seed: -1,
        layers: {
            composition: 'solo, full body, looking at viewer',
            expression: 'alluring gaze, smirk',
            appearanceDefault: 'long crimson hair, red eyes, heart in eye, stunning beauty, makeup, tall, athletic, long legs, strong, narrow waist, monster girl, (gigantic breasts:1.2), curvy',
            outfit: 'black micro bikini, covered puffy nipples, areolas slip, bodystocking, black stiletto heels',
            pose: 'contrapposto, hand on hip',
            lighting: 'soft lighting, rim light, cinematic lighting, moonlight',
        },
        negative: 'lowres, bad anatomy, bad hands, extra fingers, blurry, jpeg artifacts, watermark, text',
    },
    hubMode: 'full',
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
settings.api = Object.assign(structuredClone(defaultSettings.api), settings.api ?? {});
settings.comfy = Object.assign(structuredClone(defaultSettings.comfy), settings.comfy ?? {});

// v1.0/v1.1 -> 迁移
if (Array.isArray(settings.sideLog)) {
    if (settings.sideLog.length && settings.yinchong) {
        settings.members.push({ name: settings.yinchong, profile: settings.sidePersonaExtra ?? '', heartbeat: true, linkHub: true, log: settings.sideLog });
        if (!settings.currentTarget) settings.currentTarget = settings.yinchong;
    }
    delete settings.sideLog;
    delete settings.sidePersonaExtra;
    delete settings.yinchong;
    saveSettingsDebounced();
}
if (typeof settings.yexuan === 'string') {
    if (settings.yexuan !== '叶玄' && !settings.ownerName) settings.ownerName = settings.yexuan;
    delete settings.yexuan;
    saveSettingsDebounced();
}
if (typeof settings.linkHub !== 'undefined') {
    settings.hubMode = settings.linkHub ? 'full' : 'off';
    delete settings.linkHub;
    saveSettingsDebounced();
}
if (!['off', 'worldbook', 'hub', 'full'].includes(settings.hubMode)) settings.hubMode = 'full';
// v1.2 -> v1.3：ComfyUI 改为自定义工作流，清理旧字段
for (const k of ['checkpoint', 'steps', 'cfg', 'sampler', 'scheduler', 'positive', 'negative']) {
    if (k in settings.comfy) delete settings.comfy[k];
}
if (!settings.comfy.workflow) settings.comfy.workflow = DEFAULT_WORKFLOW;
settings.comfy.layers = Object.assign(structuredClone(defaultSettings.comfy.layers), settings.comfy.layers ?? {});
if (!settings.comfy.negative) settings.comfy.negative = defaultSettings.comfy.negative;
for (const m of settings.members) {
    m.profile = m.profile ?? m.personaExtra ?? '';
    m.appearance = m.appearance ?? '';
    m.heartbeat = m.heartbeat ?? true;
    m.linkHub = m.linkHub ?? true;
    m.log = Array.isArray(m.log) ? m.log : [];
    delete m.personaExtra;
}
if (!settings.currentTarget || !settings.members.some((m) => m.name === settings.currentTarget)) {
    settings.currentTarget = settings.members[0]?.name ?? '';
}

let busy = false;
let heartbeatTimer = null;
let $root = null;
let galleryMember = null;
let lbState = null;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRegExp = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const makeOption = (text, value) => {
    const o = document.createElement('option');
    o.textContent = text;
    o.value = value;
    return o;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

async function blobToDataUrl(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

function save() {
    saveSettingsDebounced();
}

function ownerName() {
    return String(settings.ownerName || '').trim() || (typeof name1 === 'string' && name1.trim()) || '叶玄';
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

function pushLog(key, entry) {
    settings[key].push(entry);
    const max = key === 'deviceLog' ? 100 : 300;
    if (settings[key].length > max) settings[key] = settings[key].slice(-max);
    save();
}

/* ---------------- 图库（localStorage） ---------------- */

function galleryKey(name) {
    return 'xuanshu-gallery-' + name;
}

function draftKey(name) {
    return 'xuanshu-gal-draft-' + name;
}

function getGallery(name) {
    try {
        const raw = localStorage.getItem(galleryKey(name));
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function saveGallery(name, arr) {
    try {
        localStorage.setItem(galleryKey(name), JSON.stringify(arr));
    } catch { /* 容量错误忽略 */ }
}

function getPortrait(name) {
    let g = getGallery(name);
    // v1.2 旧单图迁移
    try {
        const legacy = localStorage.getItem('xuanshu-portrait-' + name);
        if (legacy) {
            g = [{ id: 'legacy-' + Date.now(), dataUrl: legacy, prompt: '', negative: '', createdAt: Date.now(), isPortrait: true }, ...g];
            localStorage.removeItem('xuanshu-portrait-' + name);
            saveGallery(name, g);
        }
    } catch { /* 忽略 */ }
    const p = g.find((x) => x.isPortrait) ?? g[0];
    return p?.dataUrl ?? '';
}

function addGalleryImage(name, { dataUrl, prompt, negative }) {
    const g = getGallery(name);
    const entry = { id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), dataUrl, prompt: prompt ?? '', negative: negative ?? '', createdAt: Date.now(), isPortrait: g.length === 0 };
    g.push(entry);
    saveGallery(name, g);
    return entry;
}

function setPortraitImage(name, id) {
    const g = getGallery(name);
    for (const x of g) x.isPortrait = x.id === id;
    saveGallery(name, g);
}

function removeGalleryImage(name, id) {
    const g = getGallery(name).filter((x) => x.id !== id);
    if (g.length && !g.some((x) => x.isPortrait)) g[g.length - 1].isPortrait = true;
    saveGallery(name, g);
}

function removeGalleryAll(name) {
    try { localStorage.removeItem(galleryKey(name)); } catch { /* 忽略 */ }
}

function getDraft(name) {
    try {
        const raw = localStorage.getItem(draftKey(name));
        return raw ? JSON.parse(raw) : { prompt: '', negative: '' };
    } catch { return { prompt: '', negative: '' }; }
}

function saveDraft(name, prompt, negative) {
    try { localStorage.setItem(draftKey(name), JSON.stringify({ prompt, negative })); } catch { /* 忽略 */ }
}

/* ---------------- 角色中枢联动 ---------------- */

function scanWorldbookForMember(name) {
    try {
        const entries = world_info?.entries ?? [];
        const n = String(name ?? '');
        if (!n) return [];
        const hits = entries.filter((e) => {
            const entryName = String(e.name ?? '');
            if (!entryName || entryName.startsWith('TavernDB')) return false;
            if (entryName.includes(n) || n.includes(entryName)) return true;
            const keys = [e.key, ...(Array.isArray(e.secondary_keys) ? e.secondary_keys : []), e.comment ?? '']
                .filter((k) => typeof k === 'string' && k.length > 0);
            return keys.some((k) => k.includes(n) || n.includes(k));
        });
        return hits.map((e) => ({ name: e.name, keys: [e.key, ...(Array.isArray(e.secondary_keys) ? e.secondary_keys : [])].filter(Boolean), content: String(e.content ?? '') }));
    } catch (err) {
        console.warn('[玄枢] 世界书扫描失败', err);
        return [];
    }
}

let tavernCache = { at: 0, all: null };

function getTavernApi() {
    try {
        if (window.AutoCardUpdaterAPI) return window.AutoCardUpdaterAPI;
    } catch { /* 忽略 */ }
    try {
        if (window.parent && window.parent !== window && window.parent.AutoCardUpdaterAPI) return window.parent.AutoCardUpdaterAPI;
    } catch { /* 忽略 */ }
    return null;
}

function getTavernAll() {
    const now = Date.now();
    if (tavernCache.all && now - tavernCache.at < 15000) return tavernCache.all;
    const api = getTavernApi();
    if (!api || typeof api.exportTableAsJson !== 'function') {
        tavernCache = { at: now, all: null };
        return null;
    }
    try {
        const raw = api.exportTableAsJson();
        const all = raw && typeof raw === 'object' ? raw : {};
        tavernCache = { at: now, all };
        return all;
    } catch (err) {
        console.warn('[玄枢] TavernDB 读取失败', err);
        tavernCache = { at: now, all: null };
        return null;
    }
}

function findTavernTable(all, name) {
    if (!all) return null;
    for (const k of Object.keys(all)) {
        const t = all[k];
        if (!t || !Array.isArray(t.content)) continue;
        if (String(t.name ?? '') === name || String(t.key ?? '') === name || k === name) return t;
    }
    return null;
}

function tableRows(all, name) {
    const t = findTavernTable(all, name);
    if (!t || !Array.isArray(t.content) || t.content.length < 2) return [];
    const header = (t.content[0] ?? []).map((c) => String(c ?? '').trim());
    return t.content.slice(1).map((row) => header.reduce((acc, col, i) => {
        if (col) acc[col] = String(row?.[i] ?? '').trim();
        return acc;
    }, {}));
}

function rowText(row) {
    return Object.entries(row)
        .filter(([, v]) => String(v ?? '').length > 0)
        .map(([k, v]) => k + '：' + v)
        .join('；');
}

async function readChroniclesForMember(name) {
    const n = String(name ?? '');
    try {
        const api = getTavernApi();
        if (api && typeof api.queryTableRows === 'function') {
            const res = api.queryTableRows({
                tableName: '纪要表',
                columns: ['row_id', 'summary', 'key_dialogue'],
                orderBy: { column: 'row_id', direction: 'DESC' },
                limit: 5,
            });
            const rows = (res && typeof res.then === 'function') ? (await res)?.rows : res?.rows;
            if (Array.isArray(rows)) {
                return rows
                    .filter((r) => String(r?.summary ?? '').includes(n) || String(r?.key_dialogue ?? '').includes(n))
                    .map((r) => ({ summary: String(r?.summary ?? '').trim(), dialogue: String(r?.key_dialogue ?? '').trim() }));
            }
        }
    } catch { /* 回退 */ }
    const all = getTavernAll();
    if (!all) return [];
    const rows = tableRows(all, '纪要表');
    return rows
        .slice(-30)
        .reverse()
        .filter((r) => String(r.summary ?? '').includes(n) || String(r.key_dialogue ?? '').includes(n))
        .slice(0, 5)
        .map((r) => ({ summary: String(r.summary ?? '').trim(), dialogue: String(r.key_dialogue ?? '').trim() }));
}

function buildWorldbookSection(name) {
    const hits = scanWorldbookForMember(name);
    if (!hits.length) return '';
    let body = '【角色中枢·世界书档案（实时联动，随剧情更新）】\n';
    for (const h of hits.slice(0, 8)) {
        const content = h.content.slice(0, 1200);
        if (!content) continue;
        body += '· 条目「' + h.name + '」（关键词：' + h.keys.join('、') + '）：\n' + content + '\n';
    }
    return body.slice(0, 4000);
}

function buildTavernRowsSection(name) {
    const all = getTavernAll();
    if (!all) return '';
    const parts = [];
    for (const tableName of ['恋爱对象表', '重要角色表', 'NSFW信息表', '人物性格偏移表']) {
        const rows = tableRows(all, tableName);
        const row = rows.find((r) => String(r['姓名'] ?? '').trim() === String(name ?? ''));
        if (!row) continue;
        const text = rowText(row);
        if (text) parts.push('· ' + tableName + '：' + text);
    }
    if (!parts.length) return '';
    return '【角色中枢·TavernDB 档案（实时）】\n' + parts.join('\n').slice(0, 2000);
}

async function buildChroniclesSection(name) {
    const rows = await readChroniclesForMember(name);
    if (!rows.length) return '';
    let body = '【角色中枢·近期纪要摘要（仅最近 5 条，限流）】\n';
    for (const r of rows) {
        if (r.summary) body += '· ' + r.summary.slice(0, 300) + '\n';
        else if (r.dialogue) body += '· ' + r.dialogue.slice(0, 300) + '\n';
    }
    return body.slice(0, 800);
}

async function buildHubSection(name) {
    const mode = settings.hubMode ?? 'full';
    if (mode === 'off') return '';
    const parts = [];
    const wb = buildWorldbookSection(name);
    if (wb) parts.push(wb);
    if (mode === 'hub' || mode === 'full') {
        const tb = buildTavernRowsSection(name);
        if (tb) parts.push(tb);
    }
    if (mode === 'full') {
        const cr = await buildChroniclesSection(name);
        if (cr) parts.push(cr);
    }
    return parts.join('\n\n').slice(0, 6000);
}

async function buildMemberContext(member, opts = {}) {
    const parts = [];
    parts.push('你是' + member.name + '。');
    if (member.profile) parts.push('【角色档案】\n' + member.profile);
    if (settings.hubMode !== 'off' && member.linkHub) {
        const hub = await buildHubSection(member.name);
        if (hub) parts.push(hub);
    }
    parts.push('你正通过' + settings.deviceName + '加密通讯器与' + ownerName() + (opts.forLive ? '私密通讯' : '进行番外私聊（与主线剧情平行、互不影响）') + '。用第一人称直接输出你发出的讯息正文：像发短讯一样自然，可以撒娇、汇报、挑逗，禁止旁白、禁止动作描写标记、禁止输出除讯息正文以外的任何内容。');
    return parts.join('\n\n');
}

function stripNamePrefix(text, name) {
    return String(text ?? '').trim().replace(new RegExp('^' + escapeRegExp(name) + '\\s*[:：]\\s*'), '').trim();
}

/* ---------------- AI 生成：OpenAI 直连 → 回退酒馆接口 ---------------- */

async function aiChat(messages) {
    const api = settings.api;
    if (api.enabled && api.baseUrl && api.apiKey && api.model) {
        const url = String(api.baseUrl).replace(/\/+$/, '') + '/chat/completions';
        const body = {
            model: api.model,
            messages,
            temperature: Number(api.temperature ?? 1),
        };
        const maxTokens = Number(api.maxTokens);
        if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.apiKey },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120000),
            });
        } catch (err) {
            throw new Error('OpenAI 接口连接失败：' + (err?.message ?? err));
        }
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error('OpenAI 接口 ' + resp.status + '：' + detail.slice(0, 300));
        }
        const data = await resp.json();
        const reply = data?.choices?.[0]?.message?.content;
        return String(reply ?? '').trim();
    }
    const reply = await generateRaw({ prompt: messages, trimNames: true });
    return String(reply ?? '').trim();
}

/* ---------------- 分层提示词组装（正负词固定模板） ---------------- */

function assemblePrompt(member) {
    const L = settings.comfy?.layers ?? {};
    const appear = String(member?.appearance ?? '').trim() || String(L.appearanceDefault ?? '').trim();
    const parts = [L.composition, L.expression, appear, L.outfit, L.pose, L.lighting]
        .map((s) => String(s ?? '').trim())
        .filter(Boolean);
    return parts.join(', ');
}

function fixedNegative() {
    return String(settings.comfy?.negative ?? '').trim();
}

/* ---------------- ComfyUI：主人自己的工作流 ---------------- */

function buildComfyWorkflow(prompt, negative) {
    const raw = String(settings.comfy?.workflow ?? '').trim();
    if (!raw) throw new Error('请先在设置里粘贴 ComfyUI 工作流 JSON');
    let json;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error('ComfyUI 工作流 JSON 解析失败：' + err.message);
    }
    const seed = Number(settings.comfy.seed) >= 0 ? Number(settings.comfy.seed) : Math.floor(Math.random() * 1e12);
    const widthNum = Number(settings.comfy.width) || 512;
    const heightNum = Number(settings.comfy.height) || 768;
    const typed = {
        '{{prompt}}': String(prompt ?? ''),
        '{{negative}}': String(negative ?? ''),
        '{{seed}}': seed,
        '{{width}}': widthNum,
        '{{height}}': heightNum,
    };
    const strSubs = Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, String(v)]));
    const replace = (v) => {
        if (typeof v === 'string') {
            // 整串等于占位符时给强类型（seed/宽高必须为数字），混在其他文本里则做字符串替换
            if (typed[v] !== undefined) return typed[v];
            let s = v;
            for (const [k, r] of Object.entries(strSubs)) s = s.split(k).join(r);
            return s;
        }
        if (Array.isArray(v)) return v.map(replace);
        if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) v[k] = replace(v[k]);
            return v;
        }
        return v;
    };
    return replace(json);
}

async function generateImage(name, prompt, negative) {
    const c = settings.comfy;
    const base = String(c.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('请先在设置里填写 ComfyUI 地址');
    const wf = buildComfyWorkflow(prompt, negative);
    const resp = await fetch(base + '/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: wf }),
        signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error('ComfyUI /prompt 返回 ' + resp.status);
    const data = await resp.json();
    const promptId = data?.prompt_id;
    if (!promptId) throw new Error('ComfyUI 未返回 prompt_id：' + JSON.stringify(data).slice(0, 200));
    for (let i = 0; i < 100; i++) {
        await sleep(3000);
        let hist;
        try {
            const hr = await fetch(base + '/history/' + promptId, { signal: AbortSignal.timeout(15000) });
            if (!hr.ok) continue;
            hist = await hr.json();
        } catch { continue; }
        const outputs = hist?.[promptId]?.outputs ?? {};
        const images = Object.values(outputs).flatMap((o) => Array.isArray(o?.images) ? o.images : []);
        if (images.length) {
            const img = images[0];
            const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
            const ir = await fetch(base + '/view?' + qs.toString(), { signal: AbortSignal.timeout(60000) });
            if (!ir.ok) throw new Error('立绘下载失败：' + ir.status);
            const blob = await ir.blob();
            return await blobToDataUrl(blob);
        }
    }
    throw new Error('ComfyUI 生成超时（超过 5 分钟未出图）');
}

/* ---------------- 成员管理 ---------------- */

function inviteMember(name, profile = '', appearance = '') {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return false;
    if (getMember(trimmed)) {
        toastr.info(trimmed + ' 已经在频道里了');
        return false;
    }
    settings.members.push({ name: trimmed, profile: String(profile ?? '').trim(), appearance: String(appearance ?? '').trim(), heartbeat: true, linkHub: true, log: [] });
    if (!settings.currentTarget) settings.currentTarget = trimmed;
    toastr.success(trimmed + ' 的档案已建立，已加入' + settings.deviceName + '频道');
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
    removeGalleryAll(name);
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
        listEl.append($('<div class="xuanshu-set-note">尚未建立任何角色档案</div>'));
    }
    for (const m of settings.members) {
        const portrait = getPortrait(m.name);
        const row = $(`<div class="xuanshu-member-row" data-member="${escapeHtml(m.name)}">
            ${portrait ? `<img class="xuanshu-member-portrait" src="${portrait}" alt="" />` : '<span class="xuanshu-member-portrait xuanshu-member-portrait-empty">?</span>'}
            <span class="xuanshu-member-name">${escapeHtml(m.name)}</span>
            <button class="xuanshu-member-edit" title="编辑档案">档案</button>
            <button class="xuanshu-member-gallery" title="图库与立绘">立绘</button>
            <label class="xuanshu-member-hb" title="参与心跳待机"><input type="checkbox" class="xuanshu-member-heartbeat" ${m.heartbeat ? 'checked' : ''} /> 心跳</label>
            <label class="xuanshu-member-hb" title="回复时实时联动角色中枢"><input type="checkbox" class="xuanshu-member-link" ${m.linkHub ? 'checked' : ''} /> 中枢</label>
            <button class="xuanshu-member-kick" title="移出频道">踢出</button>
        </div>`);
        row.find('.xuanshu-member-heartbeat').on('change', function () {
            m.heartbeat = !!this.checked;
            save();
        });
        row.find('.xuanshu-member-link').on('change', function () {
            m.linkHub = !!this.checked;
            save();
        });
        row.find('.xuanshu-member-kick').on('click', async () => {
            const ok = await callGenericPopup('要把 ' + m.name + ' 移出频道吗？其档案、图库与番外记录会一并删除。', POPUP_TYPE.CONFIRM);
            if (!ok) return;
            kickMember(m.name);
            refreshRosterUI();
        });
        row.find('.xuanshu-member-edit').on('click', () => openProfileEditor(m.name));
        row.find('.xuanshu-member-gallery').on('click', () => openGallery(m.name));
        listEl.append(row);
    }
}

function openProfileEditor(name) {
    const member = getMember(name);
    if (!$root || !member) return;
    const ed = $root.find('#xuanshu-profile-editor');
    ed.empty();
    ed.append($(`<div class="xuanshu-set-title">▍档案编辑 · ${escapeHtml(name)}</div>`));
    const html = `
        <div class="xuanshu-set-row"><label>名字</label><input id="xuanshu-pe-name" type="text" value="${escapeHtml(name)}" disabled /></div>
        <div class="xuanshu-set-row"><label>档案文本</label><textarea id="xuanshu-pe-profile" rows="6" placeholder="外观、性格、与机主的关系、背景……回复时作为依据"></textarea></div>
        <div class="xuanshu-set-row"><label>外貌提示词</label><textarea id="xuanshu-pe-appearance" rows="2" placeholder="立绘外貌标签：发色、瞳色、体型……留空则用默认外貌层"></textarea></div>
        <div class="xuanshu-set-row"><button id="xuanshu-pe-save" class="xuanshu-invite-btn">保存档案</button></div>`;
    ed.append($(html));
    const ta = document.getElementById('xuanshu-pe-profile');
    if (ta) ta.value = member.profile ?? '';
    const ap = document.getElementById('xuanshu-pe-appearance');
    if (ap) ap.value = member.appearance ?? '';
    $('#xuanshu-pe-save').on('click', () => {
        const v = String(document.getElementById('xuanshu-pe-profile')?.value ?? '').trim();
        const a = String(document.getElementById('xuanshu-pe-appearance')?.value ?? '').trim();
        member.profile = v;
        member.appearance = a;
        save();
        toastr.success(member.name + ' 的档案已保存');
    });
}

/* ---------------- 图库面板 + 灯箱（照搬色色灵感交互） ---------------- */

function openGallery(name) {
    const member = getMember(name);
    if (!$root || !member) return;
    galleryMember = name;
    $root.find('.xuanshu-settings-pop').hide();
    const g = getGallery(name);
    const draft = getDraft(name);
    $('#xuanshu-gallery').show();
    $('#xuanshu-gallery-title').text('图库 · ' + name);
    $('#xuanshu-gal-prompt').val(draft.prompt || (g.length ? g[g.length - 1].prompt : '') || assemblePrompt(member));
    $('#xuanshu-gal-neg').val(draft.negative || (g.length ? g[g.length - 1].negative : '') || fixedNegative());
    $('#xuanshu-gal-status').text('');
    renderGallery();
}

function closeGallery() {
    galleryMember = null;
    $('#xuanshu-gallery').hide();
    closeLightbox();
}

function renderGallery() {
    if (!galleryMember) return;
    const g = getGallery(galleryMember);
    const grid = $('#xuanshu-gal-grid');
    grid.empty();
    if (!g.length) {
        grid.append($('<div class="xuanshu-set-note">图库为空——下方写好提示词点「生成立绘」，或上传本地图片</div>'));
    }
    for (const img of g) {
        const item = $(`<div class="xuanshu-gal-item ${img.isPortrait ? 'is-portrait' : ''}" data-id="${img.id}" title="${escapeHtml(img.prompt).slice(0, 150)}">
            <img src="${img.dataUrl}" alt="" loading="lazy">
            <span class="xuanshu-gal-badge">${img.isPortrait ? '立绘' : ''}</span>
            <div class="xuanshu-gal-actions">
                <span data-act="pick" title="设为立绘">★</span>
                <span data-act="edit" title="编辑提示词">✎</span>
                <span data-act="del" title="删除">✕</span>
            </div>
        </div>`);
        item.on('click', function (e) {
            const act = $(e.target).closest('[data-act]').data('act');
            if (act === 'pick') {
                setPortraitImage(galleryMember, img.id);
                renderGallery();
                syncTargetUI();
                refreshRosterUI();
                return;
            }
            if (act === 'edit') {
                $('#xuanshu-gal-prompt').val(img.prompt ?? '');
                $('#xuanshu-gal-neg').val(img.negative ?? '');
                $('#xuanshu-gal-status').text('已载入该图提示词——修改后点「生成立绘」生成新图');
                return;
            }
            if (act === 'del') {
                removeGalleryImage(galleryMember, img.id);
                renderGallery();
                syncTargetUI();
                refreshRosterUI();
                return;
            }
            openLightbox(galleryMember, img.id);
        });
        grid.append(item);
    }
}

function openLightbox(name, id) {
    const entries = getGallery(name);
    if (!entries.length) return;
    const idx = Math.max(0, entries.findIndex((x) => x.id === id));
    lbState = { name, entries, index: idx };
    const root = $('#xuanshu-lightbox');
    root.empty();
    root.append($(`
        <div class="xuanshu-lb-track" id="xuanshu-lb-track">
            <div class="xuanshu-lb-slide"><img alt="" draggable="false"><span class="xuanshu-lb-nav xuanshu-lb-prev" title="前一张">‹</span><span class="xuanshu-lb-nav xuanshu-lb-next" title="后一张">›</span></div>
            <div class="xuanshu-lb-slide"><img alt="" draggable="false"><span class="xuanshu-lb-nav xuanshu-lb-prev" title="前一张">‹</span><span class="xuanshu-lb-nav xuanshu-lb-next" title="后一张">›</span></div>
            <div class="xuanshu-lb-slide"><img alt="" draggable="false"><span class="xuanshu-lb-nav xuanshu-lb-prev" title="前一张">‹</span><span class="xuanshu-lb-nav xuanshu-lb-next" title="后一张">›</span></div>
        </div>
        <div class="xuanshu-lb-counter" id="xuanshu-lb-counter"></div>
        <div class="xuanshu-lb-actions">
            <button class="xuanshu-lb-star" title="设为立绘">★ 设为立绘</button>
            <button class="xuanshu-lb-edit" title="把提示词载入图库编辑区">✎ 编辑提示词</button>
            <button class="xuanshu-lb-del" title="删除这张">✕ 删除</button>
            <button class="xuanshu-lb-close">关闭</button>
        </div>`));
    root.show();
    renderLightbox();
}

function renderLightbox() {
    if (!lbState) return;
    const s = lbState.entries;
    const b = lbState.index;
    const track = document.getElementById('xuanshu-lb-track');
    if (!track) return;
    const slides = [...track.children];
    const S = (e) => (e >= 0 && e < s.length ? s[e] : null);
    const setImg = (slide, entry) => {
        const img = slide.querySelector('img');
        if (entry) {
            if (img.getAttribute('src') !== entry.dataUrl) img.src = entry.dataUrl;
            img.style.display = '';
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
        }
    };
    slides.forEach((sl, t) => {
        setImg(sl, S(b + t - 1));
        sl.querySelector('.xuanshu-lb-prev').style.display = (t === 1 && b > 0) ? '' : 'none';
        sl.querySelector('.xuanshu-lb-next').style.display = (t === 1 && b < s.length - 1) ? '' : 'none';
    });
    track.style.transition = 'none';
    track.style.transform = 'translateX(-100%)';
    raf(() => { track.style.transition = ''; });
    $('#xuanshu-lb-counter').text((b + 1) + '/' + s.length);
    $('#xuanshu-lightbox .xuanshu-lb-star').toggleClass('on', !!s[b]?.isPortrait);
}

function flipLightbox(dir) {
    if (!lbState) return;
    const t = lbState.index + dir;
    if (t < 0 || t >= lbState.entries.length) return;
    const track = document.getElementById('xuanshu-lb-track');
    if (track) {
        track.style.transition = 'transform .24s cubic-bezier(.25,.72,.36,1)';
        track.style.transform = 'translateX(' + (-100 * (1 + dir)) + '%)';
    }
    setTimeout(() => {
        lbState.index = t;
        renderLightbox();
    }, 240);
}

function closeLightbox() {
    lbState = null;
    $('#xuanshu-lightbox').hide().empty();
}

function syncTargetUI() {
    if (!$root) return;
    const sel = $root.find('#xuanshu-target')[0];
    if (!sel) return;
    const current = settings.currentTarget;
    sel.innerHTML = '';
    if (!settings.members.length) {
        sel.append(makeOption('（未建立档案）', ''));
        sel.disabled = true;
    } else {
        for (const m of settings.members) sel.append(makeOption(m.name, m.name));
        sel.disabled = false;
        sel.value = settings.members.some((m) => m.name === current) ? current : settings.members[0].name;
    }
    renderTargetPortrait();
}

function renderTargetPortrait() {
    const holder = document.getElementById('xuanshu-target-portrait');
    if (!holder) return;
    const member = getCurrentMember();
    const portrait = member ? getPortrait(member.name) : '';
    holder.innerHTML = portrait ? `<img src="${portrait}" alt="" title="点 ⚙ 通讯录的「立绘」按钮管理图库" />` : '';
}

function renderLog() {
    if (!$root) return;
    const el = $root.find('.xuanshu-log');
    el.empty();
    const isSide = settings.ui.tab === 'side';
    const member = getCurrentMember();
    if (isSide && !member) {
        el.append($(`<div class="xuanshu-line sys"><span class="xuanshu-text">频道暂无通讯对象——点 ⚙ 为故事角色建立档案。</span></div>`));
    } else {
        const log = isSide ? member.log : settings.deviceLog;
        for (const m of log) {
            let whoName;
            if (m.who === 'yexuan') whoName = ownerName();
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

/* ---------------- 主线（实时）频道 ---------------- */

async function sendLive(text, targetName = null) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;
    const member = targetName ? getMember(targetName) : getCurrentMember();
    if (!member) {
        toastr.warning('频道里还没有角色档案——请先点 ⚙ 建立档案');
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
    const mesText = `【${settings.deviceName} · 加密链路】\n${ownerName()} → ${member.name}：\n${trimmed}`;
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
        let clean = '';
        const api = settings.api;
        if (api.enabled && api.baseUrl && api.apiKey && api.model) {
            // OpenAI 直连（含主线剧情上下文）
            const memberCtx = await buildMemberContext(member, { forLive: true });
            const char = getCharByName(member.name);
            let sys = memberCtx;
            if (char) {
                const card = ['【当前角色卡】'];
                if (char.description) card.push('设定：' + char.description);
                if (char.personality) card.push('性格：' + char.personality);
                sys += '\n\n' + card.join('\n');
            }
            const messages = [{ role: 'system', content: sys.slice(0, 8000) }];
            const history = Array.isArray(getContext().chat) ? getContext().chat.slice(-24) : [];
            let used = 0;
            for (const m of history) {
                const text = String(m?.mes ?? '').trim();
                if (!text || used > 6000) break;
                used += text.length;
                if (m.is_user) messages.push({ role: 'user', name: ownerName(), content: text });
                else messages.push({ role: 'assistant', name: m.name ?? member.name, content: text });
            }
            messages.push({ role: 'user', name: ownerName(), content: '（你正通过' + settings.deviceName + '加密通讯器私密回复' + ownerName() + '。保持角色，只输出回复讯息正文，不要旁白、不要格式标记。）\n' + ownerName() + '刚刚发来的讯息：' + last.text });
            clean = stripNamePrefix(await aiChat(messages), member.name);
        } else {
            const memberCtx = await buildMemberContext(member, { forLive: true });
            const quietPrompt = '（你是' + member.name + '，正通过' + settings.deviceName + '加密通讯器私密回复' + ownerName() + '。保持角色，只输出回复讯息正文，不要旁白、不要格式标记。）\n' + ownerName() + '刚刚发来的讯息：' + last.text + '\n\n' + memberCtx;
            const char = getCharByName(member.name);
            let forceChId = null;
            if (char && Array.isArray(characters)) {
                const idx = characters.findIndex((c) => c === char);
                if (idx >= 0) forceChId = idx;
            }
            clean = String(await generateQuietPrompt({ quietPrompt, quietName: member.name, forceChId, removeReasoning: true }) ?? '').trim();
        }
        if (!clean) {
            toastr.warning(member.name + '没有回应……');
            return;
        }
        const mesText = `【${settings.deviceName} · 加密链路】\n${member.name} → ${ownerName()}：\n${clean}`;
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
        toastr.warning('频道里还没有角色档案——请先点 ⚙ 建立档案');
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
        const memberCtx = await buildMemberContext(member);
        const messages = [{ role: 'system', content: memberCtx }];
        for (const m of member.log) {
            if (m.who === 'yexuan') messages.push({ role: 'user', name: ownerName(), content: m.text });
            else if (m.who === 'yinchong') messages.push({ role: 'assistant', name: member.name, content: m.text });
        }
        messages.push({ role: 'assistant', name: member.name, content: '' });
        const reply = await aiChat(messages);
        const clean = stripNamePrefix(reply, member.name);
        if (!clean) {
            toastr.warning(member.name + '没有回应……');
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
        const instruction = '（现在，随机地给' + ownerName() + '发一条主动的私讯。内容随机选择一种：撒娇想他、汇报近况、分享刚经历的小事、暧昧挑逗、突兀却可爱的碎碎念。语气与性格必须完全符合你的人设。直接输出讯息正文，不要任何旁白或说明。）';
        const messages = [
            { role: 'system', content: (await buildMemberContext(member)) + '\n\n' + instruction },
            { role: 'assistant', name: member.name, content: '' },
        ];
        const reply = await aiChat(messages);
        const clean = stripNamePrefix(reply, member.name);
        if (!clean) return;
        member.log.push({ who: 'yinchong', text: clean, ts: Date.now() });
        if (member.log.length > 300) member.log = member.log.slice(-300);
        save();
        renderLog();
        notify();
        if (!settings.ui.open || settings.ui.tab !== 'side' || settings.currentTarget !== member.name) {
            toastr.info(settings.deviceName + ' · 番外频道有新讯息', member.name + ' 发来了私讯', { timeOut: 4000 });
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
            <span id="xuanshu-target-portrait" class="xuanshu-target-portrait"></span>
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
          <div class="xuanshu-set-row"><label>机主名字</label><input id="xuanshu-set-owner" type="text" placeholder="留空 = 跟随当前人格名" /></div>
          <div class="xuanshu-set-title">▍通讯录（故事角色档案）</div>
          <div class="xuanshu-set-row"><label>角色名</label><input id="xuanshu-new-name" type="text" placeholder="故事里的角色名字" /></div>
          <div class="xuanshu-set-row"><label>角色档案</label><textarea id="xuanshu-new-profile" rows="4" placeholder="外观、性格、与机主的关系、背景……"></textarea></div>
          <div class="xuanshu-set-row"><label>外貌提示词</label><textarea id="xuanshu-new-appearance" rows="2" placeholder="立绘外貌标签：发色、瞳色、体型……留空则用默认外貌层"></textarea></div>
          <div class="xuanshu-set-row"><button id="xuanshu-invite-btn" class="xuanshu-invite-btn">建立档案并加入频道</button></div>
          <div id="xuanshu-members-list"></div>
          <div id="xuanshu-profile-editor"></div>
          <div class="xuanshu-set-title">▍模型（OpenAI 兼容接口，全部频道通用）</div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-api-enabled" type="checkbox" /> 启用独立接口</label></div>
          <div class="xuanshu-set-row"><label>接口地址</label><input id="xuanshu-set-api-url" type="text" placeholder="https://api.openai.com/v1" /></div>
          <div class="xuanshu-set-row"><label>API 密钥</label><input id="xuanshu-set-api-key" type="password" placeholder="sk-..." /></div>
          <div class="xuanshu-set-row"><label>模型</label><input id="xuanshu-set-api-model" type="text" placeholder="gpt-4o-mini" /></div>
          <div class="xuanshu-set-row"><label>温度</label><input id="xuanshu-set-api-temp" type="number" min="0" max="2" step="0.1" /></div>
          <div class="xuanshu-set-row"><label>最大回复</label><input id="xuanshu-set-api-maxtok" type="number" min="16" max="8192" /></div>
          <div class="xuanshu-set-title">▍立绘（ComfyUI）</div>
          <div class="xuanshu-set-row"><label>ComfyUI 地址</label><input id="xuanshu-set-comfy-url" type="text" placeholder="http://127.0.0.1:8188" /></div>
          <div class="xuanshu-set-row"><label>工作流 JSON</label><textarea id="xuanshu-set-comfy-workflow" rows="10" spellcheck="false" placeholder="粘贴 ComfyUI API 格式工作流；占位符：{{prompt}} {{negative}} {{seed}} {{width}} {{height}}"></textarea></div>
          <div class="xuanshu-set-row"><label>尺寸</label><input id="xuanshu-set-comfy-w" type="number" min="256" max="2048" /><span>×</span><input id="xuanshu-set-comfy-h" type="number" min="256" max="2048" /></div>
          <div class="xuanshu-set-row"><label>种子</label><input id="xuanshu-set-comfy-seed" type="number" min="-1" step="1" /></div>
          <div class="xuanshu-set-note">工作流完全由主人自己粘贴；生成时仅替换 {{prompt}} {{negative}} {{seed}} {{width}} {{height}} 占位符。</div>
          <div class="xuanshu-set-title">▍立绘提示词模板（固定分层，自动组装）</div>
          <div class="xuanshu-set-row"><label>构图层</label><input id="xuanshu-set-l-composition" type="text" /></div>
          <div class="xuanshu-set-row"><label>表情层</label><input id="xuanshu-set-l-expression" type="text" /></div>
          <div class="xuanshu-set-row"><label>默认外貌层</label><textarea id="xuanshu-set-l-appearance" rows="2"></textarea></div>
          <div class="xuanshu-set-row"><label>服装层</label><input id="xuanshu-set-l-outfit" type="text" /></div>
          <div class="xuanshu-set-row"><label>姿势层</label><input id="xuanshu-set-l-pose" type="text" /></div>
          <div class="xuanshu-set-row"><label>光影层</label><input id="xuanshu-set-l-lighting" type="text" /></div>
          <div class="xuanshu-set-row"><label>负面提示词</label><textarea id="xuanshu-set-neg" rows="2"></textarea></div>
          <div class="xuanshu-set-note">组装顺序：构图 → 表情 → 角色外貌（成员「外貌提示词」，留空用默认外貌层） → 服装 → 姿势 → 光影。图库面板里的提示词会自动按此组装，可微调。</div>
          <div class="xuanshu-set-title">▍行为</div>
          <div class="xuanshu-set-row"><label>中枢联动</label><select id="xuanshu-set-hubmode">
            <option value="off">关闭</option>
            <option value="worldbook">仅世界书档案</option>
            <option value="hub">世界书 + TavernDB 角色表</option>
            <option value="full">全部（含纪要摘要）</option>
          </select></div>
          <div class="xuanshu-set-note">限流规则：世界书≤4000 字、角色表≤2000 字、纪要仅取该角色最近 5 条摘要≤800 字，总注入≤6000 字，绝不爆 token。</div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-autoreply" type="checkbox" /> 实时频道自动回复</label></div>
          <div class="xuanshu-set-row xuanshu-set-check"><label><input id="xuanshu-set-heartbeat" type="checkbox" /> 心跳待机（成员随机主动来讯）</label></div>
          <div class="xuanshu-set-row"><label>心跳间隔（分钟）</label><input id="xuanshu-set-heartbeatmin" type="number" min="1" max="1440" /></div>
          <div class="xuanshu-set-note">修改后即时生效，记录自动保存。API 密钥仅保存在本地设置中。</div>
        </div>
        <div id="xuanshu-gallery" class="xuanshu-settings-pop" style="display:none">
          <div class="xuanshu-gal-head"><span class="xuanshu-set-title" id="xuanshu-gallery-title">图库</span><button class="xuanshu-btn xuanshu-gal-close" title="关闭">×</button></div>
          <div id="xuanshu-gal-grid"></div>
          <div class="xuanshu-set-title">▍生成 / 重生成</div>
          <div class="xuanshu-set-row"><label>提示词</label><textarea id="xuanshu-gal-prompt" rows="4" placeholder="按固定分层模板自动组装：构图 → 表情 → 角色外貌 → 服装 → 姿势 → 光影"></textarea></div>
          <div class="xuanshu-set-row"><label>负向词</label><textarea id="xuanshu-gal-neg" rows="2" placeholder="固定负向词（设置里配置）"></textarea></div>
          <div class="xuanshu-set-row">
            <button id="xuanshu-gal-gen" class="xuanshu-invite-btn">生成立绘</button>
            <button id="xuanshu-gal-reassemble" class="xuanshu-invite-btn" title="按固定分层模板重新组装提示词">重装模板</button>
            <label class="xuanshu-invite-btn xuanshu-upload-label">上传图片<input id="xuanshu-gal-upload" type="file" accept="image/*" multiple style="display:none" /></label>
          </div>
          <div id="xuanshu-gal-status" class="xuanshu-set-note"></div>
        </div>
      </div>
    </div>
    <div id="xuanshu-lightbox" style="display:none"></div>`;
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
    $('#xuanshu-launcher').attr('title', settings.deviceName + '通讯器');
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
        const pop = $root.find('.xuanshu-settings-pop').first();
        const showing = pop.is(':visible');
        if (showing) {
            applySettingsFromPanel();
            pop.hide();
        } else {
            $('#xuanshu-gallery').hide();
            closeLightbox();
            fillSettingsPanel();
            refreshRosterUI();
            pop.show();
        }
    });
    $root.find('.xuanshu-target').on('change', function () {
        settings.currentTarget = String(this.value);
        save();
        renderTargetPortrait();
        renderLog();
    });
    $('#xuanshu-invite-btn').on('click', () => {
        const name = String(document.getElementById('xuanshu-new-name')?.value ?? '').trim();
        const profile = String(document.getElementById('xuanshu-new-profile')?.value ?? '').trim();
        const appearance = String(document.getElementById('xuanshu-new-appearance')?.value ?? '').trim();
        if (!name) {
            toastr.info('请先填写故事角色的名字');
            return;
        }
        inviteMember(name, profile, appearance);
        if (document.getElementById('xuanshu-new-name')) document.getElementById('xuanshu-new-name').value = '';
        if (document.getElementById('xuanshu-new-profile')) document.getElementById('xuanshu-new-profile').value = '';
        if (document.getElementById('xuanshu-new-appearance')) document.getElementById('xuanshu-new-appearance').value = '';
        refreshRosterUI();
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
        const ok = await callGenericPopup('要清空「' + (isSide ? ('番外频道 · ' + member.name) : '实时频道') + '」的全部记录吗？（主线聊天里的消息不受影响）', POPUP_TYPE.CONFIRM);
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
    // 图库面板
    $root.find('.xuanshu-gal-close').on('click', () => closeGallery());
    $('#xuanshu-gal-reassemble').on('click', () => {
        if (!galleryMember) return;
        const member = getMember(galleryMember);
        $('#xuanshu-gal-prompt').val(assemblePrompt(member));
        $('#xuanshu-gal-neg').val(fixedNegative());
        $('#xuanshu-gal-status').text('已按固定分层模板重新组装');
    });
    $('#xuanshu-gal-gen').on('click', async () => {
        if (!galleryMember) return;
        const prompt = String($('#xuanshu-gal-prompt').val() ?? '').trim();
        if (!prompt) {
            toastr.info('请先写提示词——生成时原样使用，不做任何自动拼接');
            return;
        }
        const negative = String($('#xuanshu-gal-neg').val() ?? '').trim();
        const status = $('#xuanshu-gal-status');
        status.text('▌正在生成……（约 1-5 分钟，请保持页面开启）');
        try {
            const dataUrl = await generateImage(galleryMember, prompt, negative);
            const entry = addGalleryImage(galleryMember, { dataUrl, prompt, negative });
            saveDraft(galleryMember, prompt, negative);
            renderGallery();
            syncTargetUI();
            refreshRosterUI();
            status.text('生成完毕 ✓');
            openLightbox(galleryMember, entry.id);
        } catch (err) {
            console.error('[玄枢] 立绘生成失败', err);
            status.text('生成失败：' + (err?.message ?? err));
            toastr.error('立绘生成失败：' + (err?.message ?? err));
        }
    });
    $('#xuanshu-gal-upload').on('change', async function () {
        if (!galleryMember) return;
        const files = [...(this.files ?? [])];
        for (const file of files) {
            try {
                const dataUrl = await blobToDataUrl(file);
                addGalleryImage(galleryMember, { dataUrl, prompt: '', negative: '' });
            } catch (err) {
                toastr.error('上传失败：' + (err?.message ?? err));
            }
        }
        this.value = '';
        renderGallery();
        syncTargetUI();
        refreshRosterUI();
    });
    // 灯箱
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-prev', () => flipLightbox(-1));
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-next', () => flipLightbox(1));
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-close', () => closeLightbox());
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-star', () => {
        if (!lbState) return;
        const cur = lbState.entries[lbState.index];
        setPortraitImage(lbState.name, cur.id);
        renderLightbox();
        renderGallery();
        syncTargetUI();
        refreshRosterUI();
    });
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-edit', () => {
        if (!lbState) return;
        const cur = lbState.entries[lbState.index];
        closeLightbox();
        if (!galleryMember) openGallery(lbState.name);
        $('#xuanshu-gal-prompt').val(cur.prompt ?? '');
        $('#xuanshu-gal-neg').val(cur.negative ?? '');
        $('#xuanshu-gal-status').text('已载入该图提示词——修改后点「生成立绘」生成新图');
    });
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-del', async () => {
        if (!lbState) return;
        const cur = lbState.entries[lbState.index];
        const ok = await callGenericPopup('删除这张立绘？', POPUP_TYPE.CONFIRM);
        if (!ok) return;
        removeGalleryImage(lbState.name, cur.id);
        const entries = getGallery(lbState.name);
        renderGallery();
        syncTargetUI();
        refreshRosterUI();
        if (!entries.length) {
            closeLightbox();
        } else {
            lbState.entries = entries;
            lbState.index = Math.min(lbState.index, entries.length - 1);
            renderLightbox();
        }
    });
    $('#xuanshu-lightbox').on('click', function (e) {
        // 点图/空白关闭（仿照色色灵感：点图或空白或 ESC 返回）
        if (!lbState) return;
        if (e.target.closest('.xuanshu-lb-actions') || e.target.closest('.xuanshu-lb-nav') || e.target.closest('.xuanshu-lb-counter')) return;
        closeLightbox();
    });
    $(document).on('keydown.xuanshu-lb', (e) => {
        if (!lbState) return;
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') flipLightbox(-1);
        else if (e.key === 'ArrowRight') flipLightbox(1);
    });
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
    setVal('xuanshu-set-owner', settings.ownerName ?? '');
    setChk('xuanshu-set-api-enabled', !!settings.api.enabled);
    setVal('xuanshu-set-api-url', settings.api.baseUrl);
    setVal('xuanshu-set-api-key', settings.api.apiKey);
    setVal('xuanshu-set-api-model', settings.api.model);
    setVal('xuanshu-set-api-temp', settings.api.temperature);
    setVal('xuanshu-set-api-maxtok', settings.api.maxTokens);
    setVal('xuanshu-set-comfy-url', settings.comfy.baseUrl);
    setVal('xuanshu-set-comfy-workflow', settings.comfy.workflow ?? DEFAULT_WORKFLOW);
    setVal('xuanshu-set-comfy-w', settings.comfy.width);
    setVal('xuanshu-set-comfy-h', settings.comfy.height);
    setVal('xuanshu-set-comfy-seed', settings.comfy.seed);
    const L = settings.comfy.layers ?? {};
    setVal('xuanshu-set-l-composition', L.composition);
    setVal('xuanshu-set-l-expression', L.expression);
    setVal('xuanshu-set-l-appearance', L.appearanceDefault);
    setVal('xuanshu-set-l-outfit', L.outfit);
    setVal('xuanshu-set-l-pose', L.pose);
    setVal('xuanshu-set-l-lighting', L.lighting);
    setVal('xuanshu-set-neg', settings.comfy.negative);
    setVal('xuanshu-set-hubmode', settings.hubMode ?? 'full');
    setChk('xuanshu-set-autoreply', !!settings.autoReplyLive);
    setChk('xuanshu-set-heartbeat', !!settings.heartbeatOn);
    setVal('xuanshu-set-heartbeatmin', settings.heartbeatMin);
}

function applySettingsFromPanel() {
    const getVal = (id) => { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; };
    const getChk = (id) => { const el = document.getElementById(id); return el ? !!el.checked : false; };
    settings.deviceName = getVal('xuanshu-set-device') || '玄枢';
    settings.ownerName = getVal('xuanshu-set-owner');
    settings.api.enabled = getChk('xuanshu-set-api-enabled');
    settings.api.baseUrl = getVal('xuanshu-set-api-url');
    settings.api.apiKey = getVal('xuanshu-set-api-key');
    settings.api.model = getVal('xuanshu-set-api-model');
    const temp = Number(getVal('xuanshu-set-api-temp'));
    settings.api.temperature = Number.isFinite(temp) ? temp : 1;
    const maxTok = Number(getVal('xuanshu-set-api-maxtok'));
    settings.api.maxTokens = Number.isFinite(maxTok) ? maxTok : 300;
    settings.comfy.baseUrl = getVal('xuanshu-set-comfy-url');
    const wfRaw = document.getElementById('xuanshu-set-comfy-workflow')?.value ?? '';
    if (wfRaw.trim()) {
        try {
            JSON.parse(wfRaw);
            settings.comfy.workflow = wfRaw;
        } catch (err) {
            toastr.error('工作流 JSON 解析失败，未保存：' + err.message);
        }
    }
    const cw = Number(getVal('xuanshu-set-comfy-w'));
    settings.comfy.width = Number.isFinite(cw) && cw >= 256 ? cw : 512;
    const ch = Number(getVal('xuanshu-set-comfy-h'));
    settings.comfy.height = Number.isFinite(ch) && ch >= 256 ? ch : 768;
    const cseed = Number(getVal('xuanshu-set-comfy-seed'));
    settings.comfy.seed = Number.isFinite(cseed) ? cseed : -1;
    settings.comfy.layers.composition = getVal('xuanshu-set-l-composition');
    settings.comfy.layers.expression = getVal('xuanshu-set-l-expression');
    settings.comfy.layers.appearanceDefault = getVal('xuanshu-set-l-appearance');
    settings.comfy.layers.outfit = getVal('xuanshu-set-l-outfit');
    settings.comfy.layers.pose = getVal('xuanshu-set-l-pose');
    settings.comfy.layers.lighting = getVal('xuanshu-set-l-lighting');
    settings.comfy.negative = getVal('xuanshu-set-neg');
    const hm = getVal('xuanshu-set-hubmode');
    settings.hubMode = ['off', 'worldbook', 'hub', 'full'].includes(hm) ? hm : 'full';
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
        if (sub === 'invite' || sub === 'new') {
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
            toastr.info(settings.deviceName + '频道成员：' + list);
            return '';
        }
        if (sub === 'target') {
            if (!text) { toastr.info('用法：/comm target 角色名'); return ''; }
            if (!getMember(text)) {
                toastr.warning(text + ' 不在频道里，请先 /comm invite ' + text);
                return '';
            }
            settings.currentTarget = text;
            save();
            syncTargetUI();
            renderLog();
            toastr.success('通讯对象已切换为 ' + text);
            return '';
        }
        if (sub === 'side') {
            if (!text) { toastr.info('用法：/comm side 消息内容'); return ''; }
            await sendSide(text);
            return '';
        }
        if (sub) {
            await sendLive(text ? sub + ' ' + text : sub);
            return '';
        }
        if (text) {
            await sendLive(text);
            return '';
        }
        toastr.info(settings.deviceName + '：/comm 消息 | side 消息 | target 名 | invite 名 | kick 名 | members | reply | open | close');
    } catch (err) {
        console.error('[玄枢]', err);
        toastr.error(settings.deviceName + '出错了：' + (err?.message ?? err));
    }
    return '';
}

/* ---------------- 启动 ---------------- */

function init() {
    ensureUI();
    refreshChatStyle();
    setupHeartbeat();
    registerSlashCommand('comm', commCallback, ['xlink', '玄枢'], settings.deviceName + '通讯器：/comm 消息 | side 消息 | target 名 | invite 名 | kick 名 | members | reply | open | close');
}

jQuery(async () => {
    init();
    console.log('[玄枢通讯器] 已启动。主人，随时可以使用通讯器了。');
});
