/**
 * 伊甸园状态面板 — 提示词配置文件
 *
 * 本文件包含两部分：
 *   1. 主提示词（系统提示 + 用户提示构建函数）
 *   2. 知识库模块（按剧情类型按需注入）
 *
 * buildUserPrompt() 可用变量：
 *   {name} {race} {age} {height} {weight} {measurements}
 *   {cycleLength} {menstrualDuration} {symptoms}
 *   {currentState}   上次保存的完整 <伊甸园> 块
 *   {datetime}       当前时间 YYYY-MM-DD HH:MM
 *   {chatHistory}    最近对话文本
 *   {knowledgeModules}  数组，由引擎按剧情自动填充，通常无需手动修改
 */

// ────────────────────────────────────────────────
//  第一步：剧情分类提示词
//  引擎会先用这对提示词判断剧情类型，结果决定加载哪些知识库模块。
// ────────────────────────────────────────────────

export const CLASSIFY_SYSTEM_PROMPT =
`You are a scene classifier for a roleplay story tracker.
Analyze the provided conversation excerpt and return ONLY a JSON object with these boolean fields:
- pregnant: Is the character currently pregnant, or has conception/pregnancy been established in the story?
- sexual: Is there sexual activity or intercourse occurring/implied in the recent messages?
- consanguinity: Are any characters in a blood-related (incestuous/consanguineous) relationship?
- special_race: Are any characters non-human (e.g. demon, elf, beast-kin, alien, etc.)?
Respond with ONLY valid JSON, no explanation. Example: {"pregnant":false,"sexual":true,"consanguinity":false,"special_race":false}`;

export function buildClassifyPrompt({ chatHistory }) {
    return `Analyze this conversation excerpt:\n\n${chatHistory}\n\nReturn the JSON classification:`;
}

// ────────────────────────────────────────────────
//  主系统提示词（System Prompt）
// ────────────────────────────────────────────────

export const SYSTEM_PROMPT =
`你是被追踪角色的生理状态记录员，只输出<伊甸园>...</伊甸园>块，不加解释。

【铁律】
- 只更新"角色基本信息"里指定的那一个角色。对话中其他角色的活动一概不算数。
- 无剧情变化的字段保持原值。非孕相关字段（精子/卵子/胎数/父亲/健康）未孕写"N/A"或"0"。
- 时间从剧情推断（YYYY-MM-DD HH:MM），无法确定则沿用原值。

【怀孕认知梯度】
怀孕是客观事件，但角色对此有认知过程。阶段字段必须标注她的认知层级：
- "孕X周（未察觉）"：早期，仅有轻微症状（乳房胀、犯困、恶心等），角色以为是普通不适。
- "孕X周（疑似）"：症状明显，角色开始怀疑（月经推迟、持续孕吐），但未验证。
- "孕X周（已确认）"：经过验孕棒/血检/超声等明确检测。
其他字段配合：
- 特质：写角色主观察觉到的症状（不写"怀孕"两字，除非已确认）。
- 健康：结合人设写角色对当前状态的反应/态度（喜悦、惊恐、盘算堕胎、假装不知、焦虑、麻木...），禁止统一写"接受怀孕"。

【避孕认知】
- 安全期伪科学。避孕套约2%失败率，事后药>5%，体外射精约20%。任何时期都可能受孕。
- 子宫字段须体现受孕概率（极低/低/中/高/极高）。

【背景角色想象】
角色名未出现在对话中 = 她在幕后生活。
- 活动字段：大胆想象她此刻在做什么（上班/购物/运动/自慰/吵架/偷情/看电影...任何真人活动）。
- 严禁"无特殊活动"、"正常生活"等敷衍。
- 其他身体字段随活动变化（运动→充血心跳；久坐→腹胀；自慰→润滑；情绪激动→白带变化）。
出现在对话中则如实记录当前活动。`;

// ────────────────────────────────────────────────
//  主用户提示词构建函数（User Prompt）
// ────────────────────────────────────────────────

