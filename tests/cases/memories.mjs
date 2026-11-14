// 模拟记忆库：字段对应真实 schema 的 event_text / gist / summary / keywords。
//
// 检索评估按 name 判定命中，所以「用例里的理想命中」写的就是这里的 name。
// kind: "upcoming" = 未来事件（不进检索池）；"default" = 兜底事件（不进检索池）。
// 数组顺序 = 同分候选的先后（评估脚本按顺序生成 id）。
//
// 这里只放「人真的会记住的事」。寒暄、问候、道别不该成为记忆事件
// （巩固提示词已明确禁止为它们新建事件），所以库里也不该有这种条目。
export const MEMORIES = [
  {
    name: "巷口面馆",
    event: "巷口面馆",
    gist: "[time]晚上[user]加完班去巷口面馆吃了一碗牛肉面",
    summary: "[time]晚上[user]说加班结束绕去巷口面馆，点了牛肉面，汤头很暖，觉得一天的压力都被抚平了，还说下次要带[ai]一起去",
    kw: "巷口面馆 牛肉面 吃面 面馆 加班 夜宵",
  },
  {
    name: "妈妈做的番茄炒蛋",
    event: "妈妈做的番茄炒蛋",
    gist: "[time][user]说想吃妈妈做的番茄炒蛋",
    summary: "[time][user]聊起小时候妈妈做的番茄炒蛋，说外面怎么都做不出那个味道，有点想家",
    kw: "妈妈 母亲 我妈 老妈 番茄炒蛋 想家 老家",
  },
  {
    name: "加班到很晚",
    event: "加班到很晚",
    gist: "[time][user]连着一周加班到很晚",
    summary: "[time][user]说项目赶稿连着一周加班到凌晨，颈椎疼，语气很疲惫但没抱怨，只说想早点睡",
    kw: "加班 熬夜 项目 赶稿 疲惫 颈椎 压力",
  },
  {
    name: "团子橘猫",
    event: "团子（橘猫）",
    gist: "[time][user]说团子又把桌上的杯子推下去了",
    summary: "[time][user]家养了只橘猫叫团子，爱推桌上的东西，[user]嘴上嫌弃其实很宠",
    kw: "团子 橘猫 猫 宠物 推杯子",
  },
  {
    name: "被领导批评",
    event: "被领导批评",
    alias: "汇报翻车",
    gist: "[time][user]被领导当众批评了",
    summary: "[time][user]说方案被领导当众否了，觉得委屈又不好意思跟同事说，回家跟[ai]讲了很久",
    kw: "领导 老板 批评 方案 委屈 当众 骂",
  },
  {
    name: "周末去西山",
    event: "周末去西山",
    gist: "[time][user]周末去爬了西山",
    summary: "[time][user]说周末一个人去爬西山，山顶风很大，拍了张照片，觉得好久没这么松快",
    kw: "西山 爬山 周末 山顶 照片",
  },
  {
    name: "感冒发烧",
    event: "感冒发烧",
    gist: "[time][user]感冒发烧请假在家",
    summary: "[time][user]说感冒发烧到38度，一个人躺了一天没人照顾，语气有点低落",
    kw: "感冒 发烧 生病 请假 38度",
  },
  {
    name: "和小陈吵架",
    event: "和小陈吵架",
    gist: "[time][user]跟朋友小陈闹了别扭",
    summary: "[time][user]说和小陈因为一件小事吵了架，其实不全是对方的问题，但拉不下脸先开口",
    kw: "小陈 朋友 吵架 闹别扭",
  },
  {
    name: "手冲咖啡",
    event: "学做手冲咖啡",
    gist: "[time][user]开始学手冲咖啡",
    summary: "[time][user]买了一套手冲器具，第一次冲出来的咖啡太酸，说要慢慢练",
    kw: "手冲 咖啡 拿铁 latte 器具 太酸",
  },
  {
    name: "童年外婆家",
    event: "童年外婆家",
    gist: "[time][user]聊起小时候在外婆家过暑假",
    summary: "[time][user]说小时候暑假都在外婆家，院子里有棵枇杷树，那是记忆里最安稳的夏天",
    kw: "外婆 童年 暑假 枇杷树 院子",
  },
  {
    name: "打算去大理",
    event: "打算去大理",
    gist: "[time][user]说想请年假去大理",
    summary: "[time][user]说想请年假去大理住几天，看看洱海，还没订机票",
    kw: "大理 旅行 洱海 年假 机票",
  },
  {
    name: "下周三面试",
    event: "下周三的面试",
    gist: "[time][user]说下周三有个面试",
    summary: "",
    kw: "面试 跳槽 offer 准备",
    kind: "upcoming",
  },
  {
    name: "日常闲聊",
    event: "日常闲聊",
    gist: "日常闲聊",
    summary: "",
    kw: "",
    kind: "default",
  },
];

/** 片段检索时的比对文本：gist / summary / keywords 三者都参与匹配 */
export const memoryText = (m) => [m.gist, m.summary, m.kw].filter(Boolean).join(" ");

/** 可被检索命中的记忆（排除未来事件与兜底事件） */
export const RETRIEVABLE = MEMORIES.filter((m) => !m.kind);

/** 身份名：分词时要屏蔽（用户昵称 + AI 名） */
export const BLOCKED_NAMES = ["阿柚", "私藏"];
