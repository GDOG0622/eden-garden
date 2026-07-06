/**
 * 伊甸园状态面板 — 提示词配置文件
 *
 * 你可以在这里自由修改发给 AI 的提示词。
 *
 * buildUserPrompt() 接收一个对象，包含以下可用变量：
 *   {name}               角色名字
 *   {race}               种族
 *   {age}                年龄（数字字符串）
 *   {height}             身高
 *   {weight}             体重
 *   {measurements}       三围
 *   {cycleLength}        月经周期天数 C
 *   {menstrualDuration}  经期持续天数 M
 *   {symptoms}           月经症状描述
 *   {currentState}       上次保存的 <伊甸园> 块完整文本
 *   {datetime}           当前时间，格式 YYYY-MM-DD HH:MM
 *   {chatHistory}        最近对话文本（User/角色名: 消息内容）
 */

// ────────────────────────────────────────────────
//  系统提示词（System Prompt）
// ────────────────────────────────────────────────
export const SYSTEM_PROMPT =
`你是一个专业的角色生理状态追踪器。
任务：根据最新对话内容，更新角色的<伊甸园>状态面板。
规则：
1. 仅输出<伊甸园>...</伊甸园>块，不输出任何其他内容或解释。
2. 对话中没有明确提及的字段，保持原值不变（非孕未提及则写"N/A"）。
3. 根据时间和事件合理推断月经周期阶段，精子活性，卵子状态等。
4. 如有近亲关系，须在该前提下综合考量所有指标。`;

// ────────────────────────────────────────────────
//  用户提示词构建函数（User Prompt）
// ────────────────────────────────────────────────
export function buildUserPrompt({
    name, race, age, height, weight, measurements,
    cycleLength, menstrualDuration, symptoms,
    currentState, datetime, chatHistory,
}) {
    return `角色基本信息：
名字：${name}
种族：${race}
年龄：${age}岁
身高：${height}
体重：${weight}
三围：${measurements}
月经周期（C）：${cycleLength}天（即多久来一次月经）
经期持续（M）：${menstrualDuration}天
月经症状：${symptoms}

当前状态（上次记录）：
${currentState}

当前时间：${datetime}

最近对话（从旧到新）：
${chatHistory}

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
}
