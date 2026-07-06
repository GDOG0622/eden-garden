/**
 * 伊甸园状态面板 — SillyTavern Extension
 *
 * 功能：
 * - 为角色注册生理信息（种族/年龄/身高/体重/三围/月经周期等）
 * - 每次AI回复后，调用独立配置的API，根据聊天记录更新状态
 * - 将状态以 <伊甸园> 块的格式写入世界书条目（位于作者注释之后）
 * - 在扩展面板中以可编辑表格显示当前状态，支持多角色翻页
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    callPopup,
    getRequestHeaders,
} from '../../../../script.js';
import { world_names } from '../../../world-info.js';

// ============================
//  常量与默认值
// ============================

const EXT_NAME = 'eden-garden';
const LOG = '[EdenGarden]';

/** 状态字段顺序（与原 <伊甸园> 格式一致） */
const STATUS_FIELDS = [
    '阶段', '种族', '年龄', '身高', '体重', '三围',
    '乳房', '小穴', '子宫', '后庭', '特质',
    '精子', '卵子', '胎数', '父亲', '健康',
];

const defaultSettings = {
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    autoUpdate: true,
    worldbook: '',
    characters: [],
    activeCharIndex: 0,
};

// ============================
//  Settings helpers
// ============================

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(defaultSettings);
    }
    return extension_settings[EXT_NAME];
}

function ensureDefaults() {
    const s = getSettings();
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
}

// ============================
//  伊甸园 block 解析 / 构建
// ============================

/**
 * 从文本中解析 <伊甸园> 块，返回 { datetime, fields } 或 null
 */
function parseEdenBlock(text) {
    if (!text) return null;
    const match = text.match(/<伊甸园>([\s\S]*?)<\/伊甸园>/);
    if (!match) return null;

    const lines = match[1].split('\n').map(l => l.trim()).filter(Boolean);
    const result = { datetime: '', fields: {} };

    for (const line of lines) {
        const pipeIdx = line.indexOf('|');
        if (pipeIdx > 0) {
            const key = line.substring(0, pipeIdx).trim();
            const val = line.substring(pipeIdx + 1).trim();
            if (STATUS_FIELDS.includes(key)) {
                result.fields[key] = val;
            }
        } else if (/\d{4}-\d{2}-\d{2}/.test(line)) {
            result.datetime = line;
        }
    }
    return result;
}

/**
 * 从角色对象构建用于写入世界书的状态文本
 * 格式：供AI阅读的上下文注入，不含"请生成"指令
 */
function buildWIContent(char) {
    const s = char.status || {};
    const dt = s.datetime || '';

    const lines = [
        `[${char.name} 当前生理状态 | 角色不知情，仅供AI参考]`,
        dt ? `更新时间：${dt}` : '',
        ...STATUS_FIELDS.map(f => `${f}：${s[f] || '未知'}`),
    ].filter(Boolean);

    return lines.join('\n');
}

// ============================
//  世界书操作（直接调用 REST API，绕过 ST 缓存层）
// ============================

/** 计算世界书中空闲的 UID */
function getFreeUid(entries) {
    const nums = Object.keys(entries).map(Number).filter(n => !isNaN(n));
    return nums.length ? Math.max(...nums) + 1 : 0;
}

