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
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    callPopup,
} from '../../../../script.js';
import {
    world_names,
    loadWorldInfo,
    saveWorldInfo,
    createWorldInfoEntry,
    world_info_position,
} from '../../../world-info.js';

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
//  世界书操作
// ============================

/**
 * 在世界书中创建或更新角色对应的条目
 */
async function syncCharacterWIEntry(char) {
    const wb = getSettings().worldbook;
    if (!wb) { console.warn(`${LOG} 未选择世界书`); return; }

    let data;
    try {
        data = await loadWorldInfo(wb);
    } catch (e) {
        console.error(`${LOG} 无法加载世界书:`, e);
        return;
    }
    if (!data) return;

    const content = buildWIContent(char);

    if (char.wiUid != null && data.entries[char.wiUid]) {
        // 更新已有条目
        data.entries[char.wiUid].content = content;
        data.entries[char.wiUid].disable = false;
    } else {
        // 新建条目
        const entry = createWorldInfoEntry(wb, data);
        if (!entry) { console.error(`${LOG} 无法创建世界书条目`); return; }

        entry.comment     = `伊甸园-${char.name}`;
        entry.content     = content;
        entry.constant    = true;
        entry.addMemo     = true;
        entry.position    = world_info_position.ANBottom; // 作者注释之后
        entry.order       = 9998;
        entry.disable     = false;
        entry.role        = 0;
        entry.depth       = 4;

        char.wiUid = entry.uid;
        saveSettingsDebounced();
    }

    await saveWorldInfo(wb, data, true);
    console.log(`${LOG} 世界书条目已同步: ${char.name} (uid=${char.wiUid})`);
}

/**
 * 删除角色在世界书中的条目
 */
