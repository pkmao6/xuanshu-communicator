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
            qualityPrefix: 'masterpiece, best quality',
            composition: 'solo, full body, looking at viewer',
            expression: 'alluring gaze, smirk',
            outfitDefault: 'black micro bikini, covered puffy nipples, areolas slip, bodystocking, black stiletto heels',
            pose: 'contrapposto, hand on hip',
            lighting: 'soft lighting, rim light, cinematic lighting, moonlight',
            suffix: '',
        },
        negative: 'lowres, bad anatomy, bad hands, extra fingers, blurry, jpeg artifacts, watermark, text',
    },
    hubMode: 'full',
    autoReplyLive: true,
    heartbeatOn: false,
    heartbeatMin: 30,
    genPref: { preset: 'default', theme: 'default', size: 'default', extraPrompt: '' },
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
settings.genPref = Object.assign(structuredClone(defaultSettings.genPref), settings.genPref ?? {});

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
delete settings.comfy.layers.appearanceDefault;
if (settings.comfy.layers.outfit !== undefined) {
    settings.comfy.layers.outfitDefault = settings.comfy.layers.outfitDefault ?? settings.comfy.layers.outfit;
    delete settings.comfy.layers.outfit;
}
if (!settings.comfy.negative) settings.comfy.negative = defaultSettings.comfy.negative;
for (const m of settings.members) {
    m.profile = m.profile ?? m.personaExtra ?? '';
    if (typeof m.appearance === 'string') {
        m.appearance = m.appearance.trim() ? { other: m.appearance } : {};
    }
    m.appearance = Object.assign({ face: '', hair: '', eyes: '', body: '', bust: '', outfit: '', features: '', other: '' }, m.appearance ?? {});
    delete m.appearance.pose;
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
let genState = { preset: 'default', theme: 'default', size: 'default' };
let tagEditId = null;
let galleryBatchMode = null;
let galleryBatchSet = new Set();
let galleryFilterEmotion = 'all';
let galleryFilterNsfw = 'all';

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
    const pool = g.filter((x) => x.inRandom);
    if (pool.length >= 2) {
        return pool[Math.floor(Math.random() * pool.length)].dataUrl;
    }
    const p = g.find((x) => x.isPortrait) ?? g[0];
    return p?.dataUrl ?? '';
}

function addGalleryImage(name, { dataUrl, prompt, negative }) {
    const g = getGallery(name);
    const entry = { id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), dataUrl, prompt: prompt ?? '', negative: negative ?? '', emotion: '', nsfw: undefined, createdAt: Date.now(), isPortrait: g.length === 0, inRandom: false };
    g.push(entry);
    saveGallery(name, g);
    return entry;
}

function updateGalleryImage(name, id, patch) {
    const g = getGallery(name);
    const e = g.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    saveGallery(name, g);
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

/* ---------------- ComfyUI 辅助：错误透传 + 模型自动校准 ---------------- */

async function comfyErrorDetail(resp) {
    try {
        const j = await resp.json();
        const parts = [];
        if (j?.error) {
            const m = j.error.message ?? '';
            const t = j.error.type ?? '';
            parts.push(String(m || t || JSON.stringify(j.error)).slice(0, 400));
        }
        if (j?.node_errors && typeof j.node_errors === 'object') {
            for (const [nid, ne] of Object.entries(j.node_errors)) {
                const em = ne?.errors?.[0]?.message ?? JSON.stringify(ne);
                parts.push('节点 ' + nid + '：' + String(em).slice(0, 300));
            }
        }
        if (!parts.length) parts.push(JSON.stringify(j).slice(0, 500));
        return parts.join('；');
    } catch {
        const text = await resp.text().catch(() => '');
        return text.slice(0, 500) || '（无响应内容）';
    }
}

async function autoFixWorkflowModels(wf, base) {
    // 工作流里 CheckpointLoaderSimple 的模型名若在本机不存在 → 自动替换为可用模型（如：默认模板的 model.safetensors）
    try {
        const ir = await fetch(base + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(10000) });
        if (!ir.ok) return;
        const info = await ir.json();
        const list = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        const names = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
        if (!names.length) return;
        const pick = (bad) => {
            const lower = String(bad).toLowerCase();
            if (lower.includes('xl')) {
                const m = names.find((n) => n.toLowerCase().includes('xl'));
                if (m) return m;
            }
            if (lower.includes('flux')) {
                const m = names.find((n) => n.toLowerCase().includes('flux'));
                if (m) return m;
            }
            return names[0];
        };
        let replaced = false;
        const walk = (v) => {
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v && typeof v === 'object') {
                if (v.class_type === 'CheckpointLoaderSimple' && typeof v.inputs?.ckpt_name === 'string') {
                    const cur = v.inputs.ckpt_name;
                    if (cur && !names.includes(cur)) {
                        v.inputs.ckpt_name = pick(cur);
                        replaced = true;
                    }
                }
                for (const k of Object.keys(v)) walk(v[k]);
            }
        };
        walk(wf);
        if (replaced) {
            console.log('[玄枢] 已自动校准 ComfyUI 模型：', wf['4']?.inputs?.ckpt_name ?? '');
        }
    } catch { /* 校准失败不阻塞，交由 ComfyUI 报错 */ }
}