/** 从服务器加载世界书数据 */
async function fetchWorldInfo(name) {
    const resp = await fetch('/api/worldinfo/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
    });
    if (!resp.ok) throw new Error(`读取世界书失败: HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.entries) data.entries = {};
    return data;
}

/** 将世界书数据保存到服务器 */
async function pushWorldInfo(name, data) {
    const resp = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data }),
    });
    if (!resp.ok) throw new Error(`保存世界书失败: HTTP ${resp.status}`);
}

/**
 * 在世界书中创建或更新角色对应的条目
 */
async function syncCharacterWIEntry(char) {
    const wb = getSettings().worldbook;
    if (!wb) {
        toastr.warning('请先在扩展设置中选择目标世界书', '伊甸园');
        return;
    }

    try {
        const data = await fetchWorldInfo(wb);
        const content = buildWIContent(char);

        if (char.wiUid != null && data.entries[char.wiUid] !== undefined) {
            // 更新已有条目
            data.entries[char.wiUid].content = content;
            data.entries[char.wiUid].disable = false;
        } else {
            // 新建条目，手动构建完整的 entry 对象
            const uid = getFreeUid(data.entries);
            data.entries[uid] = {
                uid,
                key: [], keysecondary: [],
                comment:   `伊甸园-${char.name}`,
                content,
                constant:  true,
                vectorized: false,
                selective: true,
                selectiveLogic: 0,
                addMemo:   true,
                order:     9998,
                position:  3,      // ANBottom：作者注释之后
                disable:   false,
                excludeRecursion: false,
                preventRecursion: false,
                delayUntilRecursion: false,
                probability: 100,
                useProbability: true,
                depth:     4,
                group: '', groupOverride: false, groupWeight: 100,
                scanDepth: null, caseSensitive: null,
                matchWholeWords: null, useGroupScoring: null,
                automationId: '', role: 0,
                sticky: 0, cooldown: 0, delay: 0,
            };
            char.wiUid = uid;
            saveSettingsDebounced();
        }

        await pushWorldInfo(wb, data);
        console.log(`${LOG} 世界书条目已同步: ${char.name} (uid=${char.wiUid})`);

    } catch (e) {
        console.error(`${LOG} 同步世界书条目失败:`, e);
        toastr.error(`同步失败: ${e.message}`, '伊甸园');
    }
}

/**
 * 删除角色在世界书中的条目
 */
async function deleteCharacterWIEntry(char) {
    const wb = getSettings().worldbook;
    if (!wb || char.wiUid == null) return;
    try {
        const data = await fetchWorldInfo(wb);
        if (data.entries[char.wiUid] === undefined) return;
        delete data.entries[char.wiUid];
        await pushWorldInfo(wb, data);
        console.log(`${LOG} 已删除世界书条目: ${char.name}`);
    } catch (e) {
        console.error(`${LOG} 删除世界书条目失败:`, e);
    }
}

// ============================
//  独立 API 调用
// ============================

/**
 * 根据聊天记录调用独立API更新角色状态
 * @returns {string|null} 返回 AI 的原始响应文本，失败返回 null
 */
async function callStatusAPI(char) {
    const { apiUrl, apiKey, model } = getSettings();
    if (!apiKey || !model) {
        toastr.warning('请先在扩展设置中配置 API Key 和模型', '伊甸园');
        return null;
    }

    const context = getContext();
    const chat = context.chat || [];

    // 取最近 20 条非系统消息
    const recent = chat.slice(-20).filter(m => m.mes && !m.is_system);
    const chatHistory = recent.map(m =>
        `${m.is_user ? 'User' : (m.name || 'Assistant')}: ${m.mes}`
    ).join('\n\n');

    // 当前时间
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const datetime = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 构建当前状态文本
    const s = char.status || {};
    const currentStateLines = STATUS_FIELDS.map(f => `      ${f}|${s[f] || ''}`).join('\n');
    const currentState = `<伊甸园>\n      ${s.datetime || datetime}\n${currentStateLines}\n</伊甸园>`;

    const systemPrompt = SYSTEM_PROMPT;

    const userPrompt = buildUserPrompt({
        name:               char.name,
        race:               char.race               || '人类',
        age:                char.age                || '?',
        height:             char.height             || '?',
        weight:             char.weight             || '?',
        measurements:       char.measurements       || '?',
        cycleLength:        char.cycleLength        || '?',
        menstrualDuration:  char.menstrualDuration  || '?',
        symptoms:           char.symptoms           || '无',
        currentState,
        datetime,
        chatHistory:        chatHistory             || '（无对话记录）',
    });

    try {
        const base = apiUrl.replace(/\/$/, '');
        const resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt },
                ],
                max_tokens: 1200,
                temperature: 0.5,
            }),
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => resp.statusText);
            throw new Error(`HTTP ${resp.status}: ${errText}`);
        }

        const json = await resp.json();
        return json.choices?.[0]?.message?.content ?? null;

    } catch (err) {
        console.error(`${LOG} API 调用失败:`, err);
        toastr.error(`状态更新失败: ${err.message}`, '伊甸园');
        return null;
    }
}

// ============================
//  状态更新流程
// ============================

let isUpdating = false;

/**
 * 对指定角色发起状态更新（API调用 → 解析 → 写入WI → 刷新UI）
 */
async function updateCharacterStatus(charIndex) {
    const settings = getSettings();
    const char = settings.characters[charIndex];
    if (!char) return;

    const raw = await callStatusAPI(char);
    if (!raw) return;

    const parsed = parseEdenBlock(raw);
    if (!parsed) {
        console.warn(`${LOG} API 响应无法解析为伊甸园块:`, raw);
        toastr.warning('API 响应格式异常，无法解析', '伊甸园');
        return;
    }

    // 合并字段（保留未覆盖的旧值）
    if (!char.status) char.status = {};
    if (parsed.datetime) char.status.datetime = parsed.datetime;
    for (const field of STATUS_FIELDS) {
        if (parsed.fields[field] !== undefined) {
            char.status[field] = parsed.fields[field];
        }
    }

    saveSettingsDebounced();
    await syncCharacterWIEntry(char);
    renderStatusPanel();
    toastr.success(`${char.name} 状态已更新`, '伊甸园', { timeOut: 2000 });
}

/** AI 回复渲染后触发的自动更新 */
async function onCharacterMessageRendered() {
    if (isUpdating) return;
    const settings = getSettings();
    if (!settings.autoUpdate || !settings.characters.length) return;

    isUpdating = true;
    showUpdatingIndicator(true);
    try {
        for (let i = 0; i < settings.characters.length; i++) {
            if (!settings.characters[i].disabled) {
                await updateCharacterStatus(i);
            }
        }
    } finally {
        isUpdating = false;
        showUpdatingIndicator(false);
    }
}

// ============================
//  UI 渲染
// ============================

function showUpdatingIndicator(show) {
    const el = document.getElementById('eden-updating-indicator');
    if (el) el.style.display = show ? 'inline' : 'none';
}

/** 重新渲染整个扩展面板 */
function renderUI() {
    refreshWorldbookSelector();
    renderCharacterNav();
    renderStatusPanel();
    const s = getSettings();
    const autoChk = document.getElementById('eden-auto-update');
    if (autoChk) autoChk.checked = s.autoUpdate;
}

/** 更新世界书下拉列表 */
function refreshWorldbookSelector() {
    const select = document.getElementById('eden-worldbook-select');
    if (!select) return;
    const current = getSettings().worldbook;
    select.innerHTML = '<option value="">— 选择世界书 —</option>';
    for (const name of world_names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === current) opt.selected = true;
        select.appendChild(opt);
    }
}

/** 渲染角色导航栏 */
function renderCharacterNav() {
    const s = getSettings();
    const chars = s.characters;
    const idx = s.activeCharIndex;

    const nameEl  = document.getElementById('eden-char-name');
    const pageEl  = document.getElementById('eden-char-page');
    const prevBtn = document.getElementById('eden-prev-char');
    const nextBtn = document.getElementById('eden-next-char');
    if (!nameEl) return;

    if (chars.length === 0) {
        nameEl.textContent  = '无角色';
        pageEl.textContent  = '(0/0)';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
    } else {
        nameEl.textContent  = chars[idx].name;
        pageEl.textContent  = `(${idx + 1}/${chars.length})`;
        if (prevBtn) prevBtn.disabled = chars.length <= 1;
        if (nextBtn) nextBtn.disabled = chars.length <= 1;
    }
}

// 只在主表格中显示、需要可编辑的字段（AI 主要更新区域）
const EDITABLE_FIELDS = ['阶段', '乳房', '小穴', '子宫', '后庭', '特质', '精子', '卵子', '胎数', '父亲', '健康'];

/** 渲染状态表格 */
function renderStatusPanel() {
    const s = getSettings();
    const tbody = document.getElementById('eden-status-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!s.characters.length) {
        const row = tbody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 2;
        cell.style.cssText = 'text-align:center;padding:12px;opacity:0.5;';
        cell.textContent = '暂无角色，请点击 + 新建';
        return;
    }

    const char   = s.characters[s.activeCharIndex];
    const status = char.status || {};

    // ── 时间行 ──
    const dtRow  = tbody.insertRow();
    const dtCell = dtRow.insertCell();
    dtCell.colSpan = 2;
    dtCell.className = 'eden-datetime-row';
    dtCell.textContent = status.datetime || '（未更新）';

    // ── 紧凑信息行（种族/年龄/身高 · 体重/三围）──
    // 这 5 项直接取角色基本信息 + AI 更新的 status，不显示编辑按钮
    const infoRow  = tbody.insertRow();
    const infoCell = infoRow.insertCell();
    infoCell.colSpan = 2;
    infoCell.className = 'eden-info-strip';
    infoCell.innerHTML =
        `<span class="eden-info-item"><em>种族</em>${char.race || '—'}</span>` +
        `<span class="eden-info-item"><em>年龄</em>${char.age || '—'}岁</span>` +
        `<span class="eden-info-item"><em>身高</em>${char.height || '—'}</span>` +
        `<br>` +
        `<span class="eden-info-item"><em>体重</em>${status['体重'] || char.weight || '—'}</span>` +
        `<span class="eden-info-item"><em>三围</em>${status['三围'] || char.measurements || '—'}</span>`;

    // ── AI 可编辑字段行 ──
    for (const field of EDITABLE_FIELDS) {
        const row     = tbody.insertRow();
        const keyCell = row.insertCell();
        keyCell.className   = 'eden-field-key';
        keyCell.textContent = field;

        const valCell = row.insertCell();
        valCell.className   = 'eden-field-val';

        const value = status[field] ?? '';

        const displaySpan = document.createElement('span');
        displaySpan.className   = 'eden-field-display';
        displaySpan.textContent = value || '—';

        const editInput = document.createElement('textarea');
        editInput.className     = 'eden-field-edit text_pole';
        editInput.value         = value;
        editInput.rows          = 2;
        editInput.style.display = 'none';

        const editBtn = document.createElement('i');
        editBtn.className = 'eden-edit-btn fa-solid fa-pencil';
        editBtn.title     = '编辑';

        editBtn.addEventListener('click', async () => {
            const isEditing = editInput.style.display !== 'none';
            if (!isEditing) {
                displaySpan.style.display = 'none';
                editInput.style.display   = 'block';
                editInput.focus();
                editBtn.className = 'eden-edit-btn fa-solid fa-check';
                editBtn.title     = '保存';
            } else {
                const newVal = editInput.value;
                if (!char.status) char.status = {};
                char.status[field]        = newVal;
                displaySpan.textContent   = newVal || '—';
                displaySpan.style.display = '';
                editInput.style.display   = 'none';
                editBtn.className         = 'eden-edit-btn fa-solid fa-pencil';
                editBtn.title             = '编辑';
                saveSettingsDebounced();
                await syncCharacterWIEntry(char);
            }
        });

        valCell.appendChild(displaySpan);
        valCell.appendChild(editInput);
        valCell.appendChild(editBtn);
    }
}

// ============================
//  角色新建 / 编辑 表单
// ============================

// 所有角色基本信息字段 id（用于数据读取）
const CHAR_FIELD_IDS = ['name', 'race', 'age', 'height', 'weight', 'measurements', 'cycleLength', 'menstrualDuration', 'symptoms'];

function showCharacterForm(editIndex = -1) {
    const settings = getSettings();
    const isEdit   = editIndex >= 0;
    const src      = isEdit ? settings.characters[editIndex] : {};
    const v = id  => (src[id] ?? '').replace(/"/g, '&quot;');

    const overlay = document.createElement('div');
    overlay.className = 'eden-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'eden-modal';

    modal.innerHTML = `
        <div class="eden-modal-header">
            <b>${isEdit ? '编辑角色' : '新建角色'}</b>
            <i id="eden-modal-close" class="fa-solid fa-times menu_button" style="font-size:1em;"></i>
        </div>
        <div class="eden-modal-body">
            <!-- 行1：名字 · 种族 · 年龄 -->
            <div class="eden-form-trio">
                <input id="edf-name" type="text" class="text_pole" value="${v('name')}" placeholder="名字" />
                <input id="edf-race" type="text" class="text_pole" value="${v('race') || ''}" placeholder="种族（人类）" />
                <input id="edf-age"  type="text" class="text_pole" value="${v('age')  || ''}" placeholder="年龄（岁）" />
            </div>
            <!-- 行2：身高 · 体重 · 三围 -->
            <div class="eden-form-trio">
                <input id="edf-height"       type="text" class="text_pole" value="${v('height')       || ''}" placeholder="身高（cm）" />
                <input id="edf-weight"       type="text" class="text_pole" value="${v('weight')       || ''}" placeholder="体重（kg）" />
                <input id="edf-measurements" type="text" class="text_pole" value="${v('measurements') || ''}" placeholder="三围（胸/腰/臀）" />
            </div>
            <!-- 行3：月经周期 · 经期 -->
            <div class="eden-form-duo">
                <input id="edf-cycleLength"       type="text" class="text_pole" value="${v('cycleLength')       || ''}" placeholder="月经周期 C（天）" />
                <input id="edf-menstrualDuration" type="text" class="text_pole" value="${v('menstrualDuration') || ''}" placeholder="经期持续 M（天）" />
            </div>
            <!-- 行4：症状 -->
            <textarea id="edf-symptoms" class="text_pole" rows="2"
                placeholder="月经症状（如：痛经、腰痛、无）">${src.symptoms ?? ''}</textarea>
        </div>
        <div class="eden-modal-footer">
            <div id="eden-form-cancel" class="menu_button">取消</div>
            <div id="eden-form-save" class="menu_button menu_button_icon">
                <i class="fa-solid fa-save"></i><span>保存</span>
            </div>
        </div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    modal.querySelector('#eden-modal-close').addEventListener('click', close);
    modal.querySelector('#eden-form-cancel').addEventListener('click', close);

    modal.querySelector('#eden-form-save').addEventListener('click', async () => {
        const get = id => (document.getElementById(`edf-${id}`)?.value ?? '').trim();
        const newData = Object.fromEntries(CHAR_FIELD_IDS.map(id => [id, get(id)]));

        if (!newData.name) {
            toastr.warning('请输入角色名字', '伊甸园');
            return;
        }

        if (isEdit) {
            Object.assign(settings.characters[editIndex], newData);
            await syncCharacterWIEntry(settings.characters[editIndex]);
            toastr.success(`${newData.name} 已更新`, '伊甸园');
        } else {
            const charObj = { ...newData, status: {}, wiUid: null, disabled: false };
            settings.characters.push(charObj);
            settings.activeCharIndex = settings.characters.length - 1;
            await syncCharacterWIEntry(charObj);
            toastr.success(`${newData.name} 已创建`, '伊甸园');
        }

        saveSettingsDebounced();
        renderUI();
        close();
    });
}

