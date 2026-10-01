import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  FlatList,
  StyleSheet,
  Keyboard,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Modal,
  Alert,
} from "react-native";
import dayjs from "dayjs";

import ChatBubble, { StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore, logDebug } from "@/store/chatStore";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { buildChatContext } from "@/memory/chatHandler";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import { shouldConsolidate, runConsolidation } from "@/memory/consolidation";
import { checkDuePromises, markPromiseReminded } from "@/memory/promiseChecker";
import { checkAndGenerateSchedule } from "@/memory/scheduler";
import {
  getActiveGameSession,
  getGameSessionById,
  createGameSession,
  finishGameSession,
  updateGameTurns,
  insertEpisode,
} from "@/db/queries";
import { startGame, handlePlayerInput, MAX_QUESTIONS } from "@/game/twentyQuestions";
import {
  buildGameSection,
  buildGameProgressHint,
  buildGameStartHint,
} from "@/game/prompt";
import {
  createYachtState,
  roll as yachtRoll,
  toggleKeep as yachtToggleKeep,
  score as yachtScore,
  canRoll as yachtCanRoll,
  openSlots,
  MAX_ROLLS,
  type YachtState,
} from "@/game/yacht/engine";
import {
  previewScores,
  totalScore,
  upperSubtotal,
  upperBonus,
  YACHT_SLOTS,
  type YachtSlot,
} from "@/game/yacht/rules";
import {
  decideKeep,
  decideSlot,
  fallbackKeep,
  fallbackSlot,
} from "@/game/yacht/ai";
import {
  buildYachtSection,
  buildYachtActionHint,
  buildYachtStartHint,
  buildYachtEndHint,
} from "@/game/yacht/prompt";
import { YachtDiceCard } from "@/components/YachtDiceCard";
import { YachtScoreCard } from "@/components/YachtScoreCard";
import {
  createBombState,
  guess as bombGuess,
  type BombState,
} from "@/game/bomb/engine";
import { aiGuess } from "@/game/bomb/ai";
import {
  buildBombSection,
  buildBombActionHint,
  buildBombStartHint,
  buildBombEndHint,
} from "@/game/bomb/prompt";
import { BombCard } from "@/components/BombCard";
import type { GameSession } from "@/types/schema";
import { useTheme } from "@/theme/useTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import type { ChatMessage } from "@/types/schema";

/** 首屏渲染的消息条数（更早的消息滑到顶部时再加载） */
const PAGE_SIZE = 30;