export function buildUserPrompt({
    name, race, age, height, weight, measurements,
    cycleLength, menstrualDuration, symptoms, persona,
    currentState, chatHistory,
    knowledgeModules = [],
}) {
    // 将命中的知识模块拼成一个段落插入提示词
    const knowledgeSection = knowledgeModules.filter(m => m && m.trim()).length
        ? '\n\n## 当前情景适用参考知识（请结合以下知识更新状态）\n\n' +
          knowledgeModules.filter(m => m && m.trim()).join('\n\n---\n\n')
        : '';

    const personaLine = persona ? `\n人设摘要：${persona}` : '';

    return `【本次更新对象：${name}】（对话中其他角色与本次无关）

角色基本信息：
名字：${name}
种族：${race}
年龄：${age}岁
身高：${height}
体重：${weight}
三围：${measurements}
月经周期（C）：${cycleLength}天（即多久来一次月经）
经期持续（M）：${menstrualDuration}天
月经症状：${symptoms}${personaLine}

当前状态（上次记录）：
${currentState}

最新剧情：
${chatHistory}${knowledgeSection}

按此格式输出（字段顺序和名称固定）：
<伊甸园>
      YYYY-MM-DD HH:MM
      阶段|月经/卵泡/排卵/黄体第X天 或 孕X周（未察觉/疑似/已确认）
      活动|此刻在做什么，简述对身体的影响
      种族|
      年龄|
      身高|
      体重|
      三围|
      乳房|形态与当前反应
      小穴|生理状态
      子宫|宫压+状态+受孕概率（极低/低/中/高/极高）；孕期改写羊膜/胎儿
      后庭|正常 或 15字内描述
      特质|角色主观察觉到的症状/临时特征（未确认怀孕前不写"怀孕"）
      精子|宫内量+来源+活性，无则"无"
      卵子|宫内数，无则"无"
      胎数|孕：胎数性别；非孕：已产胎数或"0"
      父亲|孕：生父；非孕：N/A
      健康|孕：结合人设的态度反应+胎儿状态；非孕：N/A
</伊甸园>`;
}

// ════════════════════════════════════════════════
//  知识库模块
//  引擎会根据剧情分类自动决定是否注入。
//  你可以自由修改每个模块的内容，留空字符串则该模块不加载。
// ════════════════════════════════════════════════

// ── 模块A：怀孕 ────────────────────────────────
// 命中条件：剧情中存在怀孕或受孕事件
export const KNOWLEDGE_PREGNANCY =
`【妊娠速查】
孕周与表现：
- 0–4周：无自觉症状。血hCG受精后7–10天可测。
- 5–8周：晨吐、犯困、乳房胀痛、频尿。尿试纸阳性；阴超6–7周见胎心。
- 9–12周：孕反高峰后缓解，乳晕变深。
- 13–16周：症状缓解，偶下腹牵拉。
- 17–20周：初感胎动。18–22周系统超声。
- 21–28周：显怀，胃灼热/便秘/腰背痛，OGTT糖耐量。
- 29–36周：胎动规律，假性宫缩，耻骨联合痛。
- 37–40+周：足月，规律宫缩/见红/破水。
- 产褥期：泌乳开始。

角色自觉症状 → 认知层级映射：
- 未察觉：轻微晨吐、疲倦，容易误认为普通不适。
- 疑似：月经推迟+持续孕吐+乳房明显胀痛。
- 已确认：验孕棒/血检/超声后。

孕期复孕极罕见；如发生阶段字段分列两胎孕周。`;

// ── 模块B：性爱/受孕 ──────────────────────────
// 命中条件：剧情中存在性行为
export const KNOWLEDGE_SEXUAL =
`【受孕概率速查】
周期各阶段受孕率（C=周期天数，M=经期天数）：
- 月经期(1~M)：约1–2%
- 卵泡期(M+1~M+7)：3–28%
- 排卵期(M+8~M+11)：25–33%（高峰）
- 黄体期(M+12~C)：接近0%但非零

避孕失败率（提醒角色不可掉以轻心）：
- 安全套：约2%（破损/使用不当）
- 事后药：>5%
- 体外射精：约20%

精子：单次2–5ml/4千万–3亿个，宫内活性3–5天，最长7天。`;

// ── 模块C：近亲关系 ───────────────────────────
// 命中条件：剧情中存在血缘关系的角色之间发生性行为
export const KNOWLEDGE_CONSANGUINITY =
`【近亲遗传风险】
近交系数F（内部推断，不外显）：
- 父母-子女/全同胞：0.25（极高）
- 半同胞/叔侄：0.125（很高）
- 堂/表兄妹：0.0625（中等）
- 更远旁系：≤0.03125（较低）

先天缺陷风险（基线3–4%）：
- 堂/表兄妹：5–7%
- 更近亲属：显著更高
- 是概率上升，非必然

怀孕时：健康字段体现孕检建议（NT筛查+系统超声，家族有遗传病加基因检测）。`;

// ── 模块D：特殊种族 ───────────────────────────
// 命中条件：剧情中有非人类角色（妖魔/精灵/兽人等）
// 请在此填写特殊种族的生理差异，留空则不加载
export const KNOWLEDGE_SPECIAL_RACE =
``;
// 示例（取消注释并修改）：
// export const KNOWLEDGE_SPECIAL_RACE =
// `【特殊种族参考知识】
// 恶魔：体温较人类高约1–2°C；孕期更长（约12–14个月）；后代可能具有尾/角等特征
// 精灵：孕期约18个月；极低生育率；双胎罕见
// 兽人：月经周期较短（约21天）；排卵信号更明显（体温/气味变化）`;