// ============================
//  模型列表拉取
// ============================

/**
 * 从已配置的 API 拉取模型列表，填充到下拉选择框
 */
async function fetchModelList() {
    const { apiUrl, apiKey } = getSettings();
    const select = document.getElementById('eden-api-model');
    if (!select) return;

    const refreshBtn = document.getElementById('eden-fetch-models');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.querySelector('i')?.classList.add('fa-spin');
    }

    try {
        const resp = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const json = await resp.json();

        // 兼容 OpenAI 格式 { data: [{id, ...}] } 和部分返回数组的格式
        const list = Array.isArray(json) ? json : (json.data ?? []);
        const ids = list
            .map(m => m.id ?? m.name ?? String(m))
            .filter(Boolean)
            .sort();

        if (!ids.length) {
            toastr.warning('未获取到任何模型', '伊甸园');
            return;
        }

        const current = getSettings().model;
        select.innerHTML = '';
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            if (id === current) opt.selected = true;
            select.appendChild(opt);
        }

        // 如果当前设置的模型不在列表里，默认选第一个并保存
        if (!ids.includes(current)) {
            getSettings().model = ids[0];
            saveSettingsDebounced();
        }

        toastr.success(`已加载 ${ids.length} 个模型`, '伊甸园', { timeOut: 2000 });

    } catch (e) {
        console.error(`${LOG} 拉取模型列表失败:`, e);
        toastr.error(`拉取模型失败: ${e.message}`, '伊甸园');
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.querySelector('i')?.classList.remove('fa-spin');
        }
    }
}

