import { useState, useCallback } from "react";
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
import { useChatStore } from "@/store/chatStore";
import {
  getSystemPrompt,
  getConfigDefault,
  setCustomSystemPrompt,
  getThresholds,
  getWeightDecay,
  getModelRouting,
  getPrompts,
  setConfigOverride,
  resetConfigOverride,
} from "@/prompt/config";
import { getUserInfo, getTopActive, getActiveCount, getMeta, clearAllData, updateBasicIdentityNickname, updateEventText, deleteEvent } from "@/db/queries";
import { fetchModels } from "@/llm/client";
import type { UserInfo, MemoryEvent } from "@/types/schema";

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

const DECAY_FIELDS: ConfigField[] = [
  { key: "ebbinghaus_decay_rate", label: "衰减系数", type: "number", description: "艾宾浩斯遗忘速率（越大遗忘越快）" },
  { key: "epiphany_trigger_probability", label: "灵光一闪概率", type: "number", description: "0-1 之间，如 0.05 = 5%" },
];

const PROMPT_FIELDS: ConfigField[] = [
  { key: "system_prompt", label: "系统人设", type: "multiline", description: "AI 的角色定义与人格设定，用 [user] 指代用户" },
  { key: "context_template", label: "上下文提示词模板", type: "multiline", description: "已弃用：系统人设现独立为稳定 message，状态区+记忆区作为易变 message，分别缓存" },
  { key: "state_injection_template", label: "状态区注入模板", type: "multiline", description: "用户信息区的格式模板，用 {{variable}} 引用字段" },
  { key: "memory_injection_template", label: "记忆区注入模板", type: "multiline", description: "记忆区的整体格式，用 {{event_list}} 引用事件列表，{{epiphany}} 引用灵光一闪" },
  { key: "memory_event_template", label: "记忆事件格式", type: "multiline", description: "单条记忆事件的格式，用 {{event_text}} 引用事件内容（权重通过排序隐式表达）" },
  { key: "extraction_prompt", label: "提取指令", type: "multiline", description: "后台记忆与用户信息提取的系统指令" },
  { key: "dream_consolidation_prompt", label: "做梦折叠指令", type: "multiline", description: "冷数据语义折叠的 LLM 指令" },
  { key: "cold_start_template", label: "冷启动模板", type: "multiline", description: "空库首次对话的引导性人设" },
];

