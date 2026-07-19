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
} from "@/prompt/config";
import { getUserInfo, getTopActive, getActiveCount, clearAllData, updateBasicIdentityNickname, updateEventText, deleteEvent, getFragmentsByEventId, insertEvent, insertFragment, deleteScheduleForWeek, mergeUserInfo, getDefaultEventId, getEventById } from "@/db/queries";
import { getWeekStart } from "@/memory/scheduler";
import { fetchModels, getClient } from "@/llm/client";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import type { UserInfo, MemoryEvent, MemoryFragment } from "@/types/schema";

// 配置项元数据
interface ConfigField {
  key: string;
  label: string;
  type: "number" | "text" | "multiline";
  description?: string;
}

const THRESHOLD_FIELDS: ConfigField[] = [
  { key: "consolidation_window_turns", label: "巩固触发轮数", type: "number", description: "对话满多少轮触发后台巩固" },
  { key: "context_active_events_limit", label: "记忆区事件上限", type: "number", description: "上下文中加载的高权重事件数量" },
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
      { key: "state_injection_template", label: "② 状态区注入模板", type: "multiline", description: "定义用户信息的注入格式。此部分在10轮对话内保持稳定，空字段自动隐藏。" },
      { key: "memory_injection_template", label: "③ 记忆区注入模板", type: "multiline", description: "定义记忆区的整体结构。每次检索可能注入不同事件。" },
      { key: "memory_event_template", label: "└ 记忆事件格式", type: "multiline", description: "定义单条记忆事件的格式。[time] 为相对于事件发生时间的描述。" },
    ],
  },
  {
    icon: "🔧",
    title: "后台任务",
    fields: [
      { key: "extraction_prompt", label: "记忆提取指令", type: "multiline", description: "每10轮对话触发一次，从对话中提取用户信息和记忆片段。" },
      { key: "dream_consolidation_prompt", label: "做梦折叠指令", type: "multiline", description: "闲置时自动触发，将琐碎记忆事件折叠为概括性事件。" },
    ],
  },
  {
    icon: "🚀",
    title: "特殊场景",
    fields: [
      { key: "cold_start_template", label: "冷启动模板", type: "multiline", description: "当数据库为空时，与系统人设组合使用，引导用户自我介绍。" },
    ],
  },
];