/* ---------------- 分层提示词组装（正负词固定模板） ---------------- */

const APPEARANCE_FIELDS = [
    ['face', '面部特征'],
    ['hair', '发型发色'],
    ['eyes', '眼睛特征'],
    ['body', '体型身材'],
    ['bust', '胸臀特征'],
    ['outfit', '服装/饰品'],
    ['features', '特征/纹身'],
    ['other', '其他'],
];

// 按单个 tag 拆分并规范化（照搬色色灵感规则）
function splitTags(text, opts = {}) {
    return String(text ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => {
            // 表情/神态类标签禁止加权：剥离 (tag:1.2) 形式的权重
            if (opts.stripWeights) {
                const m = t.match(/^\((.+?):\d+(?:\.\d+)?\)$/);
                if (m) return m[1];
            }
            return t;
        });
}

const GEN_PRESETS = {
    default: null,                                  // 用模板构图层
    avatar: 'portrait, face focus, close-up',
    halfbody: 'upper body',
    fullbody: 'full body',
};

const GEN_THEMES = {
    default: '',
    cinematic: 'dynamic angle, action, motion blur',
    allure: 'seductive pose, alluring charm, bedroom eyes',
    nsfw: 'nsfw, nude, explicit',
    emotion: 'close-up, detailed face, emotional expression',
    fashion: 'fashion show, full body, outfit focus',
};

function assemblePrompt(member, opts = {}) {
    const L = settings.comfy?.layers ?? {};
    const a = member?.appearance ?? {};
    const outfit = String(a.outfit ?? '').trim() || String(L.outfitDefault ?? '').trim();
    const composition = GEN_PRESETS[opts.preset] ?? GEN_PRESETS.default ?? L.composition;
    const themeTags = splitTags(GEN_THEMES[opts.theme] ?? '');
    const extra = splitTags(opts.extraPrompt ?? '');
    const sections = [
        splitTags(L.qualityPrefix),                                  // 质量词固定前缀
        splitTags(composition ?? ''),                                // 构图（可被预设覆盖）
        splitTags(L.expression, { stripWeights: true }),             // 表情/神态（禁止加权）
        splitTags(a.face),
        splitTags(a.hair),
        splitTags(a.eyes),
        splitTags(a.body),                                           // 体型（保留括号权重）
        splitTags(a.bust),
        splitTags(outfit),
        splitTags(a.features),
        splitTags(a.other),
        splitTags(L.pose),
        splitTags(L.lighting),
        themeTags,                                                   // 主题
        extra,                                                       // 本次额外提示词
        splitTags(L.suffix),                                         // 固定后缀
    ];
    // 按单个 tag 去重（不区分大小写，保留首次出现顺序）
    const seen = new Set();
    const deduped = [];
    for (const tag of sections.flat()) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(tag);
    }
    return deduped.join(', ');
}

function genSizeFor(sizeKey) {
    const w = Number(settings.comfy.width) || 512;
    const h = Number(settings.comfy.height) || 768;
    if (sizeKey === 'portrait') return { width: Math.min(w, h), height: Math.max(w, h) };
    if (sizeKey === 'landscape') return { width: Math.max(w, h), height: Math.min(w, h) };
    if (sizeKey === 'square') { const s = Math.max(w, h); return { width: s, height: s }; }
    return { width: w, height: h };
}

function fixedNegative() {
    return String(settings.comfy?.negative ?? '').trim();
}

/* ---------------- ComfyUI：主人自己的工作流 ---------------- */

function buildComfyWorkflow(prompt, negative, size = null) {
    const raw = String(settings.comfy?.workflow ?? '').trim();
    if (!raw) throw new Error('请先在设置里粘贴 ComfyUI 工作流 JSON');
    let json;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error('ComfyUI 工作流 JSON 解析失败：' + err.message);
    }
    const seed = Number(settings.comfy.seed) >= 0 ? Number(settings.comfy.seed) : Math.floor(Math.random() * 1e12);
    const sz = size ?? { width: Number(settings.comfy.width) || 512, height: Number(settings.comfy.height) || 768 };
    const widthNum = Number(sz.width) || 512;
    const heightNum = Number(sz.height) || 768;
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

