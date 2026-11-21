import { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Alert,
  TextInput,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import dayjs from "dayjs";
import { useSettingsStore } from "@/store/settingsStore";
import { useTheme, useThemeStore } from "@/theme/useTheme";
import { lightColors, darkColors } from "@/theme/colors";
import { useChatStore } from "@/store/chatStore";
import {
  getSystemPrompt,
  getConfigDefault,
  setCustomSystemPrompt,
  getThresholds,
  getModelRouting,
  getPrompts,
  setConfigOverride,
  resetConfigOverride,
  loadConfigOverrides,
} from "@/prompt/config";
import { getUserInfo, setUserInfo as persistUserInfo, getTopActive, getActiveCount, clearAllData, updateEventParams, replaceEventAliases, getEventAliases, updateFragmentParams, deleteEvent, getFragmentsByEventId, insertEvent, insertFragment, deleteFragment, deleteScheduleForWeek, getWeekSchedule, mergeUserInfo, getDefaultEventId, getEventById, getUpcomingEvents, getActiveConditions, startCondition, resolveCondition, getMeta } from "@/db/queries";
import { getWeekStart } from "@/memory/scheduler";
import { getLiveDay, getLateNight, dayKey, type LiveDay } from "@/memory/dailyLife";
import { TIME_SLOT_LABELS, getCurrentDayOfWeek, getCurrentTimeSlot } from "@/memory/week";
import { identityNames } from "@/memory/identity";
import { calculateWeight } from "@/memory/decay";
import {
  getAllFriends,
  updateFriendName,
  setFriendActive,
  deleteFriendPersona,
  getFriendLastInteraction,
} from "@/db/queries";
import { rebuildFriendRoster, replaceFriend } from "@/friends/roster";
import { friendAvatarText } from "@/friends/persona";
import { formatTodayLine } from "@/utils/holidays";
import { applyIdentityPlaceholders, normalizePlaceholders } from "@/prompt/assembler";
import { fetchModels, getClient } from "@/llm/client";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { exportBackup, importBackup, listAutoBackups, restoreFromUri } from "../../src/utils/backup";
import * as Updates from "expo-updates";
import { RELEASE_VERSION } from "@/version";
import type { UserInfo, MemoryEvent, MemoryFragment, ConsolidationResponse, FriendPersona } from "@/types/schema";

/** 人设提取结果：属性桶同巩固流，另加「仍在持续的处境」标签（落成 condition 事件） */
type PersonaInfo = ConsolidationResponse["new_info"] & { conditions?: string[] };

/** 事件的实际权重：库里存的 active_weight 是「上次被想起时的满分」，衰减要在读取时现算 */
function liveWeightOf(e: MemoryEvent): number {
  return calculateWeight(e.active_weight, e.last_accessed, e.priority);
}

// 替换片段中的 [user] [ai] [time] 占位符
function replaceFragmentPlaceholder(text: string, timestamp: string, nickname: string, aiName?: string): string {
  let result = normalizePlaceholders(text).replace(/\[user\]/gi, nickname || "用户");
  result = result.replace(/\[ai\]/gi, aiName || "私藏");
  if (result.includes("[time]") && timestamp) {
    const now = dayjs();
    const eventTime = dayjs(timestamp);
    // 自然日差（与聊天页日期横幅同口径），不足 24h 的昨天不再显示「今天」
    const diffDays = Math.max(0, now.startOf("day").diff(eventTime.startOf("day"), "day"));
    let relativeTime: string;
    if (diffDays < 1) relativeTime = "今天";
    else if (diffDays < 2) relativeTime = "昨天";
    else if (diffDays < 7) relativeTime = `${diffDays}天前`;
    else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      relativeTime = weeks <= 1 ? "上周" : `${weeks}周前`;
    } else if (diffDays < 365) {
      const months = Math.floor(diffDays / 30);
      relativeTime = months <= 1 ? "上个月" : `前${months}个月`;
    } else {
      const years = Math.floor(diffDays / 365);
      relativeTime = years <= 1 ? "去年" : `${years}年前`;
    }
    result = result.replace(/\[time\]/g, relativeTime);
  }
  return result;
}

/** 事件字段的中文名，设置页只读展示用 */
const MEMORY_KIND_LABEL: Record<string, string> = { daily: "日常琐事", episode: "共同经历", condition: "持续处境" };
const EVENT_STATUS_LABEL: Record<string, string> = { none: "普通", upcoming: "待发生", caring: "关心中", archived: "已归档" };

/** 作息表展示用的短标签（与 TIME_SLOT_LABELS 同序） */
const WEEK_DAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SHORT_SLOT_LABELS = ["早", "上午", "午", "下午", "晚"];

// 配置项元数据
interface ConfigField {
  key: string;
  label: string;
  type: "number" | "text" | "multiline";
  description?: string;
}

/** 模型选择器的标题：跟着设置项 key 走 */
const MODEL_PICKER_TITLE: Record<"foreground_model" | "background_model" | "retrieval_model", string> = {
  foreground_model: "前台对话模型",
  background_model: "后台巩固模型",
  retrieval_model: "后台检索模型",
};

/** 密文显示：只留尾部 4 位，截图或旁人扫一眼都看不到整串 Key */
function maskApiKey(key: string): string {
  return key.length <= 8 ? "••••••" : `••••••${key.slice(-4)}`;
}

const THRESHOLD_FIELDS: ConfigField[] = [
  { key: "consolidation_window_turns", label: "巩固最小窗口（轮）", type: "number", description: "少于这么多轮不触发巩固，避免每聊两句就调一次模型（默认 10）" },
  { key: "consolidation_token_budget", label: "巩固 token 预算", type: "number", description: "未巩固对话攒到这么多 token 就触发巩固（默认 10000，约 50 轮）" },
  { key: "consolidation_idle_minutes", label: "空闲巩固（分钟）", type: "number", description: "用户停多久后把不足预算的积压也消化掉（默认 30）" },
  { key: "context_history_rounds", label: "冷启动 / 好友私聊轮数", type: "number", description: "冷启动（还没有摘要，首次使用 / 旧数据）和好友私聊最多带多少轮历史；主聊天有了摘要后按巩固游标全量带上，不按轮数截断" },
  { key: "context_token_budget", label: "上下文总预算（token）", type: "number", description: "人设 + 状态区 + 摘要 + 历史 + 记忆区的目标预算（默认 18000）。超了只会降级/删除记忆区，未巩固的历史一条都不删——删了这段经历就永远进不了记忆" },
  { key: "detail_visible_weight", label: "详细/简略切换权重", type: "number", description: "实时权重低于此值的记忆只显示一句话摘要（默认 60，调高=更多记忆变简略）。AI 检索判定开启时，这条只影响兜底路径的详略" },
  { key: "friend_roster_size", label: "好友人数", type: "number", description: "AI 熟人圈的固定人数（默认 5，重建花名册时生效）" },
  { key: "friend_moment_probability", label: "好友每日发帖概率", type: "number", description: "每位好友每天发一条动态的概率（0~1，默认 0.35），太高会抢主角戏份" },
  { key: "friend_comment_probability", label: "好友评论概率", type: "number", description: "每位好友「刷到这条动态」的概率（0~1，默认 0.5）。刷到的人设一起进提示词，由 AI 自己判断谁真的会留言——可以一个都不留，人数不设上限" },
  { key: "recent_moment_recall_weight", label: "近期动态回想权重", type: "number", description: "每 1× 动态新近度折算的灵光一闪概率（默认 0.2）：用户刚评论/自己刚发帖 = 4× → 约 82%。好友自己发帖不计入" },
];

// 提示词分组配置
interface PromptGroup {
  icon: string;
  title: string;
  description?: string;
  fields: ConfigField[];
}

const PROMPT_GROUPS: PromptGroup[] = [
  {
    icon: "💬",
    title: "聊天提示词",
    description: "按消息发送顺序排列，越靠前缓存命中率越高",
    fields: [
      { key: "system_prompt", label: "① 系统人设", type: "multiline", description: "定义 AI 的角色与人格。此部分作为独立消息发送，缓存命中率最高。" },
      { key: "state_injection_template", label: "② 状态区注入模板", type: "multiline", description: "定义用户信息的注入格式。两次巩固之间保持稳定，空字段自动隐藏。这里只放用户侧；AI 自己的情境由聊天历史里的状态注记提供。" },
      { key: "memory_injection_template", label: "③ 记忆区注入模板", type: "multiline", description: "定义记忆区的整体结构。没有可注入的记忆时整块不出现。" },
      { key: "event_reminder_template", label: "未来事件临近提示", type: "multiline", description: "隐形提示词：未来事件到点前 24h 注入消息末尾，AI 自然提起。{{event}} 事件内容、{{due_time}} 发生时刻。" },
      { key: "event_care_template", label: "已过期关心提示", type: "multiline", description: "隐形提示词：事件过去且用户没提起时注入，AI 找机会关心。{{event}} 事件内容、{{due_time}} 发生时刻。" },
    ],
  },
  {
    icon: "🔧",
    title: "后台任务",
    fields: [
      { key: "extraction_prompt", label: "记忆提取指令", type: "multiline", description: "按 token 预算或空闲触发，从对话中提取片段、更新画像并维护会话摘要。" },
      { key: "retrieval_judge_prompt", label: "检索判定指令", type: "multiline", description: "每轮判断「这句话想起了哪些往事」的固定说明。清单由代码按固定格式拼接，改这段话只会影响判定口径。" },
    ],
  },
  {
    icon: "🚀",
    title: "特殊场景",
    fields: [
      { key: "cold_start_template", label: "冷启动模板", type: "multiline", description: "当数据库为空时，与系统人设组合使用，引导用户自我介绍。" },
      { key: "schedule_generation_prompt", label: "时间表生成指令", type: "multiline", description: "每周自动生成行为时间表时使用。{{persona}} 为 AI 人设，{{last_week}} 为上周实况。" },
    ],
  },
  {
    icon: "🌤️",
    title: "生活与动态",
    description: "清晨一次的实况生成 + 朋友圈文案，失败会静默回退，不影响聊天",
    fields: [
      { key: "daily_life_generation_prompt", label: "每日实况生成", type: "multiline", description: "每天一次，把习惯基线变成「今天具体怎么过」。可用 {{persona}} {{date}} {{day_context}} {{weather}} {{baseline}} {{yesterday}} {{late_night}} {{user_context}}。" },
      { key: "moment_generation_prompt", label: "AI 发动态", type: "multiline", description: "AI 发心情动态时的文案指令。{{persona}} {{scene}} {{theme_hint}} {{memories}}（最近 3 天的共同经历）{{friends}}（掷骰刷到这条动态的人及其小传，评论只能由他们出）{{recent}}。" },
      { key: "moment_comment_prompt", label: "AI 回评", type: "multiline", description: "AI 在动态下评论/回评。{{persona}} {{moment}} {{comments}} {{task}}。" },
      { key: "friend_persona_generation_prompt", label: "好友花名册生成", type: "multiline", description: "一次性生成 AI 的熟人圈。{{persona}} {{scene}} {{user_context}} {{preferences}} {{count}}。" },
      { key: "friend_moment_generation_prompt", label: "好友发动态", type: "multiline", description: "好友发帖文案。{{friend_name}} {{profile}} {{scene}} {{recent}}。" },
      { key: "friend_comment_prompt", label: "好友回评", type: "multiline", description: "好友被回复时，本人回一句话。{{friend_name}} {{profile}} {{preferences}} {{moment}} {{comments}}。" },
      { key: "friend_comments_prompt", label: "好友评论（多人）", type: "multiline", description: "刷到这条动态的人一起决定谁开口，可以一个都不回。{{moment}} {{comments}} {{candidates}}（候选人设）{{preferences}}。" },
    ],
  },
];