async function deleteCharacterWIEntry(char) {
    const wb = getSettings().worldbook;
    if (!wb || char.wiUid == null) return;

    let data;
    try { data = await loadWorldInfo(wb); } catch { return; }
    if (!data || !data.entries[char.wiUid]) return;

    delete data.entries[char.wiUid];
    await saveWorldInfo(wb, data, true);
    console.log(`${LOG} 已删除世界书条目: ${char.name}`);
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
    const currentState = STATUS_FIELDS.map(f => `      ${f}|${s[f] || ''}`).join('\n');

    const systemPrompt =
`你是一个专业的角色生理状态追踪器。
任务：根据最新对话内容，更新角色的<伊甸园>状态面板。
规则：
1. 仅输出<伊甸园>...</伊甸园>块，不输出任何其他内容或解释。
2. 对话中没有明确提及的字段，保持原值不变（非孕未提及则写"N/A"）。
3. 根据时间和事件合理推断月经周期阶段，精子活性，卵子状态等。
4. 如有近亲关系，须在该前提下综合考量所有指标。`;

    const userPrompt =
`角色基本信息：
名字：${char.name}
种族：${char.race || '人类'}
年龄：${char.age || '?'}岁
身高：${char.height || '?'}
体重：${char.weight || '?'}
三围：${char.measurements || '?'}
月经周期（C）：${char.cycleLength || '?'}天（即多久来一次月经）
经期持续（M）：${char.menstrualDuration || '?'}天
月经症状：${char.symptoms || '无'}

当前状态（上次记录）：
<伊甸园>
      ${s.datetime || datetime}
${currentState}
</伊甸园>

当前时间：${datetime}

最近对话（从旧到新）：
${chatHistory || '（无对话记录）'}

请输出更新后的状态，格式如下（字段顺序和名称不可变动）：
<伊甸园>
      ${datetime}
      阶段|（月经/卵泡/排卵/黄体 或 孕X期 等，写明第几天/周）
      种族|
      年龄|
      身高|
      体重|
      三围|
      乳房|（解剖学描述形状及当前反应）
      小穴|（根据生理状态描述）
      子宫|（宫压+生理状态；孕期描述羊膜/羊水/胎儿；非孕时写孕率和子宫状态）
      后庭|（15字内；正常则写"正常"）
      特质|（身体非典型特征；孕期写妊娠症状）
      精子|（宫内总量/来源/活性；无则写"无"）
      卵子|（宫内卵子数；无则写"无"）
      胎数|（孕：胎数和性别；非孕：已产胎数，无则写"0"）
      父亲|（孕：生父名；非孕：N/A）
      健康|（孕：胎儿健康/孕检提醒；非孕：N/A）
</伊甸园>`;

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

    // 时间行
    const dtRow  = tbody.insertRow();
    const dtCell = dtRow.insertCell();
    dtCell.colSpan = 2;
    dtCell.className = 'eden-datetime-row';
    dtCell.textContent = status.datetime || '（未更新）';

    // 各状态字段行
    for (const field of STATUS_FIELDS) {
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
        editInput.className         = 'eden-field-edit text_pole';
        editInput.value             = value;
        editInput.rows              = 2;
        editInput.style.display     = 'none';
        editInput.dataset.field     = field;

        const editBtn = document.createElement('i');
        editBtn.className = 'eden-edit-btn fa-solid fa-pencil';
        editBtn.title     = '编辑';

        editBtn.addEventListener('click', async () => {
            const isEditing = editInput.style.display !== 'none';
            if (!isEditing) {
                // 切换到编辑模式
                displaySpan.style.display = 'none';
                editInput.style.display   = 'block';
                editInput.focus();
                editBtn.className = 'eden-edit-btn fa-solid fa-check';
                editBtn.title     = '保存';
            } else {
                // 保存
                const newVal = editInput.value;
                if (!char.status) char.status = {};
                char.status[field]          = newVal;
                displaySpan.textContent     = newVal || '—';
                displaySpan.style.display   = '';
                editInput.style.display     = 'none';
                editBtn.className           = 'eden-edit-btn fa-solid fa-pencil';
                editBtn.title               = '编辑';
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

const CHAR_FIELDS = [
    { id: 'name',              label: '名字',         placeholder: '',                    textarea: false },
    { id: 'race',              label: '种族',         placeholder: '人类',                textarea: false },
    { id: 'age',               label: '年龄',         placeholder: '26',                  textarea: false },
    { id: 'height',            label: '身高',         placeholder: '165cm',               textarea: false },
    { id: 'weight',            label: '体重',         placeholder: '76kg',                textarea: false },
    { id: 'measurements',      label: '三围',         placeholder: '95E/110/90',          textarea: false },
    { id: 'cycleLength',       label: '周期(C)',      placeholder: '30（月经多久来一次）', textarea: false },
    { id: 'menstrualDuration', label: '经期(M)',      placeholder: '7（月经持续几天）',   textarea: false },
    { id: 'symptoms',          label: '月经症状',     placeholder: '痛经/腰痛/无 等',    textarea: true  },
];

function showCharacterForm(editIndex = -1) {
    const settings = getSettings();
    const isEdit   = editIndex >= 0;
    const src      = isEdit ? settings.characters[editIndex] : {};

    const overlay = document.createElement('div');
    overlay.className = 'eden-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'eden-modal';

    const fieldsHtml = CHAR_FIELDS.map(f => {
        const val = (src[f.id] ?? '');
        const esc = val.replace(/"/g, '&quot;');
        const input = f.textarea
            ? `<textarea id="edf-${f.id}" class="text_pole" rows="2" placeholder="${f.placeholder}">${val}</textarea>`
            : `<input id="edf-${f.id}" type="text" class="text_pole" value="${esc}" placeholder="${f.placeholder}" />`;
        return `<div class="eden-form-row">
                    <label class="eden-form-label">${f.label}</label>
                    ${input}
                </div>`;
    }).join('');

    modal.innerHTML = `
        <div class="eden-modal-header">
            <b>${isEdit ? '编辑角色' : '新建角色'}</b>
            <i id="eden-modal-close" class="fa-solid fa-times menu_button" style="font-size:1em;"></i>
        </div>
        <div class="eden-modal-body">${fieldsHtml}</div>
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
        const newData = Object.fromEntries(CHAR_FIELDS.map(f => [f.id, get(f.id)]));

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
    $(document).on('input', '#eden-api-url',   function () { getSettings().apiUrl  = this.value; saveSettingsDebounced(); });
    $(document).on('input', '#eden-api-key',   function () { getSettings().apiKey  = this.value; saveSettingsDebounced(); });
    $(document).on('input', '#eden-api-model', function () { getSettings().model   = this.value; saveSettingsDebounced(); });

    // 测试 API 连接
    $(document).on('click', '#eden-api-test', async () => {
        const { apiUrl, apiKey } = getSettings();
        try {
            const resp = await fetch(`${apiUrl.replace(/\/$/, '')}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (resp.ok) {
                toastr.success('API 连接成功', '伊甸园');
            } else {
                toastr.error(`连接失败: HTTP ${resp.status}`, '伊甸园');
            }
        } catch (e) {
            toastr.error(`连接失败: ${e.message}`, '伊甸园');
        }
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
            <input id="eden-api-model" type="text" class="text_pole" value="${s.model}"
              placeholder="gpt-4o-mini"/>
          </div>
          <button id="eden-api-test" class="menu_button menu_button_icon" style="width:100%;">
            <i class="fa-solid fa-plug"></i><span>测试连接</span>
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

    // 等待 ST 初始化完成后注入 UI
    eventSource.on(event_types.APP_READY, () => {
        $('#extensions_settings2').append(buildPanelHTML());
        bindEvents();
        renderUI();
    });

    // 如果 APP_READY 已经触发过（扩展热加载情形），立即执行
    if ($('#extensions_settings2').length && !document.getElementById('eden-garden-container')) {
        $('#extensions_settings2').append(buildPanelHTML());
        bindEvents();
        renderUI();
    }

    // 监听 AI 回复完成事件
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

    // 切换聊天时刷新世界书下拉列表
    eventSource.on(event_types.CHAT_CHANGED, () => refreshWorldbookSelector());

    console.log(`${LOG} 扩展已加载`);
}