export default function SettingsScreen() {
  const { apiKey, baseUrl, user_nickname, ai_name, stream_output, thinking_mode, customColorsLight, customColorsDark, saveApiKey, saveBaseUrl, saveUserNickname, saveAiName, saveStreamOutput, saveThinkingMode, saveCustomColors } = useSettingsStore();
  const clearMessages = useChatStore((s) => s.clearMessages);
  const colors = useTheme();
  const { themeMode, toggleTheme } = useThemeStore();
  const currentCustomColors = themeMode === "light" ? customColorsLight : customColorsDark;

  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [showAiNameModal, setShowAiNameModal] = useState(false);
  const [inputKey, setInputKey] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [inputNickname, setInputNickname] = useState("");
  const [inputAiName, setInputAiName] = useState("");

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
    dream_consolidation_prompt: COMMON_VARIABLES,
    state_injection_template: [
      ...COMMON_VARIABLES,
      { label: "昵称", value: "{{nickname}}" },
      { label: "性别", value: "{{gender}}" },
      { label: "生日", value: "{{birthday}}" },
      { label: "职业", value: "{{occupation}}" },
      { label: "所在地", value: "{{location}}" },
      { label: "喜欢", value: "{{likes}}" },
      { label: "讨厌", value: "{{dislikes}}" },
      { label: "社交图谱", value: "{{social_graph}}" },
      { label: "性格特质", value: "{{personality_traits}}" },
      { label: "近期压力", value: "{{current_stressors}}" },
      { label: "沟通偏好", value: "{{comm_preference}}" },
      { label: "长期目标", value: "{{long_term_goals}}" },
      { label: "待办任务", value: "{{ongoing_tasks}}" },
      { label: "当前状态", value: "{{current_status}}" },
    ],
    memory_injection_template: [
      { label: "事件列表", value: "{{event_list}}" },
      { label: "灵光一闪", value: "{{epiphany}}" },
    ],
    memory_event_template: [
      ...COMMON_VARIABLES,
      { label: "相对时间", value: "[time]" },
      { label: "事件内容", value: "{{event_text}}" },
    ],
    context_template: [
      { label: "系统人设", value: "{{{system_prompt}}}" },
      { label: "状态区", value: "{{{state_info}}}" },
      { label: "记忆区", value: "{{{memory_events}}}" },
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
  const [modelPickerTarget, setModelPickerTarget] = useState<"foreground_model" | "background_model">("foreground_model");
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");

  // 记忆数据
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [systemPrompt, setSystemPromptState] = useState("");
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [editingEvent, setEditingEvent] = useState<MemoryEvent | null>(null);
  const [editEventText, setEditEventText] = useState("");
  const [showEventEditor, setShowEventEditor] = useState(false);
  const [editorFragments, setEditorFragments] = useState<MemoryFragment[]>([]);
  const [newFragmentSummary, setNewFragmentSummary] = useState("");
  const [newFragmentEmotion, setNewFragmentEmotion] = useState("");
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

  // 配置值刷新
  const [thresholds, setThresholds] = useState(getThresholds());
  const [modelRouting, setModelRouting] = useState(getModelRouting());

  // 人设编辑器
  const [personaModalVisible, setPersonaModalVisible] = useState(false);
  const [personaInput, setPersonaInput] = useState("");
  const [personaExtracting, setPersonaExtracting] = useState(false);
  const [personaResult, setPersonaResult] = useState<UserInfo | null>(null);
  const [personaError, setPersonaError] = useState("");

  useFocusEffect(
    useCallback(() => {
      setUserInfo(getUserInfo());
      setEventCount(getActiveCount());
      setSystemPromptState(getSystemPrompt());
      setThresholds(getThresholds());
      setModelRouting(getModelRouting());
      const activeEvents = getTopActive(999);
      const defaultId = getDefaultEventId();
      if (defaultId) {
        const defaultEvt = getEventById(defaultId);
        if (defaultEvt) activeEvents.unshift(defaultEvt);
      }
      setEvents(activeEvents);
    }, []),
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
    await saveUserNickname(inputNickname);
    if (inputNickname.trim()) {
      updateBasicIdentityNickname(inputNickname.trim());
    }
    setShowNicknameModal(false);
  };

  const handleSaveAiName = async () => {
    await saveAiName(inputAiName);
    setShowAiNameModal(false);
  };

  const handleCreateEvent = () => {
    const text = newEventText.trim();
    const weight = parseInt(newEventWeight) || 50;
    const priority = parseInt(newEventPriority) || 5;
    if (!text) return;
    insertEvent(text, Math.min(100, Math.max(1, weight)), events.length, Math.min(9, Math.max(1, priority)));
    setEvents(getTopActive(999));
    setEventCount(getActiveCount());
    setShowNewEventModal(false);
  };

  const handleCreateFragment = () => {
    if (!editingEvent || !newFragmentSummary.trim()) return;
    const priority = parseInt(newFragmentPriority) || 5;
    insertFragment(editingEvent.id, newFragmentSummary.trim(), newFragmentEmotion.trim() || "未标记情绪", Math.min(9, Math.max(1, priority)));
    setEditorFragments(getFragmentsByEventId(editingEvent.id));
    setNewFragmentSummary("");
    setNewFragmentEmotion("");
  };

  // 获取模型列表
  const handleFetchModels = async (target: "foreground_model" | "background_model") => {
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
    return ["system_prompt", "state_injection_template", "memory_injection_template", "memory_event_template", "extraction_prompt", "cold_start_template", "dream_consolidation_prompt"].includes(key);
  };

  // 渲染状态区模板（用 editorValue 替换 {{}}），空字段整行移除
  const EMPTY = "__EMPTY__";
  const renderStateTemplate = (template: string, ui: UserInfo, currentStatus: string): string => {
    const bi = ui.basic_identity;
    const pref = ui.preferences;
    const sg = ui.social_graph;
    const ps = ui.psycho_state;
    const lq = ui.life_quests;
    const graphText = sg.length > 0 ? sg.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ") : EMPTY;
    const tasksText = lq.ongoing_tasks.length > 0 ? lq.ongoing_tasks.map((t) => `${t.task_name}(${t.status})`).join("；") : EMPTY;
    const result = template
      .replace(/\{\{nickname\}\}/g, bi.nickname || "你")
      .replace(/\{\{occupation\}\}/g, bi.occupation || "未知")
      .replace(/\{\{location\}\}/g, bi.location || "未知")
      .replace(/\{\{likes\}\}/g, pref.likes.length > 0 ? pref.likes.join("、") : EMPTY)
      .replace(/\{\{dislikes\}\}/g, pref.dislikes.length > 0 ? pref.dislikes.join("、") : EMPTY)
      .replace(/\{\{social_graph\}\}/g, graphText)
      .replace(/\{\{personality_traits\}\}/g, ps.personality_traits.length > 0 ? ps.personality_traits.join("、") : EMPTY)
      .replace(/\{\{current_stressors\}\}/g, ps.current_stressors.length > 0 ? ps.current_stressors.join("、") : EMPTY)
      .replace(/\{\{comm_preference\}\}/g, ps.comm_preference || EMPTY)
      .replace(/\{\{long_term_goals\}\}/g, lq.long_term_goals.length > 0 ? lq.long_term_goals.join("、") : EMPTY)
      .replace(/\{\{ongoing_tasks\}\}/g, tasksText)
      .replace(/\{\{current_status\}\}/g, currentStatus || EMPTY)
      // 通用变量
      .replace(/\[user\]/g, bi.nickname || "你")
      .replace(/\[now\]/g, new Date().toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    // 移除空值行和空段落标题
    return result.split("\n").filter(line => !line.includes(EMPTY)).join("\n")
      .replace(/\n{3,}/g, "\n\n").trim();
  };

  // 渲染记忆区（使用模板）
  const renderMemorySection = (
    events: ReturnType<typeof getTopActive>,
    epiphany: ReturnType<typeof getTopActive>[0] | null,
    memEventTplOverride?: string,
    memInjectTplOverride?: string
  ): string => {
    const nickname = user_nickname || "用户";
    const prompts = getPrompts();
    const eventTpl = memEventTplOverride || prompts.memory_event_template;
    const injectTpl = memInjectTplOverride || prompts.memory_injection_template;

    // 渲染每条事件
    const eventLines: string[] = [];
    for (const e of events) {
      const text = e.event_text.replace(/\[user\]/gi, nickname);
      const line = eventTpl
        .replace(/\{\{weight\}\}/g, String(e.active_weight))
        .replace(/\{\{event_text\}\}/g, text);
      eventLines.push(line);
    }

    // 渲染灵光一闪
    let epiphanyText = "";
    if (epiphany) {
      const text = epiphany.event_text.replace(/\[user\]/gi, nickname);
      epiphanyText = `- [灵光一闪·冷记忆] ${text}`;
    }

    // 使用 memory_injection_template 拼装
    if (injectTpl && injectTpl.includes("{{")) {
      return injectTpl
        .replace(/\{\{event_list\}\}/g, eventLines.join("\n") || "（暂无记忆事件）")
        .replace(/\{\{epiphany\}\}/g, epiphanyText);
    }

    // 降级
    const lines: string[] = [];
    if (eventLines.length > 0) {
      lines.push("## 记忆区");
      lines.push(...eventLines);
    }
    if (epiphanyText) lines.push(epiphanyText);
    return lines.join("\n");
  };

  // 构建预览文本（展示完整 system prompt 拼接结果）
  const buildPreview = (): string => {
    const key = editorField?.key ?? "";
    const ui = getUserInfo();
    const nickname = user_nickname || "用户";
    const prompts = getPrompts();

    // 获取当前各段的实际值（编辑中的值优先）
    const getSysPrompt = () => {
      if (key === "system_prompt") return editorValue.replace(/\[user\]/gi, nickname);
      return prompts.system_prompt.replace(/\[user\]/gi, nickname);
    };
    const getStateInfo = () => {
      const tpl = key === "state_injection_template" ? editorValue : prompts.state_injection_template;
      if (!ui) return "";
      return tpl.includes("{{") ? renderStateTemplate(tpl, ui, "（当前状态预览）") : "（模板无变量占位符）";
    };
    const getMemoryInfo = () => {
      const events = getTopActive(10);
      return renderMemorySection(events, null) || "（暂无记忆事件）";
    };

    switch (key) {
      // ===== 系统人设：展示人设内容 =====
      case "system_prompt": {
        const sections: string[] = [];
        sections.push("━━━ 系统人设（当前编辑）━━━");
        sections.push(getSysPrompt());
        sections.push("", "━━━ 渲染效果 ━━━");
        sections.push("作为独立 system message 发送，缓存命中率最高。");
        return sections.join("\n");
      }

      // ===== 状态区模板：展示渲染后的状态区 =====
      case "state_injection_template": {
        const sections: string[] = [];
        sections.push("━━━ 状态区模板（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果 ━━━");
        if (ui) {
          sections.push(renderStateTemplate(editorValue, ui, "（当前状态预览）"));
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
        const memSection = renderMemorySection(events, null, undefined, editorValue);
        sections.push(memSection || "（暂无记忆事件）");
        return sections.join("\n");
      }

      // ===== 记忆事件格式 =====
      case "memory_event_template": {
        const sections: string[] = [];
        sections.push("━━━ 记忆事件格式（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果（完整记忆区）━━━");
        const events = getTopActive(10);
        const memSection = renderMemorySection(events, null, editorValue);
        sections.push(memSection || "（暂无记忆事件）");
        return sections.join("\n");
      }

      case "cold_start_template": {
        const sysPrompt = getSysPrompt();
        const coldStart = editorValue.replace(/\[user\]/gi, nickname);
        const fullSys = [sysPrompt, coldStart].filter(Boolean).join("\n\n");
        return fullSys;
      }

      // ===== 提取指令：展示完整提取 prompt =====
      case "extraction_prompt": {
        const events = getTopActive(50);
        const lines = [editorValue, "", "## 当前用户信息"];
        lines.push(ui ? JSON.stringify(ui, null, 2) : "（暂无用户信息）");
        lines.push("", "## 已有索引事件");
        if (events.length === 0) {
          lines.push("（暂无索引事件，请为本次对话创建新事件）");
        } else {
          for (const e of events) {
            lines.push(`- [id:${e.id}] ${e.event_text}`);
          }
        }
        lines.push("", "## 对话快照（最近 10 轮）");
        lines.push("[用户] （示例：你好）");
        lines.push("[助手] （示例：你好呀～最近怎么样？）");
        lines.push("", '请严格输出 JSON，格式：{"updated_user_info": {...}, "new_fragment": {"summary": "...", "emotion": "...", "target_event_index": 数字或-1, "new_event_text": ""}}');
        return lines.join("\n");
      }

      // ===== 做梦指令 =====
      case "dream_consolidation_prompt": {
        const events = getTopActive(50).slice(-10);
        const lines = [editorValue, "", "## 待折叠的琐碎事件"];
        if (events.length === 0) {
          lines.push("（暂无事件）");
        } else {
          for (let i = 0; i < events.length; i++) {
            lines.push(`${i + 1}. ${events[i].event_text}`);
          }
        }
        lines.push("", '请输出 JSON：{"folded_events": ["概括事件1", "概括事件2"]}');
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

输出格式：
{
  "basic_identity": {"nickname":"", "gender":"", "birthday":"", "occupation":"", "location":""},
  "preferences": {"likes":[], "dislikes":[]},
  "social_graph": [],
  "psycho_state": {"personality_traits":[], "current_stressors":[], "comm_preference":""},
  "life_quests": {"long_term_goals":[], "ongoing_tasks":[]}
}

规则：
- 只提取文本中明确提到的信息，不要推测
- 未提到的字段留空字符串或空数组
- likes/dislikes/personality_traits/long_term_goals 用字符串数组
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

      const parsed = JSON.parse(raw) as UserInfo;
      // 基础校验
      if (!parsed.basic_identity || !parsed.preferences) {
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
            {field.type === "multiline" ? "已编辑" : currentValue}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // 用户信息摘要
  const renderUserInfo = () => {
    if (!userInfo) return <Text style={styles.emptyText}>暂无用户数据</Text>;

    const { basic_identity, preferences, social_graph, psycho_state } = userInfo;
    const lines: string[] = [];
    if (basic_identity.nickname) lines.push(`昵称：${basic_identity.nickname}`);
    if (basic_identity.location) lines.push(`城市：${basic_identity.location}`);
    if (basic_identity.occupation) lines.push(`职业：${basic_identity.occupation}`);
    if (preferences.likes.length > 0) lines.push(`喜好：${preferences.likes.join("、")}`);
    if (preferences.dislikes.length > 0) lines.push(`不喜：${preferences.dislikes.join("、")}`);
    if (social_graph.length > 0) lines.push(`社交：${social_graph.map((s) => s.name).join("、")}`);
    if (psycho_state.personality_traits.length > 0) lines.push(`特质：${psycho_state.personality_traits.join("、")}`);

    if (lines.length === 0) return <Text style={[styles.emptyText, { color: colors.textMuted }]}>暂无用户数据</Text>;
    return lines.map((line, i) => <Text key={i} style={[styles.infoLine, { color: colors.textSecondary }]}>{line}</Text>);
  };

  const thresholdsVal = thresholds as Record<string, number>;
  const bgRouting = modelRouting.background_extraction_config;
  const fgRouting = modelRouting.foreground_chat_config;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]}>
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
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputKey(apiKey); setShowKeyModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{apiKey ? `${apiKey.slice(0, 8)}...` : "未设置"}</Text>
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
            style={[styles.toggle, stream_output ? styles.toggleOn : styles.toggleOff]}
            onPress={() => saveStreamOutput(!stream_output)}
          >
            <Text style={[styles.toggleText, stream_output ? styles.toggleTextOn : styles.toggleTextOff]}>
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
            style={[styles.toggle, thinking_mode ? styles.toggleOn : styles.toggleOff]}
            onPress={() => saveThinkingMode(!thinking_mode)}
          >
            <Text style={[styles.toggleText, thinking_mode ? styles.toggleTextOn : styles.toggleTextOff]}>
              {thinking_mode ? "开" : "关"}
            </Text>
          </TouchableOpacity>
        </View>
      </CollapsibleSection>

      {/* 模型路由 */}
      <CollapsibleSection title="模型路由" icon="🤖" defaultExpanded={false}>

        {/* 前台模型 */}
        <View style={[styles.modelRow, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>前台聊天模型</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>用户交互用，建议高质量模型</Text>
          </View>
          <View style={styles.modelActions}>
            <Text style={[styles.modelValue, { color: colors.accent }]}>{fgRouting.model}</Text>
            <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels("foreground_model")}>
              <Text style={[styles.fetchBtnText, { color: colors.text }]}>获取</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderConfigRow("模型路由", { key: "foreground_temperature", label: "前台温度", type: "number", description: "0-2，越高越有创意" }, String(fgRouting.temperature))}

        {/* 后台模型 */}
        <View style={[styles.modelRow, { borderBottomColor: colors.border }]}>
          <View style={styles.modelInfo}>
            <Text style={[styles.label, { color: colors.text }]}>后台提取模型</Text>
            <Text style={[styles.rowDesc, { color: colors.textMuted }]}>巩固/做梦用，建议低成本模型</Text>
          </View>
          <View style={styles.modelActions}>
            <Text style={[styles.modelValue, { color: colors.accent }]}>{bgRouting.model}</Text>
            <TouchableOpacity style={[styles.fetchBtn, { backgroundColor: colors.btnBg }]} onPress={() => handleFetchModels("background_model")}>
              <Text style={[styles.fetchBtnText, { color: colors.text }]}>获取</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderConfigRow("模型路由", { key: "background_temperature", label: "后台温度", type: "number", description: "建议 0，追求结构稳定" }, String(bgRouting.temperature))}
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
                setShowEventDetail(true);
              }}
              onLongPress={() => setDeletingEvent(evt)}
            >
              <View style={[styles.rowLeft, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.text, fontSize: 14, lineHeight: 20 }]}>{evt.event_text}</Text>
                <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
                  权重 {evt.active_weight} · 优先级 {evt.priority} · {new Date(evt.timestamp).toLocaleDateString()}
                </Text>
              </View>
              <Text style={[styles.value, { color: colors.textMuted, fontSize: 12 }]}>#{evt.id}</Text>
            </TouchableOpacity>
          ))
        )}
      </CollapsibleSection>

      {/* 数据管理 */}
      <CollapsibleSection title="数据管理" icon="🗑️" defaultExpanded={false}>
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

      <Text style={[styles.hint, { color: colors.textMuted }]}>支持所有 OpenAI 兼容 API：OpenAI / DeepSeek / Moonshot / 本地模型等</Text>

      {/* API Key 弹窗 */}
      <Modal visible={showKeyModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>设置 API Key</Text>
            <TextInput style={[styles.input, { borderColor: colors.border, color: colors.text }]} value={inputKey} onChangeText={setInputKey} placeholder="sk-..." placeholderTextColor={colors.placeholder} autoCapitalize="none" autoCorrect={false} autoFocus />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowKeyModal(false)}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleSaveKey}><Text style={styles.confirmText}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* API URL 弹窗 */}
      <Modal visible={showUrlModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>API 地址</Text>
            <TextInput style={styles.input} value={inputUrl} onChangeText={setInputUrl} placeholder="https://api.openai.com/v1" placeholderTextColor="#9B9A97" autoCapitalize="none" autoCorrect={false} autoFocus />
            <Text style={styles.modalHint}>DeepSeek: https://api.deepseek.com/v1{"\n"}Moonshot: https://api.moonshot.cn/v1</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowUrlModal(false)}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleSaveUrl}><Text style={styles.confirmText}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 称呼弹窗 */}
      <Modal visible={showNicknameModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>AI 怎么称呼你</Text>
            <TextInput style={styles.input} value={inputNickname} onChangeText={setInputNickname} placeholder="留空则不指定" placeholderTextColor="#9B9A97" autoFocus />
            <Text style={styles.modalHint}>系统提示词中的 [user] 会被替换为此称呼（不区分大小写）</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNicknameModal(false)}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleSaveNickname}><Text style={styles.confirmText}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* AI名字弹窗 */}
      <Modal visible={showAiNameModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>怎么称呼 TA</Text>
            <TextInput style={styles.input} value={inputAiName} onChangeText={setInputAiName} placeholder="留空则显示默认标题" placeholderTextColor="#9B9A97" autoFocus />
            <Text style={styles.modalHint}>标题栏会显示 TA 的名字</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAiNameModal(false)}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleSaveAiName}><Text style={styles.confirmText}>保存</Text></TouchableOpacity>
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
              {modelPickerTarget === "foreground_model" ? "前台模型" : "后台模型"}
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
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
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
                <Text style={[styles.editorSaveBtnText, { color: colors.textOnAccent }]}>确认保存</Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 新建事件弹窗 */}
      <Modal visible={showNewEventModal} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={[styles.modal, { maxHeight: "80%" }]}>
            <Text style={styles.modalTitle}>新建记忆事件</Text>
            <TextInput
              style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
              value={newEventText}
              onChangeText={setNewEventText}
              placeholder="输入事件内容..."
              placeholderTextColor="#9B9A97"
              multiline
              autoFocus
            />
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, gap: 8 }}>
              <Text style={[styles.modalHint, { marginTop: 0 }]}>权重 (1-100):</Text>
              <TextInput
                style={[styles.input, { flex: 1, marginTop: 0 }]}
                value={newEventWeight}
                onChangeText={setNewEventWeight}
                placeholder="50"
                placeholderTextColor="#9B9A97"
                keyboardType="number-pad"
              />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}>
              <Text style={[styles.modalHint, { marginTop: 0 }]}>优先级 (1-9):</Text>
              <TextInput
                style={[styles.input, { flex: 1, marginTop: 0 }]}
                value={newEventPriority}
                onChangeText={setNewEventPriority}
                placeholder="5"
                placeholderTextColor="#9B9A97"
                keyboardType="number-pad"
              />
            </View>
            <Text style={styles.modalHint}>权重：检索命中概率。优先级：1-3琐事，4-6中等，7-9重大（影响衰减速度）</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowNewEventModal(false)}><Text style={styles.cancelText}>取消</Text></TouchableOpacity>
              <TouchableOpacity style={styles.confirmBtn} onPress={handleCreateEvent}><Text style={styles.confirmText}>创建</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 事件编辑器 */}
      <Modal visible={showEventEditor} animationType="slide" onRequestClose={() => setShowEventEditor(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={[styles.editorContainer, { backgroundColor: colors.editorBg }]}>
            <View style={[styles.editorHeader, { backgroundColor: colors.editorBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setShowEventEditor(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editorTitle, { color: colors.text }]}>编辑事件 #{editingEvent?.id}</Text>
              <TouchableOpacity onPress={() => {
                if (editingEvent && editEventText.trim()) {
                  updateEventText(editingEvent.id, editEventText.trim());
                  setEvents(getTopActive(999));
                  setShowEventEditor(false);
                }
              }}>
                <Text style={[styles.confirmText, { color: colors.accent }]}>保存</Text>
              </TouchableOpacity>
            </View>
            {editingEvent && (
              <ScrollView style={{ flex: 1, padding: 20 }}>
                {/* 事件内容 */}
                <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>事件内容</Text>
                <TextInput
                  style={[styles.editorInputMultiline, { borderColor: colors.border, color: colors.text, minHeight: 80, marginHorizontal: 0, marginTop: 8 }]}
                  value={editEventText}
                  onChangeText={setEditEventText}
                  multiline
                  textAlignVertical="top"
                />
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 8 }}>
                  <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
                    权重: {editingEvent.active_weight} · 创建于 {new Date(editingEvent.timestamp).toLocaleString()}
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
                      <Text style={[styles.fragmentSummary, { color: colors.text }]}>{frag.summary}</Text>
                      {frag.emotion ? (
                        <Text style={[styles.fragmentEmotion, { color: colors.textMuted }]}>情绪: {frag.emotion}</Text>
                      ) : null}
                      <Text style={[styles.fragmentTime, { color: colors.textMuted }]}>
                        优先级 {frag.priority} · {new Date(frag.timestamp).toLocaleString()}
                      </Text>
                    </View>
                  ))
                )}

                {/* 添加新片段 */}
                <View style={[styles.sectionDivider, { borderTopColor: colors.border, marginTop: 16 }]}>
                  <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 16 }]}>添加片段</Text>
                </View>
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  value={newFragmentSummary}
                  onChangeText={setNewFragmentSummary}
                  placeholder="片段摘要（必填，建议包含 [user] [time]）"
                  placeholderTextColor="#9B9A97"
                  multiline
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  value={newFragmentEmotion}
                  onChangeText={setNewFragmentEmotion}
                  placeholder="情绪标记（选填）"
                  placeholderTextColor="#9B9A97"
                />
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}>
                  <Text style={[styles.modalHint, { marginTop: 0 }]}>优先级 (1-9):</Text>
                  <TextInput
                    style={[styles.input, { flex: 1, marginTop: 0 }]}
                    value={newFragmentPriority}
                    onChangeText={setNewFragmentPriority}
                    placeholder="5"
                    placeholderTextColor="#9B9A97"
                    keyboardType="number-pad"
                  />
                </View>
                <Text style={[styles.modalHint, { marginTop: 4 }]}>1-3琐事，4-6中等，7-9重大</Text>
                <TouchableOpacity
                  style={[styles.setupButton, { backgroundColor: newFragmentSummary.trim() ? colors.accent : colors.btnDisabled, marginTop: 12, marginBottom: 20 }]}
                  onPress={handleCreateFragment}
                  disabled={!newFragmentSummary.trim()}
                >
                  <Text style={[styles.setupButtonText, { color: colors.textOnAccent }]}>添加片段</Text>
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
                if (selectedEvent) {
                  setEditingEvent(selectedEvent);
                  setEditEventText(selectedEvent.event_text);
                  setEditorFragments(getFragmentsByEventId(selectedEvent.id));
                  setShowEventEditor(true);
                }
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
                <Text style={[styles.detailMetaLabel, { color: colors.textMuted }]}>权重</Text>
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
                    <Text style={[styles.fragmentIndex, { color: colors.textMuted }]}>#{index + 1}</Text>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Text style={[styles.fragmentEmotion, { color: colors.textMuted }]}>优先级 {frag.priority}</Text>
                      <Text style={[styles.fragmentEmotion, { color: colors.accent }]}>{frag.emotion}</Text>
                    </View>
                  </View>
                  <Text style={[styles.fragmentText, { color: colors.text }]}>{frag.summary}</Text>
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
                  setEvents(getTopActive(999));
                  setEventCount(getActiveCount());
                  setDeletingEvent(null);
                }
              }}>
                <Text style={[styles.confirmText, { color: colors.textOnAccent }]}>删除</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 人设编辑器 */}
      <Modal visible={personaModalVisible} animationType="slide" onRequestClose={() => setPersonaModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
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
                    style={[styles.setupButton, { backgroundColor: personaInput.trim() ? colors.accent : colors.btnDisabled, marginTop: 16 }]}
                    onPress={handleExtractPersona}
                    disabled={!personaInput.trim() || personaExtracting}
                  >
                    <Text style={[styles.setupButtonText, { color: colors.textOnAccent }]}>
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
                    {personaResult.basic_identity.nickname && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>昵称：{personaResult.basic_identity.nickname}</Text>}
                    {personaResult.basic_identity.gender && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>性别：{personaResult.basic_identity.gender}</Text>}
                    {personaResult.basic_identity.occupation && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>职业：{personaResult.basic_identity.occupation}</Text>}
                    {personaResult.basic_identity.location && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>城市：{personaResult.basic_identity.location}</Text>}
                    {personaResult.basic_identity.birthday && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>生日：{personaResult.basic_identity.birthday}</Text>}
                  </View>

                  {/* 偏好 */}
                  {(personaResult.preferences.likes.length > 0 || personaResult.preferences.dislikes.length > 0) && (
                    <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.infoTitle, { color: colors.text }]}>偏好</Text>
                      {personaResult.preferences.likes.length > 0 && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>喜欢：{personaResult.preferences.likes.join("、")}</Text>}
                      {personaResult.preferences.dislikes.length > 0 && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>讨厌：{personaResult.preferences.dislikes.join("、")}</Text>}
                    </View>
                  )}

                  {/* 心理状态 */}
                  {(personaResult.psycho_state.personality_traits.length > 0 || personaResult.psycho_state.comm_preference) && (
                    <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.infoTitle, { color: colors.text }]}>心理状态</Text>
                      {personaResult.psycho_state.personality_traits.length > 0 && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>性格：{personaResult.psycho_state.personality_traits.join("、")}</Text>}
                      {personaResult.psycho_state.current_stressors.length > 0 && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>压力：{personaResult.psycho_state.current_stressors.join("、")}</Text>}
                      {personaResult.psycho_state.comm_preference && <Text style={[styles.infoLine, { color: colors.textSecondary }]}>沟通偏好：{personaResult.psycho_state.comm_preference}</Text>}
                    </View>
                  )}

                  {/* 生活主线 */}
                  {personaResult.life_quests.long_term_goals.length > 0 && (
                    <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
                      <Text style={[styles.infoTitle, { color: colors.text }]}>生活主线</Text>
                      <Text style={[styles.infoLine, { color: colors.textSecondary }]}>目标：{personaResult.life_quests.long_term_goals.join("、")}</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: colors.accent, marginTop: 20 }]}
                    onPress={handleMergePersona}
                  >
                    <Text style={[styles.setupButtonText, { color: colors.textOnAccent }]}>合并到现有画像</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.resetBtn, { marginTop: 12, alignSelf: "center" }]}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F7F7F5", paddingTop: 8 },
  section: { backgroundColor: "#FFFFFF", marginBottom: 16, paddingHorizontal: 20, paddingVertical: 4 },
  sectionTitle: { fontSize: 12, fontWeight: "600", color: "#9B9A97", textTransform: "uppercase", letterSpacing: 1, paddingVertical: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  rowLeft: { flex: 1, marginRight: 12 },
  rowRight: { flexShrink: 0 },
  rowDesc: { fontSize: 12, color: "#9B9A97", marginTop: 2 },
  label: { fontSize: 15, color: "#37352F" },
  value: { fontSize: 14, color: "#9B9A97", maxWidth: 160, textAlign: "right" },
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
  actionRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  actionText: { fontSize: 15, color: "#2F81F7" },
  promptRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  promptPreview: { fontSize: 14, color: "#37352F", lineHeight: 20 },
  editHint: { fontSize: 12, color: "#2F81F7", marginTop: 8 },
  infoBlock: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  infoTitle: { fontSize: 13, fontWeight: "600", color: "#37352F", marginBottom: 8 },
  infoLine: { fontSize: 14, color: "#555450", lineHeight: 22 },
  emptyText: { fontSize: 14, color: "#9B9A97", fontStyle: "italic" },
  hint: { textAlign: "center", fontSize: 12, color: "#9B9A97", marginTop: 12, marginBottom: 40 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center" },
  modal: { width: "85%", backgroundColor: "#fff", borderRadius: 12, padding: 24 },
  modalTitle: { fontSize: 17, fontWeight: "600", color: "#37352F", marginBottom: 16 },
  input: { borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#37352F" },
  modalHint: { fontSize: 12, color: "#9B9A97", marginTop: 8, lineHeight: 18 },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", marginTop: 20, gap: 12 },
  cancelBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 6 },
  cancelText: { fontSize: 15, color: "#9B9A97" },
  confirmBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "#2F81F7", borderRadius: 6 },
  confirmText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  // 编辑器
  editorContainer: { flex: 1, backgroundColor: "#FFFFFF" },
  editorHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#E8E7E4" },
  editorTitle: { fontSize: 17, fontWeight: "600", color: "#37352F" },
  editorLabel: { fontSize: 15, fontWeight: "600", color: "#37352F", marginTop: 20, marginHorizontal: 20 },
  editorDesc: { fontSize: 13, color: "#9B9A97", marginTop: 4, marginHorizontal: 20 },
  editorInputSingle: { marginHorizontal: 20, marginTop: 12, borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: "#37352F" },
  editorInputMultiline: { flex: 1, minHeight: 200, marginHorizontal: 20, marginTop: 12, borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#37352F", lineHeight: 22 },
  editorFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E8E7E4" },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: "#F7F7F5" },
  resetText: { fontSize: 13, color: "#9B9A97" },
  editorSaveBtn: { marginHorizontal: 20, marginBottom: 34, marginTop: 8, backgroundColor: "#2F81F7", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  editorSaveBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
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
  // 事件详情
  detailText: { fontSize: 15, lineHeight: 24, marginTop: 8 },
  detailMeta: { flexDirection: "row", flexWrap: "wrap", gap: 16, paddingVertical: 16, marginTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  detailMetaItem: { minWidth: 80 },
  detailMetaLabel: { fontSize: 11, marginBottom: 4 },
  detailMetaValue: { fontSize: 14, fontWeight: "500" },
  fragmentCard: { borderRadius: 10, padding: 14, marginTop: 10, borderWidth: 1 },
  fragmentHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  fragmentIndex: { fontSize: 12 },
  fragmentEmotion: { fontSize: 13, fontWeight: "600" },
  fragmentText: { fontSize: 14, lineHeight: 20 },
  fragmentTime: { fontSize: 11, marginTop: 8 },
  sectionDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  fragmentItem: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  fragmentSummary: { fontSize: 14, lineHeight: 20 },
  detailActions: { paddingVertical: 24, marginTop: 24, borderTopWidth: StyleSheet.hairlineWidth },
  detailActionBtn: { paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  detailActionText: { fontSize: 15, fontWeight: "600" },
  // 颜色选择器
  colorRow: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  colorChips: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  colorChip: { width: 32, height: 32, borderRadius: 16, borderWidth: 2 },
  colorChipActive: { borderWidth: 3 },
  // 预览
  editorHeaderRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  previewToggle: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#F0F0EE", borderRadius: 6 },
  previewToggleText: { fontSize: 14, color: "#37352F", fontWeight: "500" },
  previewContainer: { flex: 1, marginHorizontal: 20, marginTop: 12, backgroundColor: "#F7F7F5", borderRadius: 8, padding: 14 },
  previewText: { fontSize: 13, color: "#37352F", lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  // 开关
  toggle: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, minWidth: 50, alignItems: "center" },
  toggleOn: { backgroundColor: "#2F81F7" },
  toggleOff: { backgroundColor: "#F0F0EE" },
  toggleText: { fontSize: 14, fontWeight: "600" },
  toggleTextOn: { color: "#FFFFFF" },
  toggleTextOff: { color: "#37352F" },
  setupButton: { paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  setupButtonText: { fontSize: 16, fontWeight: "600" },
});