// ============================
//  事件绑定
// ============================

function bindEvents() {
    // 世界书选择
    $(document).on('change', '#eden-worldbook-select', function () {
        getSettings().worldbook = this.value;
        saveSettingsDebounced();
    });

    // 翻页
    $(document).on('click', '#eden-prev-char', () => {
        const s = getSettings();
        if (s.characters.length <= 1) return;
        s.activeCharIndex = (s.activeCharIndex - 1 + s.characters.length) % s.characters.length;
        saveSettingsDebounced();
        renderCharacterNav();
        renderStatusPanel();
    });

    $(document).on('click', '#eden-next-char', () => {
        const s = getSettings();
        if (s.characters.length <= 1) return;
        s.activeCharIndex = (s.activeCharIndex + 1) % s.characters.length;
        saveSettingsDebounced();
        renderCharacterNav();
        renderStatusPanel();
    });

    // 新建 / 编辑 / 删除
    $(document).on('click', '#eden-add-char',  () => showCharacterForm());
    $(document).on('click', '#eden-edit-char', () => {
        const s = getSettings();
        if (!s.characters.length) return;
        showCharacterForm(s.activeCharIndex);
    });
    $(document).on('click', '#eden-delete-char', async () => {
        const s = getSettings();
        if (!s.characters.length) return;
        const char = s.characters[s.activeCharIndex];
        const confirmed = await callPopup(
            `确定删除角色 "<b>${char.name}</b>"？相关世界书条目也会被删除。`,
            'confirm'
        );
        if (!confirmed) return;
        await deleteCharacterWIEntry(char);
        s.characters.splice(s.activeCharIndex, 1);
        s.activeCharIndex = Math.max(0, s.activeCharIndex - 1);
        saveSettingsDebounced();
        renderUI();
        toastr.success(`${char.name} 已删除`, '伊甸园');
    });

    // 立即更新
    $(document).on('click', '#eden-update-now', async () => {
        if (isUpdating) return;
        const s = getSettings();
        if (!s.characters.length) { toastr.info('请先添加角色', '伊甸园'); return; }
        isUpdating = true;
        showUpdatingIndicator(true);
        try {
            await updateCharacterStatus(s.activeCharIndex);
        } finally {
            isUpdating = false;
            showUpdatingIndicator(false);
        }
    });

    // 自动更新开关
    $(document).on('change', '#eden-auto-update', function () {
        getSettings().autoUpdate = this.checked;
        saveSettingsDebounced();
    });

    // API 配置
    $(document).on('input', '#eden-api-url', function () { getSettings().apiUrl = this.value; saveSettingsDebounced(); });
    $(document).on('input', '#eden-api-key', function () { getSettings().apiKey = this.value; saveSettingsDebounced(); });

    // 模型下拉选择
    $(document).on('change', '#eden-api-model', function () {
        getSettings().model = this.value;
        saveSettingsDebounced();
    });

    // 拉取模型列表
    $(document).on('click', '#eden-fetch-models', async () => {
        await fetchModelList();
    });

    // 测试 API 连接（复用拉取模型）
    $(document).on('click', '#eden-api-test', async () => {
        await fetchModelList();
    });
}

