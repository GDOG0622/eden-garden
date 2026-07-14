# 伊甸园状态面板

SillyTavern 第三方扩展，为角色维护一份持续更新的生理状态面板，通过独立 API 调用（与主聊天 API 完全分离）在每次 AI 回复后自动更新。

---

## 文件结构

```
eden-garden/
├── manifest.json   扩展元信息（ST 加载入口）
├── index.js        主逻辑（UI、事件、API 调用、世界书操作）
├── prompt.js       全部提示词配置（可自由编辑）
├── style.css       扩展面板样式
└── README.md       本文件
```

---

## 核心概念

### 角色注册
每个角色存储以下基本信息（`extension_settings['eden-garden'].characters[]`）：

| 字段 | 说明 |
|------|------|
| `name` | 角色名 |
| `race` | 种族 |
| `age` / `height` / `weight` / `measurements` | 体型数据 |
| `cycleLength` / `menstrualDuration` | 月经周期 C 天 / 经期 M 天 |
| `symptoms` | 月经症状描述 |
| `persona` | 角色人设摘要（性格、职业、背景等，供 AI 推断背景活动） |
| `wiUid` | 在目标世界书中的条目 UID |
| `status` | 当前状态对象（16 个字段 + datetime） |
| `prevStatus` | 上一次更新前的状态备份（用于"重新生成"） |

### 状态字段（STATUS_FIELDS）
`阶段` `活动` `种族` `年龄` `身高` `体重` `三围` `乳房` `小穴` `子宫` `后庭` `特质` `精子` `卵子` `胎数` `父亲` `健康`

面板中**不可编辑**（仅显示在信息条）：种族、年龄、身高、体重、三围  
其余字段均可点击编辑按钮手动修改。

### 世界书条目
每个角色对应目标世界书中的一个条目：
- `constant: true`（常驻注入）
- `position: 3`（ANBottom，作者注释之后）
- 内容包含角色人设摘要 + 最新状态
- 通过 REST API（`/api/worldinfo/get` / `/api/worldinfo/edit`）直接读写，不经过 ST 缓存层
- **在世界书 UI 中禁用条目 = 本轮跳过该角色的状态更新**

---

## 更新流程

```
AI 回复渲染完成
  └─► onCharacterMessageRendered()
        ├─ 读取世界书，检查各角色条目是否被禁用
        └─ 对每个未禁用角色：
             updateCharacterStatus(i)
               ├─ 备份 status → prevStatus
               ├─ callStatusAPI(char)
               │    ├─ [可选] 两步模式：classifyScene() → 判断剧情类型
               │    │    └─ 按需注入 KNOWLEDGE_* 模块
               │    └─ 主调用：buildUserPrompt() → _apiCall(stream=true)
               ├─ parseEdenBlock() → 解析 <伊甸园>...</伊甸园>
               ├─ 写入 char.status
               ├─ syncCharacterWIEntry() → 更新世界书条目
               └─ renderStatusPanel() → 刷新面板 UI
```

### 重新生成 vs 立即更新
- **立即更新**：以 `status`（当前状态）为基线，备份后生成新状态
- **重新生成**：以 `prevStatus`（上次备份）为基线重跑，可反复点击直到满意

### 消息提取
只取最后一条 AI 消息，优先提取 `<content>…</content>` 标签内的文本（去除思维链等其他内容）。

### 时间处理
不注入现实时间，由 AI 从剧情内容自行推断故事时间并填入状态块第一行。

---

## API 调用

### 独立配置
扩展使用自己的 `apiUrl` / `apiKey` / `model`，与 ST 主聊天 API 完全独立。

### `_apiCall()`
默认启用流式传输（`stream: true`），通过 SSE 逐块读取，避免长响应静默超时。  
分类步骤（`classifyScene`）使用 `stream: false`，因响应极短。

### 两步模式（智能知识库）
启用后，状态更新前先发一次轻量分类请求，返回 JSON：
```json
{ "pregnant": bool, "sexual": bool, "consanguinity": bool, "special_race": bool }
```
命中的标志对应注入 `prompt.js` 中的知识模块：

| 标志 | 注入模块 |
|------|----------|
| `pregnant` | `KNOWLEDGE_PREGNANCY` |
| `sexual` | `KNOWLEDGE_SEXUAL` |
| `consanguinity` | `KNOWLEDGE_CONSANGUINITY` |
| `special_race` | `KNOWLEDGE_SPECIAL_RACE` |

---

## 提示词定制（prompt.js）

所有提示词集中在 `prompt.js`，可自由修改，无需改动主逻辑。

| 导出 | 用途 |
|------|------|
| `CLASSIFY_SYSTEM_PROMPT` | 分类步骤的 system prompt |
| `buildClassifyPrompt()` | 分类步骤的 user prompt 构建函数 |
| `SYSTEM_PROMPT` | 状态生成的 system prompt |
| `buildUserPrompt()` | 状态生成的 user prompt 构建函数 |
| `KNOWLEDGE_PREGNANCY` | 妊娠知识模块 |
| `KNOWLEDGE_SEXUAL` | 性爱/受孕知识模块 |
| `KNOWLEDGE_CONSANGUINITY` | 近亲关系知识模块 |
| `KNOWLEDGE_SPECIAL_RACE` | 特殊种族知识模块（默认空，按需填写） |

---

## UI 结构

扩展面板注入到 `#extensions_settings2`，包含：

- **角色导航栏**：上一个 / 角色名+页码 / 下一个 / 新建 / 编辑 / 删除
- **状态表格**：时间行 → 紧凑信息条（种族/年龄/身高/体重/三围）→ 可编辑字段行
- **操作栏**：立即更新 / 重新生成 / 自动更新开关 / 智能知识库开关 / 更新指示器
- **API 配置区**（折叠）：API URL / Key / 模型下拉（从 `/models` 端点拉取）
- **目标世界书选择** + 眼睛按钮（查看上次调用的完整提示词）

### 模态框
角色新建/编辑使用自定义模态框（`position: fixed; width: 100vw; height: 100vh`，使用 vw/vh 而非 top/bottom，以兼容 ST 在 `<html>` 上的 CSS transform）。

---

## 设置存储

```javascript
extension_settings['eden-garden'] = {
    apiUrl, apiKey, model,
    autoUpdate,   // 自动更新开关
    useTwoStep,   // 智能知识库（两步模式）开关
    worldbook,    // 目标世界书名称
    characters,   // 角色数组
    activeCharIndex,
}
```

持久化通过 ST 的 `saveSettingsDebounced()` 完成。

---

## 已知注意事项

- `prompt.js` 为纯文本配置文件，修改后刷新页面即生效，**注意防止提示词注入**（外部内容不应直接写入此文件）
- 世界书条目的 `disable` 字段由用户在 ST 世界书 UI 中控制，扩展同步更新时会保留该状态，不会强制重新启用
- 模型列表通过 `GET {apiUrl}/models` 拉取，若 API 不支持该端点需手动填写模型名