async function generateImage(name, prompt, negative, size = null) {
    const c = settings.comfy;
    const base = String(c.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('请先在设置里填写 ComfyUI 地址');
    const wf = buildComfyWorkflow(prompt, negative, size);
    await autoFixWorkflowModels(wf, base);
    let resp;
    try {
        resp = await fetch(base + '/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf }),
            signal: AbortSignal.timeout(30000),
        });
    } catch (err) {
        throw new Error('ComfyUI 连接失败：' + (err?.message ?? err) + '（请确认地址可达、已启动）');
    }
    if (!resp.ok) {
        throw new Error('ComfyUI 拒绝了工作流（HTTP ' + resp.status + '）：' + await comfyErrorDetail(resp));
    }
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
    settings.members.push({ name: trimmed, profile: String(profile ?? '').trim(), appearance: Object.assign({ hair: '', eyes: '', body: '', bust: '', outfit: '', features: '', pose: '', other: '' }, appearance && typeof appearance === 'object' ? appearance : {}), heartbeat: true, linkHub: true, log: [] });
    if (!settings.currentTarget) settings.currentTarget = trimmed;
    toastr.success(trimmed + ' 的档案已建立，已加入' + settings.deviceName + '频道');
    save();
    syncTargetUI();
    refreshRosterUI();
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
    refreshRosterUI();
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
        <div class="xuanshu-set-title">▍外貌 Tag 档案（本角色专属，立绘组装时取这里）</div>
        <div class="xuanshu-set-row"><label>发色/发型</label><input id="xuanshu-pe-ap-hair" type="text" /></div>
        <div class="xuanshu-set-row"><label>瞳色</label><input id="xuanshu-pe-ap-eyes" type="text" /></div>
        <div class="xuanshu-set-row"><label>体型/身材</label><input id="xuanshu-pe-ap-body" type="text" /></div>
        <div class="xuanshu-set-row"><label>胸臀特征</label><input id="xuanshu-pe-ap-bust" type="text" /></div>
        <div class="xuanshu-set-row"><label>服装/饰品</label><input id="xuanshu-pe-ap-outfit" type="text" /></div>
        <div class="xuanshu-set-row"><label>特征/纹身</label><input id="xuanshu-pe-ap-features" type="text" /></div>
        <div class="xuanshu-set-row"><label>姿势/神态</label><input id="xuanshu-pe-ap-pose" type="text" /></div>
        <div class="xuanshu-set-row"><label>其他</label><input id="xuanshu-pe-ap-other" type="text" /></div>
        <div class="xuanshu-set-row"><button id="xuanshu-pe-save" class="xuanshu-invite-btn">保存档案</button></div>`;
    ed.append($(html));
    const ta = document.getElementById('xuanshu-pe-profile');
    if (ta) ta.value = member.profile ?? '';
    for (const [key] of APPEARANCE_FIELDS) {
        const el = document.getElementById('xuanshu-pe-ap-' + key);
        if (el) el.value = member.appearance?.[key] ?? '';
    }
    $('#xuanshu-pe-save').on('click', () => {
        const v = String(document.getElementById('xuanshu-pe-profile')?.value ?? '').trim();
        member.profile = v;
        member.appearance = member.appearance ?? {};
        for (const [key] of APPEARANCE_FIELDS) {
            const el = document.getElementById('xuanshu-pe-ap-' + key);
            member.appearance[key] = String(el?.value ?? '').trim();
        }
        save();
        toastr.success(member.name + ' 的档案已保存');
    });
}

/* ---------------- 图库面板（照搬色色灵感立绘功能整体） ---------------- */

function galleryEmotions() {
    const g = getGallery(galleryMember ?? '');
    const set = new Set();
    for (const x of g) {
        const e = String(x.emotion ?? '').trim();
        if (e) set.add(e);
    }
    return [...set];
}

function openGallery(name) {
    const member = getMember(name);
    if (!$root || !member) return;
    galleryMember = name;
    galleryBatchMode = null;
    galleryBatchSet = new Set();
    galleryFilterEmotion = 'all';
    galleryFilterNsfw = 'all';
    $root.find('.xuanshu-settings-pop').hide();
    $('#xuanshu-gallery').show();
    $('#xuanshu-gallery-title').text('图库 · ' + name);
    renderGallery();
}

function closeGallery() {
    galleryMember = null;
    $('#xuanshu-gallery').hide();
    $('#xuanshu-generator').hide();
    $('#xuanshu-tag-edit').hide();
    closeLightbox();
}

function refreshGalleryBanner() {
    if (!galleryMember) return;
    const pool = getGallery(galleryMember).filter((x) => x.inRandom);
    $('#xuanshu-gal-random-banner').text(pool.length >= 2 ? ('⚄ 随机立绘已开启：每次刷新从 ' + pool.length + ' 张中随机展示') : '');
}

function renderGallery() {
    if (!galleryMember) return;
    const g = getGallery(galleryMember);
    const emo = document.getElementById('xuanshu-gal-filter-emotion');
    if (emo) {
        emo.innerHTML = '';
        emo.append(makeOption('全部', 'all'));
        for (const e of galleryEmotions()) emo.append(makeOption(e, e));
        emo.append(makeOption('其他（未标注）', 'untagged'));
        emo.value = galleryFilterEmotion;
    }
    const visible = g.filter((x) => {
        if (galleryFilterEmotion === 'untagged') {
            if (String(x.emotion ?? '').trim()) return false;
        } else if (galleryFilterEmotion !== 'all' && x.emotion !== galleryFilterEmotion) {
            return false;
        }
        if (galleryFilterNsfw === 'daily' && x.nsfw !== false) return false;
        if (galleryFilterNsfw === 'nsfw' && x.nsfw !== true) return false;
        if (galleryFilterNsfw === 'untagged' && x.nsfw !== undefined) return false;
        return true;
    });
    const grid = $('#xuanshu-gal-grid');
    grid.empty();
    if (!g.length) {
        grid.append($('<div class="xuanshu-set-note">还没有立绘，点右上「生成新立绘」开始</div>'));
    } else if (!visible.length) {
        grid.append($('<div class="xuanshu-set-note">没有符合筛选条件的立绘</div>'));
    }
    for (const img of visible) {
        const date = new Date(img.createdAt);
        const dateStr = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
        const emoTag = img.emotion
            ? '<span class="xuanshu-gal-tag xuanshu-gal-tag-emotion">' + escapeHtml(img.emotion) + '</span>'
            : '<span class="xuanshu-gal-tag xuanshu-gal-tag-muted">未标注</span>';
        const nsfwTag = img.nsfw === undefined ? '' : img.nsfw
            ? '<span class="xuanshu-gal-tag xuanshu-gal-tag-nsfw">瑟瑟</span>'
            : '<span class="xuanshu-gal-tag xuanshu-gal-tag-daily">日常</span>';
        const inBatch = galleryBatchMode && galleryBatchSet.has(img.id);
        const item = $(`<div class="xuanshu-gal-item${img.isPortrait ? ' is-portrait' : ''}${img.inRandom ? ' in-random' : ''}${inBatch ? ' batch-selected' : ''}" data-id="${img.id}" title="${escapeHtml(img.prompt).slice(0, 150)}">
            <img src="${img.dataUrl}" alt="" loading="lazy">
            <span class="xuanshu-gal-check">${inBatch ? '✓' : ''}</span>
            <div class="xuanshu-gal-actions">
                <span data-act="pick" title="设为立绘">★</span>
                <span data-act="random" title="${img.inRandom ? '移出随机池' : '加入随机池'}">⚄</span>
                <span data-act="edit" title="编辑标签">✎</span>
                <span data-act="del" title="删除">×</span>
            </div>
            <div class="xuanshu-gal-meta">${emoTag}${nsfwTag}<span class="xuanshu-gal-date">${dateStr}</span></div>
        </div>`);
        item.on('click', function (e) {
            if (galleryBatchMode) {
                if (galleryBatchSet.has(img.id)) galleryBatchSet.delete(img.id);
                else galleryBatchSet.add(img.id);
                renderGallery();
                return;
            }
            const act = $(e.target).closest('[data-act]').data('act');
            if (act === 'pick') {
                setPortraitImage(galleryMember, img.id);
                renderGallery();
                syncTargetUI();
                refreshRosterUI();
                return;
            }
            if (act === 'random') {
                updateGalleryImage(galleryMember, img.id, { inRandom: !img.inRandom });
                renderGallery();
                return;
            }
            if (act === 'edit') {
                openTagEdit(img.id);
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
    const bar = document.getElementById('xuanshu-gal-batch-bar');
    if (bar) {
        bar.style.display = galleryBatchMode ? '' : 'none';
        const cnt = document.getElementById('xuanshu-gal-batch-count');
        if (cnt) cnt.textContent = '已选 ' + galleryBatchSet.size + ' 张';
    }
    refreshGalleryBanner();
}

function startBatch(mode) {
    if (!galleryMember || !getGallery(galleryMember).length) return;
    galleryBatchMode = mode;
    galleryBatchSet = new Set();
    renderGallery();
}

async function execBatch() {
    if (!galleryBatchMode || !galleryBatchSet.size) return;
    const name = galleryMember;
    if (galleryBatchMode === 'delete') {
        const ok = await callGenericPopup('删除选中的 ' + galleryBatchSet.size + ' 张立绘？', POPUP_TYPE.CONFIRM);
        if (!ok) return;
        const rest = getGallery(name).filter((x) => !galleryBatchSet.has(x.id));
        if (rest.length && !rest.some((x) => x.isPortrait)) rest[rest.length - 1].isPortrait = true;
        saveGallery(name, rest);
        toastr.success('已删除 ' + galleryBatchSet.size + ' 张');
    } else {
        let n = 0;
        for (const img of getGallery(name).filter((x) => galleryBatchSet.has(x.id))) {
            const a = document.createElement('a');
            a.href = img.dataUrl;
            a.download = 'xuanshu-' + name + '-' + Date.now() + '-' + (n++) + '.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
        toastr.success('已导出 ' + galleryBatchSet.size + ' 张');
    }
    galleryBatchMode = null;
    galleryBatchSet = new Set();
    renderGallery();
    syncTargetUI();
    refreshRosterUI();
}

/* ---------------- 标签编辑 ---------------- */

function openTagEdit(id) {
    const img = getGallery(galleryMember ?? '').find((x) => x.id === id);
    if (!img) return;
    tagEditId = id;
    $('#xuanshu-gallery').hide();
    $('#xuanshu-tag-edit').show();
    const emo = document.getElementById('xuanshu-tag-emotion');
    const nsfw = document.getElementById('xuanshu-tag-nsfw');
    if (emo) {
        if (img.emotion && ![...emo.options].some((o) => o.value === img.emotion)) emo.append(makeOption(img.emotion, img.emotion));
        emo.value = img.emotion || '';
    }
    if (nsfw) nsfw.value = img.nsfw === true ? 'nsfw' : img.nsfw === false ? 'daily' : 'untagged';
    const tp = document.getElementById('xuanshu-tag-prompt');
    if (tp) tp.value = img.prompt ?? '';
}

/* ---------------- 生成表单（照搬色色灵感生成立绘整体） ---------------- */

function openGenerator(name) {
    const member = getMember(name);
    if (!$root || !member) return;
    galleryMember = name;
    $('#xuanshu-gallery').hide();
    $('#xuanshu-tag-edit').hide();
    $('#xuanshu-generator').show();
    $('#xuanshu-generator-title').text('为「' + name + '」生成立绘');
    const pref = settings.genPref ?? {};
    genState = { preset: pref.preset || 'default', theme: pref.theme || 'default', size: pref.size || 'default' };
    renderGeneratorPresets();
    const extra = document.getElementById('xuanshu-gen-extra');
    if (extra) extra.value = pref.extraPrompt ?? '';
    renderGeneratorTags(member);
    refreshGenPrompt(true);
}

function renderGeneratorPresets() {
    const mark = (id, attr, key) => {
        const row = document.getElementById(id);
        if (!row) return;
        row.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset[attr] === genState[key]));
    };
    mark('xuanshu-gen-presets', 'preset', 'preset');
    mark('xuanshu-gen-themes', 'theme', 'theme');
    mark('xuanshu-gen-sizes', 'size', 'size');
}

function renderGeneratorTags(member) {
    const holder = document.getElementById('xuanshu-gen-tags');
    if (!holder) return;
    holder.innerHTML = '';
    for (const [key, label] of APPEARANCE_FIELDS) {
        const row = document.createElement('div');
        row.className = 'xuanshu-set-row';
        row.innerHTML = '<label>' + label + '</label><input id="xuanshu-gen-ap-' + key + '" type="text" />';
        holder.appendChild(row);
        const inp = document.getElementById('xuanshu-gen-ap-' + key);
        if (inp) inp.value = member.appearance?.[key] ?? '';
    }
}

function collectGenTags() {
    const member = getMember(galleryMember ?? '');
    if (!member) return;
    member.appearance = member.appearance ?? {};
    for (const [key] of APPEARANCE_FIELDS) {
        const inp = document.getElementById('xuanshu-gen-ap-' + key);
        if (inp) member.appearance[key] = String(inp.value ?? '').trim();
    }
}

function currentGenOptions() {
    return {
        preset: genState.preset,
        theme: genState.theme,
        size: genState.size,
        extraPrompt: String(document.getElementById('xuanshu-gen-extra')?.value ?? '').trim(),
    };
}

function refreshGenPrompt(useDraft = false) {
    const member = getMember(galleryMember ?? '');
    if (!member) return;
    const draft = getDraft(galleryMember);
    if (useDraft && draft.prompt) {
        $('#xuanshu-gen-prompt').val(draft.prompt);
    } else {
        $('#xuanshu-gen-prompt').val(assemblePrompt(member, currentGenOptions()));
    }
    $('#xuanshu-gen-neg').val(useDraft && draft.negative ? draft.negative : fixedNegative());
}

async function runGen() {
    if (!galleryMember) return;
    const prompt = String($('#xuanshu-gen-prompt').val() ?? '').trim();
    if (!prompt) {
        toastr.info('生图内容为空');
        return;
    }
    const negative = String($('#xuanshu-gen-neg').val() ?? '').trim();
    const size = genSizeFor(genState.size);
    const status = $('#xuanshu-gen-status');
    status.text('▌正在生成……（约 10 秒到数分钟，请保持页面开启）');
    try {
        const dataUrl = await generateImage(galleryMember, prompt, negative, size);
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
            <button class="xuanshu-lb-regen" title="把生图内容载入生成表单">↻ 重新生图</button>
            <button class="xuanshu-lb-edit" title="编辑标签">✎ 标签</button>
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
          <div class="xuanshu-set-row"><button id="xuanshu-invite-btn" class="xuanshu-invite-btn">建立档案并加入频道</button></div>
          <div class="xuanshu-set-note">每个角色有独立的外貌 tag 档案（发色/瞳色/体型……）——建好档案后点成员行的「档案」按钮编辑。</div>
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
          <div class="xuanshu-set-row"><label>服装层</label><input id="xuanshu-set-l-outfit" type="text" /></div>
          <div class="xuanshu-set-row"><label>姿势层</label><input id="xuanshu-set-l-pose" type="text" /></div>
          <div class="xuanshu-set-row"><label>光影层</label><input id="xuanshu-set-l-lighting" type="text" /></div>
          <div class="xuanshu-set-row"><label>负面提示词</label><textarea id="xuanshu-set-neg" rows="2"></textarea></div>
          <div class="xuanshu-set-note">组装顺序：构图 → 表情 → 角色外貌（每个角色自己的外貌 Tag 档案，在成员「档案」里编辑） → 服装 → 姿势 → 光影。图库面板里的提示词会自动按此组装，可微调。</div>
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
          <div class="xuanshu-gal-head">
            <span class="xuanshu-set-title" id="xuanshu-gallery-title">图库</span>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-batch-del" title="勾选多张后执行删除">批量删除</button>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-batch-export" title="勾选多张后执行导出">批量导出</button>
            <button class="xuanshu-gal-btn xuanshu-gal-primary" id="xuanshu-gal-gen-open">生成新立绘</button>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-import-btn">导入本地图片</button>
            <input type="file" id="xuanshu-gal-upload" accept="image/*" multiple style="display:none" />
            <button class="xuanshu-btn xuanshu-gal-close" title="关闭">×</button>
          </div>
          <div class="xuanshu-gal-hint">点 ★ 设为立绘；点 ⚄ 加入随机池（≥2 张后每次刷新随机展示）</div>
          <div class="xuanshu-gal-random-banner" id="xuanshu-gal-random-banner"></div>
          <div class="xuanshu-gal-filters">
            <label>情绪 <select id="xuanshu-gal-filter-emotion"></select></label>
            <label>场景 <select id="xuanshu-gal-filter-nsfw">
              <option value="all">全部</option>
              <option value="daily">日常</option>
              <option value="nsfw">瑟瑟</option>
              <option value="untagged">未标注</option>
            </select></label>
          </div>
          <div id="xuanshu-gal-grid"></div>
          <div class="xuanshu-gal-batch-toolbar" id="xuanshu-gal-batch-bar" style="display:none">
            <span id="xuanshu-gal-batch-count">已选 0 张</span>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-batch-all">全选可见</button>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-batch-clear">清空</button>
            <span style="flex:1"></span>
            <button class="xuanshu-gal-btn xuanshu-gal-danger" id="xuanshu-gal-batch-exec">执行</button>
            <button class="xuanshu-gal-btn" id="xuanshu-gal-batch-cancel">取消</button>
          </div>
        </div>
        <div id="xuanshu-generator" class="xuanshu-settings-pop" style="display:none">
          <div class="xuanshu-gal-head">
            <span class="xuanshu-set-title" id="xuanshu-generator-title">生成立绘</span>
            <button class="xuanshu-btn xuanshu-generator-close" title="关闭">×</button>
          </div>
          <div class="xuanshu-set-title">▍构图预设</div>
          <div class="xuanshu-gen-preset-row" id="xuanshu-gen-presets">
            <button data-preset="default">默认</button><button data-preset="avatar">头像</button><button data-preset="halfbody">半身像</button><button data-preset="fullbody">全身像</button>
          </div>
          <div class="xuanshu-set-title">▍主题</div>
          <div class="xuanshu-gen-preset-row" id="xuanshu-gen-themes">
            <button data-theme="default">立绘</button><button data-theme="cinematic">精彩瞬间</button><button data-theme="allure">角色魅力</button><button data-theme="nsfw">NSFW情节</button><button data-theme="emotion">情绪特写</button><button data-theme="fashion">服装展示</button>
          </div>
          <div class="xuanshu-set-title">▍尺寸</div>
          <div class="xuanshu-gen-preset-row" id="xuanshu-gen-sizes">
            <button data-size="default">默认</button><button data-size="portrait">竖版</button><button data-size="landscape">横版</button><button data-size="square">方形</button>
          </div>
          <div class="xuanshu-set-title">▍本次额外提示词（可选）</div>
          <div class="xuanshu-set-row"><textarea id="xuanshu-gen-extra" rows="2" placeholder="例如：手持折扇，背景樱花，微笑"></textarea></div>
          <div class="xuanshu-set-title">▍人物 Tag（外貌/身材一致性锚点） <button class="xuanshu-gal-btn" id="xuanshu-gen-tag-edit">编辑 Tag</button></div>
          <div id="xuanshu-gen-tags" style="display:none"></div>
          <div class="xuanshu-set-title">▍生图内容（可编辑；点「重新生图」直接使用此处内容）</div>
          <div class="xuanshu-set-row"><textarea id="xuanshu-gen-prompt" rows="4" spellcheck="false"></textarea></div>
          <div class="xuanshu-set-title">▍负面提示词</div>
          <div class="xuanshu-set-row"><textarea id="xuanshu-gen-neg" rows="2" spellcheck="false"></textarea></div>
          <div class="xuanshu-gen-btns">
            <button class="xuanshu-invite-btn" id="xuanshu-gen-start">开始生成</button>
            <button class="xuanshu-invite-btn" id="xuanshu-gen-regen">重新生图</button>
            <button class="xuanshu-invite-btn" id="xuanshu-gen-save-pref">保存为偏好</button>
            <button class="xuanshu-invite-btn" id="xuanshu-gen-cancel">取消</button>
          </div>
          <div id="xuanshu-gen-status" class="xuanshu-set-note"></div>
        </div>
        <div id="xuanshu-tag-edit" class="xuanshu-settings-pop" style="display:none">
          <div class="xuanshu-gal-head">
            <span class="xuanshu-set-title">编辑标签</span>
            <button class="xuanshu-btn xuanshu-tag-edit-close" title="关闭">×</button>
          </div>
          <div class="xuanshu-set-row"><label>情绪</label><select id="xuanshu-tag-emotion">
            <option value="">未标注</option>
            <option>开心</option><option>害羞</option><option>诱惑</option><option>得意</option><option>惊讶</option><option>委屈</option><option>慵懒</option><option>兴奋</option>
          </select></div>
          <div class="xuanshu-set-row"><label>场景</label><select id="xuanshu-tag-nsfw">
            <option value="untagged">未标注</option>
            <option value="daily">日常</option>
            <option value="nsfw">瑟瑟</option>
          </select></div>
          <div class="xuanshu-set-row"><label>提示词</label><textarea id="xuanshu-tag-prompt" rows="3"></textarea></div>
          <div class="xuanshu-gen-btns">
            <button class="xuanshu-invite-btn" id="xuanshu-tag-save">保存</button>
            <button class="xuanshu-invite-btn" id="xuanshu-tag-cancel">取消</button>
          </div>
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
        if (!name) {
            toastr.info('请先填写故事角色的名字');
            return;
        }
        inviteMember(name, profile);
        if (document.getElementById('xuanshu-new-name')) document.getElementById('xuanshu-new-name').value = '';
        if (document.getElementById('xuanshu-new-profile')) document.getElementById('xuanshu-new-profile').value = '';
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
    // 图库面板（照搬色色灵感立绘功能整体）
    $root.find('.xuanshu-gal-close').on('click', () => closeGallery());
    $('#xuanshu-gal-import-btn').on('click', () => $('#xuanshu-gal-upload').trigger('click'));
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
    $('#xuanshu-gal-gen-open').on('click', () => openGenerator(galleryMember));
    $('#xuanshu-gal-filter-emotion').on('change', function () {
        galleryFilterEmotion = this.value;
        renderGallery();
    });
    $('#xuanshu-gal-filter-nsfw').on('change', function () {
        galleryFilterNsfw = this.value;
        renderGallery();
    });
    $('#xuanshu-gal-batch-del').on('click', () => startBatch('delete'));
    $('#xuanshu-gal-batch-export').on('click', () => startBatch('export'));
    $('#xuanshu-gal-batch-all').on('click', () => {
        for (const img of getGallery(galleryMember ?? '')) galleryBatchSet.add(img.id);
        renderGallery();
    });
    $('#xuanshu-gal-batch-clear').on('click', () => {
        galleryBatchSet.clear();
        renderGallery();
    });
    $('#xuanshu-gal-batch-exec').on('click', () => execBatch());
    $('#xuanshu-gal-batch-cancel').on('click', () => {
        galleryBatchMode = null;
        galleryBatchSet.clear();
        renderGallery();
    });
    // 生成表单
    $root.find('.xuanshu-generator-close').on('click', () => {
        $('#xuanshu-generator').hide();
        $('#xuanshu-gallery').show();
        renderGallery();
    });
    $('#xuanshu-gen-presets button').on('click', function () {
        genState.preset = this.dataset.preset;
        renderGeneratorPresets();
        refreshGenPrompt();
    });
    $('#xuanshu-gen-themes button').on('click', function () {
        genState.theme = this.dataset.theme;
        renderGeneratorPresets();
        refreshGenPrompt();
    });
    $('#xuanshu-gen-sizes button').on('click', function () {
        genState.size = this.dataset.size;
        renderGeneratorPresets();
    });
    $('#xuanshu-gen-extra').on('input', () => refreshGenPrompt());
    $('#xuanshu-gen-tag-edit').on('click', () => {
        const holder = document.getElementById('xuanshu-gen-tags');
        if (holder) holder.style.display = holder.style.display === 'none' ? '' : 'none';
    });
    $('#xuanshu-gen-tags').on('input', function (e) {
        const key = String(e.target?.id ?? '').replace('xuanshu-gen-ap-', '');
        const member = getMember(galleryMember ?? '');
        if (member && key && member.appearance) {
            member.appearance[key] = String(e.target.value ?? '').trim();
            refreshGenPrompt();
        }
    });
    $('#xuanshu-gen-start').on('click', async () => {
        collectGenTags();
        save();
        refreshGenPrompt();
        await runGen();
    });
    $('#xuanshu-gen-regen').on('click', () => runGen());
    $('#xuanshu-gen-save-pref').on('click', () => {
        settings.genPref = Object.assign({}, genState, { extraPrompt: String(document.getElementById('xuanshu-gen-extra')?.value ?? '').trim() });
        save();
        toastr.success('已保存为生图偏好');
    });
    $('#xuanshu-gen-cancel').on('click', () => {
        $('#xuanshu-generator').hide();
        $('#xuanshu-gallery').show();
        renderGallery();
    });
    // 标签编辑
    $root.find('.xuanshu-tag-edit-close').on('click', () => {
        $('#xuanshu-tag-edit').hide();
        $('#xuanshu-gallery').show();
        renderGallery();
    });
    $('#xuanshu-tag-save').on('click', () => {
        if (!tagEditId) return;
        const emo = document.getElementById('xuanshu-tag-emotion');
        const nsfw = document.getElementById('xuanshu-tag-nsfw');
        const tp = document.getElementById('xuanshu-tag-prompt');
        updateGalleryImage(galleryMember, tagEditId, {
            emotion: String(emo?.value ?? '').trim(),
            nsfw: nsfw?.value === 'nsfw' ? true : nsfw?.value === 'daily' ? false : undefined,
            prompt: String(tp?.value ?? '').trim(),
        });
        toastr.success('标签已保存');
        $('#xuanshu-tag-edit').hide();
        $('#xuanshu-gallery').show();
        renderGallery();
    });
    $('#xuanshu-tag-cancel').on('click', () => {
        $('#xuanshu-tag-edit').hide();
        $('#xuanshu-gallery').show();
        renderGallery();
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
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-regen', () => {
        if (!lbState) return;
        const cur = lbState.entries[lbState.index];
        const name = lbState.name;
        closeLightbox();
        openGenerator(name);
        $('#xuanshu-gen-prompt').val(cur.prompt ?? '');
        $('#xuanshu-gen-neg').val(cur.negative ?? fixedNegative());
        $('#xuanshu-gen-status').text('已载入该图生图内容——修改后点「重新生图」');
    });
    $('#xuanshu-lightbox').on('click', '.xuanshu-lb-edit', () => {
        if (!lbState) return;
        const cur = lbState.entries[lbState.index];
        const name = lbState.name;
        closeLightbox();
        openGallery(name);
        openTagEdit(cur.id);
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