export default function SettingsScreen() {
  const { apiKey, baseUrl, user_nickname, ai_name, stream_output, thinking_mode, auto_focus_input, blocked_keywords, ai_retrieval_enabled, friend_preferences, customColorsLight, customColorsDark, saveApiKey, saveBaseUrl, saveUserNickname, saveAiName, saveStreamOutput, saveThinkingMode, saveAutoFocusInput, saveBlockedKeywords, saveAiRetrievalEnabled, saveFriendPreferences, saveCustomColors } = useSettingsStore();
  const clearMessages = useChatStore((s) => s.clearMessages);
  const colors = useTheme();
  const { themeMode, toggleTheme } = useThemeStore();
  const currentCustomColors = themeMode === "light" ? customColorsLight : customColorsDark;

  const [showKeyModal, setShowKeyModal] = useState(false);
  /** API Key 输入框是否显示明文（默认密文） */
  const [showKeyText, setShowKeyText] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [showAiNameModal, setShowAiNameModal] = useState(false);
  const [showBlockedModal, setShowBlockedModal] = useState(false);
  /** 连续判定失败次数与原因：Key 过期这类故障会让检索静默退回本地，这里给个出口 */
  const [retrievalFailStreak, setRetrievalFailStreak] = useState(0);
  const [retrievalFailReason, setRetrievalFailReason] = useState("");
  const [inputKey, setInputKey] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [inputNickname, setInputNickname] = useState("");
  const [inputAiName, setInputAiName] = useState("");
  const [inputBlocked, setInputBlocked] = useState("");

  // 好友圈
  const [friends, setFriends] = useState<FriendPersona[]>([]);
  const [showFriendPrefsModal, setShowFriendPrefsModal] = useState(false);
  const [inputFriendPrefs, setInputFriendPrefs] = useState("");
  const [renamingFriend, setRenamingFriend] = useState<FriendPersona | null>(null);
  const [inputFriendName, setInputFriendName] = useState("");
  const [friendBusy, setFriendBusy] = useState(false);

  // 配置编辑器状态
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorField, setEditorField] = useState<ConfigField | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const editorInputRef = useRef<TextInput>(null);

  // 各模板可用变量库
  const COMMON_VARIABLES = [
    { label: "用户名", value: "[user]" },
    { label: "当前时间", value: "[now]" },
  ];
  const TEMPLATE_VARIABLES: Record<string, { label: string; value: string }[]> = {
    system_prompt: COMMON_VARIABLES,
    cold_start_template: COMMON_VARIABLES,
    extraction_prompt: COMMON_VARIABLES,
    state_injection_template: [
      ...COMMON_VARIABLES,
      { label: "昵称", value: "{{nickname}}" },
      { label: "性别", value: "{{gender}}" },
      { label: "生日", value: "{{birthday}}" },
      { label: "职业", value: "{{occupation}}" },
      { label: "所在地", value: "{{location}}" },
      { label: "社交图谱", value: "{{social_graph}}" },
      { label: "属性（永久）", value: "{{traits}}" },
      { label: "当前处境", value: "{{conditions}}" },
      { label: "安排（未来事件）", value: "{{events}}" },
    ],
    event_reminder_template: [
      ...COMMON_VARIABLES,
      { label: "相对时间", value: "[time]" },
      { label: "事件内容", value: "{{event}}" },
      { label: "发生时刻", value: "{{due_time}}" },
    ],
    event_care_template: [
      ...COMMON_VARIABLES,
      { label: "相对时间", value: "[time]" },
      { label: "事件内容", value: "{{event}}" },
      { label: "发生时刻", value: "{{due_time}}" },
    ],
    memory_injection_template: [
      { label: "事件列表", value: "{{event_list}}" },
      { label: "灵光一闪", value: "{{epiphany}}" },
      { label: "当前时间", value: "[now]" },
    ],
  };

  // 在光标位置插入变量
  const insertVariable = (variable: string) => {
    const before = editorValue.slice(0, cursorPos);
    const after = editorValue.slice(cursorPos);
    const newValue = before + variable + after;
    setEditorValue(newValue);
    const newPos = cursorPos + variable.length;
    setCursorPos(newPos);
    // 延迟设置光标位置，确保 TextInput 更新后生效
    setTimeout(() => {
      editorInputRef.current?.setNativeProps({ selection: { start: newPos, end: newPos } });
    }, 50);
  };

  // 模型选择器
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [modelPickerTarget, setModelPickerTarget] = useState<"foreground_model" | "background_model" | "retrieval_model">("foreground_model");
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");

  // 记忆数据
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  // AI 自己的作息：本周习惯表 + 今日实况（只读，用于和实际对话表现比对）
  const [aiSchedule, setAiSchedule] = useState<{ weekStart: string; items: ReturnType<typeof getWeekSchedule> }>({ weekStart: "", items: [] });
  const [aiTodayLive, setAiTodayLive] = useState<LiveDay | null>(null);
  // 用户信息编辑
  const [editFieldModalVisible, setEditFieldModalVisible] = useState(false);
  const [editFieldLabel, setEditFieldLabel] = useState("");
  const [editFieldValue, setEditFieldValue] = useState("");
  const [editFieldKey, setEditFieldKey] = useState("");
  const [eventCount, setEventCount] = useState(0);
  const [systemPrompt, setSystemPromptState] = useState("");
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [editingEvent, setEditingEvent] = useState<MemoryEvent | null>(null);
  const [editEventText, setEditEventText] = useState("");
  const [editEventPriority, setEditEventPriority] = useState("5");
  const [editEventWeight, setEditEventWeight] = useState("100");
  const [editEventAliases, setEditEventAliases] = useState("");
  const [showEventEditor, setShowEventEditor] = useState(false);
  const [editorFragments, setEditorFragments] = useState<MemoryFragment[]>([]);
  /** 片段检索词 / 优先级的编辑草稿，按片段 id 存 */
  const [fragmentEdits, setFragmentEdits] = useState<Record<number, { keywords: string; priority: string }>>({});
  const [newFragmentSummary, setNewFragmentSummary] = useState("");
  const [newFragmentGist, setNewFragmentGist] = useState("");
  const [newFragmentKeywords, setNewFragmentKeywords] = useState("");
  const [newFragmentPriority, setNewFragmentPriority] = useState("5");
  const [deletingEvent, setDeletingEvent] = useState<MemoryEvent | null>(null);
  const [showNewEventModal, setShowNewEventModal] = useState(false);
  const [newEventText, setNewEventText] = useState("");
  const [newEventWeight, setNewEventWeight] = useState("50");
  const [newEventPriority, setNewEventPriority] = useState("5");

  // 事件详情弹窗
  const [selectedEvent, setSelectedEvent] = useState<MemoryEvent | null>(null);
  const [showEventDetail, setShowEventDetail] = useState(false);
  const [eventFragments, setEventFragments] = useState<MemoryFragment[]>([]);
  const [eventAliases, setEventAliases] = useState<string[]>([]);

  // 配置值刷新
  const [thresholds, setThresholds] = useState(getThresholds());
  const [modelRouting, setModelRouting] = useState(getModelRouting());

  // 人设编辑器
  const [personaModalVisible, setPersonaModalVisible] = useState(false);
  const [personaInput, setPersonaInput] = useState("");
  const [personaExtracting, setPersonaExtracting] = useState(false);
  const [personaResult, setPersonaResult] = useState<PersonaInfo | null>(null);
  const [personaError, setPersonaError] = useState("");

  // 自动备份恢复列表
  const [showAutoBackupList, setShowAutoBackupList] = useState(false);
  const [autoBackupFiles, setAutoBackupFiles] = useState<{ name: string; uri: string; time: string }[]>([]);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);

  /** 恢复备份后统一刷新各内存缓存，手动导入与自动备份恢复共用 */
  const reloadAfterRestore = useCallback(async () => {
    await useChatStore.getState().reloadMessages();
    await useSettingsStore.getState().loadApiKey();
    // 备份会覆盖 config_overrides，内存缓存必须跟着刷新
    await loadConfigOverrides();
    setThresholds(getThresholds());
    setModelRouting(getModelRouting());
    setSystemPromptState(getSystemPrompt());
  }, []);

  /**
   * 列表含兜底事件「日常闲聊」，新建/编辑/删除后也走这里刷新。
   * 排序按现算的实际权重降序（同分再看最近被想起的时刻）——库里的 active_weight
   * 命中时都刷成 100，按它排等于按创建顺序排，看不出谁快被忘了。
   */
  const reloadEvents = useCallback(() => {
    const defaultId = getDefaultEventId();
    const defaultEvt = defaultId ? getEventById(defaultId) : null;
    const rest = getTopActive(999)
      .filter((e) => e.id !== defaultId)
      .sort(
        (a, b) =>
          liveWeightOf(b) - liveWeightOf(a) ||
          (b.last_accessed ?? "").localeCompare(a.last_accessed ?? "")
      );
    return defaultEvt ? [defaultEvt, ...rest] : rest;
  }, []);

  /** 读一次 AI 的本周习惯表与今日实况：实况由聊天页/动态引擎生成，这里只读 */
  const reloadAiRoutine = useCallback(() => {
    const weekStart = getWeekStart();
    setAiSchedule({ weekStart, items: getWeekSchedule(weekStart) });
    setAiTodayLive(getLiveDay(dayKey()));
  }, []);

  useFocusEffect(
    useCallback(() => {
      setUserInfo(getUserInfo());
      setEventCount(getActiveCount());
      setSystemPromptState(getSystemPrompt());
      setThresholds(getThresholds());
      setModelRouting(getModelRouting());
      setEvents(reloadEvents());
      setFriends(getAllFriends().filter((f) => !f.is_deleted));
      setRetrievalFailStreak(Number(getMeta("retrieval_fail_streak") ?? 0));
      setRetrievalFailReason(getMeta("retrieval_fail_reason") ?? "");
      reloadAiRoutine();
    }, [reloadEvents, reloadAiRoutine]),
  );

  const handleSaveKey = async () => {
    const key = inputKey.trim();
    if (!key) return;
    await saveApiKey(key);
    setShowKeyModal(false);
  };

  const handleSaveUrl = async () => {
    const url = inputUrl.trim();
    if (!url) return;
    await saveBaseUrl(url);
    setShowUrlModal(false);
  };

  const handleSaveNickname = async () => {
    // 称呼的唯一写入口（写入 user_info 画像）
    await saveUserNickname(inputNickname);
    setShowNicknameModal(false);
  };

  const handleSaveAiName = async () => {
    await saveAiName(inputAiName);
    setShowAiNameModal(false);
  };

  const handleSaveBlocked = async () => {
    await saveBlockedKeywords(inputBlocked);
    setShowBlockedModal(false);
  };

  // --- 好友圈 ---

  const reloadFriends = () => setFriends(getAllFriends().filter((f) => !f.is_deleted));

  const handleSaveFriendPrefs = async () => {
    await saveFriendPreferences(inputFriendPrefs);
    setShowFriendPrefsModal(false);

    // 首秀前：引擎会静默按新偏好重掷，不打扰；
    // 首秀后：给出二选一——默认只影响以后，也可以主动按偏好重建（重建会丢关系）
    const debuted = getAllFriends().some(
      (f) =>
        f.is_active === 1 &&
        !f.is_deleted &&
        !!f.debut_at &&
        !dayjs(f.debut_at).isAfter(dayjs())
    );
    if (!debuted) return;

    Alert.alert(
      "偏好已保存",
      "已经出现过的朋友不会自动改动。要按新偏好重建花名册吗？（重建后旧人会停用）",
      [
        { text: "只影响以后", style: "cancel" },
        { text: "按偏好重建", onPress: handleRebuildFriends },
      ]
    );
  };

  const handleRenameFriend = () => {
    const name = inputFriendName.trim();
    if (!renamingFriend || !name) return;
    updateFriendName(renamingFriend.id, name);
    setRenamingFriend(null);
    reloadFriends();
  };

  const handleToggleFriend = (f: FriendPersona) => {
    setFriendActive(f.id, f.is_active !== 1);
    reloadFriends();
  };

  const handleDeleteFriend = (f: FriendPersona) => {
    Alert.alert(
      "删除这位朋友？",
      `${f.name} 会从你的生活里消失。以前认识过的记忆不会被抹掉，但 ta 不会再出现。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            deleteFriendPersona(f.id);
            reloadFriends();
          },
        },
      ]
    );
  };

  const handleReplaceFriend = (f: FriendPersona) => {
    Alert.alert("换一个朋友？", `${f.name} 会下线，补一位新人。这不要求新人接替原来的关系定位。`, [
      { text: "取消", style: "cancel" },
      {
        text: "换一个",
        onPress: () => {
          void (async () => {
            setFriendBusy(true);
            const ok = await replaceFriend(f.id);
            setFriendBusy(false);
            reloadFriends();
            if (!ok) Alert.alert("没换成", "生成失败了，可能网络或模型有问题，稍后再试。");
          })();
        },
      },
    ]);
  };

  const handleRebuildFriends = () => {
    Alert.alert(
      "重建好友圈？",
      "现有的朋友会全部停用，重新生成一批新人。以前认识过的记忆会保留，但这些人不会再出现。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "重建",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setFriendBusy(true);
              const ok = await rebuildFriendRoster();
              setFriendBusy(false);
              reloadFriends();
              if (!ok) Alert.alert("重建失败", "生成失败了，稍后再试。旧朋友已停用。");
            })();
          },
        },
      ]
    );
  };

  const handleCreateEvent = () => {
    const text = newEventText.trim();
    const weight = parseInt(newEventWeight) || 50;
    const priority = parseInt(newEventPriority) || 5;
    if (!text) return;
    insertEvent(text, Math.min(100, Math.max(1, weight)), Math.min(9, Math.max(1, priority)));
    setEvents(reloadEvents());
    setEventCount(getActiveCount());
    setShowNewEventModal(false);
  };

  /** 打开事件编辑器：载入事件与片段的可编辑参数 */
  const openEventEditor = (evt: MemoryEvent) => {
    const frags = getFragmentsByEventId(evt.id);
    const edits: Record<number, { keywords: string; priority: string }> = {};
    for (const f of frags) edits[f.id] = { keywords: f.keywords, priority: String(f.priority) };
    setEditingEvent(evt);
    setEditEventText(evt.event_text);
    setEditEventPriority(String(evt.priority));
    setEditEventWeight(String(evt.active_weight));
    setEditEventAliases(getEventAliases(evt.id).join("、"));
    setEditorFragments(frags);
    setFragmentEdits(edits);
    setNewFragmentSummary("");
    setNewFragmentGist("");
    setNewFragmentKeywords("");
    setNewFragmentPriority("5");
    setShowEventEditor(true);
  };

  /** 保存事件与片段的可编辑参数 */
  const handleSaveEvent = () => {
    if (!editingEvent || !editEventText.trim()) return;
    const priority = Math.min(9, Math.max(1, parseInt(editEventPriority) || 5));
    const weight = Math.min(100, Math.max(1, parseInt(editEventWeight) || 100));
    updateEventParams(editingEvent.id, editEventText.trim(), priority, weight);
    replaceEventAliases(editingEvent.id, editEventAliases);
    for (const frag of editorFragments) {
      const edit = fragmentEdits[frag.id];
      if (!edit) continue;
      updateFragmentParams(
        frag.id,
        edit.keywords.trim(),
        Math.min(9, Math.max(1, parseInt(edit.priority) || 5))
      );
    }
    setEvents(reloadEvents());
    setEventCount(getActiveCount());
    setShowEventEditor(false);
  };

  const handleCreateFragment = () => {
    if (!editingEvent || !newFragmentSummary.trim()) return;
    const priority = parseInt(newFragmentPriority) || 5;
    // 一句话概要留空时由摘要截取，保证分层渲染有内容
    const gist = newFragmentGist.trim() || newFragmentSummary.trim().slice(0, 24);
    insertFragment(editingEvent.id, gist, newFragmentSummary.trim(), Math.min(9, Math.max(1, priority)), newFragmentKeywords.trim());
    setEditorFragments(getFragmentsByEventId(editingEvent.id));
    setNewFragmentSummary("");
    setNewFragmentGist("");
    setNewFragmentKeywords("");
    setNewFragmentPriority("5");
  };

  // 获取模型列表
  const handleFetchModels = async (target: "foreground_model" | "background_model" | "retrieval_model") => {
    setModelPickerTarget(target);
    setModelPickerVisible(true);
    setModelLoading(true);
    setModelError("");
    setModelList([]);
    try {
      const models = await fetchModels();
      setModelList(models);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "获取失败";
      setModelError(msg);
    } finally {
      setModelLoading(false);
    }
  };

  // 选择模型
  const handleSelectModel = async (modelId: string) => {
    await setConfigOverride(modelPickerTarget, modelId);
    setModelRouting(getModelRouting());
    setModelPickerVisible(false);
  };

  // 打开配置编辑器
  const openEditor = (title: string, field: ConfigField, currentValue: string) => {
    setEditorTitle(title);
    setEditorField(field);
    setEditorValue(currentValue);
    setPreviewMode(false);
    setEditorVisible(true);
  };

  // 是否为提示词类型（可预览）
  const isPreviewable = (key: string) => {
    return ["system_prompt", "state_injection_template", "memory_injection_template", "extraction_prompt", "cold_start_template"].includes(key);
  };

  // 渲染状态区模板（用 editorValue 替换 {{}}），空字段整行移除
  const EMPTY = "__EMPTY__";
  const renderStateTemplate = (template: string, ui: UserInfo): string => {
    const bi = ui.basic_identity;
    const sg = ui.social_graph;
    const nickname = bi.nickname || "用户";
    const graphText = sg.length > 0 ? sg.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ") : EMPTY;
    // 当前处境：仍在持续的 condition 事件，标出从哪天开始；未来事件带发生时刻
    const conditions = getActiveConditions();
    const conditionsText = conditions.length > 0
      ? conditions.map((c) => `- ${replaceFragmentPlaceholder(c.event_text, c.timestamp, nickname, ai_name)}（${dayjs(c.timestamp).format("M/D")} 起）`).join("\n")
      : EMPTY;
    const appointments = getUpcomingEvents();
    const eventsText = appointments.length > 0
      ? appointments
          .map((e) => `${replaceFragmentPlaceholder(e.event_text, e.timestamp, nickname, ai_name)}（${dayjs(e.timestamp).format("M/D HH:mm")}）`)
          .join("\n")
      : EMPTY;
    const result = normalizePlaceholders(template)
      .replace(/\{\{nickname\}\}/g, () => nickname)
      .replace(/\{\{gender\}\}/g, bi.gender || EMPTY)
      .replace(/\{\{birthday\}\}/g, bi.birthday || EMPTY)
      .replace(/\{\{occupation\}\}/g, bi.occupation || "未知")
      .replace(/\{\{location\}\}/g, bi.location || "未知")
      .replace(/\{\{traits\}\}/g, ui.traits.length > 0 ? ui.traits.join("、") : EMPTY)
      .replace(/\{\{social_graph\}\}/g, graphText)
      .replace(/\{\{conditions\}\}/g, conditionsText)
      .replace(/\{\{events\}\}/g, eventsText)
      // 老模板里可能还留着这两个变量：渲染成空行清掉
      .replace(/\{\{friends\}\}/g, EMPTY)
      .replace(/\{\{current_status\}\}/g, EMPTY)
      // 通用变量
      .replace(/\[user\]/gi, () => nickname)
      .replace(/\[ai\]/gi, () => ai_name || "私藏")
      .replace(/\[now\]/g, () => new Date().toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }))
      .replace(/\[today\]/g, () => formatTodayLine());
    // 移除空值行和空段落标题
    return result.split("\n").filter(line => !line.includes(EMPTY)).join("\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  };

  // 渲染记忆区预览
  const renderMemorySection = (
    events: ReturnType<typeof getTopActive>,
    memInjectTplOverride?: string
  ): string => {
    const nickname = user_nickname || "用户";
    const aiName = ai_name || "私藏";
    const prompts = getPrompts();
    const injectTpl = normalizePlaceholders(memInjectTplOverride || prompts.memory_injection_template);

    // 预览用事件名当一行片段占位
    const eventLines = events.map((e) => {
      const text = normalizePlaceholders(e.event_text)
        .replace(/\[user\]/gi, nickname)
        .replace(/\[ai\]/gi, aiName);
      return `  · ${text}`;
    });

    if (injectTpl && injectTpl.includes("{{")) {
      return injectTpl
        .replace(/\{\{event_list\}\}/g, eventLines.join("\n"))
        .replace(/\{\{epiphany\}\}/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    return eventLines.join("\n");
  };

  // 构建预览文本（展示完整 system prompt 拼接结果）
  const buildPreview = (): string => {
    const key = editorField?.key ?? "";
    const ui = getUserInfo();
    const nickname = user_nickname || "用户";
    const prompts = getPrompts();

    // 获取当前各段的实际值（编辑中的值优先）
    const fillIdentity = (text: string) =>
      normalizePlaceholders(text)
        .replace(/\[user\]/gi, nickname)
        .replace(/\[ai\]/gi, ai_name || "私藏");
    const getSysPrompt = () => fillIdentity(key === "system_prompt" ? editorValue : prompts.system_prompt);
    const getStateInfo = () => {
      const tpl = key === "state_injection_template" ? editorValue : prompts.state_injection_template;
      if (!ui) return "";
      return tpl.includes("{{") ? renderStateTemplate(tpl, ui) : "（模板无变量占位符）";
    };
    switch (key) {
      // ===== 系统人设：展示人设内容 =====
      case "system_prompt": {
        const sections: string[] = [];
        sections.push("━━━ 系统人设（当前编辑）━━━");
        sections.push(getSysPrompt());
        sections.push("", "━━━ 渲染效果 ━━━");
        sections.push("作为独立 system message 发送，缓存命中率最高。");
        sections.push(`紧随其后另有一条独立的消息：「${formatTodayLine()}」（同一天内恒定）。`);
        return sections.join("\n");
      }

      // ===== 状态区模板：展示渲染后的状态区 =====
      case "state_injection_template": {
        const sections: string[] = [];
        sections.push("━━━ 状态区模板（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果 ━━━");
        if (ui) {
          sections.push(renderStateTemplate(editorValue, ui));
        } else {
          sections.push("（暂无用户数据，无法渲染）");
        }
        return sections.join("\n");
      }

      // ===== 记忆区注入模板 =====
      case "memory_injection_template": {
        const sections: string[] = [];
        sections.push("━━━ 记忆区注入模板（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果 ━━━");
        const events = getTopActive(10);
        const memSection = renderMemorySection(events, editorValue);
        sections.push(memSection);
        return sections.join("\n");
      }

      case "cold_start_template": {
        const sysPrompt = getSysPrompt();
        const coldStart = fillIdentity(editorValue);
        const fullSys = [sysPrompt, coldStart].filter(Boolean).join("\n\n");
        return fullSys;
      }

      // ===== 提取指令：按真实请求结构展示（固定段 + 历史 + 动态块）=====
      case "extraction_prompt": {
        const candidates = getTopActive(5);
        const lines: string[] = [];
        lines.push("━━━ [system] 固定段（每次一致，可命中前缀缓存）━━━");
        lines.push(editorValue);
        lines.push("");
        lines.push("## 输出格式（严格 JSON）");
        lines.push('{"new_info": {...}, "new_fragments": [{gist, summary, keywords, priority, target_event_index, new_event_text, happens_at, condition, condition_ended}], "event_merges": [{"keep": 数字, "merge": [数字], "reason": "..."}], "session_digest": "..."}');
        lines.push("");
        lines.push("━━━ [history] 游标之后的新对话（多条消息）━━━");
        lines.push("[21:02] （相邻消息断开 ≥30 分钟时，段首标一次时刻；同一天只写时刻，跨天补日期）");
        lines.push("（用户说了什么）");
        lines.push("（AI 回了什么）");
        lines.push("[22:05] （再断开时另标一次）");
        lines.push("");
        lines.push("━━━ [user] 动态块（放最后，不打断前缀）━━━");
        lines.push("## 当前时间");
        lines.push("（本批最后一条消息的时间）");
        lines.push("片段事发时间写 [time] 占位符；历史里的时刻标签只用来判断先后与间隔，不写进片段。");
        lines.push("");
        lines.push("## 已有数据（不需要重复提取）");
        lines.push(`属性：${ui?.traits?.join("、") || "（无）"}`);
        lines.push(`当前处境：${getActiveConditions().map((c) => c.event_text).join("、") || "（无）"}`);
        lines.push(`近期会发生的事：${getUpcomingEvents().map((e) => `${e.event_text}（${dayjs(e.timestamp).format("M/D HH:mm")}）`).join("、") || "（无）"}`);
        lines.push(`社交关系：${ui?.social_graph?.map((s) => `${s.name}(${s.role})`).join("、") || "（无）"}`);
        lines.push("");
        lines.push("## 上次摘要（有则展示，供更新）");
        lines.push("（上一次巩固生成的 200~300 字摘要）");
        lines.push("");
        lines.push("## 候选事件（关键词倒排 3~5 个）");
        if (candidates.length === 0) {
          lines.push("（暂无相关事件，请为本次对话创建新事件）");
        } else {
          for (const e of candidates) {
            lines.push(`- [id:${e.id}] ${e.event_text}`);
            lines.push("  · （最早 1 条 + 最近 2 条片段，保持原文含 [time]/[user] 占位符）");
          }
        }
        lines.push("");
        lines.push("## 任务");
        lines.push("提取 new_info / new_fragments / event_merges / session_digest；片段优先挂靠候选事件。");
        return lines.join("\n");
      }

      default:
        return editorValue;
    }
  };

  // 保存配置
  const handleSaveConfig = async () => {
    if (!editorField) return;
    await setConfigOverride(editorField.key, editorValue.trim());

    // 刷新所有配置
    setThresholds(getThresholds());
    setModelRouting(getModelRouting());
    setSystemPromptState(getSystemPrompt());
    setEditorVisible(false);
  };

  // 恢复默认
  const handleResetConfig = async () => {
    if (!editorField) return;
    await resetConfigOverride(editorField.key);
    setThresholds(getThresholds());
    setModelRouting(getModelRouting());
    setSystemPromptState(getSystemPrompt());
    setEditorVisible(false);
  };

  const handleClearData = () => {
    Alert.alert("清除所有数据", "确定要清除所有聊天记录和记忆数据吗？此操作不可恢复。", [
      { text: "取消", style: "cancel" },
      {
        text: "确认清除",
        style: "destructive",
        onPress: () => {
          clearMessages();
          clearAllData();
          reloadFriends();
          setUserInfo(null);
          setEventCount(0);
          Alert.alert("已清除", "所有数据已清除，下次对话将触发冷启动。");
        },
      },
    ]);
  };

  // 人设提取：用户输入一段话 → LLM 解析为 UserInfo
  const handleExtractPersona = async () => {
    const text = personaInput.trim();
    if (!text) return;
    setPersonaExtracting(true);
    setPersonaError("");
    setPersonaResult(null);

    const prompt = `你是一个用户画像提取引擎。从以下文本中提取用户信息，输出严格 JSON。

文本：
${text}

输出格式（属性 / 当前处境）：
{
  "basic_identity": {"nickname":"", "gender":"", "birthday":"", "occupation":"", "location":""},
  "social_graph": [],
  "traits": [],
  "conditions": []
}

规则：
- 只提取文本中明确提到的信息，不要推测
- 未提到的字段留空字符串或空数组
- traits（属性，永久有效）：喜好/厌恶/性格/能力/长期目标等，如「喜欢吃番茄炒蛋」
- conditions（仍在持续的处境）：还在进行、会结束的事，每条写成 2~8 字标签，如「感冒」「在考研」「在赶项目」
- 已经过去的一次性经历不要放进 conditions
- 未来的约定（如「周五面试」）不用在这里提取，正常聊天时会进记忆
- social_graph 暂时留空数组
- 只输出 JSON，不要其他文字`;

    try {
      const client = getClient();
      const config = getModelRouting().background_extraction_config;
      const response = await client.chat.completions.create({
        model: config.model,
        temperature: 0.0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是一个用户画像提取引擎，只输出 JSON。" },
          { role: "user", content: prompt },
        ],
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error("AI 返回为空");

      const parsed = JSON.parse(raw) as PersonaInfo;
      // 基础校验
      if (!parsed.basic_identity) {
        throw new Error("返回格式不正确");
      }
      setPersonaResult(parsed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "提取失败";
      setPersonaError(msg);
    } finally {
      setPersonaExtracting(false);
    }
  };

  // 确认合并人设
  const handleMergePersona = () => {
    if (!personaResult) return;
    mergeUserInfo(personaResult);
    // 仍在持续的处境落成 condition 事件：手动录入也算「现在还在」
    for (const label of personaResult.conditions ?? []) {
      const text = label.trim();
      if (text) startCondition(text, 5, new Date().toISOString());
    }
    setUserInfo(getUserInfo());
    setPersonaModalVisible(false);
    setPersonaInput("");
    setPersonaResult(null);
    Alert.alert("已更新", "用户画像已合并更新。");
  };

  // 通用配置行
  const renderConfigRow = (sectionTitle: string, field: ConfigField, currentValue: string) => {
    const isChanged = currentValue !== getConfigDefault(field.key);
    return (
      <TouchableOpacity
        key={field.key}
        style={[styles.row, { borderBottomColor: colors.border }]}
        onPress={() => openEditor(sectionTitle, field, currentValue)}
      >
        <View style={styles.rowLeft}>
          <Text style={[styles.label, { color: colors.text }]}>{field.label}</Text>
          {field.description ? <Text style={[styles.rowDesc, { color: colors.textMuted }]}>{field.description}</Text> : null}
        </View>
        <View style={styles.rowRight}>
          <Text style={[styles.value, { color: colors.textMuted }, isChanged && { color: colors.accent }]} numberOfLines={1}>
            {field.type === "multiline" ? (isChanged ? "已编辑" : "默认") : currentValue}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // 用户信息摘要（可编辑）
  const openEditField = (label: string, key: string, value: string) => {
    setEditFieldLabel(label);
    setEditFieldKey(key);
    setEditFieldValue(value);
    setEditFieldModalVisible(true);
  };

  const saveEditField = () => {
    if (!userInfo) return;
    const val = editFieldValue.trim();
    const updated: UserInfo = {
      ...userInfo,
      basic_identity: { ...userInfo.basic_identity },
    };

    switch (editFieldKey) {
      case "nickname": updated.basic_identity.nickname = val; break;
      case "gender": updated.basic_identity.gender = val; break;
      case "birthday": updated.basic_identity.birthday = val; break;
      case "occupation": updated.basic_identity.occupation = val; break;
      case "location": updated.basic_identity.location = val; break;
      case "traits":
        updated.traits = val ? val.split(/[,，、\n]+/).filter(Boolean) : [];
        break;
      case "conditions": {
        // 处境是内存事件不是画像字段：删掉的等于「结束了」，新增的等于「现在还在」
        const nowIso = new Date().toISOString();
        const next = val ? val.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean) : [];
        const current = getActiveConditions();
        for (const c of current) {
          if (!next.includes(c.event_text)) resolveCondition(c.id, nowIso);
        }
        for (const label of next) {
          if (!current.some((c) => c.event_text === label)) startCondition(label, 5, nowIso);
        }
        // 处境不在 user_info 里，换一个对象引用让列表重新读一遍
        setUserInfo(getUserInfo());
        setEditFieldModalVisible(false);
        return;
      }
      default: return;
    }

    if (editFieldKey === "nickname") {
      // 称呼的唯一写入口（写库 + 同步内存镜像）
      saveUserNickname(val);
    }
    // 手动编辑是替换语义（删掉的条目要真正消失），直接全量落库
    setUserInfo(updated);
    persistUserInfo(updated);
    setEditFieldModalVisible(false);
  };

  const renderUserInfo = () => {
    if (!userInfo) return <Text style={[styles.emptyText, { color: colors.textMuted }]}>暂无用户数据</Text>;

    const { basic_identity, social_graph, traits } = userInfo;
    const appointments = getUpcomingEvents();
    const conditions = getActiveConditions();

    const Row = ({ label, value, fieldKey, fieldValue }: { label: string; value: string; fieldKey: string; fieldValue: string }) => (
      <TouchableOpacity style={[styles.editableRow, { borderBottomColor: colors.border }]} onPress={() => openEditField(label, fieldKey, fieldValue)}>
        <Text style={[styles.editableLabel, { color: colors.textMuted }]}>{label}</Text>
        <Text style={[styles.editableValue, { color: colors.text }]}>{value || "点击编辑"}</Text>
      </TouchableOpacity>
    );

    return (
      <>
        <Row label="昵称" value={basic_identity.nickname} fieldKey="nickname" fieldValue={basic_identity.nickname} />
        <Row label="性别" value={basic_identity.gender} fieldKey="gender" fieldValue={basic_identity.gender} />
        <Row label="生日" value={basic_identity.birthday} fieldKey="birthday" fieldValue={basic_identity.birthday} />
        <Row label="职业" value={basic_identity.occupation} fieldKey="occupation" fieldValue={basic_identity.occupation} />
        <Row label="城市" value={basic_identity.location} fieldKey="location" fieldValue={basic_identity.location} />
        {social_graph.length > 0 && (
          <View style={[styles.editableRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.editableLabel, { color: colors.textMuted }]}>社交</Text>
            <Text style={[styles.editableValue, { color: colors.text }]}>{social_graph.map((s) => `${s.name}(${s.role})`).join("、")}</Text>
          </View>
        )}
        <Row label="属性（永久）" value={traits.join("、")} fieldKey="traits" fieldValue={traits.join("、")} />
        <Row
          label="当前处境"
          value={conditions
            .map((c) => `${c.event_text} · ${dayjs(c.timestamp).format("M/D")} 起`)
            .join("、")}
          fieldKey="conditions"
          fieldValue={conditions.map((c) => c.event_text).join("、")}
        />
        {appointments.length > 0 && (
          <View style={[styles.editableRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.editableLabel, { color: colors.textMuted }]}>安排</Text>
            <Text style={[styles.editableValue, { color: colors.text }]}>
              {appointments
                .map((e) => `${e.event_text}(${dayjs(e.timestamp).format("M/D HH:mm")})`)
                .join("、")}
            </Text>
          </View>
        )}
      </>
    );
  };

  /** AI 自己的作息：今日实况逐格对照习惯，外加本周习惯表（只读） */
  const renderAiRoutine = () => {
    const todayIdx = getCurrentDayOfWeek();
    const nowSlot = getCurrentTimeSlot(dayjs().hour());
    const live = aiTodayLive;
    const baseOf = (day: number, slot: number) =>
      applyIdentityPlaceholders(
        aiSchedule.items.find((i) => i.day_of_week === day && i.time_slot === slot)?.activity ?? ""
      );

    const head = `今天 ${dayjs().format("M/D")}（${WEEK_DAY_LABELS[todayIdx]}）`;
    const todayLines: string[] = [live ? head : `${head} · 今天还没有实况，聊天时按习惯表兜底`];
    if (live) {
      const meta = [
        live.highlight ? `主线：${applyIdentityPlaceholders(live.highlight)}` : "",
        live.mood ? `心情：${live.mood}` : "",
        live.weather ? `天气：${live.weather}` : "",
      ]
        .filter(Boolean)
        .join(" ｜ ");
      if (meta) todayLines.push(meta);
    }
    todayLines.push(`凌晨：${applyIdentityPlaceholders(live?.lateNight || getLateNight(dayKey()))}`);

    for (let slot = 0; slot < 5; slot++) {
      const liveText = applyIdentityPlaceholders(live?.slots[slot]?.trim() ?? "");
      const baseText = baseOf(todayIdx, slot);
      todayLines.push(`${TIME_SLOT_LABELS[slot]}${slot === nowSlot ? " ← 当前" : ""}`);
      todayLines.push(`　实况：${liveText || (live ? "（留白，按习惯）" : "（还没生成）")}`);
      todayLines.push(`　习惯：${baseText || "（没排）"}`);
    }

    const weekLines = WEEK_DAY_LABELS.map((label, day) => {
      const items = aiSchedule.items
        .filter((i) => i.day_of_week === day)
        .sort((a, b) => a.time_slot - b.time_slot);
      const body =
        items.length > 0
          ? items
              .map((i) => `${SHORT_SLOT_LABELS[i.time_slot]} ${applyIdentityPlaceholders(i.activity)}`)
              .join(" · ")
          : "（没排）";
      return `${day === todayIdx ? "▸ " : ""}${label}${day === todayIdx ? "（今天）" : ""}\n　${body}`;
    });

    return (
      <>
        <Text style={[styles.infoTitle, { color: colors.text }]}>今日实况 vs 习惯</Text>
        <Text style={[styles.infoLine, { color: colors.text }]}>{todayLines.join("\n")}</Text>
        <Text style={[styles.infoTitle, { color: colors.text, marginTop: 14 }]}>
          本周习惯（{aiSchedule.weekStart || "—"} 起）
        </Text>
        {aiSchedule.items.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            本周习惯表还没生成，进一次聊天页会自动生成
          </Text>
        ) : (
          <Text style={[styles.infoLine, { color: colors.text }]}>{weekLines.join("\n")}</Text>
        )}
      </>
    );
  };

  const thresholdsVal = thresholds as Record<string, number>;
  // 未来事件就是 timestamp 在未来的记忆事件，渲染时直接查一次
  const appointmentList = getUpcomingEvents();
  const bgRouting = modelRouting.background_extraction_config;
  const fgRouting = modelRouting.foreground_chat_config;
  const judgeRouting = modelRouting.retrieval_judge_config;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={styles.scrollContent}>
      {/* 外观 */}
      <CollapsibleSection title="外观" icon="🎨" defaultExpanded={false}>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={toggleTheme}>
          <Text style={[styles.label, { color: colors.text }]}>深色模式</Text>
          <Text style={[styles.value, { color: colors.accent }]}>{themeMode === "dark" ? "已开启" : "已关闭"}</Text>
        </TouchableOpacity>

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>聊天气泡颜色（{themeMode === "dark" ? "深色" : "浅色"}模式）</Text>

        {/* 用户消息背景 */}
        <View style={[styles.colorRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.text }]}>用户消息背景</Text>
          <View style={styles.colorChips}>
            {(themeMode === "light"
              ? ["#FFE4E1", "#FFD1DC", "#E8D0F0", "#D0E8F0", "#D0F0D8", "#F5E8C0", "#F0D8C0", "#E0E0F0"]
              : ["#8B4A4A", "#4A8B4A", "#4A4A8B", "#8B8B4A", "#8B4A8B", "#4A8B8B", "#7A5A3A", "#6A6A6A"]
            ).map((c) => (
              <TouchableOpacity
                key={c}
                style={[
                  styles.colorChip,
                  { backgroundColor: c, borderColor: currentCustomColors.bubbleUserBg === c ? colors.accent : colors.border },
                  currentCustomColors.bubbleUserBg === c && styles.colorChipActive,
                ]}
                onPress={() => saveCustomColors({ bubbleUserBg: c }, themeMode)}
                accessibilityRole="radio"
                accessibilityLabel={`用户消息背景 ${c}`}
                accessibilityState={{ selected: currentCustomColors.bubbleUserBg === c }}
              />
            ))}
          </View>
        </View>

        {/* 用户消息文字 */}
        <View style={[styles.colorRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.text }]}>用户消息文字</Text>
          <View style={styles.colorChips}>
            {(themeMode === "light"
              ? ["#000000", "#333333", "#5D524A", "#4A5568", "#5D4A4A", "#4A5D4A", "#8B4513", "#FFFFFF"]
              : ["#FFFFFF", "#F0F0F0", "#E0D8D0", "#D0D8E0", "#E0D0D0", "#D0E0D0", "#D0D0D0", "#E8E0D8"]
            ).map((c) => (
              <TouchableOpacity
                key={c}
                style={[
                  styles.colorChip,
                  { backgroundColor: c, borderColor: currentCustomColors.bubbleUserText === c ? colors.accent : colors.border },
                  currentCustomColors.bubbleUserText === c && styles.colorChipActive,
                ]}
                onPress={() => saveCustomColors({ bubbleUserText: c }, themeMode)}
                accessibilityRole="radio"
                accessibilityLabel={`用户消息文字颜色 ${c}`}
                accessibilityState={{ selected: currentCustomColors.bubbleUserText === c }}
              />
            ))}
          </View>
        </View>

        {/* AI 消息背景 */}
        <View style={[styles.colorRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.text }]}>AI 消息背景</Text>
          <View style={styles.colorChips}>
            {(themeMode === "light"
              ? ["#FFFFFF", "#F5F5F5", "#FAF5F0", "#F0F0FA", "#F0FAF5", "#FFF5F0", "#F5F0FA", "#F0F5FA"]
              : ["#000000", "#1A1A1A", "#2A2A2A", "#1A1A2E", "#2E1A1A", "#1A2E1A", "#2E1A2E", "#1A2E2E"]
            ).map((c) => (
              <TouchableOpacity
                key={c}
                style={[
                  styles.colorChip,
                  { backgroundColor: c, borderColor: currentCustomColors.bubbleAiBg === c ? colors.accent : colors.border },
                  currentCustomColors.bubbleAiBg === c && styles.colorChipActive,
                ]}
                onPress={() => saveCustomColors({ bubbleAiBg: c }, themeMode)}
                accessibilityRole="radio"
                accessibilityLabel={`AI 消息背景 ${c}`}
                accessibilityState={{ selected: currentCustomColors.bubbleAiBg === c }}
              />
            ))}
          </View>
        </View>

        {/* AI 消息文字 */}
        <View style={[styles.colorRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.text }]}>AI 消息文字</Text>
          <View style={styles.colorChips}>
            {(themeMode === "light"
              ? ["#000000", "#333333", "#6B6560", "#555450", "#795548", "#5D4037", "#8B6B4A", "#6B4226"]
              : ["#FFFFFF", "#E8E8E8", "#B0A89E", "#A0A0A0", "#BCAAA4", "#D7CCC8", "#D0C8C0", "#C8C0B8"]
            ).map((c) => (
              <TouchableOpacity
                key={c}
                style={[
                  styles.colorChip,
                  { backgroundColor: c, borderColor: currentCustomColors.bubbleAiText === c ? colors.accent : colors.border },
                  currentCustomColors.bubbleAiText === c && styles.colorChipActive,
                ]}
                onPress={() => saveCustomColors({ bubbleAiText: c }, themeMode)}
                accessibilityRole="radio"
                accessibilityLabel={`AI 消息文字颜色 ${c}`}
                accessibilityState={{ selected: currentCustomColors.bubbleAiText === c }}
              />
            ))}
          </View>
        </View>
      </CollapsibleSection>

      {/* API */}
      <CollapsibleSection title="API" icon="🔑" defaultExpanded={true}>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputUrl(baseUrl); setShowUrlModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>API 地址</Text>
          <Text style={[styles.value, { color: colors.textMuted }]} numberOfLines={1}>{baseUrl.replace(/^https?:\/\//, "")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputKey(apiKey); setShowKeyText(false); setShowKeyModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{apiKey ? maskApiKey(apiKey) : "未设置"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputAiName(ai_name); setShowAiNameModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>怎么称呼 TA</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{ai_name || "未设置"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputNickname(user_nickname); setShowNicknameModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>AI 怎么称呼你</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{user_nickname || "未设置"}</Text>
        </TouchableOpacity>
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>流式输出</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>逐字显示，首字更快（网络不稳定时可关闭）</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, { backgroundColor: stream_output ? colors.accent : colors.btnBg }]}
            onPress={() => saveStreamOutput(!stream_output)}
            accessibilityRole="switch"
            accessibilityLabel="流式输出"
            accessibilityState={{ checked: stream_output }}
          >
            <Text style={[styles.toggleText, { color: stream_output ? colors.accentText : colors.textMuted }]}>
              {stream_output ? "开" : "关"}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>思考模式</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>AI 输出带思考过程（仅 DeepSeek 等支持模型）</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, { backgroundColor: thinking_mode ? colors.accent : colors.btnBg }]}
            onPress={() => saveThinkingMode(!thinking_mode)}
            accessibilityRole="switch"
            accessibilityLabel="思考模式"
            accessibilityState={{ checked: thinking_mode }}
          >
            <Text style={[styles.toggleText, { color: thinking_mode ? colors.accentText : colors.textMuted }]}>
              {thinking_mode ? "开" : "关"}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>自动弹起输入框</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>回复完成后自动聚焦输入框，方便继续输入</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, { backgroundColor: auto_focus_input ? colors.accent : colors.btnBg }]}
            onPress={() => saveAutoFocusInput(!auto_focus_input)}
            accessibilityRole="switch"
            accessibilityLabel="自动弹起输入框"
            accessibilityState={{ checked: auto_focus_input }}
          >
            <Text style={[styles.toggleText, { color: auto_focus_input ? colors.accentText : colors.textMuted }]}>
              {auto_focus_input ? "开" : "关"}
            </Text>
          </TouchableOpacity>
        </View>
      </CollapsibleSection>

      {/* 模型路由 */}
      <CollapsibleSection title="模型路由" icon="🤖" defaultExpanded={false}>

        {/* 前台模型 */}
        <View style={[styles.modelRow, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>前台对话模型</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>用户交互用，建议高质量模型</Text>
          </View>
          <View style={styles.modelActions}>
            <Text style={[styles.modelValue, { color: colors.accent }]}>{fgRouting.model}</Text>
            <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels("foreground_model")}>
              <Text style={[styles.fetchBtnText, { color: colors.text }]}>获取</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderConfigRow("模型路由", { key: "foreground_temperature", label: "对话温度", type: "number", description: "0-2，越高越有创意" }, String(fgRouting.temperature))}

        {/* 后台模型 */}
        <View style={[styles.modelRow, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>后台巩固模型</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>巩固用，建议低成本模型</Text>
          </View>
          <View style={styles.modelActions}>
            <Text style={[styles.modelValue, { color: colors.accent }]}>{bgRouting.model}</Text>
            <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels("background_model")}>
              <Text style={[styles.fetchBtnText, { color: colors.text }]}>获取</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderConfigRow("模型路由", { key: "background_temperature", label: "巩固温度", type: "number", description: "建议 0，追求结构稳定" }, String(bgRouting.temperature))}

        {/* 检索判定模型 */}
        <View style={[styles.modelRow, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>后台检索模型</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>每轮判断这句话想起哪些往事，建议用便宜快速的模型</Text>
          </View>
          <View style={styles.modelActions}>
            <Text style={[styles.modelValue, { color: colors.accent }]} numberOfLines={1}>{judgeRouting.model}</Text>
            <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels("retrieval_model")}>
              <Text style={[styles.fetchBtnText, { color: colors.text }]}>获取</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderConfigRow("模型路由", { key: "retrieval_temperature", label: "检索温度", type: "number", description: "建议 0，判定要稳定" }, String(judgeRouting.temperature))}
      </CollapsibleSection>

      {/* 记忆检索 */}
      <CollapsibleSection title="记忆检索" icon="🔍" defaultExpanded={false}>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputBlocked(blocked_keywords || identityNames().join("、")); setShowBlockedModal(true); }}>
          <View style={styles.rowLeft}>
            <Text style={[styles.label, { color: colors.text }]}>检索屏蔽词</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]} numberOfLines={1}>这些词不作为想起往事的依据（只发它们时不触发检索）</Text>
          </View>
          <Text style={[styles.value, { color: colors.textMuted }]} numberOfLines={1}>{blocked_keywords || identityNames().join("、")}</Text>
        </TouchableOpacity>

        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <View style={styles.rowLeft}>
            <Text style={[styles.label, { color: colors.text }]}>AI 检索判定</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>让 AI 判断这句话想起了哪些往事，比关键词更准；关闭即回到纯本地检索</Text>
          </View>
          <TouchableOpacity
            style={[styles.toggle, { backgroundColor: ai_retrieval_enabled ? colors.accent : colors.btnBg }]}
            onPress={() => saveAiRetrievalEnabled(!ai_retrieval_enabled)}
            accessibilityRole="switch"
            accessibilityLabel="AI 检索判定"
            accessibilityState={{ checked: ai_retrieval_enabled }}
          >
            <Text style={[styles.toggleText, { color: ai_retrieval_enabled ? colors.accentText : colors.textMuted }]}>
              {ai_retrieval_enabled ? "开" : "关"}
            </Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.sectionNote, { color: colors.textMuted }]}>
          开启后每轮会把全部记忆的标题与一句印象发给模型接口（判定质量优先），记忆本身仍只存在本机
        </Text>
        {retrievalFailStreak >= 3 ? (
          <Text style={[styles.sectionWarn, { color: colors.danger }]}>
            已连续 {retrievalFailStreak} 次判定失败，当前在用本地检索，请检查 API Key 与网络
            {retrievalFailReason ? `（${retrievalFailReason}）` : ""}
          </Text>
        ) : null}
      </CollapsibleSection>

      {/* 记忆流转阈值 */}
      <CollapsibleSection title="记忆流转阈值" icon="⚙️" defaultExpanded={false}>
        {THRESHOLD_FIELDS.map((f) =>
          renderConfigRow("记忆流转阈值", f, String(thresholdsVal[f.key]))
        )}
      </CollapsibleSection>

      {/* 提示词设置 - 分组显示 */}
      <CollapsibleSection title="提示词设置" icon="📝" defaultExpanded={false}>
        {PROMPT_GROUPS.map((group) => (
          <View key={group.title} style={styles.promptGroup}>
            <View style={styles.promptGroupHeader}>
              <Text style={[styles.promptGroupTitle, { color: colors.text }]}>{group.icon} {group.title}</Text>
              {group.description ? <Text style={[styles.promptGroupDesc, { color: colors.textMuted }]}>{group.description}</Text> : null}
            </View>
            {group.fields.map((f) => {
              const prompts = getPrompts();
              const value = (prompts as Record<string, string>)[f.key] ?? "";
              return renderConfigRow(group.title, f, value);
            })}
          </View>
        ))}
      </CollapsibleSection>

      {/* 用户画像 */}
      <CollapsibleSection title="用户画像" icon="👤" defaultExpanded={true}>
        <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
          {renderUserInfo()}
        </View>
        <TouchableOpacity
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
          onPress={() => { setPersonaInput(""); setPersonaResult(null); setPersonaError(""); setPersonaModalVisible(true); }}
        >
          <Text style={[styles.actionText, { color: colors.accent }]}>✨ AI 提取人设</Text>
        </TouchableOpacity>
      </CollapsibleSection>

      {/* AI 自己的作息：本周习惯 + 今日实况，用来和聊天里的状态注记比对 */}
      <CollapsibleSection title="AI 作息" icon="🗓️" defaultExpanded={false}>
        <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
          {renderAiRoutine()}
        </View>
        <TouchableOpacity
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
          onPress={reloadAiRoutine}
        >
          <Text style={[styles.actionText, { color: colors.accent }]}>🔄 重新读取</Text>
        </TouchableOpacity>
      </CollapsibleSection>

      {/* 好友圈：AI 自己的熟人（不是用户的社交图谱） */}
      <CollapsibleSection
        title={`好友圈 (${friends.filter((f) => f.is_active === 1).length})`}
        icon="👥"
        defaultExpanded={false}
      >
        <TouchableOpacity
          style={[styles.row, { borderBottomColor: colors.border }]}
          onPress={() => {
            setInputFriendPrefs(friend_preferences);
            setShowFriendPrefsModal(true);
          }}
        >
          <View style={styles.rowLeft}>
            <Text style={[styles.label, { color: colors.text }]}>好友偏好</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
              约束 ta 交什么样的朋友、朋友怎么说话（不填 = 不限制）
            </Text>
          </View>
          <Text style={[styles.value, { color: colors.textMuted }]} numberOfLines={1}>
            {friend_preferences || "未设置"}
          </Text>
        </TouchableOpacity>

        {friends.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textMuted, paddingVertical: 16 }]}>
            还没有自己的圈子，聊过几轮后会自然出现
          </Text>
        ) : (
          friends.map((f) => {
            const last = getFriendLastInteraction(f.id);
            const pending = f.debut_at ? dayjs(f.debut_at).isAfter(dayjs()) : false;
            return (
              <View
                key={f.id}
                style={[
                  styles.row,
                  {
                    borderBottomColor: colors.border,
                    alignItems: "flex-start",
                    opacity: f.is_active === 1 ? 1 : 0.45,
                  },
                ]}
              >
                <View style={[styles.rowLeft, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.text }]}>
                    {friendAvatarText(f)} {f.name}
                    {pending ? "（还没出现）" : ""}
                  </Text>
                  <Text style={[styles.rowDesc, { color: colors.textMuted }]} numberOfLines={2}>
                    {f.summary || "（没有小传摘要）"}
                  </Text>
                  <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
                    {last ? `最近互动 ${dayjs(last).format("M/D HH:mm")}` : "还没互动过"}
                  </Text>

                  <View style={styles.friendActions}>
                    <TouchableOpacity
                      onPress={() => {
                        setRenamingFriend(f);
                        setInputFriendName(f.name);
                      }}
                    >
                      <Text style={[styles.confirmText, { color: colors.accent }]}>改名</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleToggleFriend(f)}>
                      <Text style={[styles.confirmText, { color: colors.accent }]}>
                        {f.is_active === 1 ? "停用" : "启用"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={friendBusy} onPress={() => handleReplaceFriend(f)}>
                      <Text
                        style={[
                          styles.confirmText,
                          { color: friendBusy ? colors.textMuted : colors.accent },
                        ]}
                      >
                        换一个
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDeleteFriend(f)}>
                      <Text style={[styles.confirmText, { color: colors.danger }]}>删除</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })
        )}

        <TouchableOpacity
          style={[styles.actionRow, { borderBottomColor: colors.border }]}
          disabled={friendBusy}
          onPress={handleRebuildFriends}
        >
          <Text style={[styles.actionText, { color: friendBusy ? colors.textMuted : colors.accent }]}>
            {friendBusy ? "正在重新生成…" : "🔄 重建花名册（全部换新）"}
          </Text>
        </TouchableOpacity>
      </CollapsibleSection>

      {/* 未来事件（约定/离职/考试…到点注入隐形提醒） */}
      <CollapsibleSection
        title={`未来事件 (${appointmentList.length})`}
        icon="⏰"
        defaultExpanded={true}
      >
        {appointmentList.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textMuted, paddingVertical: 16 }]}>暂无未来事件</Text>
        ) : (
          appointmentList.map((event) => {
            const dueTime = dayjs(event.timestamp);
            const isPast = dueTime.isBefore(dayjs());
            return (
              <View key={event.id} style={[styles.promiseItem, { borderBottomColor: colors.border }]}>
                <View style={styles.promiseContent}>
                  <Text style={[styles.promiseText, { color: isPast ? colors.danger : colors.text }]}>
                    {event.event_text}
                  </Text>
                  <Text style={[styles.promiseTime, { color: isPast ? colors.danger : colors.textMuted }]}>
                    {isPast ? "已过期，AI 会找机会关心 " : "约定 "}{dueTime.format("M/D HH:mm")}
                  </Text>
                </View>
                <Text style={[styles.promiseStatus, { color: colors.textMuted }]}>
                  {event.event_status === "caring" ? "关心中" : "待发生"} · 已提醒 {event.nudge_count ?? 0}/2
                </Text>
              </View>
            );
          })
        )}
      </CollapsibleSection>

      {/* 活跃事件列表 */}
      <CollapsibleSection
        title={`活跃记忆事件 (${eventCount})`}
        icon="🧠"
        defaultExpanded={false}
        right={
          <TouchableOpacity onPress={() => { setNewEventText(""); setNewEventWeight("50"); setNewEventPriority("5"); setShowNewEventModal(true); }}>
            <Text style={[styles.confirmText, { color: colors.accent }]}>+ 新建</Text>
          </TouchableOpacity>
        }
      >
        {events.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textMuted, paddingVertical: 16 }]}>暂无记忆事件</Text>
        ) : (
          events.map((evt) => (
            <TouchableOpacity
              key={evt.id}
              style={[styles.row, { borderBottomColor: colors.border, alignItems: "flex-start" }]}
              onPress={() => {
                setSelectedEvent(evt);
                setEventFragments(getFragmentsByEventId(evt.id));
                setEventAliases(getEventAliases(evt.id));
                setShowEventDetail(true);
              }}
              onLongPress={() => setDeletingEvent(evt)}
            >
              <View style={[styles.rowLeft, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.text, fontSize: 14, lineHeight: 20 }]}>{evt.event_text}</Text>
                <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
                  当前权重 {liveWeightOf(evt)} · 优先级 {evt.priority} · {new Date(evt.timestamp).toLocaleDateString()}
                </Text>
              </View>
              <Text style={[styles.value, { color: colors.textMuted, fontSize: 12 }]}>#{evt.id}</Text>
            </TouchableOpacity>
          ))
        )}
      </CollapsibleSection>

      {/* 数据管理 */}
      <CollapsibleSection title="数据管理" icon="🗑️" defaultExpanded={false}>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={async () => {
          try {
            const result = await exportBackup();
            if (result.success) {
              Alert.alert("导出成功", result.message);
            } else {
              Alert.alert("导出失败", result.message);
            }
          } catch (e: any) {
            Alert.alert("导出失败", e.message || "无法导出数据");
          }
        }}>
          <Text style={[styles.actionText, { color: colors.text }]}>📦 导出备份</Text>
        </TouchableOpacity>
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
            自动备份：每次记忆更新都会保存一份，上限 100MB，超出后从中间清理（保留最新和最旧）。仅存应用内，卸载会一并删除。可在下方「从自动备份恢复」里查看和还原。
            {getMeta("last_auto_backup_at")
              ? ` 最近：${new Date(getMeta("last_auto_backup_at")!).toLocaleString()}`
              : " 尚未生成"}
          </Text>
        </View>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={async () => {
          try {
            const files = await listAutoBackups();
            if (files.length === 0) {
              Alert.alert("自动备份", "还没有自动备份。等记忆更新一次后会自动生成。");
              return;
            }
            setAutoBackupFiles(files);
            setShowAutoBackupList(true);
          } catch (e: any) {
            Alert.alert("读取失败", e.message || "无法读取自动备份列表");
          }
        }}>
          <Text style={[styles.actionText, { color: colors.text }]}>🕘 从自动备份恢复</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={() => {
          Alert.alert("导入备份", "导入会覆盖当前所有数据（聊天记录、记忆、设置），确定继续？", [
            { text: "取消", style: "cancel" },
            { text: "导入", style: "destructive", onPress: async () => {
              try {
                const result = await importBackup();
                if (result.success) {
                  await reloadAfterRestore();
                  Alert.alert("导入成功", result.message);
                } else {
                  Alert.alert("导入失败", result.message);
                }
              } catch (e: any) {
                Alert.alert("导入失败", e.message || "无法导入数据");
              }
            }},
          ]);
        }}>
          <Text style={[styles.actionText, { color: colors.text }]}>📥 导入备份</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={() => {
          Alert.alert("删除本周时间表", "确定要删除本周的行为时间表吗？下次对话时会自动重新生成。", [
            { text: "取消", style: "cancel" },
            { text: "删除", style: "destructive", onPress: () => {
              deleteScheduleForWeek(getWeekStart());
              Alert.alert("已删除", "本周时间表已清除。");
            }},
          ]);
        }}>
          <Text style={[styles.actionText, { color: colors.danger }]}>删除本周时间表</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={handleClearData}>
          <Text style={[styles.actionText, { color: colors.danger }]}>清除所有数据</Text>
        </TouchableOpacity>
      </CollapsibleSection>

      {/* 版本信息（用于确认 OTA 更新是否生效） */}
      <CollapsibleSection title={`版本信息 · ${RELEASE_VERSION}`} icon="ℹ️" defaultExpanded={false}>
        <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.text }]}>发布版本：{RELEASE_VERSION}（每次 OTA 递增）</Text>
          <Text style={[styles.label, { color: colors.text }]}>运行时版本：{Updates.runtimeVersion ?? "—"}</Text>
          <Text style={[styles.label, { color: colors.text }]}>
            更新时间：{Updates.createdAt ? dayjs(Updates.createdAt).format("MM-DD HH:mm:ss") : "—"}
          </Text>
          <Text style={[styles.label, { color: colors.text }]}>
            更新 ID：{Updates.updateId ? `${Updates.updateId.slice(0, 8)}…` : "（内置包，无 ID）"}
          </Text>
          <Text style={[styles.label, { color: colors.text }]}>
            运行来源：{Updates.updateId ? "OTA 远程更新" : "内置包（APK 自带）"}
          </Text>
          <Text style={[styles.hint, { color: colors.textMuted }]}>
            {Updates.updateId
              ? "✅ 当前跑的是 OTA 远程更新，已是最新代码"
              : "⚠️ 当前是 APK 自带的老代码，OTA 未应用——请从最近任务彻底关闭 App 再打开"}
          </Text>
        </View>
      </CollapsibleSection>

      <Text style={[styles.hint, { color: colors.textMuted }]}>支持所有 OpenAI 兼容 API：OpenAI / DeepSeek / Moonshot / 本地模型等</Text>

      {/* 自动备份恢复列表 */}
      <Modal visible={showAutoBackupList} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>从自动备份恢复</Text>
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>选择一份备份恢复，会覆盖当前全部数据。恢复后 App 会自动刷新。</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {autoBackupFiles.map((f) => (
                <TouchableOpacity
                  key={f.name}
                  style={[styles.row, { borderBottomColor: colors.border }]}
                  disabled={restoringBackup !== null}
                  onPress={async () => {
                    Alert.alert("恢复备份", `确定用 ${new Date(f.time).toLocaleString()} 的备份覆盖当前数据？`, [
                      { text: "取消", style: "cancel" },
                      { text: "恢复", style: "destructive", onPress: async () => {
                        setRestoringBackup(f.name);
                        try {
                          const result = await restoreFromUri(f.uri);
                          if (result.success) {
                            await reloadAfterRestore();
                            setShowAutoBackupList(false);
                            Alert.alert("恢复成功", result.message);
                          } else {
                            Alert.alert("恢复失败", result.message);
                          }
                        } catch (e: any) {
                          Alert.alert("恢复失败", e.message || "无法恢复");
                        } finally {
                          setRestoringBackup(null);
                        }
                      }},
                    ]);
                  }}
                >
                  <View style={styles.rowLeft}>
                    <Text style={[styles.label, { color: colors.text }]}>
                      {restoringBackup === f.name ? "恢复中…" : new Date(f.time).toLocaleString()}
                    </Text>
                    <Text style={[styles.rowDesc, { color: colors.textMuted }]}>{f.name}</Text>
                  </View>
                  <Text style={[styles.value, { color: colors.accent }]}>恢复</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAutoBackupList(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>关闭</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* API Key 弹窗 */}
      <Modal visible={showKeyModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>设置 API Key</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
              value={inputKey}
              onChangeText={setInputKey}
              placeholder="sk-..."
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              // 默认密文：旁边有人或录屏时不会把整串 Key 露出来
              secureTextEntry={!showKeyText}
            />
            <TouchableOpacity onPress={() => setShowKeyText((v) => !v)}>
              <Text style={[styles.keyToggleText, { color: colors.accent }]}>
                {showKeyText ? "隐藏" : "显示明文"}
              </Text>
            </TouchableOpacity>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowKeyModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveKey}><Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* API URL 弹窗 */}
      <Modal visible={showUrlModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>API 地址</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]} value={inputUrl} onChangeText={setInputUrl} placeholder="https://api.openai.com/v1" placeholderTextColor={colors.placeholder} autoCapitalize="none" autoCorrect={false} autoFocus />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>DeepSeek: https://api.deepseek.com/v1{"\n"}Moonshot: https://api.moonshot.cn/v1</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowUrlModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveUrl}><Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 称呼弹窗 */}
      <Modal visible={showNicknameModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>AI 怎么称呼你</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]} value={inputNickname} onChangeText={setInputNickname} placeholder="留空则不指定" placeholderTextColor={colors.placeholder} autoFocus />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>系统提示词中的 [user] 会被替换为此称呼（不区分大小写）</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNicknameModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveNickname}><Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* AI名字弹窗 */}
      <Modal visible={showAiNameModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>怎么称呼 TA</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]} value={inputAiName} onChangeText={setInputAiName} placeholder="留空则显示默认标题" placeholderTextColor={colors.placeholder} autoFocus />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>标题栏会显示 TA 的名字</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAiNameModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveAiName}><Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 检索屏蔽词弹窗 */}
      <Modal visible={showBlockedModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>检索屏蔽词</Text>
            <TextInput style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]} value={inputBlocked} onChangeText={setInputBlocked} placeholder="用逗号分隔，如：小明、私藏" placeholderTextColor={colors.placeholder} autoFocus />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>
              这些词按停用词处理：整句只有它们时直接跳过 AI 判定，兜底检索也不会拿它们当关键词{"\n"}
              默认是你们俩的称呼，留空恢复默认；不会改动记忆内容
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowBlockedModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveBlocked}><Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 好友偏好弹窗 */}
      <Modal visible={showFriendPrefsModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>好友偏好</Text>
            <TextInput
              style={[styles.input, { minHeight: 96, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
              value={inputFriendPrefs}
              onChangeText={setInputFriendPrefs}
              placeholder="如：不要前任相关的朋友；只要同事/同学；别总开我们玩笑"
              placeholderTextColor={colors.placeholder}
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>
              一条偏好同时管「交什么样的朋友」和「朋友怎么说话」{"\n"}
              好友还没露面时修改会静默换掉不合规的人；已经出现过就只影响以后{"\n"}
              留空 = 不限制
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowFriendPrefsModal(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleSaveFriendPrefs}>
                <Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 好友改名弹窗（只改称呼，不改人格） */}
      <Modal visible={renamingFriend !== null} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>改名</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
              value={inputFriendName}
              onChangeText={setInputFriendName}
              placeholder="新的称呼"
              placeholderTextColor={colors.placeholder}
              autoFocus
              maxLength={12}
            />
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>只改你怎么称呼 ta，性格、口吻与关系都不变</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setRenamingFriend(null)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleRenameFriend}>
                <Text style={[styles.confirmText, { color: colors.accentText }]}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 模型选择器 */}
      <Modal visible={modelPickerVisible} animationType="slide">
        <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
          <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setModelPickerVisible(false)}>
              <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
            <Text style={[styles.editorTitle, { color: colors.text }]}>
              {MODEL_PICKER_TITLE[modelPickerTarget]}
            </Text>
            <View style={{ width: 50 }} />
          </View>

          {modelLoading ? (
            <View style={styles.modelLoadingBox}>
              <Text style={[styles.modelLoadingText, { color: colors.textMuted }]}>正在获取模型列表...</Text>
            </View>
          ) : modelError ? (
            <View style={styles.modelLoadingBox}>
              <Text style={[styles.modelErrorText, { color: colors.danger }]}>获取失败：{modelError}</Text>
              <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels(modelPickerTarget)}>
                <Text style={[styles.fetchBtnText, { color: colors.text }]}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView style={styles.modelListContainer}>
              {modelList.map((model) => (
                <TouchableOpacity
                  key={model}
                  style={[styles.modelItem, { borderBottomColor: colors.border }]}
                  onPress={() => handleSelectModel(model)}
                >
                  <Text style={[styles.modelItemText, { color: colors.text }]}>{model}</Text>
                </TouchableOpacity>
              ))}
              {modelList.length === 0 && (
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>未找到可用模型</Text>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* 通用配置编辑器 */}
      <Modal visible={editorVisible} animationType="slide">
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: colors.bg }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
            <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setEditorVisible(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editorTitle, { color: colors.text }]}>{editorTitle}</Text>
              <View style={styles.editorHeaderRight}>
                {editorField && isPreviewable(editorField.key) && (
                  <TouchableOpacity
                    style={[styles.previewToggle, { backgroundColor: colors.btnBg }]}
                    onPress={() => setPreviewMode(!previewMode)}
                  >
                    <Text style={[styles.previewToggleText, { color: colors.text }]}>{previewMode ? "编辑" : "预览"}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={handleSaveConfig}>
                  <Text style={[styles.confirmText, { color: colors.accent }]}>保存</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={[styles.editorLabel, { color: colors.text }]}>{editorField?.label}</Text>
            {editorField?.description ? <Text style={[styles.editorDesc, { color: colors.textMuted }]}>{editorField.description}</Text> : null}

            {previewMode ? (
              <ScrollView style={[styles.previewContainer, { backgroundColor: colors.bg }]}>
                <Text style={[styles.previewText, { color: colors.text }]} selectable>{buildPreview()}</Text>
              </ScrollView>
            ) : (
              <TextInput
                ref={editorInputRef}
                style={[
                  editorField?.type === "multiline" ? styles.editorInputMultiline : styles.editorInputSingle,
                  { borderColor: colors.border, color: colors.text },
                ]}
                value={editorValue}
                onChangeText={setEditorValue}
                onSelectionChange={(e) => setCursorPos(e.nativeEvent.selection.start)}
                multiline={editorField?.type === "multiline"}
                keyboardType={editorField?.type === "number" ? "decimal-pad" : "default"}
                textAlignVertical={editorField?.type === "multiline" ? "top" : "center"}
                autoFocus
              />
            )}

            {/* 变量选择器 */}
            {!previewMode && editorField && TEMPLATE_VARIABLES[editorField.key] && (
              <View style={[styles.varPickerContainer, { borderTopColor: colors.border }]}>
                <Text style={[styles.varPickerTitle, { color: colors.textMuted }]}>点击插入变量：</Text>
                <View style={styles.varPickerChips}>
                  {TEMPLATE_VARIABLES[editorField.key].map((v) => (
                    <TouchableOpacity
                      key={v.value}
                      style={[styles.varChip, { backgroundColor: colors.bubbleAi, borderColor: colors.border }]}
                      onPress={() => insertVariable(v.value)}
                    >
                      <Text style={[styles.varChipText, { color: colors.text }]}>{v.label}</Text>
                      <Text style={[styles.varChipValue, { color: colors.textMuted }]}>{v.value}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {!previewMode && (
              <View style={[styles.editorFooter, { borderTopColor: colors.border }]}>
                <TouchableOpacity style={[styles.resetBtn, { backgroundColor: colors.bg }]}>
                  <Text style={[styles.resetText, { color: colors.textMuted }]} onPress={handleResetConfig}>恢复默认</Text>
                </TouchableOpacity>
              </View>
            )}

            {!previewMode && (
              <TouchableOpacity style={[styles.editorSaveBtn, { backgroundColor: colors.accent }]} onPress={handleSaveConfig}>
                <Text style={[styles.editorSaveBtnText, { color: colors.accentText }]}>确认保存</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 新建事件弹窗 */}
      <Modal visible={showNewEventModal} transparent animationType="fade">
        <View style={[styles.overlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.modal, { maxHeight: "80%", backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>新建记忆事件</Text>
            <TextInput
              style={[styles.input, { minHeight: 100, textAlignVertical: "top", backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
              value={newEventText}
              onChangeText={setNewEventText}
              placeholder="输入事件内容..."
              placeholderTextColor={colors.placeholder}
              multiline
              autoFocus
            />
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, gap: 8 }}>
              <Text style={[styles.modalHint, { marginTop: 0 }]}>权重 (1-100，会随时间衰减):</Text>
              <TextInput
                style={[styles.input, { flex: 1, marginTop: 0, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                value={newEventWeight}
                onChangeText={setNewEventWeight}
                placeholder="50"
                placeholderTextColor={colors.placeholder}
                keyboardType="number-pad"
              />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}>
              <Text style={[styles.modalHint, { marginTop: 0 }]}>优先级 (1-9):</Text>
              <TextInput
                style={[styles.input, { flex: 1, marginTop: 0, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                value={newEventPriority}
                onChangeText={setNewEventPriority}
                placeholder="5"
                placeholderTextColor={colors.placeholder}
                keyboardType="number-pad"
              />
            </View>
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>权重：检索命中概率。优先级：1-3琐事，4-6中等，7-9重大（影响衰减速度）</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNewEventModal(false)}><Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={handleCreateEvent}><Text style={[styles.confirmText, { color: colors.accentText }]}>创建</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 事件编辑器 */}
      <Modal visible={showEventEditor} animationType="slide" onRequestClose={() => setShowEventEditor(false)}>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
            <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setShowEventEditor(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editorTitle, { color: colors.text }]}>编辑事件 #{editingEvent?.id}</Text>
              <TouchableOpacity onPress={handleSaveEvent}>
                <Text style={[styles.confirmText, { color: colors.accent }]}>保存</Text>
              </TouchableOpacity>
            </View>
            {editingEvent && (
              <ScrollView style={{ flex: 1, padding: 20 }}>
                {/* 事件内容 */}
                <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>事件标题</Text>
                <TextInput
                  style={[styles.editorInputMultiline, { borderColor: colors.border, color: colors.text, minHeight: 80, marginHorizontal: 0, marginTop: 8 }]}
                  value={editEventText}
                  onChangeText={setEditEventText}
                  multiline
                  textAlignVertical="top"
                />
                <View style={{ flexDirection: "row", gap: 12, marginTop: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowDesc, { color: colors.textMuted }]}>优先级 (1-9)</Text>
                    <TextInput
                      style={[styles.input, { marginTop: 4, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                      value={editEventPriority}
                      onChangeText={setEditEventPriority}
                      keyboardType="number-pad"
                      placeholder="5"
                      placeholderTextColor={colors.placeholder}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowDesc, { color: colors.textMuted }]}>权重 (1-100，想起时回到这个值，之后随时间衰减)</Text>
                    <TextInput
                      style={[styles.input, { marginTop: 4, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                      value={editEventWeight}
                      onChangeText={setEditEventWeight}
                      keyboardType="number-pad"
                      placeholder="100"
                      placeholderTextColor={colors.placeholder}
                    />
                  </View>
                </View>
                <Text style={[styles.rowDesc, { color: colors.textMuted, marginTop: 10 }]}>别名（逗号或空格分隔，换种说法也能想起这件事）</Text>
                <TextInput
                  style={[styles.input, { marginTop: 4, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                  value={editEventAliases}
                  onChangeText={setEditEventAliases}
                  placeholder="例如：朋友圈、动态、帖子"
                  placeholderTextColor={colors.placeholder}
                />
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
                  <Text style={[styles.rowDesc, { color: colors.textMuted, flex: 1, marginRight: 8 }]}>
                    创建于 {new Date(editingEvent.timestamp).toLocaleString()} · 被想起时权重会刷新为 100
                  </Text>
                  <TouchableOpacity onPress={() => {
                    setShowEventEditor(false);
                    setDeletingEvent(editingEvent);
                  }}>
                    <Text style={[styles.rowDesc, { color: colors.danger }]}>删除此事件</Text>
                  </TouchableOpacity>
                </View>

                {/* 记忆片段列表 */}
                <View style={[styles.sectionDivider, { borderTopColor: colors.border, marginTop: 20 }]}>
                  <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 16 }]}>
                    记忆片段 ({editorFragments.length})
                  </Text>
                </View>
                {editorFragments.length === 0 ? (
                  <Text style={[styles.emptyText, { color: colors.textMuted, marginTop: 8 }]}>暂无记忆片段</Text>
                ) : (
                  editorFragments.map((frag) => (
                    <View key={frag.id} style={[styles.fragmentItem, { borderBottomColor: colors.border }]}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <Text style={[styles.fragmentPriority, { color: colors.textMuted }]}>片段 #{frag.id}</Text>
                        <Text style={[styles.fragmentTime, { color: colors.textMuted }]}>
                          {new Date(frag.timestamp).toLocaleString()}
                        </Text>
                      </View>
                      <Text style={[styles.fragmentSummary, { color: colors.text }]}>
                        一句话印象：{replaceFragmentPlaceholder(frag.gist, frag.timestamp, user_nickname, ai_name)}
                      </Text>
                      <Text style={[styles.fragmentSummary, { color: colors.textMuted }]}>
                        详细内容：{replaceFragmentPlaceholder(frag.summary, frag.timestamp, user_nickname, ai_name)}
                      </Text>
                      <Text style={[styles.rowDesc, { color: colors.textMuted, marginTop: 8 }]}>检索词／唤醒词（逗号分隔）</Text>
                      <TextInput
                        style={[styles.input, { marginTop: 4, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                        value={fragmentEdits[frag.id]?.keywords ?? frag.keywords}
                        onChangeText={(text) => setFragmentEdits((prev) => ({
                          ...prev,
                          [frag.id]: { keywords: text, priority: prev[frag.id]?.priority ?? String(frag.priority) },
                        }))}
                        placeholder="用户以后可能怎么提起这件事"
                        placeholderTextColor={colors.placeholder}
                      />
                      <Text style={[styles.rowDesc, { color: colors.textMuted, marginTop: 8 }]}>优先级 (1-9)</Text>
                      <TextInput
                        style={[styles.input, { marginTop: 4, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                        value={fragmentEdits[frag.id]?.priority ?? String(frag.priority)}
                        onChangeText={(text) => setFragmentEdits((prev) => ({
                          ...prev,
                          [frag.id]: { keywords: prev[frag.id]?.keywords ?? frag.keywords, priority: text },
                        }))}
                        keyboardType="number-pad"
                      />
                    </View>
                  ))
                )}

                {/* 添加新片段 */}
                <View style={[styles.sectionDivider, { borderTopColor: colors.border, marginTop: 16 }]}>
                  <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 16 }]}>添加片段</Text>
                </View>
                <TextInput
                  style={[styles.input, { marginTop: 8, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                  value={newFragmentSummary}
                  onChangeText={setNewFragmentSummary}
                  placeholder="片段摘要（必填，建议包含 [user] [time]，写清发生了什么 + 细节 + 情绪）"
                  placeholderTextColor={colors.placeholder}
                  multiline
                />
                <TextInput
                  style={[styles.input, { marginTop: 8, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                  value={newFragmentGist}
                  onChangeText={setNewFragmentGist}
                  placeholder="一句话概要（选填，20 字内，留空自动截取）"
                  placeholderTextColor={colors.placeholder}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                  value={newFragmentKeywords}
                  onChangeText={setNewFragmentKeywords}
                  placeholder="检索词／唤醒词（逗号分隔，留空则这条片段不会被想起）"
                  placeholderTextColor={colors.placeholder}
                />
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}>
                  <Text style={[styles.modalHint, { marginTop: 0 }]}>优先级 (1-9):</Text>
                  <TextInput
                    style={[styles.input, { flex: 1, marginTop: 0, backgroundColor: colors.inputBg, borderColor: colors.border, color: colors.text }]}
                    value={newFragmentPriority}
                    onChangeText={setNewFragmentPriority}
                    placeholder="5"
                    placeholderTextColor={colors.placeholder}
                    keyboardType="number-pad"
                  />
                </View>
                <Text style={[styles.modalHint, { marginTop: 4 }]}>1-3琐事，4-6中等，7-9重大</Text>
                <TouchableOpacity
                  style={[styles.setupButton, { backgroundColor: newFragmentSummary.trim() ? colors.accent : colors.btnBg, marginTop: 12, marginBottom: 20 }]}
                  onPress={handleCreateFragment}
                  disabled={!newFragmentSummary.trim()}
                >
                  <Text style={[styles.setupButtonText, { color: newFragmentSummary.trim() ? colors.accentText : colors.textMuted }]}>添加片段</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 事件详情弹窗 */}
      <Modal visible={showEventDetail} animationType="slide" onRequestClose={() => setShowEventDetail(false)}>
        <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
          <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setShowEventDetail(false)}>
              <Text style={[styles.cancelText, { color: colors.textMuted }]}>返回</Text>
            </TouchableOpacity>
            <Text style={[styles.editorTitle, { color: colors.text }]}>事件详情 #{selectedEvent?.id}</Text>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <TouchableOpacity onPress={() => {
                setShowEventDetail(false);
                if (selectedEvent) openEventEditor(selectedEvent);
              }}>
                <Text style={[styles.confirmText, { color: colors.accent }]}>编辑</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView style={{ flex: 1, padding: 20 }}>
            {/* 事件信息 */}
            <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>事件内容</Text>
            <Text style={[styles.detailText, { color: colors.text }]}>{selectedEvent?.event_text}</Text>

            <View style={[styles.detailMeta, { borderTopColor: colors.border, borderBottomColor: colors.border }]}>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>当前权重</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {selectedEvent ? liveWeightOf(selectedEvent) : ""}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>想起时权重</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>{selectedEvent?.active_weight}</Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>优先级</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>{selectedEvent?.priority}</Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>创建时间</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {selectedEvent ? new Date(selectedEvent.timestamp).toLocaleString() : ""}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>最后访问</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {selectedEvent ? new Date(selectedEvent.last_accessed).toLocaleString() : ""}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>片段数量</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>{eventFragments.length}</Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>类型</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {MEMORY_KIND_LABEL[selectedEvent?.memory_kind ?? ""] ?? "未知"}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>状态</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {EVENT_STATUS_LABEL[selectedEvent?.event_status ?? ""] ?? "未知"}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>结束时刻</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>
                  {selectedEvent?.closed_at ? new Date(selectedEvent.closed_at).toLocaleString() : "未结束"}
                </Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>提醒次数</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>{selectedEvent?.nudge_count ?? 0}</Text>
              </View>
              <View style={styles.detailMetaItem}>
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>别名</Text>
                <Text style={[styles.detailMetaValue, { color: colors.text }]}>{eventAliases.join("、") || "无"}</Text>
              </View>
            </View>

            {/* 记忆片段列表 */}
            <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 20 }]}>
              记忆片段 ({eventFragments.length})
            </Text>
            {eventFragments.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textMuted, marginTop: 8 }]}>暂无关联的记忆片段</Text>
            ) : (
              eventFragments.map((frag, index) => (
                <View key={frag.id} style={[styles.fragmentCard, { backgroundColor: colors.sectionBg, borderColor: colors.border }]}>
                  <View style={styles.fragmentHeader}>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Text style={[styles.fragmentIndex, { color: colors.textMuted }]}>#{index + 1}</Text>
                      <Text style={[styles.fragmentPriority, { color: colors.textMuted, marginLeft: 8 }]}>P{frag.priority}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => {
                        Alert.alert("删除片段", "确认删除这条记忆片段？", [
                          { text: "取消", style: "cancel" },
                          { text: "删除", style: "destructive", onPress: () => {
                            deleteFragment(frag.id);
                            setEventFragments(getFragmentsByEventId(selectedEvent!.id));
                          }},
                        ]);
                      }}
                    >
                      <Text style={[styles.fragmentDelete, { color: colors.danger }]}>删除</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={[styles.rowDesc, { color: colors.textMuted }]}>一句话印象</Text>
                  <Text style={[styles.fragmentText, { color: colors.text }]}>
                    {replaceFragmentPlaceholder(frag.gist, frag.timestamp, user_nickname, ai_name)}
                  </Text>
                  <Text style={[styles.rowDesc, { color: colors.textMuted, marginTop: 8 }]}>详细内容</Text>
                  <Text style={[styles.fragmentText, { color: colors.text }]}>
                    {replaceFragmentPlaceholder(frag.summary, frag.timestamp, user_nickname, ai_name)}
                  </Text>
                  <Text style={[styles.rowDesc, { color: colors.textMuted, marginTop: 8 }]}>检索词／唤醒词</Text>
                  <Text style={[styles.fragmentText, { color: colors.text }]}>{frag.keywords || "（空）"}</Text>
                  <Text style={[styles.fragmentTime, { color: colors.textMuted }]}>
                    {new Date(frag.timestamp).toLocaleString()}
                  </Text>
                </View>
              ))
            )}

            {/* 操作按钮 */}
            <View style={[styles.detailActions, { borderTopColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.detailActionBtn, { backgroundColor: colors.bg }]}
                onPress={() => {
                  setShowEventDetail(false);
                  setDeletingEvent(selectedEvent);
                }}
              >
                <Text style={[styles.detailActionText, { color: colors.danger }]}>删除此事件</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* 事件删除确认 */}
      <Modal visible={!!deletingEvent} transparent animationType="fade" onRequestClose={() => setDeletingEvent(null)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setDeletingEvent(null)}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>删除事件？</Text>
            <Text style={[styles.modalHint, { color: colors.textMuted }]}>{deletingEvent?.event_text}</Text>
            <Text style={[styles.modalHint, { color: colors.textMuted, marginTop: 4 }]}>关联的记忆片段也会一并删除，不可恢复。</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setDeletingEvent(null)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.danger }]} onPress={() => {
                if (deletingEvent) {
                  deleteEvent(deletingEvent.id);
                  setEvents(reloadEvents());
                  setEventCount(getActiveCount());
                  setDeletingEvent(null);
                }
              }}>
                <Text style={[styles.confirmText, { color: colors.dangerText }]}>删除</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 人设编辑器 */}
      <Modal visible={personaModalVisible} animationType="slide" onRequestClose={() => setPersonaModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
            <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setPersonaModalVisible(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editorTitle, { color: colors.text }]}>AI 提取人设</Text>
              {personaResult ? (
                <TouchableOpacity onPress={handleMergePersona}>
                  <Text style={[styles.confirmText, { color: colors.accent }]}>合并</Text>
                </TouchableOpacity>
              ) : (
                <View style={{ width: 50 }} />
              )}
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
              {!personaResult ? (
                <>
                  <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>输入一段自我介绍</Text>
                  <Text style={[styles.editorDesc, { color: colors.textMuted, marginHorizontal: 0 }]}>
                    写下关于你的任何信息：身份、喜好、性格、人际关系等，AI 会自动提取为结构化画像。
                  </Text>
                  <TextInput
                    style={[styles.editorInputMultiline, { borderColor: colors.border, color: colors.text, minHeight: 180, marginHorizontal: 0, marginTop: 12 }]}
                    value={personaInput}
                    onChangeText={setPersonaInput}
                    placeholder="例如：我叫小明，25岁，在北京做程序员。平时喜欢打篮球和看科幻电影，不太喜欢社交应酬。性格偏内向但很重感情，最近工作压力比较大..."
                    placeholderTextColor={colors.placeholder}
                    multiline
                    textAlignVertical="top"
                    autoFocus
                  />
                  {personaError ? (
                    <Text style={[styles.modelErrorText, { color: colors.danger, marginTop: 8 }]}>{personaError}</Text>
                  ) : null}
                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: personaInput.trim() ? colors.accent : colors.btnBg, marginTop: 16 }]}
                    onPress={handleExtractPersona}
                    disabled={!personaInput.trim() || personaExtracting}
                  >
                    <Text style={[styles.setupButtonText, { color: personaInput.trim() ? colors.accentText : colors.textMuted }]}>
                      {personaExtracting ? "提取中..." : "✨ 开始提取"}
                    </Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>提取结果</Text>
                  <Text style={[styles.editorDesc, { color: colors.textMuted, marginHorizontal: 0 }]}>
                    以下是 AI 从你的描述中提取的信息，将合并到现有画像中。点击「合并」确认。
                  </Text>

                  {/* 基础信息 */}
                  <View style={[styles.infoBlock, { borderBottomColor: colors.border, marginTop: 16 }]}>
                    <Text style={[styles.infoTitle, { color: colors.text }]}>基础信息</Text>
                    {personaResult.basic_identity?.nickname && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>昵称：{personaResult.basic_identity.nickname}</Text>}
                    {personaResult.basic_identity?.gender && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>性别：{personaResult.basic_identity.gender}</Text>}
                    {personaResult.basic_identity?.occupation && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>职业：{personaResult.basic_identity.occupation}</Text>}
                    {personaResult.basic_identity?.location && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>城市：{personaResult.basic_identity.location}</Text>}
                    {personaResult.basic_identity?.birthday && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>生日：{personaResult.basic_identity.birthday}</Text>}
                  </View>

                  {/* 属性（永久） */}
                  {(personaResult.traits?.length ?? 0) > 0 && (
                    <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.infoTitle, { color: colors.text }]}>属性（永久）</Text>
                      {personaResult.traits!.map((t, i) => (
                        <Text key={i} style={[styles.infoLine, { color: colors.textSecondary }]}>· {t}</Text>
                      ))}
                    </View>
                  )}

                  {/* 当前处境（仍在持续） */}
                  {(personaResult.conditions?.length ?? 0) > 0 && (
                    <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.infoTitle, { color: colors.text }]}>当前处境（仍在持续）</Text>
                      {personaResult.conditions!.map((s, i) => (
                        <Text key={i} style={[styles.infoLine, { color: colors.textSecondary }]}>· {s}</Text>
                      ))}
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: colors.accent, marginTop: 20 }]}
                    onPress={handleMergePersona}
                  >
                    <Text style={[styles.setupButtonText, { color: colors.accentText }]}>合并到现有画像</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.resetBtn, { marginTop: 12, alignSelf: "center", backgroundColor: colors.bg }]}
                    onPress={() => { setPersonaResult(null); setPersonaError(""); }}
                  >
                    <Text style={[styles.resetText, { color: colors.textMuted }]}>重新输入</Text>
                  </TouchableOpacity>
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 用户信息编辑弹窗 */}
      <Modal visible={editFieldModalVisible} transparent animationType="fade" onRequestClose={() => setEditFieldModalVisible(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setEditFieldModalVisible(false)}>
          <View style={[styles.modal, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>编辑{editFieldLabel}</Text>
            <TextInput
              style={[styles.input, styles.editFieldInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBg }]}
              value={editFieldValue}
              onChangeText={setEditFieldValue}
              placeholder={`输入${editFieldLabel}，多项用逗号或换行分隔`}
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditFieldModalVisible(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmBtn, { backgroundColor: colors.accent }]} onPress={saveEditField}>
                <Text style={[styles.confirmText, { color: colors.accent }]}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 8 },
  scrollContent: { paddingBottom: 28 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: "#9B9A97", letterSpacing: 0.2, paddingVertical: 12 },
  row: { minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  rowLeft: { flex: 1, marginRight: 12 },
  rowRight: { flexShrink: 0 },
  rowDesc: { fontSize: 12, lineHeight: 18, color: "#9B9A97", marginTop: 2 },
  sectionNote: { fontSize: 12, lineHeight: 18, color: "#9B9A97", paddingVertical: 10 },
  sectionWarn: { fontSize: 12, lineHeight: 18, color: "#E03E3E", paddingBottom: 12 },
  label: { fontSize: 15, lineHeight: 21, color: "#37352F" },
  friendActions: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 8 },
  value: { fontSize: 14, lineHeight: 20, color: "#9B9A97", maxWidth: 160, textAlign: "right" },
  valueChanged: { color: "#2F81F7" },
  // 模型行
  modelRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  modelInfo: { marginBottom: 8 },
  modelActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modelValue: { fontSize: 14, color: "#2F81F7", fontWeight: "500" },
  fetchBtn: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: "#F0F0EE", borderRadius: 6 },
  fetchBtnText: { fontSize: 13, color: "#37352F", fontWeight: "500" },
  // 模型列表
  modelListContainer: { flex: 1, paddingHorizontal: 20 },
  modelItem: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  modelItemText: { fontSize: 15, color: "#37352F" },
  modelLoadingBox: { flex: 1, justifyContent: "center", alignItems: "center" },
  modelLoadingText: { fontSize: 15, color: "#9B9A97" },
  modelErrorText: { fontSize: 14, color: "#E03E3E", marginBottom: 16 },
  actionRow: { minHeight: 48, justifyContent: "center", paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  actionText: { fontSize: 15, lineHeight: 21, color: "#52778A" },
  promptRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  promptPreview: { fontSize: 14, color: "#37352F", lineHeight: 20 },
  editHint: { fontSize: 12, color: "#2F81F7", marginTop: 8 },
  infoBlock: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  infoTitle: { fontSize: 13, fontWeight: "600", color: "#37352F", marginBottom: 8 },
  infoLine: { fontSize: 14, color: "#555450", lineHeight: 22 },
  editableRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  editableLabel: { fontSize: 13, color: "#9B9A97", width: 70 },
  editableValue: { fontSize: 14, flex: 1, textAlign: "right" },
  emptyText: { fontSize: 14, color: "#9B9A97", fontStyle: "italic" },
  hint: { textAlign: "center", fontSize: 12, color: "#9B9A97", marginTop: 12, marginBottom: 40 },
  overlay: { flex: 1, justifyContent: "center", alignItems: "center" },
  modal: { width: "86%", borderRadius: 18, padding: 22 },
  modalTitle: { fontSize: 17, lineHeight: 23, fontWeight: "600", marginBottom: 16 },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, lineHeight: 22 },
  // 用户属性编辑框：多行可换行，长内容不再挤成一条细长条
  editFieldInput: { minHeight: 120, maxHeight: 260, textAlignVertical: "top", lineHeight: 22 },
  modalHint: { fontSize: 12, marginTop: 8, lineHeight: 18 },
  // 「显示明文 / 隐藏」：贴在 API Key 输入框下方右对齐
  keyToggleText: { fontSize: 13, marginTop: 8, textAlign: "right" },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", marginTop: 20, gap: 10 },
  cancelBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  cancelText: { fontSize: 15 },
  confirmBtn: { minHeight: 44, justifyContent: "center", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  confirmText: { fontSize: 15, fontWeight: "600" },
  // 编辑器
  editorContainer: { flex: 1 },
  editorHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 56, paddingBottom: 14, paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  editorTitle: { fontSize: 17, lineHeight: 23, fontWeight: "600" },
  editorLabel: { fontSize: 15, fontWeight: "600", color: "#37352F", marginTop: 20, marginHorizontal: 20 },
  editorDesc: { fontSize: 13, color: "#9B9A97", marginTop: 4, marginHorizontal: 20 },
  editorInputSingle: { marginHorizontal: 20, marginTop: 12, borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#37352F" },
  editorInputMultiline: { flex: 1, minHeight: 200, marginHorizontal: 20, marginTop: 12, borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#37352F", lineHeight: 22 },
  editorFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E8E7E4" },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: "#F7F7F5" },
  resetText: { fontSize: 13, color: "#9B9A97" },
  editorSaveBtn: { minHeight: 50, justifyContent: "center", marginHorizontal: 20, marginBottom: 34, marginTop: 8, borderRadius: 14, paddingVertical: 13, alignItems: "center" },
  editorSaveBtnText: { fontSize: 16, fontWeight: "600" },
  // 变量选择器
  varPickerContainer: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  varPickerTitle: { fontSize: 11, marginBottom: 6 },
  varPickerChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  varChip: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1, gap: 3 },
  varChipText: { fontSize: 12, fontWeight: "500" },
  varChipValue: { fontSize: 10 },
  // 提示词分组
  promptGroup: { marginBottom: 8 },
  promptGroupHeader: { paddingVertical: 12, gap: 4 },
  promptGroupTitle: { fontSize: 15, fontWeight: "600" },
  promptGroupDesc: { fontSize: 12, lineHeight: 18 },
  // 约定提醒
  promiseItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  promiseContent: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  promiseText: { fontSize: 14, flex: 1, marginRight: 12 },
  promiseTime: { fontSize: 12, flexShrink: 0 },
  promiseStatus: { fontSize: 11, marginTop: 4 },
  // 事件详情
  detailText: { fontSize: 15, lineHeight: 24, marginTop: 8 },
  detailMeta: { flexDirection: "row", flexWrap: "wrap", gap: 16, paddingVertical: 16, marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  detailMetaItem: { minWidth: 80 },
  detailMetaLabel: { fontSize: 11, marginBottom: 4 },
  detailMetaValue: { fontSize: 14, fontWeight: "500" },
  fragmentCard: { borderRadius: 10, padding: 14, marginTop: 10, borderWidth: 1 },
  fragmentHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  fragmentIndex: { fontSize: 12 },
  fragmentPriority: { fontSize: 12, fontWeight: "600" },
  fragmentDelete: { fontSize: 12 },
  fragmentText: { fontSize: 14, lineHeight: 20 },
  fragmentTime: { fontSize: 11, marginTop: 4 },
  sectionDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  fragmentItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fragmentSummary: { fontSize: 14, lineHeight: 20 },
  detailActions: { paddingVertical: 24, marginTop: 24, borderTopWidth: StyleSheet.hairlineWidth },
  detailActionBtn: { paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  detailActionText: { fontSize: 15, fontWeight: "600" },
  // 颜色选择器
  colorRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  colorChips: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  colorChip: { width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
  colorChipActive: { borderWidth: 3 },
  // 预览
  editorHeaderRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  previewToggle: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#F0F0EE", borderRadius: 6 },
  previewToggleText: { fontSize: 14, color: "#37352F", fontWeight: "500" },
  previewContainer: { flex: 1, marginHorizontal: 20, marginTop: 12, backgroundColor: "#F7F7F5", borderRadius: 8, padding: 14 },
  previewText: { fontSize: 13, color: "#37352F", lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  // 开关
  // flexShrink: 0：左侧说明文字再长也不能把开关挤扁、挤出屏幕
  toggle: { minHeight: 38, minWidth: 54, justifyContent: "center", paddingHorizontal: 15, paddingVertical: 8, borderRadius: 19, alignItems: "center", flexShrink: 0 },
  toggleText: { fontSize: 14, fontWeight: "600" },
  setupButton: { minHeight: 48, justifyContent: "center", paddingVertical: 12, borderRadius: 14, alignItems: "center" },
  setupButtonText: { fontSize: 16, fontWeight: "600" },
});