export default function ChatScreen() {
  const {
    messages,
    isLoading,
    streamingText,
    streamingChunks,
    streamingThinking,
    debugLogs,
    addMessage,
    deleteMessage,
    editMessage,
    setLoading,
    setStreamingText,
    appendStreamingText,
    setStreamingThinking,
    appendStreamingThinking,
    setDebugInfo,
    clearDebugLogs,
    getHistory,
  } = useChatStore();

  const { load: loadMeta, incrementTurn } = useMetaStore();
  const { loadApiKey, saveApiKey, saveBaseUrl, saveUserNickname, apiKey, baseUrl, user_nickname, ai_name, isReady } =
    useSettingsStore();

  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // 进行中的游戏会话（用于标题栏 HUD 与游戏分支）
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  // 快艇骰子对局状态（内存态，重启后可继续由 game_sessions 兜底）
  const [yachtState, setYachtState] = useState<YachtState | null>(null);
  // 快艇骰子是否显示计分卡
  const [showYachtScore, setShowYachtScore] = useState(false);
  // 数字炸弹对局状态
  const [bombState, setBombState] = useState<BombState | null>(null);

  // 快艇骰子：得分面板（点标题栏蓝字，在上方展开，不遮挡选择区）
  const [showYachtScores, setShowYachtScores] = useState(false);
  // 规则弹窗（点标题栏 ? 打开）
  const [showRules, setShowRules] = useState(false);
  // 游戏候选菜单（点 + 弹出）
  const [showGameMenu, setShowGameMenu] = useState(false);
  // 已展开的对局（默认折叠）
  const [expandedGames, setExpandedGames] = useState<Set<number>>(new Set());

  const toggleGameExpand = (gameId: number) => {
    setExpandedGames((prev) => {
      const next = new Set(prev);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  };

  // 把同局游戏消息聚合成一组，用于折叠渲染
  const gameGroupInfo = useMemo(() => {
    const map = new Map<number, { firstId: string; lastId: string; count: number }>();
    for (const m of messages) {
      if (!m.game_id) continue;
      const info = map.get(m.game_id);
      if (info) {
        info.lastId = m.id;
        info.count += 1;
      } else {
        map.set(m.game_id, { firstId: m.id, lastId: m.id, count: 1 });
      }
    }
    return map;
  }, [messages]);

  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("https://api.deepseek.com");
  const [nicknameInput, setNicknameInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [dotsCount, setDotsCount] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  // 长按菜单状态
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editText, setEditText] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);

  // 逐条延迟动画：仅非流式模式下对刚收到的 AI 回复生效
  const [animatingMsgId, setAnimatingMsgId] = useState<string | null>(null);
  // 编辑/删除操作时不自动滚底
  const skipScrollRef = useRef(false);
  // 用户是否贴在底部：只有贴底时才自动滚动，避免上翻历史时被强行拽回底部
  const atBottomRef = useRef(true);
  /**
   * 首屏只渲染最后 PAGE_SIZE 条并全部渲染：
   * FlatList 懒渲染时未渲染项的高度是估算值，contentSize 不准会导致定位偏移，
   * 因此限定一个较小的窗口，让首屏高度是真实值
   */
  const [renderCount, setRenderCount] = useState(PAGE_SIZE);
  const visibleMessages = useMemo(
    () => (messages.length > renderCount ? messages.slice(-renderCount) : messages),
    [messages, renderCount]
  );
  const hasMore = messages.length > renderCount;

  /** 贴底时才滚到底部 */
  const scrollToBottomIfNeeded = useCallback((animated = true) => {
    if (!atBottomRef.current) return false;
    if (skipScrollRef.current) return false;
    // scrollToOffset 超出范围会自动 clamp 到末尾，比 scrollToEnd 更可靠
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated });
    return true;
  }, []);

  /** 无条件对齐底部（打开 App 时的初始定位） */
  const scrollToBottomHard = useCallback(() => {
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
    });
  }, []);

  /**
   * 布局阶段同步定位：onLayout / onContentSizeChange 都早于绘制，
   * 在这里滚动可以让「第一帧」就画在底部，消除可见的跳动。
   * 仅在打开后的初始窗口内生效，之后不再干预，避免打扰上翻历史
   */
  const initialWindowRef = useRef(true);
  const scrollOnLayout = useCallback(() => {
    if (!initialWindowRef.current) return;
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
  }, []);

  // 初始窗口结束：之后完全交给 atBottomRef 控制
  useEffect(() => {
    const t = setTimeout(() => {
      initialWindowRef.current = false;
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  /**
   * 打开 App 时定位到最新消息
   * 只做「尽早 + 补一次」两次，且都在渲染后极短时间内完成，肉眼看不到跳变
   */
  useEffect(() => {
    if (messages.length === 0) return;
    if (!initialWindowRef.current) return;
    scrollToBottomHard();
    const t = setTimeout(scrollToBottomHard, 120);
    return () => clearTimeout(t);
  }, [messages.length, scrollToBottomHard]);

  // 初始化
  useEffect(() => {
    loadApiKey();
    loadMeta();
  }, []);

  // AI 作息时间表：进入聊天时检查本周是否已生成（不在发送路径上，避免阻塞首条消息）
  useEffect(() => {
    if (!isReady) return;
    checkAndGenerateSchedule().catch((err) => {
      console.error("[chat] 时间表生成异常:", err);
    });
  }, [isReady]);

  // 恢复未结束的对局（含快艇、数字炸弹状态）
  useEffect(() => {
    if (!isReady) return;
    const session = getActiveGameSession();
    setGameSession(session);
    if (session?.game_type === "yacht") {
      try {
        const state = JSON.parse(session.turns) as YachtState;
        setYachtState(state);
        if (state.currentPlayer === "ai" && !state.finished) {
          setTimeout(() => runYachtAiTurn(state, session.id), 100);
        }
      } catch {
        // 状态损坏则当作新对局
      }
    } else if (session?.game_type === "bomb") {
      try {
        const state = JSON.parse(session.turns) as BombState;
        setBombState(state);
        if (state.currentPlayer === "ai" && !state.finished) {
          setTimeout(() => runBombAiTurn(state, session.id), 100);
        }
      } catch {
        // 状态损坏则当作新对局
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // 检查到期约定
  useEffect(() => {
    if (!isReady) return;

    const checkPromises = () => {
      const duePromises = checkDuePromises();
      if (duePromises.length === 0) return;

      // 为每个到期约定发送系统消息
      for (const { task, message } of duePromises) {
        const sysMsg: ChatMessage = {
          id: dayjs().valueOf().toString() + "_promise",
          role: "user",
          content: `[系统消息] ${message}`,
          timestamp: dayjs().toISOString(),
        };
        addMessage(sysMsg);

        // 标记已提醒（内部完成数据库更新）
        markPromiseReminded(task.task_name);

        logDebug("约定提醒", `已提醒: ${task.task_name}`);
      }
    };

    // 立即检查一次
    checkPromises();

    // 每分钟检查一次
    const timer = setInterval(checkPromises, 60000);
    return () => clearInterval(timer);
  }, [isReady]);

  useEffect(() => {
    if (isReady) {
      setNicknameInput(user_nickname);
      setUrlInput(baseUrl);
    }
  }, [isReady, user_nickname, baseUrl]);

  // 检查 API Key
  useEffect(() => {
    if (isReady && !hasApiKey()) {
      setShowKeyInput(true);
    }
  }, [isReady]);

  // 流式输出时滚动到底部（仅在用户贴底时，上翻历史不打扰）
  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    if (streamingText) {
      scrollToBottomIfNeeded(true);
    }
  }, [streamingText, scrollToBottomIfNeeded]);

  // 打字动画
  useEffect(() => {
    if (!isLoading) {
      setDotsCount(0);
      return;
    }
    const timer = setInterval(() => {
      setDotsCount((prev) => (prev + 1) % 4);
    }, 500);
    return () => clearInterval(timer);
  }, [isLoading]);

  // 键盘弹出时滚动到底部
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      // 上翻历史时键盘弹出不打断阅读
      setTimeout(() => scrollToBottomIfNeeded(true), 100);
    });
    return () => sub.remove();
  }, []);

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    if (urlInput.trim()) {
      await saveBaseUrl(urlInput.trim());
    }
    await saveApiKey(trimmed);
    if (nicknameInput.trim()) {
      // 称呼的唯一写入口（写入 user_info 画像）
      await saveUserNickname(nicknameInput.trim());
    }
    setShowKeyInput(false);
    setKeyInput("");
  };

  // 判断是否为该角色的最后一条消息
  const isLastOfRole = (msg: ChatMessage) => {
    const last = [...messages].reverse().find((m) => m.role === msg.role);
    return last?.id === msg.id;
  };

  // 长按菜单操作
  const handleAction = async (action: "copy" | "delete" | "edit" | "regenerate") => {
    if (!actionTarget) return;
    setShowActionMenu(false);

    switch (action) {
      case "copy":
        try {
          const { Clipboard } = require("react-native");
          Clipboard.setString(actionTarget.content);
          Alert.alert("已复制", "消息内容已复制到剪贴板");
        } catch (e) {
          console.warn("复制失败:", e);
          Alert.alert("复制失败", "无法复制消息内容");
        }
        break;
      case "delete":
        setShowDeleteConfirm(true);
        break;
      case "edit":
        setEditText(actionTarget.content);
        setShowEditModal(true);
        break;
      case "regenerate":
        handleRegenerate();
        break;
    }
  };

  const confirmDelete = () => {
    if (actionTarget) {
      skipScrollRef.current = true;
      deleteMessage(actionTarget.id);
    }
    setShowDeleteConfirm(false);
    setActionTarget(null);
  };

  // 执行 LLM 调用（不添加用户消息，用于重新生成/编辑后重发）
  const doLLMCall = async () => {
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");
    try {
      const history = getHistory();
      const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
      const context = buildChatContext(lastUserMsg?.content || "", history);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      let fullThinking = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onThinking: (thinking) => {
          fullThinking += thinking;
          appendStreamingThinking(thinking);
        },
        onDone: (text, thinking) => {
          if (text) fullResponse = text;
          if (thinking) fullThinking = thinking;
          const aiMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
          };
          addMessage(aiMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
          // 非流式模式：消息一次性出现，需要逐条延迟动画
          if (!useSettingsStore.getState().stream_output) {
            setAnimatingMsgId(aiMsg.id);
          }

          const shouldRun = shouldConsolidate();
          if (shouldRun) {
            const h = useChatStore.getState().messages;
            runConsolidation(h).catch((err) =>
              console.error("[chat] 巩固流异常:", err),
            );
          }
        },
        onError: (error) => {
          const errorMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: `⚠️ ${error}`,
            timestamp: dayjs().toISOString(),
          };
          addMessage(errorMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      addMessage({
        id: dayjs().valueOf().toString(),
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: dayjs().toISOString(),
      });
      setStreamingText("");
      setStreamingThinking("");
      setLoading(false);
    }
  };

  const handleEditSave = (resend: boolean) => {
    if (!actionTarget) return;
    const trimmed = editText.trim();
    if (!trimmed) return;

    skipScrollRef.current = true;
    if (resend) {
      editMessage(actionTarget.id, trimmed);
      const idx = messages.findIndex((m) => m.id === actionTarget.id);
      if (idx >= 0) {
        const idsToDelete = messages.slice(idx + 1).map((m) => m.id);
        idsToDelete.forEach((id) => deleteMessage(id));
      }
      setShowEditModal(false);
      setActionTarget(null);
      setTimeout(() => doLLMCall(), 100);
    } else {
      editMessage(actionTarget.id, trimmed);
      setShowEditModal(false);
      setActionTarget(null);
    }
  };

  // ===== 数字炸弹 =====

  /** 开始一局数字炸弹 */
  const handleStartBomb = async () => {
    if (isLoading) return;
    const state = createBombState();
    const id = createGameSession({
      gameType: "bomb",
      mode: "user_asks",
      secret: String(state.bomb),
      secretSource: "public",
    });
    setBombState(state);
    setGameSession({
      id,
      game_type: "bomb",
      mode: "user_asks",
      status: "playing",
      secret: String(state.bomb),
      secret_source: "public",
      question_count: 0,
      turns: "[]",
      started_at: dayjs().toISOString(),
      ended_at: null,
      result_note: null,
    });
    updateGameTurns(id, JSON.stringify(state));
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: `你发起了 数字炸弹 · 系统想好了一个 1~100 的数字 · ${
        state.currentPlayer === "user" ? "你先猜" : `让${ai_name || "AI"}先猜`
      }`,
      timestamp: dayjs().toISOString(),
      game_id: id,
    });
    try {
      await runBombAiTalk(
        buildBombSection(state),
        buildBombStartHint(state.currentPlayer),
        id,
        // AI 先手时，开场后立即让它猜
        state.currentPlayer === "ai" ? state : undefined
      );
    } catch (err) {
      console.error("[bomb] 开场失败:", err);
      setLoading(false);
    }
  };

  /** AI 说一句话（数字炸弹） */
  const runBombAiTalk = async (
    section: string,
    hint: string,
    gameId?: number,
    aiTurnAfter?: BombState
  ) => {
    await runYachtAiTalk(section, hint, gameId);
    if (aiTurnAfter) await runBombAiTurn(aiTurnAfter, gameId);
  };

  /** AI 自动猜数 */
  const runBombAiTurn = async (state: BombState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    setLoading(true);
    try {
      const value = aiGuess(state);
      await sleep(600); // 让玩家看到节奏
      const next = bombGuess(state, value);
      setBombState(next);
      if (gid) updateGameTurns(gid, JSON.stringify(next));

      addMessage({
        id: dayjs().valueOf().toString(),
        role: "system",
        content: `${ai_name || "AI"} 猜了 ${value} → ${
          next.finished ? "💥 炸弹！" : next.guesses[next.guesses.length - 1].result === "high" ? "大了" : "小了"
        }`,
        timestamp: dayjs().toISOString(),
        game_id: gid,
      });

      if (next.finished) {
        await finishBomb(next, gid);
        return;
      }
      await runYachtAiTalk(
        buildBombSection(next),
        buildBombActionHint(next, next.guesses[next.guesses.length - 1]),
        gid
      );
    } catch (err) {
      console.error("[bomb] AI 猜数异常:", err);
    } finally {
      setLoading(false);
    }
  };

  /** 数字炸弹结束 */
  const finishBomb = async (state: BombState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    const aiWon = state.winner === "ai";
    const summary = `[user] [time]和我玩数字炸弹，最后${aiWon ? "他踩到炸弹输了" : "我踩到炸弹输了"}（炸弹是 ${state.bomb}）`;
    insertEpisode("一起玩数字炸弹", summary, aiWon ? "[user]有点不服，[ai]很得意" : "[user]很得意，[ai]想再来一局", aiWon ? 8 : 7);

    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: `🏁 数字炸弹结束 · 炸弹是 ${state.bomb} · ${aiWon ? "你踩到炸弹输了" : `${ai_name || "AI"} 踩到炸弹输了`}`,
      timestamp: dayjs().toISOString(),
      game_id: gid,
    });
    await runYachtAiTalk(buildBombSection(state), buildBombEndHint(state, aiWon), gid);
    setGameSession(null);
    setBombState(null);
  };

  /** 退出数字炸弹 */
  const handleBombQuit = () => {
    if (!bombState) return;
    insertEpisode(
      "一起玩数字炸弹",
      `[user] [time]和我玩数字炸弹，中途退出了（炸弹是 ${bombState.bomb}）`,
      "[user]不想玩了，[ai]觉得下次可以再来",
      7
    );
    if (gameSession?.id) {
      finishGameSession(gameSession.id, "abandoned", "玩家退出对局");
    }
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: "你退出了数字炸弹对局",
      timestamp: dayjs().toISOString(),
      game_id: gameSession?.id,
    });
    setGameSession(null);
    setBombState(null);
  };

  // ===== 快艇骰子 =====

  /** 让 AI 说一句话（游戏中的发言） */
  const runYachtAiTalk = async (section: string, hint: string, gameId?: number) => {
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");
    try {
      const context = buildChatContext("", getHistory(), { section, hint });
      let full = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          full += delta;
          appendStreamingText(delta);
        },
        onDone: (text) => {
          if (text) full = text;
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: full,
            timestamp: dayjs().toISOString(),
            game_id: gameId ?? gameSession?.id,
          });
        },
        onError: (err) => {
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: `⚠️ ${err}`,
            timestamp: dayjs().toISOString(),
          });
        },
      });
    } catch (err) {
      console.error("[yacht] AI 发言异常:", err);
    } finally {
      setStreamingText("");
      setStreamingThinking("");
      setLoading(false);
    }
  };

  /** 开始一局快艇骰子 */
  const handleStartYacht = async () => {
    if (isLoading) return;
    const state = createYachtState();
    const id = createGameSession({
      gameType: "yacht",
      mode: "user_asks",
      secret: "",
      secretSource: "public",
    });
    setYachtState(state);
    setGameSession({
      id,
      game_type: "yacht",
      mode: "user_asks",
      status: "playing",
      secret: "",
      secret_source: "public",
      question_count: 0,
      turns: "[]",
      started_at: dayjs().toISOString(),
      ended_at: null,
      result_note: null,
    });
    saveYachtState(state, id);
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: "你发起了 快艇骰子 · 1v1 对战 · 13 轮 · 你先掷",
      timestamp: dayjs().toISOString(),
      game_id: id,
    });
    try {
      await runYachtAiTalk(buildYachtSection(state), buildYachtStartHint(), id);
    } catch (err) {
      console.error("[yacht] 开场失败:", err);
      setLoading(false);
    }
  };

  /** 把快艇状态持久化到 game_sessions */
  const saveYachtState = (state: YachtState, gameId?: number) => {
    const id = gameId ?? gameSession?.id;
    if (id) {
      updateGameTurns(id, JSON.stringify(state));
    }
  };

  /** 把快艇对局写入长期记忆（episode 类型） */
  const writeYachtMemory = (state: YachtState, status: "finished" | "quit") => {
    const myScore = totalScore(state.scores.ai);
    const userScore = totalScore(state.scores.user);
    const result =
      status === "quit"
        ? `中途退出了（当时 ${userScore} : ${myScore}）`
        : state.winner === "user"
        ? `最后 ${userScore} : ${myScore}，我赢了`
        : state.winner === "ai"
        ? `最后 ${userScore} : ${myScore}，AI 赢了`
        : `最后打成 ${userScore} : ${myScore} 平手`;
    const summary = `[user] [time]和我玩了 ${state.round} 轮快艇骰子，${result}`;
    const emotion =
      status === "quit"
        ? "[user]有点想走，[ai]觉得下次可以再来"
        : state.winner === "user"
        ? "[user]赢了挺开心，[ai]想再比一局"
        : "[user]有点不服，[ai]觉得很过瘾";
    const priority = status === "quit" ? 7 : state.winner === "user" ? 8 : 7;
    insertEpisode("一起玩快艇骰子", summary, emotion, priority);
  };

  /** 用户掷骰 */
  const handleYachtRoll = () => {
    if (!yachtState) return;
    const next = yachtRoll(yachtState);
    setYachtState(next);
    saveYachtState(next);
  };

  /** 用户切换骰子锁定 */
  const handleYachtToggle = (index: number) => {
    if (!yachtState) return;
    const next = yachtToggleKeep(yachtState, index);
    setYachtState(next);
    saveYachtState(next);
  };

  /** 退出对局 */
  const handleYachtQuit = () => {
    if (!yachtState) return;
    writeYachtMemory(yachtState, "quit");
    if (gameSession?.id) {
      finishGameSession(gameSession.id, "abandoned", `玩家退出对局`);
    }
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: "你退出了快艇对局",
      timestamp: dayjs().toISOString(),
      game_id: gameSession?.id,
    });
    setGameSession(null);
    setYachtState(null);
    setShowYachtScore(false);
  };

  /** 用户填分，然后交给 AI */
  const handleYachtScore = async (slot: YachtSlot) => {
    if (!yachtState) return;
    const value = previewScores(yachtState.dice, yachtState.scores.user)[slot];
    const next = yachtScore(yachtState, slot);
    setYachtState(next);
    saveYachtState(next);
    setShowYachtScore(false);
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: `你选了「${YACHT_SLOTS.find((s) => s.key === slot)?.label}」= ${value} 分`,
      timestamp: dayjs().toISOString(),
      game_id: gameSession?.id,
    });

    if (next.finished) {
      await finishYacht(next, gameSession?.id);
      return;
    }
    await runYachtAiTurn(next, gameSession?.id);
  };

  /** 给异步决策加超时，避免网络挂起把整个回合卡死 */
  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);

  /** 让 AI 的掷骰过程可见 */
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** AI 自动回合：掷骰 → 决策 → 填分（带超时与兜底，保证一定推进） */
  const runYachtAiTurn = async (state: YachtState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    setLoading(true);
    try {
      let s = state;

      // 第一次全掷（实时更新面板，让用户看到 AI 在掷）
      s = yachtRoll(s);
      setYachtState(s);
      await sleep(700);

      // 决定保留哪些骰子（1 次决策，最多再掷 2 次）
      const decision = await withTimeout(
        decideKeep({
          dice: s.dice,
          usedSlots: s.scores.ai,
          myScore: totalScore(s.scores.ai),
          opponentScore: totalScore(s.scores.user),
          round: s.round,
          rollsLeft: MAX_ROLLS - s.rolls,
        }),
        8000
      );
      const keepIndices = decision?.keep ?? fallbackKeep(s.dice);
      const keepReason = decision?.reason ?? "";

      // 应用保留后继续掷（最多到 3 次），每一步都让玩家看到
      while (s.rolls < MAX_ROLLS) {
        s = {
          ...s,
          kept: Array.from({ length: 5 }, (_, i) => keepIndices.includes(i)),
        };
        s = yachtRoll(s);
        setYachtState(s);
        await sleep(700);
        // 全留了就不用再掷
        if (keepIndices.length >= 5) break;
      }

      // 选计分项
      const slotDecision = await withTimeout(
        decideSlot({
          dice: s.dice,
          usedSlots: s.scores.ai,
          myScore: totalScore(s.scores.ai),
          opponentScore: totalScore(s.scores.user),
          round: s.round,
        }),
        8000
      );
      const slot = slotDecision?.slot ?? fallbackSlot(s.dice, s.scores.ai);
      const reason = slotDecision?.reason ?? "";
      const value = previewScores(s.dice, s.scores.ai)[slot];

      const next = yachtScore(s, slot);
      setYachtState(next);
      saveYachtState(next, gid);

      // 把 AI 的最终结果显出来，别只留一句 AI 的话
      addMessage({
        id: dayjs().valueOf().toString(),
        role: "system",
        content: `${ai_name || "AI"} 掷出 ${s.dice.join(" ")}，填了「${
          YACHT_SLOTS.find((x) => x.key === slot)?.label ?? slot
        }」= ${value} 分`,
        timestamp: dayjs().toISOString(),
        game_id: gid,
      });

      if (next.finished) {
        await finishYacht(next, gid);
        return;
      }

      await runYachtAiTalk(
        buildYachtSection(next),
        buildYachtActionHint({
          state: next,
          action: "score",
          dice: s.dice,
          slot: YACHT_SLOTS.find((x) => x.key === slot)?.label ?? slot,
          slotValue: value,
          reason: reason || keepReason,
        }),
        gid
      );
    } catch (err) {
      console.error("[yacht] AI 回合异常:", err);
    } finally {
      setLoading(false);
    }
  };

  /** 对局结束 */
  const finishYacht = async (state: YachtState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    writeYachtMemory(state, "finished");
    addMessage({
      id: dayjs().valueOf().toString(),
      role: "system",
      content: `🏁 快艇对局结束 · 你 ${totalScore(state.scores.user)} : ${totalScore(state.scores.ai)} ${ai_name || "AI"}`,
      timestamp: dayjs().toISOString(),
      game_id: gid,
    });
    await runYachtAiTalk(buildYachtSection(state), buildYachtEndHint(state), gid);
    setGameSession(null);
    setYachtState(null);
    setShowYachtScore(false);
  };

  // 开始一局 20问：出题后让 AI 用自己的语气宣布开场
  const handleStartGame = async () => {
    if (isLoading) return;
    if (gameSession && gameSession.status === "playing") return;

    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");
    try {
      const session = await startGame();
      if (!session) {
        setLoading(false);
        Alert.alert("出题失败", "没能想好谜底，请检查网络或稍后再试");
        return;
      }
      setGameSession(session);
      // 系统提示：你发起了游戏（只用于界面，不进模型上下文）
      addMessage({
        id: dayjs().valueOf().toString(),
        role: "system",
        content: "你发起了 20问 · AI 心里想好了，只能问「是/不是」的问题，20 次内猜中算赢",
        timestamp: dayjs().toISOString(),
        game_id: session.id,
      });

      const context = buildChatContext("", getHistory(), {
        section: buildGameSection(session),
        hint: buildGameStartHint(session),
      });
      let fullResponse = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onDone: (text) => {
          if (text) fullResponse = text;
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
          });
          setStreamingText("");
          setLoading(false);
        },
        onError: (err) => {
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: `⚠️ ${err}`,
            timestamp: dayjs().toISOString(),
          });
          setStreamingText("");
          setLoading(false);
        },
      });
    } catch (err) {
      setLoading(false);
      Alert.alert("开始失败", err instanceof Error ? err.message : String(err));
    }
  };

  const handleRegenerate = () => {
    if (!actionTarget || actionTarget.role !== "assistant") return;
    skipScrollRef.current = true;
    deleteMessage(actionTarget.id);
    setActionTarget(null);
    setTimeout(() => doLLMCall(), 100);
  };

  const handleSend = async (text: string) => {
    // 用户主动发言，视为回到对话底部，后续新气泡可自动滚底
    atBottomRef.current = true;

    // 上一轮完成（最后一条是 AI 回复）才计数
    const currentHistory = getHistory();
    const lastRole = currentHistory.length > 0 ? currentHistory[currentHistory.length - 1].role : "none";
    if (lastRole === "assistant") {
      incrementTurn();
    }
    const counter = useMetaStore.getState().turnCounter;
    const locked = useMetaStore.getState().isLocked;
    logDebug("轮次计数", `lastRole=${lastRole}, turn_counter=${counter}, is_locked=${locked}`);

    // 游戏回合打标记：普通巩固流会跳过，由游戏自己的巩固写入记忆
    const currentGameId =
      gameSession && gameSession.status === "playing" ? gameSession.id : undefined;

    const userMsg: ChatMessage = {
      id: dayjs().valueOf().toString(),
      role: "user",
      content: text,
      timestamp: dayjs().toISOString(),
      game_id: currentGameId,
    };
    addMessage(userMsg);
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");

    try {
      // 游戏中：先做规则判定（谜底一致性由后台模型保证），再让 AI 用自然语气包装
      let gameParts: { section: string; hint: string } | undefined;

      // 数字炸弹：用户输入数字即为猜数，直接走游戏流程（不经过普通聊天）
      if (gameSession?.game_type === "bomb" && bombState && !bombState.finished) {
        const value = parseInt(text, 10);
        const isNumber = Number.isInteger(value) && value >= 1 && value <= 100;
        const valid = isNumber && !bombState.guesses.some((g) => g.value === value);
        if (valid) {
          const next = bombGuess(bombState, value);
          setBombState(next);
          updateGameTurns(gameSession.id, JSON.stringify(next));
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "system",
            content: `你猜 ${value} → ${
              next.finished ? "💥 炸弹！" : next.guesses[next.guesses.length - 1].result === "high" ? "大了" : "小了"
            }`,
            timestamp: dayjs().toISOString(),
            game_id: gameSession.id,
          });
          if (next.finished) {
            await finishBomb(next, gameSession.id);
            setLoading(false);
            return;
          }
          await runBombAiTurn(next, gameSession.id);
          setLoading(false);
          return;
        }
        // 非数字或重复：当作闲聊，带游戏上下文
        gameParts = {
          section: buildBombSection(bombState),
          hint: "（玩家在猜数间隙闲聊，正常陪他聊，可以顺带提一下对局进展）",
        };
      } else if (gameSession && gameSession.game_type === "yacht" && yachtState) {
        // 快艇骰子：用户闲聊，AI 以对局中的身份回应
        gameParts = {
          section: buildYachtSection(yachtState),
          hint: "（玩家在对局间隙闲聊，正常陪他聊，可以顺带提一下对局进展，不要复述规则）",
        };
      } else if (gameSession && gameSession.status === "playing") {
        const res = await handlePlayerInput(gameSession, text);
        setGameSession(res.session.status === "playing" ? res.session : null);
        // 对局结束时补一条系统提示（界面可见，不进上下文）
        if (res.ended) {
          const doneText =
            res.endStatus === "won"
              ? `🎉 猜中了！本局结束 · 谜底「${gameSession.secret}」 · 第 ${gameSession.question_count + (res.turn.intent === "question" || res.turn.intent === "guess" ? 1 : 0)} 次提问`
              : `🎭 本局结束 · 谜底「${gameSession.secret}」 · 用了 ${gameSession.question_count + (res.turn.intent === "question" || res.turn.intent === "guess" ? 1 : 0)} 次提问`;
          addMessage({
            id: dayjs().valueOf().toString(),
            role: "system",
            content: doneText,
            timestamp: dayjs().toISOString(),
            game_id: gameSession.id,
          });
          // 结束后自动折叠整局，留一个可展开的卡片
          setExpandedGames((prev) => {
            const next = new Set(prev);
            next.delete(gameSession.id);
            return next;
          });
        }
        gameParts = {
          section: buildGameSection(gameSession),
          hint: res.ended
            ? `本局结束（${res.endStatus === "won" ? "玩家猜中了" : "未猜中"}），请自然地宣布结果并揭晓谜底：「${gameSession.secret}」，然后接回日常聊天。`
            : buildGameProgressHint(res.session, res.turn),
        };
      }

      const history = getHistory();
      const context = buildChatContext(text, history, gameParts);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);

      let fullResponse = "";
      let fullThinking = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          fullResponse += delta;
          appendStreamingText(delta);
        },
        onThinking: (thinking) => {
          fullThinking += thinking;
          appendStreamingThinking(thinking);
        },
        onDone: (text, thinking) => {
          if (text) fullResponse = text;
          if (thinking) fullThinking = thinking;
          const aiMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
            game_id: currentGameId,
          };
          addMessage(aiMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
          // 流式输出已实时展示，不需要逐条延迟动画

          const shouldRun = shouldConsolidate();
          if (shouldRun) {
            const h = useChatStore.getState().messages;
            runConsolidation(h).catch((err) =>
              console.error("[chat] 巩固流异常:", err),
            );
          }
        },
        onError: (error) => {
          const errorMsg: ChatMessage = {
            id: dayjs().valueOf().toString(),
            role: "assistant",
            content: `⚠️ ${error}`,
            timestamp: dayjs().toISOString(),
          };
          addMessage(errorMsg);
          setStreamingText("");
          setStreamingThinking("");
          setLoading(false);
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      addMessage({
        id: dayjs().valueOf().toString(),
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: dayjs().toISOString(),
      });
      setStreamingText("");
      setStreamingThinking("");
      setLoading(false);
    }
  };

  // API 设置界面
  if (showKeyInput) {
    return (
      <View style={[styles.setupContainer, { backgroundColor: colors.sectionBg }]}>
        <Text style={[styles.setupTitle, { color: colors.text }]}>设置 API</Text>
        <Text style={[styles.setupHint, { color: colors.textMuted }]}>支持 OpenAI / DeepSeek / Moonshot 等兼容 API</Text>

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>API 地址</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={urlInput}
          onChangeText={setUrlInput}
          placeholder="https://api.deepseek.com/v1"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>API Key</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={keyInput}
          onChangeText={setKeyInput}
          placeholder="sk-..."
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>你希望 AI 怎么称呼你？</Text>
        <TextInput
          style={[styles.setupInput, { borderColor: colors.border, color: colors.text }]}
          value={nicknameInput}
          onChangeText={setNicknameInput}
          placeholder="留空则不指定"
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity style={[styles.setupButton, { backgroundColor: colors.accent }]} onPress={handleSaveKey}>
          <Text style={[styles.setupButtonText, { color: colors.textOnAccent }]}>确认</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bg }]}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {/* 标题栏（紧凑：按安全区适配，右侧提供设置入口） */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 6,
            backgroundColor: colors.sectionBg,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity onLongPress={() => setShowDebug(true)} delayLongPress={800}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {isLoading ? `正在输入中${".".repeat(dotsCount)}` : (ai_name || "私藏")}
          </Text>
        </TouchableOpacity>
        {gameSession?.game_type === "yacht" && yachtState ? (
          <View style={styles.hudWrap}>
            {/* 点蓝字展开/收起得分面板（在选择区上方，不遮挡） */}
            <TouchableOpacity onPress={() => setShowYachtScores((v) => !v)}>
              <Text style={[styles.gameBadge, { color: colors.accent }]}>
                🎲 第 {yachtState.round}/13 轮 · 你 {totalScore(yachtState.scores.user)} - {totalScore(yachtState.scores.ai)} {ai_name || "AI"} {showYachtScores ? "▴" : "▾"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowRules(true)}
              style={[styles.hudHelpBtn, { borderColor: colors.border }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.hudHelpText, { color: colors.textMuted }]}>?</Text>
            </TouchableOpacity>
          </View>
        ) : gameSession?.game_type === "bomb" && bombState ? (
          <View style={styles.hudWrap}>
            <Text style={[styles.gameBadge, { color: colors.accent }]}>
              💣 {bombState.finished ? "已结束" : bombState.currentPlayer === "user" ? "轮到你猜" : `轮到${ai_name || "AI"}猜`} · 已猜 {bombState.guesses.length} 次
            </Text>
            <TouchableOpacity
              onPress={() => setShowRules(true)}
              style={[styles.hudHelpBtn, { borderColor: colors.border }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.hudHelpText, { color: colors.textMuted }]}>?</Text>
            </TouchableOpacity>
          </View>
        ) : gameSession?.game_type === "twenty_questions" && gameSession.status === "playing" ? (
          <View style={styles.hudWrap}>
            <Text style={[styles.gameBadge, { color: colors.accent }]}>
              20问 · {gameSession.question_count}/{MAX_QUESTIONS}
            </Text>
            <TouchableOpacity
              onPress={() => setShowRules(true)}
              style={[styles.hudHelpBtn, { borderColor: colors.border }]}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Text style={[styles.hudHelpText, { color: colors.textMuted }]}>?</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <TouchableOpacity
          onPress={() => router.push("/settings")}
          style={styles.headerAction}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={[styles.headerActionText, { color: colors.textMuted }]}>设置</Text>
        </TouchableOpacity>
      </View>

      {messages.length === 0 && !isLoading && (
        <View style={styles.welcomeContainer}>
          <Text style={[styles.welcomeHint, { color: colors.textMuted }]}>你愿意和我聊聊吗？</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={visibleMessages}
        keyExtractor={(item) => item.id}
        // 首屏窗口内全部渲染，保证 contentSize 是真实值
        initialNumToRender={visibleMessages.length}
        // 滑到顶部时加载更早的消息
        onStartReached={() => {
          if (hasMore) {
            setRenderCount((c) => Math.min(c + PAGE_SIZE, messages.length));
          }
        }}
        onStartReachedThreshold={0.2}
        // 顶部插入更早消息时保持当前可见位置，不跳动
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        // 布局阶段即对齐底部（早于绘制，避免看到从顶部跳到底部）
        onLayout={scrollOnLayout}
        onContentSizeChange={scrollOnLayout}
        // 用户一旦开始滑动就结束初始窗口，彻底交还控制权
        onScrollBeginDrag={() => {
          initialWindowRef.current = false;
        }}
        // 追踪是否贴底：距底部 80pt 内视为贴底
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const distanceFromBottom =
            contentSize.height - layoutMeasurement.height - contentOffset.y;
          atBottomRef.current = distanceFromBottom < 80;
        }}
        scrollEventThrottle={16}
        renderItem={({ item }) => {
          // 游戏回合默认折叠成一张卡片，点开才看完整过程
          if (item.game_id) {
            const gameId = item.game_id;
            const info = gameGroupInfo.get(gameId);
            const isGroupStart = info?.firstId === item.id;
            const expanded = expandedGames.has(gameId);
            const session = getGameSessionById(gameId);
            const resultText =
              session?.status === "won"
                ? "猜中了"
                : session?.status === "lost"
                ? "没猜中"
                : session?.status === "abandoned"
                ? "未完局"
                : "进行中";
            const gameName =
              session?.game_type === "yacht"
                ? "快艇骰子"
                : session?.game_type === "bomb"
                ? "数字炸弹"
                : "20问";

            return (
              <>
                {isGroupStart && (
                  <TouchableOpacity
                    style={[styles.gameCard, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}
                    onPress={() => toggleGameExpand(gameId)}
                  >
                    <Text style={[styles.gameCardTitle, { color: colors.text }]}>
                      🎮 {gameName} · {resultText}
                      {session?.game_type === "twenty_questions" && session?.status !== "playing"
                        ? ` · 谜底「${session?.secret}」`
                        : ""}
                    </Text>
                    <Text style={[styles.gameCardHint, { color: colors.textMuted }]}>
                      {expanded ? "点击收起 ▴" : `${info?.count ?? 0} 条对话 · 点击展开 ▾`}
                    </Text>
                  </TouchableOpacity>
                )}
                {expanded && (
                  <ChatBubble
                    message={item}
                    shouldAnimate={item.id === animatingMsgId}
                    onLongPress={() => {
                      setActionTarget(item);
                      setShowActionMenu(true);
                    }}
                  />
                )}
              </>
            );
          }

          return (
            <ChatBubble
              message={item}
              shouldAnimate={item.id === animatingMsgId}
              onBubbleAppear={() => {
                // 新气泡出现属于正常消息流，但仅在贴底时才滚
                skipScrollRef.current = false;
                setTimeout(() => scrollToBottomIfNeeded(true), 50);
              }}
              onLongPress={() => {
                setActionTarget(item);
                setShowActionMenu(true);
              }}
            />
          );
        }}
        ListFooterComponent={
          (streamingThinking || streamingChunks.length > 0) ? (
            <>
              {/* 流式思考气泡 */}
              {streamingThinking ? (
                <View style={[styles.thinkingContainer, { borderColor: colors.border }]}>
                  <Text style={[styles.thinkingLabel, { color: colors.textMuted }]}>💭 思考中...</Text>
                  <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{streamingThinking}</Text>
                </View>
              ) : null}
              {/* 流式内容气泡 */}
              {streamingChunks.map((chunk, index) => (
                <StreamingBubble key={index} text={chunk} />
              ))}
            </>
          ) : null
        }
        contentContainerStyle={styles.listContent}
        style={styles.list}
      />

      {/* 底栏隐藏后需自行避让系统手势区 */}
      <View style={{ paddingBottom: insets.bottom }}>
        {/* 数字炸弹面板 */}
        {gameSession?.game_type === "bomb" && bombState && !bombState.finished ? (
          <BombCard state={bombState} aiName={ai_name || "AI"} onQuit={handleBombQuit} />
        ) : null}

        {/* 快艇骰子面板 */}
        {gameSession?.game_type === "yacht" && yachtState && !yachtState.finished ? (
          <View>
            {/* 得分面板（点标题栏蓝字展开，在骰子面板上方，不遮挡选择） */}
            {showYachtScores && (
              <YachtScoreCard
                rows={YACHT_SLOTS.map((s) => ({
                  slot: s.key,
                  label: s.label,
                  section: s.section,
                  user: yachtState.scores.user[s.key] ?? null,
                  ai: yachtState.scores.ai[s.key] ?? null,
                }))}
                selectable={false}
                aiName={ai_name || "AI"}
                preview={previewScores(yachtState.dice, yachtState.scores.user)}
                upperUser={upperSubtotal(yachtState.scores.user)}
                bonusUser={upperBonus(yachtState.scores.user)}
                upperAi={upperSubtotal(yachtState.scores.ai)}
                bonusAi={upperBonus(yachtState.scores.ai)}
                totalUser={totalScore(yachtState.scores.user)}
                totalAi={totalScore(yachtState.scores.ai)}
              />
            )}
            <YachtDiceCard
              dice={yachtState.dice}
              kept={yachtState.kept}
              rollsLeft={MAX_ROLLS - yachtState.rolls}
              canRoll={yachtCanRoll(yachtState) && yachtState.currentPlayer === "user"}
              onToggle={handleYachtToggle}
              onRoll={handleYachtRoll}
              onScore={() => {
                setShowYachtScore(true);
                // 填分面板和只读得分面板共用组件，避免重复显示
                setShowYachtScores(false);
              }}
              readOnly={yachtState.currentPlayer === "ai"}
            />
            {showYachtScore && (
              <YachtScoreCard
                rows={YACHT_SLOTS.map((s) => ({
                  slot: s.key,
                  label: s.label,
                  section: s.section,
                  user: yachtState.scores.user[s.key] ?? null,
                  ai: yachtState.scores.ai[s.key] ?? null,
                }))}
                selectable={yachtState.currentPlayer === "user"}
                onSelect={handleYachtScore}
                aiName={ai_name || "AI"}
                preview={previewScores(yachtState.dice, yachtState.scores.user)}
                upperUser={upperSubtotal(yachtState.scores.user)}
                bonusUser={upperBonus(yachtState.scores.user)}
                upperAi={upperSubtotal(yachtState.scores.ai)}
                bonusAi={upperBonus(yachtState.scores.ai)}
                totalUser={totalScore(yachtState.scores.user)}
                totalAi={totalScore(yachtState.scores.ai)}
              />
            )}
            {/* 退出对局 */}
            <TouchableOpacity onPress={handleYachtQuit} style={styles.quitBtn}>
              <Text style={[styles.quitText, { color: colors.textMuted }]}>退出对局</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* 游戏进行中：系统提示剩余提问次数（不靠 AI 报数） */}
        {gameSession?.game_type === "twenty_questions" && gameSession.status === "playing" ? (
          <View style={[styles.gameStatus, { borderColor: colors.border }]}>
            <Text style={[styles.gameStatusText, { color: colors.textMuted }]}>
              🎮 20问进行中 · 还剩 {MAX_QUESTIONS - gameSession.question_count} 次提问机会 · 闲聊不计入
            </Text>
          </View>
        ) : null}

        <InputBar
          onSend={handleSend}
          disabled={isLoading}
          onPlus={() => setShowGameMenu(true)}
          hidePlus={Boolean(gameSession && gameSession.status === "playing")}
        />

      {/* 游戏候选菜单 */}
      <Modal visible={showGameMenu} transparent animationType="fade" onRequestClose={() => setShowGameMenu(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowGameMenu(false)}>
          <View style={[styles.gameMenu, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.gameMenuTitle, { color: colors.textMuted }]}>玩点什么</Text>
            <TouchableOpacity
              style={styles.gameMenuItem}
              onPress={() => {
                setShowGameMenu(false);
                handleStartGame();
              }}
            >
              <Text style={[styles.gameMenuText, { color: colors.text }]}>20问 · 我来猜</Text>
              <Text style={[styles.gameMenuDesc, { color: colors.textMuted }]}>
                AI 心里想一个人物，你问是非问题来猜
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gameMenuItem, { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => {
                setShowGameMenu(false);
                handleStartYacht();
              }}
            >
              <Text style={[styles.gameMenuText, { color: colors.text }]}>快艇骰子 · 1v1 对战</Text>
              <Text style={[styles.gameMenuDesc, { color: colors.textMuted }]}>
                5 个骰子比大小，13 轮决出胜负
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gameMenuItem, { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => {
                setShowGameMenu(false);
                handleStartBomb();
              }}
            >
              <Text style={[styles.gameMenuText, { color: colors.text }]}>数字炸弹 · 谁猜中谁输</Text>
              <Text style={[styles.gameMenuDesc, { color: colors.textMuted }]}>
                1~100 随机一个数字，轮流猜数缩小范围
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.gameMenuItem, { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => setShowGameMenu(false)}
            >
              <Text style={[styles.gameMenuText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* 规则弹窗（点标题栏 ? 打开） */}
      <Modal visible={showRules} transparent animationType="fade" onRequestClose={() => setShowRules(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowRules(false)}>
          <ScrollView style={[styles.helpModal, { backgroundColor: colors.sectionBg }]} contentContainerStyle={{ padding: 16 }}>
            {gameSession?.game_type === "twenty_questions" ? (
              <>
                <Text style={[styles.helpTitle, { color: colors.text }]}>20问 · 规则</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  AI 心里想好一个谜底，你只能问「是/不是」的问题，20 次内猜中算赢。
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>怎么玩</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  • 直接问是非问题（如"是真人吗"）{"\n"}
                  • 猜的时候直接说出答案（如"是小李！"）{"\n"}
                  • 闲聊、吐槽、要提示**不计入**次数{"\n"}
                  • 也可以中途投降（"不玩了"）
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>计数</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  只有「是非问题」和「直接猜」计入 20 次，其余不计。
                </Text>
              </>
            ) : gameSession?.game_type === "bomb" ? (
              <>
                <Text style={[styles.helpTitle, { color: colors.text }]}>数字炸弹 · 规则</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  系统随机想好一个 1~100 的数字（炸弹），双方轮流猜数来缩小范围。
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>怎么玩</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  • 在聊天框输入 1~100 的数字来猜{"\n"}
                  • 猜完系统会提示「大了」或「小了」{"\n"}
                  • 谁猜中炸弹谁就输
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>先后手</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  每局随机决定谁先猜。
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.helpTitle, { color: colors.text }]}>快艇骰子 · 规则</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  5 个骰子，每轮最多掷 3 次。第一次全掷，之后可以点击骰子「锁定」想留的，只重掷其余。13 轮后总分高者胜。
                </Text>

                <Text style={[styles.helpSection, { color: colors.text }]}>上半区（数字项）</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  1点 ~ 6点：对应点数之和。例如三个 5 填「5点」= 15 分{"\n"}
                  上半区合计 ≥ 63 加 35 分奖励
                </Text>

                <Text style={[styles.helpSection, { color: colors.text }]}>下半区（组合项）</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  三条（3 个相同）：全部骰子之和{"\n"}
                  四条（4 个相同）：全部骰子之和{"\n"}
                  葫芦（3+2）：25 分{"\n"}
                  小顺（4 连续）：30 分{"\n"}
                  大顺（5 连续）：40 分{"\n"}
                  快艇（5 个相同）：50 分{"\n"}
                  机会（任意）：全部骰子之和
                </Text>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Modal>
      </View>

      {/* 长按操作菜单 */}
      <Modal visible={showActionMenu} transparent animationType="fade" onRequestClose={() => setShowActionMenu(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowActionMenu(false)}>
          <View style={[styles.actionSheet, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.actionTitle, { color: colors.textMuted }]}>
              {actionTarget?.role === "user" ? "消息操作" : "AI 回复操作"}
            </Text>
            {actionTarget?.role === "assistant" && isLastOfRole(actionTarget) && (
              <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("regenerate")}>
                <Text style={[styles.actionText, { color: colors.text }]}>🔄 重新生成</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("copy")}>
              <Text style={[styles.actionText, { color: colors.text }]}>📋 复制</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("edit")}>
              <Text style={[styles.actionText, { color: colors.text }]}>✏️ 编辑</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("delete")}>
              <Text style={[styles.actionText, { color: colors.danger }]}>🗑️ 删除</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionCancel, { backgroundColor: colors.bg }]} onPress={() => setShowActionMenu(false)}>
              <Text style={[styles.actionCancelText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* 删除确认 */}
      <Modal visible={showDeleteConfirm} transparent animationType="fade" onRequestClose={() => setShowDeleteConfirm(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowDeleteConfirm(false)}>
          <View style={[styles.confirmBox, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.confirmTitle, { color: colors.text }]}>确认删除？</Text>
            <Text style={[styles.confirmDesc, { color: colors.textMuted }]}>删除后无法恢复</Text>
            <View style={styles.confirmButtons}>
              <TouchableOpacity style={[styles.confirmCancel, { backgroundColor: colors.btnBg }]} onPress={() => setShowDeleteConfirm(false)}>
                <Text style={[styles.confirmCancelText, { color: colors.text }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.confirmDelete, { backgroundColor: colors.danger }]} onPress={confirmDelete}>
                <Text style={[styles.confirmDeleteText, { color: colors.textOnAccent }]}>删除</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
      </Modal>

      {/* 编辑消息 */}
      <Modal visible={showEditModal} animationType="slide" onRequestClose={() => setShowEditModal(false)}>
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: colors.bg }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.editContainer, { backgroundColor: colors.sectionBg }]}>
            <View style={[styles.editHeader, { backgroundColor: colors.sectionBg, borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setShowEditModal(false)}>
                <Text style={[styles.cancelText, { color: colors.textMuted }]}>取消</Text>
              </TouchableOpacity>
              <Text style={[styles.editTitle, { color: colors.text }]}>编辑消息</Text>
              <View style={{ width: 50 }} />
            </View>
            <TextInput
              style={[styles.editInput, { color: colors.text }]}
              value={editText}
              onChangeText={setEditText}
              multiline
              autoFocus
              textAlignVertical="top"
            />
            <View style={[styles.editButtons, { borderTopColor: colors.border }]}>
              <TouchableOpacity
                style={[styles.editSaveBtn, { backgroundColor: colors.btnBg }]}
                onPress={() => handleEditSave(false)}
              >
                <Text style={[styles.editSaveBtnText, { color: colors.text }]}>完成</Text>
              </TouchableOpacity>
              {actionTarget?.role === "user" && isLastOfRole(actionTarget) && (
                <TouchableOpacity
                  style={[styles.editResendBtn, { backgroundColor: colors.accent }]}
                  onPress={() => handleEditSave(true)}
                >
                  <Text style={[styles.editResendBtnText, { color: colors.textOnAccent }]}>完成并发送</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* 调试弹窗 */}
      <Modal visible={showDebug} animationType="slide" onRequestClose={() => setShowDebug(false)}>
        <View style={[styles.debugContainer, { backgroundColor: colors.bg }]}>
          <View style={[styles.debugHeader, { backgroundColor: colors.sectionBg, borderBottomColor: colors.border }]}>
            <Text style={[styles.debugTitle, { color: colors.text }]}>🔧 开发者调试</Text>
            <TouchableOpacity onPress={() => setShowDebug(false)}>
              <Text style={[styles.debugClose, { color: colors.accent }]}>关闭</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            ref={(ref) => { if (ref && debugLogs.length > 0) setTimeout(() => ref.scrollToEnd({ animated: false }), 100); }}
            style={styles.debugScroll}
          >
            <View style={styles.debugLogHeader}>
              <Text style={[styles.debugLabel, { color: colors.textMuted }]}>运行日志</Text>
              <TouchableOpacity onPress={clearDebugLogs}>
                <Text style={[styles.debugClearLog, { color: colors.accent }]}>清空</Text>
              </TouchableOpacity>
            </View>
            {debugLogs.length === 0 ? (
              <Text style={[styles.debugValue, { color: colors.text }]}>（暂无日志）</Text>
            ) : (
              debugLogs.map((log, i) => (
                <View key={i} style={[styles.debugLogEntry, { backgroundColor: colors.sectionBg, borderColor: colors.border }]}>
                  <Text style={[styles.debugLogTime, { color: colors.textMuted }]}>{log.time}</Text>
                  <Text style={[styles.debugLogTag, { color: colors.accent }]}>{log.tag}</Text>
                  <Text style={[styles.debugLogText, { color: colors.text }]} selectable>{log.text}</Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { flex: 1 },
  listContent: { paddingTop: 16, paddingBottom: 8 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6, paddingBottom: 6, paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 16, fontWeight: "600", letterSpacing: 1 },
  headerAction: { paddingVertical: 4, paddingLeft: 12 },
  headerActionText: { fontSize: 13 },
  gameBadge: { fontSize: 12, fontWeight: "600" },
  // 标题栏 HUD：轮次/比分 + ? 按钮
  hudWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  hudHelpBtn: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  hudHelpText: {
    fontSize: 11,
    fontWeight: "600",
  },
  // 游戏进行中的系统状态条
  gameStatus: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  gameStatusText: {
    fontSize: 11,
    textAlign: "center",
  },
  // 折叠的游戏对局卡片
  gameCard: {
    marginHorizontal: 16,
    marginVertical: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  gameCardTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  gameCardHint: {
    fontSize: 11,
    marginTop: 4,
  },
  // 游戏候选菜单
  gameMenu: {
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: "hidden",
    paddingBottom: 8,
  },
  quitBtn: {
    alignSelf: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  quitText: {
    fontSize: 12,
    textDecorationLine: "underline",
  },
  // 快艇规则帮助
  helpModal: {
    marginHorizontal: 16,
    borderRadius: 12,
    maxHeight: "80%",
  },
  helpTitle: {
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 8,
  },
  helpSection: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 12,
    marginBottom: 4,
  },
  helpText: {
    fontSize: 12,
    lineHeight: 18,
  },
  helpRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  helpRowLabel: {
    fontSize: 13,
  },
  helpRowValue: {
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  // 状态面板底部：展开规则
  rulesToggle: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
  },
  rulesToggleText: {
    fontSize: 13,
    fontWeight: "600",
  },
  gameMenuTitle: {
    fontSize: 12,
    padding: 12,
  },
  gameMenuItem: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  gameMenuText: {
    fontSize: 15,
  },
  gameMenuDesc: {
    fontSize: 12,
    marginTop: 2,
  },
  welcomeContainer: { alignItems: "center", justifyContent: "center", paddingTop: 80, paddingBottom: 40 },
  welcomeHint: { fontSize: 15, marginTop: 12 },
  loadingBubble: {
    marginHorizontal: 16,
    marginVertical: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    alignSelf: "flex-start",
    maxWidth: "78%",
  },
  loadingText: { fontSize: 15 },
  // 思考气泡
  thinkingContainer: {
    marginHorizontal: 16,
    marginVertical: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    maxWidth: "85%",
  },
  thinkingLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 19,
  },
  // API 设置
  setupContainer: { flex: 1, justifyContent: "center", paddingHorizontal: 40 },
  setupTitle: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  setupHint: { fontSize: 14, marginBottom: 24 },
  setupLabel: { fontSize: 13, fontWeight: "600", marginBottom: 6 },
  setupInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, marginBottom: 16 },
  setupButton: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  setupButtonText: { fontSize: 15, fontWeight: "600" },
  // 调试弹窗
  debugContainer: { flex: 1 },
  debugHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  debugTitle: { fontSize: 18, fontWeight: "700" },
  debugClose: { fontSize: 15, fontWeight: "600" },
  debugScroll: { flex: 1, padding: 20 },
  debugLabel: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  debugValue: { fontSize: 14, lineHeight: 20 },
  debugLogHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  debugClearLog: { fontSize: 13, fontWeight: "600", marginTop: 16 },
  debugLogEntry: { borderRadius: 8, padding: 12, marginBottom: 8, borderWidth: 1 },
  debugLogTime: { fontSize: 11, marginBottom: 4 },
  debugLogTag: { fontSize: 12, fontWeight: "700", marginBottom: 4 },
  debugLogText: { fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  // 操作菜单
  overlay: { flex: 1, justifyContent: "flex-end" },
  actionSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34, paddingTop: 8 },
  actionTitle: { fontSize: 13, textAlign: "center", paddingVertical: 12 },
  actionItem: { paddingVertical: 16, paddingHorizontal: 24, borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, textAlign: "center" },
  actionCancel: { marginTop: 8 },
  actionCancelText: { fontSize: 17, textAlign: "center" },
  // 删除确认
  confirmBox: { borderRadius: 14, padding: 24, marginHorizontal: 40, alignSelf: "center", marginTop: "auto", marginBottom: "auto" },
  confirmTitle: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  confirmDesc: { fontSize: 14, textAlign: "center", marginTop: 8 },
  confirmButtons: { flexDirection: "row", marginTop: 20, gap: 12 },
  confirmCancel: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  confirmCancelText: { fontSize: 15 },
  confirmDelete: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  confirmDeleteText: { fontSize: 15, fontWeight: "600" },
  // 编辑消息
  editContainer: { flex: 1 },
  editHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingTop: 56, paddingBottom: 16, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editTitle: { fontSize: 17, fontWeight: "600" },
  cancelText: { fontSize: 15 },
  editInput: { flex: 1, marginHorizontal: 20, marginTop: 16, fontSize: 15, lineHeight: 24, textAlignVertical: "top" },
  editButtons: {
    flexDirection: "row", paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 34,
    gap: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  editSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  editSaveBtnText: { fontSize: 15, fontWeight: "600" },
  editResendBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  editResendBtnText: { fontSize: 15, fontWeight: "600" },
});