// ============================
//  构建扩展面板 HTML
// ============================

function buildPanelHTML() {
    const s = getSettings();
    return /* html */`
<div id="eden-garden-container" class="extension_container">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <div class="flex-container alignitemscenter margin0">
        <b>🌿 伊甸园状态面板</b>
      </div>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <!-- 世界书选择 -->
      <div class="flex-container alignitemscenter" style="gap:8px;margin-bottom:6px;">
        <label style="white-space:nowrap;font-size:.88em;">目标世界书</label>
        <select id="eden-worldbook-select" class="text_pole" style="flex:1;min-width:0;"></select>
      </div>

      <hr style="margin:6px 0;">

      <!-- 角色导航 -->
      <div class="eden-nav-bar">
        <button id="eden-prev-char" class="menu_button eden-nav-btn" title="上一个角色">‹</button>
        <span id="eden-char-name" class="eden-char-label">无角色</span>
        <span id="eden-char-page" class="eden-char-page">(0/0)</span>
        <button id="eden-next-char" class="menu_button eden-nav-btn" title="下一个角色">›</button>
        <button id="eden-add-char"    class="menu_button" title="新建角色"><i class="fa-solid fa-plus"></i></button>
        <button id="eden-edit-char"   class="menu_button" title="编辑角色"><i class="fa-solid fa-pencil"></i></button>
        <button id="eden-delete-char" class="menu_button" title="删除角色"><i class="fa-solid fa-trash"></i></button>
      </div>

      <!-- 状态表格 -->
      <div class="eden-table-wrap">
        <table class="eden-status-table">
          <tbody id="eden-status-tbody"></tbody>
        </table>
      </div>

      <!-- 操作栏 -->
      <div class="flex-container alignitemscenter" style="gap:8px;margin-top:6px;flex-wrap:wrap;">
        <button id="eden-update-now" class="menu_button menu_button_icon">
          <i class="fa-solid fa-arrows-rotate"></i><span>立即更新</span>
        </button>
        <label class="checkbox_label" style="margin:0;" title="每次AI回复后自动更新状态">
          <input id="eden-auto-update" type="checkbox" ${s.autoUpdate ? 'checked' : ''}/>
          <span>自动更新</span>
        </label>
        <span id="eden-updating-indicator" style="display:none;font-size:.85em;opacity:.7;">
          <i class="fa-solid fa-spinner fa-spin"></i> 更新中…
        </span>
      </div>

      <hr style="margin:8px 0;">

      <!-- API 配置（折叠） -->
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header" style="padding:4px 0;">
          <span style="font-size:.9em;"><i class="fa-solid fa-gear"></i> API 配置</span>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="padding-top:6px;">
          <div class="eden-form-row">
            <label class="eden-form-label">API URL</label>
            <input id="eden-api-url" type="text" class="text_pole" value="${s.apiUrl}"
              placeholder="https://api.openai.com/v1"/>
          </div>
          <div class="eden-form-row">
            <label class="eden-form-label">API Key</label>
            <input id="eden-api-key" type="password" class="text_pole" value="${s.apiKey}"
              placeholder="sk-…"/>
          </div>
          <div class="eden-form-row">
            <label class="eden-form-label">模型</label>
            <div style="flex:1;display:flex;gap:4px;min-width:0;">
              <select id="eden-api-model" class="text_pole" style="flex:1;min-width:0;">
                <option value="${s.model}">${s.model || '（先拉取列表）'}</option>
              </select>
              <button id="eden-fetch-models" class="menu_button" title="拉取模型列表" style="flex:0 0 auto;">
                <i class="fa-solid fa-arrows-rotate"></i>
              </button>
            </div>
          </div>
          <button id="eden-api-test" class="menu_button menu_button_icon" style="width:100%;">
            <i class="fa-solid fa-plug"></i><span>测试连接 &amp; 拉取模型</span>
          </button>
        </div>
      </div>

    </div>
  </div>
</div>`;
}

// ============================
//  入口
// ============================

export async function init() {
    ensureDefaults();

    // 用函数封装，内部守卫防止重复注入
    function setupUI() {
        if (document.getElementById('eden-garden-container')) return;
        $('#extensions_settings2').append(buildPanelHTML());
        bindEvents();
        renderUI();
    }

    // APP_READY 时注入（正常启动路径）
    eventSource.on(event_types.APP_READY, setupUI);

    // APP_READY 已触发过时立即注入（热加载 / GitHub 安装后刷新）
    if ($('#extensions_settings2').length) {
        setupUI();
    }

    // 监听 AI 回复完成事件
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

    // 切换聊天时刷新世界书下拉列表
    eventSource.on(event_types.CHAT_CHANGED, () => refreshWorldbookSelector());

    console.log(`${LOG} 扩展已加载`);
}