export default function SettingsScreen() {
  const { apiKey, baseUrl, user_nickname, saveApiKey, saveBaseUrl, saveUserNickname } = useSettingsStore();
  const clearMessages = useChatStore((s) => s.clearMessages);
  const colors = useTheme();
  const { themeMode, toggleTheme } = useThemeStore();

  const [showKeyModal, setShowKeyModal] = useState(false);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [inputKey, setInputKey] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [inputNickname, setInputNickname] = useState("");

  // 配置编辑器状态
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorField, setEditorField] = useState<ConfigField | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [previewMode, setPreviewMode] = useState(false);

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
  const [deletingEvent, setDeletingEvent] = useState<MemoryEvent | null>(null);

  // 配置值刷新
  const [thresholds, setThresholds] = useState(getThresholds());
  const [decay, setDecay] = useState(getWeightDecay());
  const [modelRouting, setModelRouting] = useState(getModelRouting());

  useFocusEffect(
    useCallback(() => {
      setUserInfo(getUserInfo());
      setEventCount(getActiveCount());
      setSystemPromptState(getSystemPrompt());
      setThresholds(getThresholds());
      setDecay(getWeightDecay());
      setModelRouting(getModelRouting());
      setEvents(getTopActive(999));
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
    return ["system_prompt", "context_template", "state_injection_template", "memory_injection_template", "memory_event_template", "extraction_prompt", "cold_start_template", "dream_consolidation_prompt"].includes(key);
  };

  // 渲染状态区模板（用 editorValue 替换 {{}}）
  const renderStateTemplate = (template: string, ui: UserInfo, emotion: string): string => {
    const bi = ui.basic_identity;
    const pref = ui.preferences;
    const sg = ui.social_graph;
    const ps = ui.psycho_state;
    const lq = ui.life_quests;
    const graphText = sg.length > 0 ? sg.map((s) => `${s.name}(${s.role})：${s.attitude}`).join("\n* ") : "无";
    const tasksText = lq.ongoing_tasks.length > 0 ? lq.ongoing_tasks.map((t) => `${t.task_name}(${t.status})`).join("；") : "无";
    return template
      .replace(/\{\{nickname\}\}/g, bi.nickname || "你")
      .replace(/\{\{occupation\}\}/g, bi.occupation || "未知")
      .replace(/\{\{location\}\}/g, bi.location || "未知")
      .replace(/\{\{likes\}\}/g, pref.likes.join("、") || "无")
      .replace(/\{\{dislikes\}\}/g, pref.dislikes.join("、") || "无")
      .replace(/\{\{social_graph\}\}/g, graphText)
      .replace(/\{\{personality_traits\}\}/g, ps.personality_traits.join("、") || "无")
      .replace(/\{\{current_stressors\}\}/g, ps.current_stressors.join("、") || "无")
      .replace(/\{\{comm_preference\}\}/g, ps.comm_preference || "无")
      .replace(/\{\{long_term_goals\}\}/g, lq.long_term_goals.join("、") || "无")
      .replace(/\{\{ongoing_tasks\}\}/g, tasksText)
      .replace(/\{\{emotion\}\}/g, emotion || "未知");
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
    const emotion = getMeta("last_emotion") || "";
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
      return tpl.includes("{{") ? renderStateTemplate(tpl, ui, emotion) : "（模板无变量占位符）";
    };
    const getMemoryInfo = () => {
      const events = getTopActive(10);
      return renderMemorySection(events, null) || "（暂无记忆事件）";
    };
    const getContextTemplate = () => {
      return key === "context_template" ? editorValue : prompts.context_template;
    };

    switch (key) {
      // ===== 系统人设：展示在上下文模板中的渲染结果 =====
      case "system_prompt": {
        const sections: string[] = [];
        sections.push("━━━ 系统人设（当前编辑）━━━");
        sections.push(getSysPrompt());
        sections.push("", "━━━ 完整上下文预览 ━━━");
        // 用 context_template 拼装
        const rendered = getContextTemplate()
          .replace(/\{\{\{system_prompt\}\}\}/g, getSysPrompt())
          .replace(/\{\{\{state_info\}\}\}/g, ui ? getStateInfo() : "")
          .replace(/\{\{\{memory_events\}\}\}/g, getMemoryInfo());
        sections.push(rendered);
        return sections.join("\n");
      }

      // ===== 上下文模板：展示渲染后的完整结果 =====
      case "context_template": {
        const sections: string[] = [];
        sections.push("━━━ 上下文模板（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果 ━━━");
        const sysText = getSysPrompt();
        const stateText = ui ? getStateInfo() : "";
        const memText = getMemoryInfo();
        const rendered = editorValue
          .replace(/\{\{\{system_prompt\}\}\}/g, sysText)
          .replace(/\{\{\{state_info\}\}\}/g, stateText || "（冷启动：无用户信息）")
          .replace(/\{\{\{memory_events\}\}\}/g, memText);
        sections.push(rendered);
        if (!ui) {
          sections.push("", "━━━ 冷启动模式 ━━━");
          sections.push("状态区和记忆区为空，系统将使用冷启动模板引导对话。");
        }
        return sections.join("\n");
      }

      // ===== 状态区模板：展示渲染后的状态区 =====
      case "state_injection_template": {
        const sections: string[] = [];
        sections.push("━━━ 状态区模板（当前编辑）━━━");
        sections.push(editorValue);
        sections.push("", "━━━ 渲染结果 ━━━");
        if (ui) {
          sections.push(renderStateTemplate(editorValue, ui, emotion));
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
        const rendered = getContextTemplate()
          .replace(/\{\{\{system_prompt\}\}\}/g, fullSys)
          .replace(/\{\{\{state_info\}\}\}/g, "")
          .replace(/\{\{\{memory_events\}\}\}/g, "");
        return rendered;
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
    setDecay(getWeightDecay());
    setModelRouting(getModelRouting());
    setSystemPromptState(getSystemPrompt());
    setEditorVisible(false);
  };

  // 恢复默认
  const handleResetConfig = async () => {
    if (!editorField) return;
    await resetConfigOverride(editorField.key);
    setThresholds(getThresholds());
    setDecay(getWeightDecay());
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
  const decayVal = decay as Record<string, number>;
  const bgRouting = modelRouting.background_extraction_config;
  const fgRouting = modelRouting.foreground_chat_config;

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* 外观 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>外观</Text>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={toggleTheme}>
          <Text style={[styles.label, { color: colors.text }]}>深色模式</Text>
          <Text style={[styles.value, { color: colors.accent }]}>{themeMode === "dark" ? "已开启" : "已关闭"}</Text>
        </TouchableOpacity>
      </View>

      {/* API */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>API</Text>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputUrl(baseUrl); setShowUrlModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>API 地址</Text>
          <Text style={[styles.value, { color: colors.textMuted }]} numberOfLines={1}>{baseUrl.replace(/^https?:\/\//, "")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputKey(apiKey); setShowKeyModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{apiKey ? `${apiKey.slice(0, 8)}...` : "未设置"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.row, { borderBottomColor: colors.border }]} onPress={() => { setInputNickname(user_nickname); setShowNicknameModal(true); }}>
          <Text style={[styles.label, { color: colors.text }]}>AI 怎么称呼你</Text>
          <Text style={[styles.value, { color: colors.textMuted }]}>{user_nickname || "未设置"}</Text>
        </TouchableOpacity>
      </View>

      {/* 模型路由 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>模型路由</Text>

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
      </View>

      {/* 记忆流转阈值 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>记忆流转阈值</Text>
        {THRESHOLD_FIELDS.map((f) =>
          renderConfigRow("记忆流转阈值", f, String(thresholdsVal[f.key]))
        )}
      </View>

      {/* 权重与衰减 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>权重与衰减</Text>
        {DECAY_FIELDS.map((f) =>
          renderConfigRow("权重与衰减", f, String(decayVal[f.key]))
        )}
      </View>

      {/* 提示词与模板 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>提示词与模板</Text>
        {PROMPT_FIELDS.map((f) => {
          const prompts = getPrompts();
          const value = (prompts as Record<string, string>)[f.key] ?? "";
          return renderConfigRow("提示词与模板", f, value);
        })}
      </View>

      {/* 记忆数据 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>用户画像</Text>
        <View style={[styles.infoBlock, { borderBottomColor: colors.border }]}>
          {renderUserInfo()}
        </View>
      </View>

      {/* 活跃事件列表 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>活跃记忆事件 ({eventCount})</Text>
        {events.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textMuted, paddingVertical: 16 }]}>暂无记忆事件</Text>
        ) : (
          events.map((evt) => (
            <TouchableOpacity
              key={evt.id}
              style={[styles.row, { borderBottomColor: colors.border, alignItems: "flex-start" }]}
              onPress={() => {
                setEditingEvent(evt);
                setEditEventText(evt.event_text);
                setShowEventEditor(true);
              }}
              onLongPress={() => setDeletingEvent(evt)}
            >
              <View style={[styles.rowLeft, { flex: 1 }]}>
                <Text style={[styles.label, { color: colors.text, fontSize: 14, lineHeight: 20 }]}>{evt.event_text}</Text>
                <Text style={[styles.rowDesc, { color: colors.textMuted }]}>
                  权重 {evt.active_weight} · {new Date(evt.timestamp).toLocaleDateString()}
                </Text>
              </View>
              <Text style={[styles.value, { color: colors.textMuted, fontSize: 12 }]}>#{evt.id}</Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* 数据管理 */}
      <View style={[styles.section, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>数据管理</Text>
        <TouchableOpacity style={[styles.actionRow, { borderBottomColor: colors.border }]} onPress={handleClearData}>
          <Text style={[styles.actionText, { color: colors.danger }]}>清除所有数据</Text>
        </TouchableOpacity>
      </View>

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
                style={[
                  editorField?.type === "multiline" ? styles.editorInputMultiline : styles.editorInputSingle,
                  { borderColor: colors.border, color: colors.text },
                ]}
                value={editorValue}
                onChangeText={setEditorValue}
                multiline={editorField?.type === "multiline"}
                keyboardType={editorField?.type === "number" ? "decimal-pad" : "default"}
                textAlignVertical={editorField?.type === "multiline" ? "top" : "center"}
                autoFocus
              />
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
              <View style={{ flex: 1, padding: 20 }}>
                <Text style={[styles.editorLabel, { color: colors.text, marginHorizontal: 0, marginTop: 0 }]}>事件内容</Text>
                <TextInput
                  style={[styles.editorInputMultiline, { borderColor: colors.border, color: colors.text, flex: 1, marginHorizontal: 0, marginTop: 8 }]}
                  value={editEventText}
                  onChangeText={setEditEventText}
                  multiline
                  autoFocus
                  textAlignVertical="top"
                />
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
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
              </View>
            )}
          </View>
        </KeyboardAvoidingView>
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
  editorInputMultiline: { flex: 1, marginHorizontal: 20, marginTop: 12, borderWidth: 1, borderColor: "#E8E7E4", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14, color: "#37352F", lineHeight: 22 },
  editorFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E8E7E4" },
  resetBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: "#F7F7F5" },
  resetText: { fontSize: 13, color: "#9B9A97" },
  editorSaveBtn: { marginHorizontal: 20, marginBottom: 34, marginTop: 8, backgroundColor: "#2F81F7", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  editorSaveBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  // 预览
  editorHeaderRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  previewToggle: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#F0F0EE", borderRadius: 6 },
  previewToggleText: { fontSize: 14, color: "#37352F", fontWeight: "500" },
  previewContainer: { flex: 1, marginHorizontal: 20, marginTop: 12, backgroundColor: "#F7F7F5", borderRadius: 8, padding: 14 },
  previewText: { fontSize: 13, color: "#37352F", lineHeight: 20, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
