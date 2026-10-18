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
  LayoutAnimation,
  UIManager,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import dayjs from "dayjs";

import ChatBubble, { StreamingBubble } from "@/components/ChatBubble";
import { InputBar } from "@/components/InputBar";
import { useChatStore, logDebug } from "@/store/chatStore";
import { genMsgId } from "@/utils/id";
import { revealTotalMsForText } from "@/utils/text";
import { useMetaStore } from "@/store/metaStore";
import { useSettingsStore } from "@/store/settingsStore";
import { buildChatContext } from "@/memory/chatHandler";
import { streamChat } from "@/llm/foreground";
import { hasApiKey } from "@/llm/client";
import { shouldConsolidate, runConsolidation, runCatchUpConsolidation } from "@/memory/consolidation";
import { checkAndGenerateSchedule } from "@/memory/scheduler";
import { ensureDailyLife } from "@/memory/dailyLife";
import { checkAndGenerateFriends } from "@/friends/roster";
import {
  getActiveGameSession,
  getGameSessionById,
  createGameSession,
  finishGameSession,
  markGameEnded,
  updateGameTurns,
  insertEpisode,
  updateGameResultNote,
  deleteGameSession,
} from "@/db/queries";
import { startGame, handlePlayerInput, MAX_QUESTIONS } from "@/game/twentyQuestions";
import {
  buildGameSection,
  buildGameProgressHint,
  buildGameStartHint,
  buildGameRevealHint,
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
  buildYachtQuitHint,
} from "@/game/yacht/prompt";
import { YachtDiceCard } from "@/components/YachtDiceCard";
import { YachtScoreCard } from "@/components/YachtScoreCard";
import {
  createBombState,
  guess as bombGuess,
  currentRange,
  type BombState,
} from "@/game/bomb/engine";
import { aiGuess } from "@/game/bomb/ai";
import {
  buildBombSection,
  buildBombActionHint,
  buildBombStartHint,
  buildBombEndHint,
  buildBombQuitHint,
} from "@/game/bomb/prompt";
import { BombCard } from "@/components/BombCard";
import {
  createTruthDareState,
  roll as tdRoll,
  completeTurn as tdCompleteTurn,
  replaceBank as tdReplaceBank,
  markFinished as tdMarkFinished,
  pickUnusedQuestion,
  rollDie as tdRollDie,
  pickByFace as tdPickByFace,
  allUsed as tdAllUsed,
  pendingQuestion as tdPendingQuestion,
  isUserTurn as tdIsUserTurn,
  type TruthDareState,
  type TruthDareQuestion,
} from "@/game/truthDare/engine";
import { generateQuestionBank } from "@/game/truthDare/questions";
import {
  buildTruthDareSection,
  buildTruthDareAnswerHint,
  buildTruthDareReactAndAnswerHint,
  buildTruthDareStartHint,
  buildTruthDareEndHint,
  KIND_LABEL,
} from "@/game/truthDare/prompt";
import { TruthDareCard } from "@/components/TruthDareCard";
import type { GameSession } from "@/types/schema";
import { useTheme } from "@/theme/useTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import type { ChatMessage } from "@/types/schema";

/** 首屏渲染的消息条数（更早的消息滑到顶部时再加载） */
const PAGE_SIZE = 30;

// Android 旧架构上 LayoutAnimation 需显式开启；新架构（Fabric）上此调用无副作用
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** 重新生成时旧气泡「收起+淡出」过渡时长；动画结束后才发起重答，避免布局跳变 */
const REGEN_ANIM_MS = 220;

/** 统一二次确认的载荷 */
interface ConfirmState {
  title: string;
  desc: string;
  okText: string;
  onConfirm: () => void;
}

/**
 * 游戏卡片的结果文案：按游戏语义区分
 * （快艇比输赢、炸弹「谁猜中谁输」、真心话无胜负、20问猜谜底）
 */
function gameResultText(session: GameSession | null): string {
  if (!session) return "已结束";
  if (session.status === "playing") return "进行中";
  const st = session.status;
  switch (session.game_type) {
    case "yacht":
      return st === "won" ? "赢了" : st === "lost" ? "输了" : st === "tie" ? "平局" : "未完局";
    case "bomb":
      return st === "won" ? "你赢了" : st === "lost" ? "你踩雷了" : "未完局";
    case "truth_or_dare":
      return "已结束";
    default:
      return st === "won" ? "猜中了" : st === "lost" ? "没猜中" : "未完局";
  }
}

/** 与上一条消息间隔达到此时长（分钟）或跨天时显示日期分隔条 */
const DATE_GAP_MINUTES = 5;

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 微信式日期文案：今天 HH:mm / 昨天 HH:mm / 7 天内 星期X HH:mm / 更早 YYYY年M月D日 HH:mm */
function formatDateLabel(ts: string): string {
  const cur = dayjs(ts);
  const time = cur.format("HH:mm");
  const diffDays = dayjs().startOf("day").diff(cur.startOf("day"), "day");
  if (diffDays <= 0) return time;
  if (diffDays === 1) return `昨天 ${time}`;
  if (diffDays < 7) return `星期${WEEKDAY_CN[cur.day()]} ${time}`;
  return `${cur.format("YYYY年M月D日")} ${time}`;
}

/** 是否在当前条目前插日期条：窗口首条必显，其余按间隔或跨天判定 */
function shouldShowDate(prevTs: string | null, ts: string): boolean {
  if (!prevTs) return true;
  const prev = dayjs(prevTs);
  const cur = dayjs(ts);
  return cur.diff(prev, "minute") >= DATE_GAP_MINUTES || !cur.isSame(prev, "day");
}

export default function ChatScreen() {
  const {
    messages: allMessages,
    isLoading,
    streamingText,
    streamingChunks,
    streamingThinking,
    debugLogs,
    addMessage,
    deleteMessage,
    deleteMessagesByGameId,
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

  // 好友私聊是另一个空间：主聊天页只显示与 AI 的对话
  // （在源头过滤一次，下游的分组/滚动/编辑/空态都自动只看主会话）
  const messages = useMemo(
    () => allMessages.filter((m) => !m.friend_id),
    [allMessages]
  );

  const { load: loadMeta, incrementTurn } = useMetaStore();
  const { loadApiKey, saveApiKey, saveBaseUrl, saveUserNickname, apiKey, baseUrl, user_nickname, ai_name, isReady } =
    useSettingsStore();

  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // 面向用户的 AI 称呼：未设置时用「对方」，绝不显示「AI」二字（情感陪伴场景，破 immersion）
  const aiLabel = ai_name || "对方";

  // 进行中的游戏会话（用于标题栏 HUD 与游戏分支）
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  // 快艇骰子对局状态（内存态，重启后可继续由 game_sessions 兜底）
  const [yachtState, setYachtState] = useState<YachtState | null>(null);
  // AI 掷骰动画（与 LLM 决策并行，把等待时间填满）
  const [yachtRolling, setYachtRolling] = useState(false);
  // 快艇骰子是否显示计分卡
  const [showYachtScore, setShowYachtScore] = useState(false);
  // 数字炸弹对局状态
  const [bombState, setBombState] = useState<BombState | null>(null);
  // 数字炸弹详情面板（点标题栏蓝字展开，避免常驻挡住底部消息）
  const [showBombInfo, setShowBombInfo] = useState(false);
  // 真心话大冒险对局状态
  const [truthDareState, setTruthDareState] = useState<TruthDareState | null>(null);
  // 真心话大冒险掷骰动画
  const [truthDareRolling, setTruthDareRolling] = useState(false);
  // 骰子定格点数（动画结束后显示真实点数，与抽中题号一致）
  const [tdDieFace, setTdDieFace] = useState(1);
  // 编辑题库弹窗
  const [showTdEdit, setShowTdEdit] = useState(false);
  const [tdEditDraft, setTdEditDraft] = useState<TruthDareQuestion[]>([]);
  // 「换一批」生成中（防连点并发多次 LLM）
  const [tdRegenerating, setTdRegenerating] = useState(false);

  // 快艇骰子：得分面板（点标题栏蓝字，在上方展开，不遮挡选择区）
  const [showYachtScores, setShowYachtScores] = useState(false);
  // 规则弹窗（点标题栏 ? 打开）
  const [showRules, setShowRules] = useState(false);
  // 游戏候选菜单（点 + 弹出）
  const [showGameMenu, setShowGameMenu] = useState(false);
  // 对局展开状态的显式覆盖（未覆盖时：进行中默认展开、已结束默认折叠）
  const [gameExpandOverride, setGameExpandOverride] = useState<Map<number, boolean>>(new Map());
  /**
   * 正在流式输出的这条回复最终会挂到哪个对局框（null = 框外普通消息）。
   * 流式气泡要跟着这个 id 渲染进框内，否则「先在框外打字 → 完成后跳进框内」观感割裂。
   */
  const [streamingGameId, setStreamingGameId] = useState<number | null>(null);

  const toggleGameExpand = (gameId: number) => {
    const session = getGameSessionById(gameId);
    const current = gameExpandOverride.get(gameId) ?? session?.status === "playing";
    setGameExpandOverride((prev) => new Map(prev).set(gameId, !current));
  };

  /** 对局结束时折叠成卡片（也可由用户手动展开） */
  const collapseGame = (gameId: number) => {
    setGameExpandOverride((prev) => new Map(prev).set(gameId, false));
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
  // 回复完成后自动弹起输入框（设置「自动弹起输入框」可关）
  const chatInputRef = useRef<TextInput>(null);
  const wasLoadingRef = useRef(false);
  // 重新生成的回答完成后不自动弹起输入框：删除旧气泡的布局过渡 + 键盘弹起会把窗口高度算错
  const skipAutoFocusRef = useRef(false);

  // 长按菜单状态
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  const [showActionMenu, setShowActionMenu] = useState(false);
  // 统一二次确认（Web 走自定义弹窗；原生走系统 Alert，防触摸穿透跳过）
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [editText, setEditText] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);

  // 逐条延迟动画：仅非流式模式下对刚收到的 AI 回复生效
  const [animatingMsgId, setAnimatingMsgId] = useState<string | null>(null);
  // 编辑/删除操作时不自动滚底
  const skipScrollRef = useRef(false);
  // 用户是否贴在底部：只有贴底时才自动滚动，避免上翻历史时被强行拽回底部
  const atBottomRef = useRef(true);
  // 手势态（拖拽中 / 用户甩动的惯性中）：只有手势期间的 onScroll 才更新 atBottomRef。
  // 程序化 scrollToOffset 动画与内容增长（游戏流程里 system 消息 + AI 消息 + 打字点频繁增删）
  // 同样会触发 onScroll，若不拦截，距离被瞬间拉大就会把 atBottomRef 误置 false，
  // 导致 scrollToBottomIfNeeded 永久 early-return（AI 输出后不再自动跳到最新消息）
  const userGestureActiveRef = useRef(false);
  // 拖拽刚结束（可能还有一段用户甩动惯性要接管）
  const dragJustEndedRef = useRef(false);
  const dragEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 程序化滚动窗口：窗口内的 onScroll 不参与贴底测量（动画目标 clamp 到旧底时距离会短暂超标）。
  // Web 端鼠标滚轮不产生拖拽/惯性事件，靠「非手势且不在程序化窗口内才测量」来覆盖
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 供定时器取「最新的 AI 发言函数」，避免 setInterval 闭包过期
  const aiTalkRef = useRef<
    ((section: string, hint: string, gameId?: number | null) => Promise<boolean>) | null
  >(null);
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

  /** 加载更早的历史消息（顶部滑到顶 / 点顶部入口都走这里） */
  const loadEarlierMessages = () => {
    if (!hasMore) return;
    setRenderCount((c) => Math.min(c + PAGE_SIZE, messages.length));
  };

  /**
   * 把同一局的连续消息聚成一块，整体框进一张游戏卡片
   * （标题 + 对话都在同一个框内，而不是散落的气泡）
   */
  const displayItems = useMemo(() => {
    type Item =
      | { kind: "date"; id: string; label: string }
      | { kind: "msg"; message: ChatMessage }
      | { kind: "game"; gameId: number; groupIndex: number; messages: ChatMessage[]; hasStreaming?: boolean };
    const items: Item[] = [];
    // 同一 gameId 可能被非游戏消息切成多块（如对局中途的约定提醒），
    // 用「窗口内出现序号」保证 key 既稳定（不随窗口扩大而变）又唯一
    const gameOccurrence = new Map<number, number>();
    // 上一条消息的时间：决定要不要在下一个条目前插日期分隔条（游戏合并块只在块首判定）
    let lastMsgTs: string | null = null;
    for (const m of visibleMessages) {
      if (m.game_id) {
        const last = items[items.length - 1];
        if (last && last.kind === "game" && last.gameId === m.game_id) {
          last.messages.push(m);
        } else {
          if (shouldShowDate(lastMsgTs, m.timestamp)) {
            items.push({ kind: "date", id: `date-${m.id}`, label: formatDateLabel(m.timestamp) });
          }
          const occ = gameOccurrence.get(m.game_id) ?? 0;
          gameOccurrence.set(m.game_id, occ + 1);
          items.push({ kind: "game", gameId: m.game_id, groupIndex: occ, messages: [m] });
        }
        lastMsgTs = m.timestamp;
      } else {
        if (shouldShowDate(lastMsgTs, m.timestamp)) {
          items.push({ kind: "date", id: `date-${m.id}`, label: formatDateLabel(m.timestamp) });
        }
        items.push({ kind: "msg", message: m });
        lastMsgTs = m.timestamp;
      }
    }
    // 流式中的回复挂进目标对局框：让打字过程就发生在框里，而不是完成后才跳进去
    if (streamingGameId != null) {
      const last = items[items.length - 1];
      if (last && last.kind === "game" && last.gameId === streamingGameId) {
        last.hasStreaming = true;
      } else {
        const occ = gameOccurrence.get(streamingGameId) ?? 0;
        gameOccurrence.set(streamingGameId, occ + 1);
        items.push({
          kind: "game",
          gameId: streamingGameId,
          groupIndex: occ,
          messages: [],
          hasStreaming: true,
        });
      }
    }
    return items;
  }, [visibleMessages, streamingGameId]);

  /** 标记一次程序化滚动：窗口期内 onScroll 不更新贴底判定 */
  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    programmaticTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 500);
  }, []);

  /** 贴底时才滚到底部 */
  const scrollToBottomIfNeeded = useCallback((animated = true) => {
    if (!atBottomRef.current) return false;
    if (skipScrollRef.current) return false;
    markProgrammaticScroll();
    // scrollToOffset 超出范围会自动 clamp 到末尾，比 scrollToEnd 更可靠
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated });
    return true;
  }, [markProgrammaticScroll]);

  /** 无条件对齐底部（打开 App 时的初始定位） */
  const scrollToBottomHard = useCallback(() => {
    requestAnimationFrame(() => {
      markProgrammaticScroll();
      flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
    });
  }, [markProgrammaticScroll]);

  /**
   * 布局阶段同步定位：onLayout / onContentSizeChange 都早于绘制，
   * 在这里滚动可以让「第一帧」就画在底部，消除可见的跳动。
   * 仅在打开后的初始窗口内生效，之后不再干预，避免打扰上翻历史
   */
  const initialWindowRef = useRef(true);
  const scrollOnLayout = useCallback(() => {
    if (!initialWindowRef.current) return;
    markProgrammaticScroll();
    flatListRef.current?.scrollToOffset({ offset: 9_999_999, animated: false });
  }, [markProgrammaticScroll]);

  /** 根据滚动事件测量是否贴底（仅用户手势期间调用，程序化滚动不参与判定） */
  const measureAtBottom = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    atBottomRef.current = distanceFromBottom < 80;
  }, []);

  /**
   * 内容尺寸变化（新消息/流式增长/卡片展开）后贴底跟随：
   * 用非动画滚动，避免动画目标按旧 contentSize clamp 后停在旧底
   */
  const handleContentSizeChange = useCallback(() => {
    scrollOnLayout();
    scrollToBottomIfNeeded(false);
  }, [scrollOnLayout, scrollToBottomIfNeeded]);

  // 手势/程序化滚动追踪定时器清理
  useEffect(
    () => () => {
      if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    },
    []
  );

  // 初始窗口结束：之后完全交给 atBottomRef 控制
  useEffect(() => {
    const t = setTimeout(() => {
      initialWindowRef.current = false;
    }, 1000);
    return () => clearTimeout(t);
  }, []);

  /**
   * 定位到最新消息：立即一次 + 下一帧后再补一次。
   * 补一次是必要的——persist 从 AsyncStorage 水合、以及首屏 contentSize 变化都晚于首帧，
   * 只滚一次会停在旧底（表现为「打开聊天页看到的是很前面的一条，而且滑不下去」）。
   */
  const positionToLatest = useCallback(() => {
    scrollToBottomHard();
    return setTimeout(scrollToBottomHard, 120);
  }, [scrollToBottomHard]);

  /**
   * 是否已经成功定位到最新消息。
   * 之前用「挂载后 1 秒」作为窗口，消息水合慢于 1 秒时窗口已关闭，定位就再也不会发生。
   * 改成「只要还没定位成功、且用户没有上翻历史，就每次消息数变化时重试」。
   */
  const positionedRef = useRef(false);

  useEffect(() => {
    if (messages.length === 0) return;
    if (positionedRef.current) return;
    // 用户已经上翻历史（atBottomRef=false）就不要把人拽回底部
    if (!atBottomRef.current) {
      positionedRef.current = true;
      return;
    }
    const t1 = positionToLatest();
    // 再补一次：气泡逐个渲染会让 contentSize 继续长高，第二次也可能停在旧底
    const t2 = setTimeout(scrollToBottomHard, 400);
    positionedRef.current = true;
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [messages.length, positionToLatest, scrollToBottomHard]);

  /**
   * AI 回复完成后自动弹起输入框（设置「自动弹起输入框」可关）：
   * 只在 loading 结束的那一刻聚焦一次；弹窗打开时不抢焦点，避免键盘顶着弹窗。
   * 非流式模式下回复是逐条动画弹出的（每段 0.5~3s），要等动画播完再弹键盘，
   * 否则键盘会在对话还没完全弹出时就升起来
   */
  useEffect(() => {
    if (isLoading) {
      wasLoadingRef.current = true;
      return;
    }
    if (!wasLoadingRef.current) return;
    wasLoadingRef.current = false;
    // 重新生成的回答只静默落定，不弹键盘（见 skipAutoFocusRef 注释）
    if (skipAutoFocusRef.current) {
      skipAutoFocusRef.current = false;
      return;
    }
    if (!useSettingsStore.getState().auto_focus_input) return;
    if (
      showActionMenu ||
      showEditModal ||
      showGameMenu ||
      showTdEdit ||
      showRules ||
      showDebug ||
      showKeyInput ||
      confirmState != null
    ) {
      return;
    }
    // 非流式逐条动画时长：流式模式 animatingMsgId 不置位、单段回复算出 0，都退化为立即聚焦
    const animMsg = animatingMsgId
      ? useChatStore.getState().messages.find((m) => m.id === animatingMsgId)
      : null;
    const revealMs =
      animMsg && !useSettingsStore.getState().stream_output
        ? revealTotalMsForText(animMsg.content)
        : 0;
    // 稍等气泡落定再聚焦，避免与滚底/布局动画抢节奏
    const t = setTimeout(() => chatInputRef.current?.focus(), 80 + revealMs);
    return () => clearTimeout(t);
  }, [isLoading, animatingMsgId, showActionMenu, showEditModal, showGameMenu, showTdEdit, showRules, showDebug, showKeyInput, confirmState]);

  // 从列表页等处回到聊天页：屏幕可能重挂载、滚动位置回到顶部，需要重新定位一次
  useFocusEffect(
    useCallback(() => {
      positionedRef.current = false;
    }, [])
  );

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

  // 会话启动补巩固：把上次没来得及巩固的历史静默补上（一次性守卫 + 后台分批，不阻塞输入）
  useEffect(() => {
    if (!isReady) return;
    runCatchUpConsolidation().catch((err) => {
      console.error("[chat] 启动补巩固异常:", err);
    });
  }, [isReady]);

  // 今日实况：早上第一次进来就后台生成，失败回退周基线（不阻塞输入）
  useEffect(() => {
    if (!isReady) return;
    ensureDailyLife().catch((err) => {
      console.error("[chat] 今日实况生成异常:", err);
    });
  }, [isReady]);

  // 恢复未结束的对局（含快艇、数字炸弹、真心话状态）
  useEffect(() => {
    if (!isReady) return;
    const session = getActiveGameSession();
    if (!session) return;
    const timers: ReturnType<typeof setTimeout>[] = [];

    /** 恢复失败兜底：标记未完局、内存态保持为空，避免残留「进行中」卡死游戏入口 */
    const abortRestore = (note: string) => {
      finishGameSession(session.id, "abandoned", note);
    };
    /**
     * 终局快照已落盘（turns 里 finished=true）但结束标记被杀进程打断：
     * 补写终局状态，否则 session 永远停在 playing、面板不渲染、退出按钮消失
     */
    const finalizeInterrupted = (
      winner: "user" | "ai" | "tie" | null,
      note: string
    ) => {
      finishGameSession(
        session.id,
        winner === "user" ? "won" : winner === "ai" ? "lost" : "abandoned",
        note
      );
    };
    /** JSON.parse 不校验形状（turns='[]' 会返回数组不抛错），必须显式比对字段 */
    const parseTurns = <T,>(validate: (s: unknown) => boolean): T | null => {
      try {
        const parsed = JSON.parse(session.turns);
        return validate(parsed) ? (parsed as T) : null;
      } catch {
        return null;
      }
    };

    if (session.game_type === "yacht") {
      const state = parseTurns<YachtState>(
        (s) =>
          !!s &&
          typeof (s as YachtState).round === "number" &&
          Array.isArray((s as YachtState).dice) &&
          Array.isArray((s as YachtState).kept) &&
          !!(s as YachtState).scores?.user &&
          !!(s as YachtState).scores?.ai
      );
      if (!state) {
        abortRestore("对局状态损坏，已自动结束");
        return;
      }
      if (state.finished) {
        finalizeInterrupted(state.winner, "对局已结束（重启后补录结果）");
        return;
      }
      setGameSession(session);
      setYachtState(state);
      if (state.currentPlayer === "ai") {
        timers.push(setTimeout(() => runYachtAiTurn(state, session.id), 100));
      }
    } else if (session.game_type === "bomb") {
      const state = parseTurns<BombState>(
        (s) =>
          !!s &&
          typeof (s as BombState).bomb === "number" &&
          typeof (s as BombState).min === "number" &&
          typeof (s as BombState).max === "number" &&
          Array.isArray((s as BombState).guesses)
      );
      if (!state) {
        abortRestore("对局状态损坏，已自动结束");
        return;
      }
      if (state.finished) {
        finalizeInterrupted(state.winner, "对局已结束（重启后补录结果）");
        return;
      }
      setGameSession(session);
      setBombState(state);
      if (state.currentPlayer === "ai") {
        timers.push(setTimeout(() => runBombAiTurn(state, session.id), 100));
      }
    } else if (session.game_type === "truth_or_dare") {
      const state = parseTurns<TruthDareState>(
        (s) =>
          !!s &&
          Array.isArray((s as TruthDareState).questions) &&
          typeof (s as TruthDareState).turnCount === "number"
      );
      if (!state) {
        abortRestore("对局状态损坏，已自动结束");
        return;
      }
      if (state.finished) {
        finalizeInterrupted(null, "对局已结束（重启后补录）");
        return;
      }
      setGameSession(session);
      setTruthDareState(state);
      // AI 回合都续跑：没抽题就抽，已抽题未作答就直接作答
      if (state.currentPlayer === "ai") {
        timers.push(setTimeout(() => runTruthDareAiTurn(state, session.id), 100));
      }
    } else {
      // 20问不需要内存状态机，直接挂为进行中
      setGameSession(session);
    }

    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      case "delete": {
        // 捕获当前目标，确认回调执行时不受后续渲染影响
        const target = actionTarget;
        confirmDialog({
          title: "确认删除？",
          desc: "删除后无法恢复",
          okText: "删除",
          onConfirm: () => {
            if (!target) return;
            skipScrollRef.current = true;
            deleteMessage(target.id);
            setActionTarget(null);
          },
        });
        break;
      }
      case "edit":
        setEditText(actionTarget.content);
        setShowEditModal(true);
        break;
      case "regenerate":
        handleRegenerate();
        break;
    }
  };

  /**
   * 统一二次确认：
   * - 原生（Android/iOS）走系统 Alert —— 系统窗口不接收应用层触摸序列，
   *   结构性免疫"弹窗刚挂载就被同一触摸抬起事件穿透/误触确认"的问题
   * - Web 上 Alert 是 no-op，回退到自定义弹窗
   */
  const confirmDialog = ({ title, desc, okText, onConfirm }: ConfirmState) => {
    if (Platform.OS === "web") {
      setConfirmState({ title, desc, okText, onConfirm });
      return;
    }
    Alert.alert(title, desc, [
      { text: "取消", style: "cancel" },
      { text: okText, style: "destructive", onPress: onConfirm },
    ]);
  };

  /** 整局删除游戏合并卡片：移除该局全部消息与对局记录 */
  const deleteGameGroup = (gameId: number) => {
    skipScrollRef.current = true;
    deleteMessagesByGameId(gameId);
    deleteGameSession(gameId);
    // 删的是进行中的对局时，同步清掉内存态，避免 HUD /面板残留
    if (gameSession?.id === gameId) {
      setGameSession(null);
      setYachtState(null);
      setBombState(null);
      setTruthDareState(null);
      setShowYachtScore(false);
      setShowBombInfo(false);
    }
    setGameExpandOverride((prev) => {
      const next = new Map(prev);
      next.delete(gameId);
      return next;
    });
  };

  /** 请求整局删除游戏卡片：先弹二次确认，确认后才执行 */
  const requestDeleteGameGroup = (gameId: number) => {
    const count = gameGroupInfo.get(gameId)?.count ?? 0;
    confirmDialog({
      title: "删除整局游戏？",
      desc: `该局 ${count} 条对话将一并删除，删除后无法恢复`,
      okText: "删除",
      onConfirm: () => deleteGameGroup(gameId),
    });
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
            id: genMsgId(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
          };
          // 非流式模式：逐条延迟动画。动画标记必须先于消息落库、流式残留先清掉——
          // 顺序反了会让气泡先闪现全文，再回退成逐条出现
          const animateIn = !useSettingsStore.getState().stream_output;
          setStreamingText("");
          setStreamingThinking("");
          if (animateIn) setAnimatingMsgId(aiMsg.id);
          addMessage(aiMsg);
          setLoading(false);

          // 首轮对话完成后生成好友花名册：此刻人设已生效、用户称呼也有了，
          // 生成出来的人最贴。函数内部幂等，已建过/已停用都不会重掷。
          checkAndGenerateFriends().catch((err) =>
            console.error("[chat] 好友花名册生成异常:", err),
          );

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
            id: genMsgId(),
            role: "assistant",
            content: `⚠️ ${error.message}`,
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
        id: genMsgId(),
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
    if (gameSession && gameSession.status === "playing") return;
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
      id: genMsgId(),
      role: "system",
      content: `你发起了 数字炸弹 · 已埋好一个 1~100 的数字 · ${
        state.currentPlayer === "user" ? "你先猜" : `让${aiLabel}先猜`
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
      await humanDelay(1100, 2100); // 模拟真人「想一下再猜」，避免秒选显得假
      // 等待期间对局可能被退出：本局已结束就中止
      if (gid && getGameSessionById(gid)?.status !== "playing") return;
      const next = bombGuess(state, value);
      setBombState(next);
      if (gid) updateGameTurns(gid, JSON.stringify(next));

      addMessage({
        id: genMsgId(),
        role: "system",
        content: `${aiLabel} 猜了 ${value} → ${
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
    const summary = `[user] [time]和我玩数字炸弹，最后${aiWon ? "他踩到炸弹输了" : "我踩到炸弹输了"}（炸弹是 ${state.bomb}），${aiWon ? "他有点不服，我还挺得意" : "他得意坏了，还想再来一局"}`;
    const gist = aiWon ? "[user]玩数字炸弹踩雷了" : "[user]玩数字炸弹赢了我";
    insertEpisode("一起玩数字炸弹", gist, summary, aiWon ? 8 : 7, "数字炸弹,猜数字,踩雷,炸弹");
    if (gid) {
      updateGameResultNote(gid, summary);
      // 标记已结束：getHistory 才会把这局合并成一条「游戏回顾」摘要
      markGameEnded(gid, aiWon ? "lost" : "won");
    }

    addMessage({
      id: genMsgId(),
      role: "system",
      content: `🏁 数字炸弹结束 · 炸弹是 ${state.bomb} · ${aiWon ? "你踩到炸弹输了" : `${aiLabel} 踩到炸弹输了`}`,
      timestamp: dayjs().toISOString(),
      game_id: gid,
    });
    // 结束感想：对局外普通消息（不进游戏框），框内只留对局过程
    await runYachtAiTalk(buildBombSection(state, true), buildBombEndHint(state, aiWon), null);
    if (gid) collapseGame(gid);
    setGameSession(null);
    setBombState(null);
  };

  /** 退出数字炸弹（二次确认，避免误触直接终局） */
  const handleBombQuit = () => {
    if (!bombState) return;
    confirmDialog({
      title: "退出对局",
      desc: "退出后本局将记为未完局，确定要退出吗？",
      okText: "退出",
      onConfirm: async () => {
        // AI 回合/发言进行中不许退出：否则告别流与回合流并发、状态互相覆盖
        if (useChatStore.getState().isLoading) return;
        const gid = gameSession?.id;
        insertEpisode(
          "一起玩数字炸弹",
          "[user]玩数字炸弹中途退出了",
          `[user] [time]和我玩数字炸弹，中途退出了（炸弹是 ${bombState.bomb}），他不太想玩了，下次可以再来`,
          7,
          "数字炸弹,猜数字,炸弹"
        );
        if (gid) {
          finishGameSession(gid, "abandoned", "玩家退出对局");
        }
        addMessage({
          id: genMsgId(),
          role: "system",
          content: "你退出了数字炸弹对局",
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
        // 先收尾状态，别让告别期间的输入再落进对局
        if (gid) collapseGame(gid);
        setGameSession(null);
        setBombState(null);
        setShowBombInfo(false);
        // 告别：对局外普通消息（不进游戏框），与真心话退出节奏一致
        await runYachtAiTalk(buildBombSection(bombState, true), buildBombQuitHint(bombState), null);
      },
    });
  };

  // ===== 真心话大冒险 =====

  /** 把真心话大冒险状态持久化到 game_sessions */
  const saveTruthDareState = (state: TruthDareState, gameId?: number) => {
    const id = gameId ?? gameSession?.id;
    if (id) updateGameTurns(id, JSON.stringify(state));
  };

  /** 题库用完则重出一批（返回新 state） */
  const ensureTruthDareBank = async (state: TruthDareState): Promise<TruthDareState> => {
    if (!tdAllUsed(state)) return state;
    const fresh = await generateQuestionBank({
      aiName: aiLabel,
      playerLabel: user_nickname || "玩家",
      recentQuestions: state.questions.map((q) => q.text),
    });
    return tdReplaceBank(state, fresh);
  };

  /** 开始一局真心话大冒险（用户先掷） */
  const handleStartTruthDare = async () => {
    if (isLoading) return;
    if (gameSession && gameSession.status === "playing") return;
    // 出题前置 loading：生成题库期间也显示"正在输入中"，消除开局无反馈空窗
    setLoading(true);
    try {
      const bank = await generateQuestionBank({
        aiName: aiLabel,
        playerLabel: user_nickname || "玩家",
      });
      const state = createTruthDareState(bank, "user");
      const id = createGameSession({
        gameType: "truth_or_dare",
        mode: "user_asks",
        secret: "",
        secretSource: "public",
      });
      setTruthDareState(state);
      setGameSession({
        id,
        game_type: "truth_or_dare",
        mode: "user_asks",
        status: "playing",
        secret: "",
        secret_source: "public",
        question_count: 0,
        turns: JSON.stringify(state),
        started_at: dayjs().toISOString(),
        ended_at: null,
        result_note: null,
      });
      saveTruthDareState(state, id);
      addMessage({
        id: genMsgId(),
        role: "system",
        content: "你发起了 真心话大冒险 · 轮流掷骰抽题 · 你先掷",
        timestamp: dayjs().toISOString(),
        game_id: id,
      });
      await runYachtAiTalk(buildTruthDareSection(state), buildTruthDareStartHint("user"), id);
    } catch (err) {
      console.error("[truthdare] 开场失败:", err);
    } finally {
      // runYachtAiTalk 自己会收尾 loading，这里兜底保证不会卡在"正在输入中"
      setLoading(false);
    }
  };

  /** 用户掷骰抽题（掷几抽几：点数即题号） */
  const tdRollingRef = useRef(false);
  const handleTruthDareRoll = async () => {
    const gid = gameSession?.id;
    // ref 同步置忙：setTruthDareRolling 是异步 state，同帧双击检查不到；
    // 也堵住 ensureTruthDareBank（题库用完时要等 LLM）await 窗口内的重复点击
    if (!truthDareState || truthDareState.finished || tdRollingRef.current) return;
    tdRollingRef.current = true;
    setTruthDareRolling(true);
    try {
      let s = await ensureTruthDareBank(truthDareState);
      await humanDelay(1300, 1900); // 掷骰动画：让骰子多转一会儿更真实
      // 等待期间对局可能被结束：别往已结束对局写掷骰结果
      if (gid && getGameSessionById(gid)?.status !== "playing") return;
      const face = tdRollDie();
      setTdDieFace(face);
      const picked = tdPickByFace(s, face);
      if (picked.kind !== "question") {
        // 掷到已用过的题：明确提示重掷，别静默吞掉点击
        addMessage({
          id: genMsgId(),
          role: "system",
          content: `你掷出 ${face} → ${face} 号玩过啦，再掷一次`,
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
        return;
      }
      s = tdRoll(s, picked.index);
      setTruthDareState(s);
      saveTruthDareState(s);
      const q = tdPendingQuestion(s);
      if (q) {
        addMessage({
          id: genMsgId(),
          role: "system",
          content: `你掷出 ${face} → 「${KIND_LABEL[q.kind]}」${q.text} · 轮到你回答`,
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
      }
    } finally {
      tdRollingRef.current = false;
      setTruthDareRolling(false);
    }
  };

  /** AI 回合：掷骰 + 回答（可对玩家答案做反应） */
  const runTruthDareAiTurn = async (state: TruthDareState, gameId?: number, userAnswer?: string) => {
    const gid = gameId ?? gameSession?.id;
    setLoading(true);
    // 每个 await 后复查：对局被退出/结束后立即中止，别复活状态或污染新局
    const stillPlaying = () => !gid || getGameSessionById(gid)?.status === "playing";
    try {
      let s = state;
      // 已有 AI 自己的待答题（重启恢复场景）：直接作答，不抽新题
      let q = tdPendingQuestion(s);
      if (!q || q.answeredBy !== "ai") {
        s = await ensureTruthDareBank(state);
        await humanDelay(700, 1500); // AI 先「想一下」再掷，避免秒选显得假
        if (!stillPlaying()) return;
        setTruthDareRolling(true);
        await humanDelay(1300, 1900); // 掷骰动画
        if (!stillPlaying()) return;
        // 掷几抽几：点数即题号；掷到已用的题自动重掷
        let face = tdRollDie();
        let picked = tdPickByFace(s, face);
        for (let i = 0; picked.kind === "already_used" && i < 5; i++) {
          await humanDelay(500, 900);
          if (!stillPlaying()) return;
          face = tdRollDie();
          picked = tdPickByFace(s, face);
        }
        if (picked.kind !== "question") {
          // 兜底：取一道没用过的题并按题号报点数，保持「点数 = 题号」一致
          const idx = pickUnusedQuestion(s);
          if (idx == null) {
            // 极端情况题库仍空：把回合交回玩家，别卡死在 AI 回合
            s = tdCompleteTurn(s);
            setTruthDareState(s);
            saveTruthDareState(s, gid);
            return;
          }
          face = idx;
          picked = { kind: "question", index: idx };
        }
        setTdDieFace(face);
        s = tdRoll(s, picked.index);
        setTruthDareState(s);
        saveTruthDareState(s, gid);
        q = tdPendingQuestion(s);
        if (!q) return;
        addMessage({
          id: genMsgId(),
          role: "system",
          content: `${aiLabel} 掷出 ${face} → 「${KIND_LABEL[q.kind]}」${q.text}`,
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
      }
      const hint = userAnswer
        ? buildTruthDareReactAndAnswerHint({
            question: q,
            userAnswer,
            aiName: aiLabel,
            playerLabel: user_nickname || "玩家",
          })
        : buildTruthDareAnswerHint({
            question: q,
            aiName: aiLabel,
            playerLabel: user_nickname || "玩家",
          });
      await runYachtAiTalk(buildTruthDareSection(s), hint, gid);
      // 写回前复查：中途退出/结束的对局不复活状态，也别覆盖新局
      if (!stillPlaying()) return;
      s = tdCompleteTurn(s);
      setTruthDareState(s);
      saveTruthDareState(s, gid);
    } catch (err) {
      console.error("[truthdare] AI 回合异常:", err);
    } finally {
      setTruthDareRolling(false);
      setLoading(false);
    }
  };

  /** 结束/退出真心话大冒险（二次确认） */
  const handleTruthDareQuit = () => {
    if (!truthDareState) return;
    confirmDialog({
      title: "结束对局",
      desc: "结束后本局将折叠成卡片，确定要结束吗？",
      okText: "结束",
      onConfirm: async () => {
        // AI 回合/发言/掷骰动画中不许结束：否则告别流与回合流并发、状态互相覆盖
        if (useChatStore.getState().isLoading || truthDareRolling) return;
        const gid = gameSession?.id;
        const summary = `[user] [time]和我玩真心话大冒险，轮流掷骰抽题，聊了真心话也做了小冒险，都很坦诚，觉得彼此更亲近了`;
        insertEpisode("一起玩真心话大冒险", "[user]玩真心话大冒险，很坦诚", summary, 8, "真心话大冒险,真心话,大冒险,掷骰子");
        if (gid) updateGameResultNote(gid, summary);
        addMessage({
          id: genMsgId(),
          role: "system",
          content: "❤️ 真心话大冒险结束 · 谢谢你的坦诚",
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
        if (gid) {
          // finished 先落盘：防止告别期间/重启恢复把已结束对局当进行中续跑
          saveTruthDareState(tdMarkFinished(truthDareState), gid);
          finishGameSession(gid, "abandoned", summary);
        }
        // 先收尾状态，别让告别期间的输入再落进对局
        if (gid) collapseGame(gid);
        setGameSession(null);
        setTruthDareState(null);
        // 结束感想：对局外普通消息（不进游戏框）
        await runYachtAiTalk(buildTruthDareSection(truthDareState, true), buildTruthDareEndHint(), null);
      },
    });
  };

  /** 打开编辑题库弹窗（AI 回合进行中不许编辑，否则保存会被回合写回覆盖） */
  const handleOpenTdEdit = () => {
    if (!truthDareState) return;
    if (useChatStore.getState().isLoading || tdRollingRef.current) return;
    setTdEditDraft(truthDareState.questions.map((q) => ({ ...q })));
    setShowTdEdit(true);
  };

  /** 保存编辑后的题库（就地改题不算换批：round 不跳号、待答题保留） */
  const handleSaveTdEdit = () => {
    if (!truthDareState) return;
    // 保存途中 AI 回合已开始（弹窗先开、随后作答触发）：此时保存会被回合写回覆盖，
    // 直接拒绝，等回合结束再保存
    if (useChatStore.getState().isLoading || tdRollingRef.current) return;
    // 空题过滤：弹窗 TextInput 无非空校验，空题存入后会被抽成「空题目」
    const cleaned = tdEditDraft
      .map((q) => ({ ...q, text: q.text.trim() }))
      .filter((q) => q.text.length > 0);
    const s = tdReplaceBank(truthDareState, cleaned, false);
    setTruthDareState(s);
    saveTruthDareState(s);
    setShowTdEdit(false);
  };

  /** 编辑弹窗里重新生成一批（先填进草稿，保存才生效） */
  const handleRegenTdDraft = async () => {
    if (tdRegenerating) return;
    setTdRegenerating(true);
    try {
      const fresh = await generateQuestionBank({
        aiName: aiLabel,
        playerLabel: user_nickname || "玩家",
        recentQuestions: tdEditDraft.map((q) => q.text),
      });
      setTdEditDraft(fresh);
    } catch (err) {
      console.error("[truthdare] 换一批失败:", err);
    } finally {
      setTdRegenerating(false);
    }
  };

  // ===== 快艇骰子 =====

  /**
   * 让 AI 说一句话（游戏中的发言）——游戏流程里玩家期待看到，强制回到底部。
   * gameId：要挂到哪个对局框里；传 null 表示「对局外」的普通消息（如结束感想），不进游戏框。
   */
  const runYachtAiTalk = async (section: string, hint: string, gameId?: number | null) => {
    atBottomRef.current = true;
    setLoading(true);
    setStreamingText("");
    setStreamingThinking("");
    // 打字过程直接发生在目标框内：null = 框外普通消息（结束感想等）
    const targetGameId = gameId === undefined ? gameSession?.id ?? null : gameId ?? null;
    setStreamingGameId(targetGameId);
    let ok = false;
    try {
      const context = buildChatContext("", getHistory(), { section, hint });
      let full = "";
      await streamChat(context.messages, {
        onDelta: (delta) => {
          full += delta;
          appendStreamingText(delta);
        },
        onDone: (text) => {
          ok = true;
          if (text) full = text;
          const msgId = genMsgId();
          // 与游戏外同逻辑：非流式模式下逐条出现气泡。
          // 动画标记先于消息落库，避免气泡先闪现全文再回退成逐条出现
          const animateIn = !useSettingsStore.getState().stream_output;
          setStreamingText("");
          setStreamingThinking("");
          if (animateIn) setAnimatingMsgId(msgId);
          addMessage({
            id: msgId,
            role: "assistant",
            content: full,
            timestamp: dayjs().toISOString(),
            // gameId 传 null = 对局外普通消息（不进游戏框）；不传 = 挂到当前对局
            game_id: targetGameId ?? undefined,
          });
        },
        onError: (err) => {
          addMessage({
            id: genMsgId(),
            role: "assistant",
            content: `⚠️ ${err.message}`,
            timestamp: dayjs().toISOString(),
            // 错误也挂到对应对局框内（null = 对局外消息，沿用既有约定）
            game_id: targetGameId ?? undefined,
          });
        },
      });
    } catch (err) {
      console.error("[yacht] AI 发言异常:", err);
    } finally {
      setStreamingText("");
      setStreamingThinking("");
      setStreamingGameId(null);
      setLoading(false);
    }
    return ok;
  };

  // 每帧把最新的 runYachtAiTalk 同步给 aiTalkRef，供定时器调用（避免闭包过期）
  useEffect(() => {
    aiTalkRef.current = runYachtAiTalk;
  });

  /** 开始一局快艇骰子 */
  const handleStartYacht = async () => {
    if (isLoading) return;
    if (gameSession && gameSession.status === "playing") return;
    // 重置上一局残留的面板展开状态，避免新开局面板直接敞开
    setShowYachtScores(false);
    setShowYachtScore(false);
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
      id: genMsgId(),
      role: "system",
      content: `你发起了 快艇骰子 · 1v1 对战 · 13 轮 · ${
        state.currentPlayer === "user" ? "你先掷" : `让${aiLabel}先掷`
      }`,
      timestamp: dayjs().toISOString(),
      game_id: id,
    });
    try {
      await runYachtAiTalk(buildYachtSection(state), buildYachtStartHint(state.currentPlayer), id);
      // AI 先手：开场白说完立即进入 AI 回合（与重启恢复路径一致），避免开局卡死
      if (state.currentPlayer === "ai" && !state.finished) {
        await runYachtAiTurn(state, id);
      }
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

  /** 把快艇对局写入长期记忆（episode 类型），并把摘要存到对局小结 */
  const writeYachtMemory = (state: YachtState, status: "finished" | "quit", gameId?: number) => {
    const myScore = totalScore(state.scores.ai);
    const userScore = totalScore(state.scores.user);
    // 记忆以 AI 口吻写（[user] 是玩家）：玩家赢说「他赢了」，AI 赢说「我赢了」
    const result =
      status === "quit"
        ? `中途退出了（当时 ${userScore} : ${myScore}）`
        : state.winner === "user"
        ? `最后 ${userScore} : ${myScore}，他赢了`
        : state.winner === "ai"
        ? `最后 ${userScore} : ${myScore}，我赢了`
        : `最后打成 ${userScore} : ${myScore} 平手`;
    // 情绪并入 summary（不再单存 emotion 字段）
    const mood =
      status === "quit"
        ? "，他有点想走，下次可以再来"
        : state.winner === "user"
        ? "，他赢了挺开心，我还想再比一局"
        : state.winner === "tie"
        ? "，没分出胜负，都想再比一局"
        : "，他有点不服，我觉得很过瘾";
    const summary = `[user] [time]和我玩了 ${state.round} 轮快艇骰子，${result}${mood}`;
    const gist =
      status === "quit"
        ? "[user]玩快艇骰子中途走了"
        : state.winner === "user"
        ? "[user]玩快艇骰子赢了我"
        : state.winner === "tie"
        ? "[user]和我玩快艇骰子打平"
        : "[user]玩快艇骰子输给我了";
    const priority = status === "quit" ? 7 : state.winner === "user" ? 8 : 7;
    insertEpisode("一起玩快艇骰子", gist, summary, priority, "快艇骰子,骰子,快艇,对战");
    if (gameId) updateGameResultNote(gameId, summary);
  };

  /** 用户掷骰 */
  const handleYachtRoll = () => {
    // isLoading/掷骰动画期间禁用：AI 发言或动画中行动会触发并发 AI 回合、双流穿插
    if (!yachtState || isLoading || yachtRolling) return;
    if (yachtState.finished || yachtState.currentPlayer !== "user") return;
    const next = yachtRoll(yachtState);
    setYachtState(next);
    saveYachtState(next);
  };

  /** 用户切换骰子锁定 */
  const handleYachtToggle = (index: number) => {
    if (!yachtState || isLoading || yachtRolling) return;
    if (yachtState.finished || yachtState.currentPlayer !== "user") return;
    const next = yachtToggleKeep(yachtState, index);
    setYachtState(next);
    saveYachtState(next);
  };

  /** 退出对局（二次确认，避免误触直接终局） */
  const handleYachtQuit = () => {
    if (!yachtState) return;
    confirmDialog({
      title: "退出对局",
      desc: "退出后本局将记为未完局，确定要退出吗？",
      okText: "退出",
      onConfirm: async () => {
        // AI 回合/发言进行中不许退出：否则告别流与回合流并发、状态互相覆盖
        if (useChatStore.getState().isLoading || yachtRolling) return;
        const gid = gameSession?.id;
        writeYachtMemory(yachtState, "quit", gid);
        if (gid) {
          finishGameSession(gid, "abandoned", `玩家退出对局`);
        }
        addMessage({
          id: genMsgId(),
          role: "system",
          content: "你退出了快艇对局",
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
        // 先收尾状态，别让告别期间的输入再落进对局
        if (gid) collapseGame(gid);
        setGameSession(null);
        setYachtState(null);
        setShowYachtScore(false);
        // 告别：对局外普通消息（不进游戏框），与真心话退出节奏一致
        await runYachtAiTalk(buildYachtSection(yachtState, true), buildYachtQuitHint(yachtState), null);
      },
    });
  };

  /** 用户填分，然后交给 AI */
  const handleYachtScore = async (slot: YachtSlot) => {
    if (!yachtState || isLoading || yachtRolling) return;
    // 只能在自己回合填未用过的槽位（UI 之外的第二道防线）：
    // AI 发言期间 currentPlayer 已翻成 user，UI 可点，无守卫会触发并发 AI 回合
    if (yachtState.finished || yachtState.currentPlayer !== "user") return;
    if (yachtState.scores.user[slot] !== undefined) return;
    const value = previewScores(yachtState.dice, yachtState.scores.user)[slot];
    const next = yachtScore(yachtState, slot);
    setYachtState(next);
    saveYachtState(next);
    setShowYachtScore(false);
    addMessage({
      id: genMsgId(),
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
  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | null> => {
    // 竞速落败的 promise 也要接住 rejection，超时后迟到的失败会变成 unhandled rejection
    promise.catch(() => {});
    return Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  };

  /** 让 AI 的掷骰过程可见 */
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 人类反应/思考时间：随机延迟，避免 AI 秒回显得机械。
   * min~max 之间取随机值，模拟真人「想一下再动」的节奏。
   */
  const humanDelay = (min: number, max: number) =>
    new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  /** AI 自动回合：掷骰 → 决策 → 填分（带超时与兜底，保证一定推进） */
  const runYachtAiTurn = async (state: YachtState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    setLoading(true);
    let s = state;
    // 每个 await 后复查：对局被退出/结束后立即中止，别往已废弃对局写状态和消息
    const stillPlaying = () => !gid || getGameSessionById(gid)?.status === "playing";
    try {
      await humanDelay(600, 1300); // AI 思考一下再掷，避免你一选完它就秒动
      if (!stillPlaying()) return;

      // 回合起始骰面即本回合第 1 掷（与玩家对齐，各最多掷 3 次）；
      // 掷骰动画与 LLM 决策并行，动画把等待填满
      setYachtRolling(true);
      const keepPromise = withTimeout(
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
      await sleep(1100); // 掷骰动画最短持续时间
      const decision = await keepPromise; // LLM 没回来就继续转
      setYachtRolling(false);
      if (!stillPlaying()) return;
      const keepIndices = decision?.keep ?? fallbackKeep(s.dice);
      const keepReason = decision?.reason ?? "";

      // 应用保留后继续掷（最多到 3 次），每次重掷都开动画再落定
      while (s.rolls < MAX_ROLLS) {
        s = {
          ...s,
          kept: Array.from({ length: 5 }, (_, i) => keepIndices.includes(i)),
        };
        s = yachtRoll(s);
        setYachtState(s);
        setYachtRolling(true);
        await sleep(850);
        setYachtRolling(false);
        if (!stillPlaying()) return;
        // 全留了就不用再掷
        if (keepIndices.length >= 5) break;
      }

      // 选计分项：同样让动画陪跑，别让玩家干等
      setYachtRolling(true);
      const slotPromise = withTimeout(
        decideSlot({
          dice: s.dice,
          usedSlots: s.scores.ai,
          myScore: totalScore(s.scores.ai),
          opponentScore: totalScore(s.scores.user),
          round: s.round,
        }),
        8000
      );
      await sleep(900);
      const slotDecision = await slotPromise;
      setYachtRolling(false);
      // 写入前最后一次复查：避免退出竞态里往已废弃对局写填分/消息
      if (!stillPlaying()) return;
      const slot = slotDecision?.slot ?? fallbackSlot(s.dice, s.scores.ai);
      const reason = slotDecision?.reason ?? "";
      const value = previewScores(s.dice, s.scores.ai)[slot];

      const next = yachtScore(s, slot);
      setYachtState(next);
      saveYachtState(next, gid);

      // 把 AI 的最终结果显出来，别只留一句 AI 的话
      addMessage({
        id: genMsgId(),
        role: "system",
        content: `${aiLabel} 掷出 ${s.dice.join(" ")}，填了「${
          YACHT_SLOTS.find((x) => x.key === slot)?.label ?? slot
        }」= ${value} 分`,
        timestamp: dayjs().toISOString(),
        game_id: gid,
      });

      if (next.finished) {
        await finishYacht(next, gid);
        return;
      }
      if (!stillPlaying()) return;

      await runYachtAiTalk(
        buildYachtSection(next),
        buildYachtActionHint({
          state: next,
          action: "score",
          dice: s.dice,
          slot: YACHT_SLOTS.find((x) => x.key === slot)?.label ?? slot,
          slotValue: value,
          reason: reason || keepReason,
          aiName: aiLabel,
          playerLabel: user_nickname || "玩家",
        }),
        gid
      );
    } catch (err) {
      console.error("[yacht] AI 回合异常:", err);
      // 兜底：强制填一格把回合交还玩家，避免 currentPlayer 卡在 ai 造成对局死锁
      try {
        if (!s.finished && stillPlaying()) {
          const slot = fallbackSlot(s.dice, s.scores.ai);
          const next = yachtScore(s, slot);
          // 引擎守卫可能拒绝写入（槽位已填/已终局），只有真的推进了才落盘
          if (next !== s) {
            setYachtState(next);
            saveYachtState(next, gid);
            if (next.finished) {
              await finishYacht(next, gid);
            }
          }
        }
      } catch (err2) {
        console.error("[yacht] AI 回合兜底失败:", err2);
      }
    } finally {
      setYachtRolling(false);
      setLoading(false);
    }
  };

  /** 对局结束 */
  const finishYacht = async (state: YachtState, gameId?: number) => {
    const gid = gameId ?? gameSession?.id;
    writeYachtMemory(state, "finished", gid);
    // 标记已结束：getHistory 才会把这局合并成一条「游戏回顾」摘要（平手记 tie）
    if (gid) markGameEnded(gid, state.winner === "user" ? "won" : state.winner === "ai" ? "lost" : "tie");
    addMessage({
      id: genMsgId(),
      role: "system",
      content: `🏁 快艇对局结束 · 你 ${totalScore(state.scores.user)} : ${totalScore(state.scores.ai)} ${aiLabel}`,
      timestamp: dayjs().toISOString(),
      game_id: gid,
    });
    // 结束感想：对局外普通消息（不进游戏框）
    await runYachtAiTalk(buildYachtSection(state, true), buildYachtEndHint(state), null);
    if (gid) collapseGame(gid);
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
    setStreamingGameId(null);
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
        id: genMsgId(),
        role: "system",
        content: `你发起了 20问 · ${aiLabel}心里想好了，只能问「是/不是」的问题，20 次内猜中算赢`,
        timestamp: dayjs().toISOString(),
        game_id: session.id,
      });

      // 开场白在框内打字，别先在框外冒出来再跳进去
      setStreamingGameId(session.id);
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
            id: genMsgId(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            // 开场白挂进游戏卡片（与其它游戏一致，整局删除才删得干净）
            game_id: session.id,
          });
          setStreamingText("");
          setLoading(false);
        },
        onError: (err) => {
          addMessage({
            id: genMsgId(),
            role: "assistant",
            content: `⚠️ ${err.message}`,
            timestamp: dayjs().toISOString(),
            game_id: session.id,
          });
          setStreamingText("");
          setLoading(false);
        },
      });
    } catch (err) {
      setLoading(false);
      Alert.alert("开始失败", err instanceof Error ? err.message : String(err));
    } finally {
      setStreamingGameId(null);
    }
  };

  /** 退出 20问对局（放弃猜测，确认后揭晓谜底并结束） */
  const handleTwentyQuestionsQuit = () => {
    if (!gameSession || gameSession.status !== "playing") return;
    confirmDialog({
      title: "退出对局",
      desc: "退出后本局将结束并揭晓谜底，确定要退出吗？",
      okText: "退出",
      onConfirm: async () => {
        // 确认期间 AI 可能正在回复（judge/流式最长数秒）：此时退出会双流并发、消息互相穿插
        if (useChatStore.getState().isLoading) return;
        const gid = gameSession.id;
        skipScrollRef.current = true;
        finishGameSession(gid, "abandoned", `玩家中途退出，谜底是「${gameSession.secret}」`);
        addMessage({
          id: genMsgId(),
          role: "system",
          content: `🏳️ 你退出了 20问 · 谜底「${gameSession.secret}」`,
          timestamp: dayjs().toISOString(),
          game_id: gid,
        });
        // 揭晓与告别：对局外普通消息（不进游戏框），与其它游戏退出节奏一致
        await runYachtAiTalk(buildGameSection(gameSession, true), buildGameRevealHint(gameSession), null);
        collapseGame(gid);
        setGameSession(null);
      },
    });
  };

  const handleRegenerate = () => {
    if (!actionTarget || actionTarget.role !== "assistant") return;
    skipScrollRef.current = true;
    skipAutoFocusRef.current = true;
    // 删除前布局过渡：旧气泡高度收起 + 淡出，消除「瞬间塌缩」的视觉跳变；
    // 动画结束后再发起重答，新气泡自然生长（Web 上 LayoutAnimation 不生效，退化为原行为）
    LayoutAnimation.configureNext({
      duration: REGEN_ANIM_MS,
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity,
      },
    });
    deleteMessage(actionTarget.id);
    setActionTarget(null);
    setTimeout(() => doLLMCall(), REGEN_ANIM_MS);
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
    // 这条回复最终挂到哪个对局框。20问结束时置为 null：
    // 结束感想是框外的普通消息，既不进游戏卡片，也不会被折叠成「游戏回顾」塞进上下文
    let replyGameId: number | undefined = currentGameId;

    const userMsg: ChatMessage = {
      id: genMsgId(),
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
        const trimmed = text.trim();
        // 以数字开头视为猜数意图；猜数只在用户回合生效，
        // AI 回合窗口（重启恢复/异常中断）内的数字当闲聊，否则会被记成 AI 猜的
        if (bombState.currentPlayer === "user" && /^\d/.test(trimmed)) {
          const validFormat = /^\d+$/.test(trimmed);
          const value = parseInt(trimmed, 10);
          // 只允许猜当前收窄后的范围：范围外的数字是废招（比如 20~40 时猜 80）
          const { low, high } = currentRange(bombState);
          const inRange = validFormat && value >= low && value <= high;
          const duplicated = inRange && bombState.guesses.some((g) => g.value === value);
          if (!validFormat || !inRange || duplicated) {
            // 非法输入明确纠正（格式错/范围外/猜过），不静默当闲聊、不进对局
            addMessage({
              id: genMsgId(),
              role: "system",
              content: !validFormat
                ? `⚠️ 请直接发一个数字来猜（当前范围 ${low} ~ ${high}）`
                : !inRange
                ? `⚠️ 当前范围是 ${low} ~ ${high}，请在范围内猜一个数字`
                : `⚠️ ${value} 已经猜过啦，换一个没猜过的数字`,
              timestamp: dayjs().toISOString(),
              game_id: gameSession.id,
            });
            setLoading(false);
            return;
          }
          const next = bombGuess(bombState, value);
          setBombState(next);
          updateGameTurns(gameSession.id, JSON.stringify(next));
          addMessage({
            id: genMsgId(),
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
        // 非猜数意图（或 AI 回合的数字输入）：当作闲聊，带游戏上下文
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
      } else if (gameSession?.game_type === "truth_or_dare" && truthDareState && !truthDareState.finished) {
        // 真心话大冒险：只有抽中「轮到玩家回答」的题时，这句话才算答案；
        // AI 的题或等待掷骰时按闲聊，避免 AI 回合窗口里的话被误当答案
        const tdPending = tdPendingQuestion(truthDareState);
        if (tdPending && tdPending.answeredBy === "user") {
          let s = tdCompleteTurn(truthDareState);
          setTruthDareState(s);
          saveTruthDareState(s, gameSession.id);
          await runTruthDareAiTurn(s, gameSession.id, text);
          setLoading(false);
          return;
        }
        gameParts = {
          section: buildTruthDareSection(truthDareState),
          hint: "（玩家在游戏间隙闲聊，正常陪他聊，可以顺带鼓励他掷骰子）",
        };
      } else if (
        gameSession?.game_type === "twenty_questions" &&
        gameSession.status === "playing"
      ) {
        // 只有 20问的 turns 是 GameTurn[] 流水，能走 handlePlayerInput；
        // 其他游戏类型 state 丢失时不得落进这个分支（appendGameTurn 会拒写或错判）
        const res = await handlePlayerInput(gameSession, text);
        setGameSession(res.session.status === "playing" ? res.session : null);
        // 对局结束时补一条系统提示（界面可见，不进上下文）
        if (res.ended) {
          const asked = res.session.question_count;
          const won = res.endStatus === "won";
          // 庆祝提示放在框外：框马上要折叠，放框内会被一起收掉看不见
          addMessage({
            id: genMsgId(),
            role: "system",
            content: won
              ? `🎉 猜中了！第 ${asked} 次提问就猜出来啦 · 谜底「${res.session.secret}」`
              : `🎭 ${MAX_QUESTIONS} 次用完啦 · 谜底「${res.session.secret}」`,
            timestamp: dayjs().toISOString(),
            game_id: undefined,
          });
          // 结束后自动折叠整局，留一个可展开的卡片
          collapseGame(gameSession.id);
          // 结束感想走框外：保留这一条完整回复在上下文里，
          // 整局被压缩成「游戏回顾」后 AI 的语气才不会突然断档
          replyGameId = undefined;
        }
        gameParts = {
          // 用 res.session（含本回合流水）拼游戏区，已问清单才不缺最新一条
          section: buildGameSection(res.session, res.ended),
          hint: res.ended
            ? `本局结束（${res.endStatus === "won" ? "玩家猜中了" : "未猜中"}），请自然地宣布结果并揭晓谜底：「${res.session.secret}」，然后接回日常聊天。`
            : buildGameProgressHint(res.session, res.turn),
        };
      }

      const history = getHistory();
      const context = buildChatContext(text, history, gameParts);
      setDebugInfo(context.systemPrompt, context.keywords, context.memoryCount);
      // 打字过程就发生在目标框内（replyGameId 为空 = 框外普通消息）
      setStreamingGameId(replyGameId ?? null);

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
            id: genMsgId(),
            role: "assistant",
            content: fullResponse,
            timestamp: dayjs().toISOString(),
            thinking: fullThinking || undefined,
            game_id: replyGameId,
          };
          // 流式输出已实时展示，不需要逐条延迟动画；非流式逐条出现。
          // 动画标记先于消息落库、流式残留先清掉，避免气泡先闪现全文再回退成逐条出现
          const animateIn = !useSettingsStore.getState().stream_output;
          setStreamingText("");
          setStreamingThinking("");
          setStreamingGameId(null);
          if (animateIn) setAnimatingMsgId(aiMsg.id);
          addMessage(aiMsg);
          setLoading(false);

          // 首轮对话完成后生成好友花名册：此刻人设已生效、用户称呼也有了，
          // 生成出来的人最贴。函数内部幂等，已建过/已停用都不会重掷。
          checkAndGenerateFriends().catch((err) =>
            console.error("[chat] 好友花名册生成异常:", err),
          );

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
            id: genMsgId(),
            role: "assistant",
            content: `⚠️ ${error.message}`,
            timestamp: dayjs().toISOString(),
            // 错误消息挂到对应对局框内，别散落在卡片外
            game_id: replyGameId,
          };
          addMessage(errorMsg);
          setStreamingText("");
          setStreamingThinking("");
          setStreamingGameId(null);
          setLoading(false);
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "未知错误";
      addMessage({
        id: genMsgId(),
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: dayjs().toISOString(),
        game_id: replyGameId,
      });
      setStreamingText("");
      setStreamingThinking("");
      setStreamingGameId(null);
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

        <Text style={[styles.setupLabel, { color: colors.textMuted }]}>你希望我怎么称呼你？</Text>
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
      {/* 标题栏（紧凑：按安全区适配，左上返回会话列表） */}
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
        <View style={styles.headerLeft}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.headerAction}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.headerActionText, { color: colors.textMuted }]}>‹ 返回</Text>
          </TouchableOpacity>
          <TouchableOpacity onLongPress={() => setShowDebug(true)} delayLongPress={800}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>
              {isLoading ? `正在输入中${".".repeat(dotsCount)}` : (ai_name || "私藏")}
            </Text>
          </TouchableOpacity>
        </View>
        {gameSession?.game_type === "yacht" && yachtState ? (
          <View style={styles.hudWrap}>
            {/* 点蓝字展开/收起得分面板（在选择区上方，不遮挡） */}
            <TouchableOpacity onPress={() => setShowYachtScores((v) => !v)}>
              <Text style={[styles.gameBadge, { color: colors.accent }]}>
                🎲 第 {yachtState.round}/13 轮 · 你 {totalScore(yachtState.scores.user)} - {totalScore(yachtState.scores.ai)} {aiLabel} {showYachtScores ? "▴" : "▾"}
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
            {/* 点蓝字展开/收起详情面板（避免常驻挡住底部消息） */}
            <TouchableOpacity onPress={() => setShowBombInfo((v) => !v)}>
              <Text style={[styles.gameBadge, { color: colors.accent }]}>
                💣 {bombState.finished ? "已结束" : bombState.currentPlayer === "user" ? "轮到你猜" : `轮到${aiLabel}猜`} · 范围 {currentRange(bombState).low}-{currentRange(bombState).high} {showBombInfo ? "▴" : "▾"}
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
        ) : gameSession?.game_type === "truth_or_dare" && truthDareState && !truthDareState.finished ? (
          <View style={styles.hudWrap}>
            <Text style={[styles.gameBadge, { color: colors.accent }]}>
              ❤️ {tdIsUserTurn(truthDareState) ? "轮到你" : `轮到${aiLabel}`} · 剩{" "}
              {truthDareState.questions.filter((q) => !q.used).length} 题
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
      </View>

      {messages.length === 0 && !isLoading && (
        <View style={styles.welcomeContainer}>
          <Text style={[styles.welcomeHint, { color: colors.textMuted }]}>你愿意和我聊聊吗？</Text>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={displayItems}
        keyExtractor={(item) =>
          item.kind === "game"
            ? `game-${item.gameId}-${item.groupIndex}`
            : item.kind === "date"
            ? item.id
            : item.message.id
        }
        // 首屏窗口内全部渲染，保证 contentSize 是真实值
        initialNumToRender={displayItems.length}
        // 滑到顶部时加载更早的消息（onStartReached 是「进入顶部区域时触发一次」，
        // 停在顶部不动不会再触发，所以下面还配了一个显式入口兜底）
        onStartReached={loadEarlierMessages}
        onStartReachedThreshold={0.2}
        ListHeaderComponent={
          hasMore ? (
            <TouchableOpacity style={styles.loadMoreBtn} onPress={loadEarlierMessages}>
              <Text style={[styles.loadMoreText, { color: colors.accent }]}>
                加载更早的消息（还有 {messages.length - renderCount} 条）
              </Text>
            </TouchableOpacity>
          ) : null
        }
        // 顶部插入更早消息时保持当前可见位置，不跳动
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        // 布局阶段即对齐底部（早于绘制，避免看到从顶部跳到底部）
        onLayout={scrollOnLayout}
        // 内容尺寸变化时：首屏定位 + 贴底跟随（非动画，避免动画目标过期停在旧底）
        onContentSizeChange={handleContentSizeChange}
        // 用户一旦开始滑动就结束初始窗口，彻底交还控制权，并进入手势态
        onScrollBeginDrag={() => {
          initialWindowRef.current = false;
          userGestureActiveRef.current = true;
          dragJustEndedRef.current = false;
          if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
        }}
        onScrollEndDrag={(e) => {
          measureAtBottom(e);
          // 拖拽结束可能还有一段用户甩动惯性：短暂保持手势态，等 momentum 接管
          dragJustEndedRef.current = true;
          if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
          dragEndTimerRef.current = setTimeout(() => {
            dragJustEndedRef.current = false;
            userGestureActiveRef.current = false;
          }, 150);
        }}
        onMomentumScrollBegin={() => {
          // 只接管「用户甩动」的惯性；程序化滚动的 momentum 事件不进入手势态
          if (dragJustEndedRef.current) {
            userGestureActiveRef.current = true;
            dragJustEndedRef.current = false;
            if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
          }
        }}
        onMomentumScrollEnd={(e) => {
          if (userGestureActiveRef.current) measureAtBottom(e);
          userGestureActiveRef.current = false;
          dragJustEndedRef.current = false;
          if (dragEndTimerRef.current) clearTimeout(dragEndTimerRef.current);
        }}
        // 贴底判定：用户手势期间测量；非手势时（Web 鼠标滚轮）只排除程序化滚动窗口，
        // 程序化滚动/内容增长引发的 onScroll 不参与，避免误置 false 后自动滚底永久失效。
        // 距底部 80pt 内视为贴底
        onScroll={(e) => {
          if (userGestureActiveRef.current || !programmaticScrollRef.current) {
            measureAtBottom(e);
          }
        }}
        scrollEventThrottle={16}
        renderItem={({ item }) => {
          // 日期分隔条（微信式：居中灰色圆角小条）
          if (item.kind === "date") {
            return (
              <View style={styles.dateDivider}>
                <Text
                  style={[styles.dateDividerText, { color: colors.textMuted, backgroundColor: colors.chipBg }]}
                >
                  {item.label}
                </Text>
              </View>
            );
          }
          // 普通消息
          if (item.kind === "msg") {
            const m = item.message;
            return (
              <ChatBubble
                message={m}
                shouldAnimate={m.id === animatingMsgId}
                onBubbleAppear={() => {
                  skipScrollRef.current = false;
                  setTimeout(() => scrollToBottomIfNeeded(true), 50);
                }}
                onLongPress={() => {
                  setActionTarget(m);
                  setShowActionMenu(true);
                }}
              />
            );
          }

          // 整局游戏框进一张卡片：标题 + 对话都在框内
          const gameId = item.gameId;
          const info = gameGroupInfo.get(gameId);
          const session = getGameSessionById(gameId);
          // 进行中的对局默认展开，已结束折叠成卡片；
          // 正在往这个框里流式输出时强制展开，否则打字过程会被折叠卡片挡住
          const expanded = streamingGameId === gameId || (gameExpandOverride.get(gameId) ?? session?.status === "playing");
          const resultText = gameResultText(session);
          const gameName =
            session?.game_type === "yacht"
              ? "快艇骰子"
              : session?.game_type === "bomb"
              ? "数字炸弹"
              : session?.game_type === "truth_or_dare"
              ? "真心话大冒险"
              : session?.game_type === "twenty_questions"
              ? "20问"
              : "游戏对局";

          return (
            <View style={[styles.gameFrame, { borderColor: colors.border, backgroundColor: colors.sectionBg }]}>
              <View style={styles.gameCardHeaderRow}>
                <TouchableOpacity
                  style={styles.gameCardHeader}
                  onPress={() => toggleGameExpand(gameId)}
                  onLongPress={() => requestDeleteGameGroup(gameId)}
                  delayLongPress={400}
                >
                  <Text style={[styles.gameCardTitle, { color: colors.text }]}>
                    🎮 {gameName} · {resultText}
                    {session?.game_type === "twenty_questions" && session?.status !== "playing"
                      ? ` · 谜底「${session?.secret}」`
                      : ""}
                  </Text>
                  <Text style={[styles.gameCardHint, { color: colors.textMuted }]}>
                    {expanded
                      ? "点击收起 ▴"
                      : `${item.messages.length} 条对话 · 点击展开 ▾`}
                  </Text>
                </TouchableOpacity>
                {/* 整局删除入口 */}
                <TouchableOpacity
                  style={styles.gameCardDelete}
                  hitSlop={8}
                  onPress={() => requestDeleteGameGroup(gameId)}
                >
                  <Text style={[styles.gameCardDeleteText, { color: colors.textMuted }]}>✕</Text>
                </TouchableOpacity>
              </View>
              {expanded && (
                <>
                  <View style={styles.gameFrameBody}>
                    {item.messages.map((m: ChatMessage) => (
                      <ChatBubble
                        key={m.id}
                        message={m}
                        shouldAnimate={m.id === animatingMsgId}
                        onBubbleAppear={() => {
                          skipScrollRef.current = false;
                          setTimeout(() => scrollToBottomIfNeeded(true), 50);
                        }}
                        onLongPress={() => {
                          setActionTarget(m);
                          setShowActionMenu(true);
                        }}
                      />
                    ))}
                    {/* 流式中的回复：直接在框内打字，不跑到框外再跳回来 */}
                    {item.hasStreaming &&
                      streamingChunks.map((chunk, index) => (
                        <StreamingBubble key={index} text={chunk} />
                      ))}
                  </View>
                  {/* 长流程：底部也放一个收起按钮，免得要滚回顶部 */}
                  <TouchableOpacity
                    style={[styles.gameFrameFooter, { borderTopColor: colors.border }]}
                    onPress={() => toggleGameExpand(gameId)}
                  >
                    <Text style={[styles.gameFrameFooterText, { color: colors.textMuted }]}>
                      点击收起整局 ▴
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          );
        }}
        ListFooterComponent={
          streamingThinking || streamingChunks.length > 0 ? (
            <>
              {/* 流式思考气泡 */}
              {streamingThinking ? (
                <View style={[styles.thinkingContainer, { borderColor: colors.border }]}>
                  <Text style={[styles.thinkingLabel, { color: colors.textMuted }]}>💭 思考中...</Text>
                  <Text style={[styles.thinkingText, { color: colors.textMuted }]}>{streamingThinking}</Text>
                </View>
              ) : null}
              {/* 流式内容气泡：挂在某个对局框里时由框内渲染，这里不再重复渲染 */}
              {streamingGameId == null &&
                streamingChunks.map((chunk, index) => (
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
        {/* 数字炸弹详情面板（点标题栏蓝字展开） */}
        {gameSession?.game_type === "bomb" && bombState && !bombState.finished && showBombInfo ? (
          <BombCard
            state={bombState}
            aiName={aiLabel}
            onQuit={handleBombQuit}
            disabled={isLoading}
          />
        ) : null}

        {/* 真心话大冒险面板 */}
        {gameSession?.game_type === "truth_or_dare" && truthDareState && !truthDareState.finished ? (
          <TruthDareCard
            state={truthDareState}
            aiName={aiLabel}
            rolling={truthDareRolling}
            realFace={tdDieFace}
            canRoll={
              tdIsUserTurn(truthDareState) &&
              truthDareState.pendingIndex == null &&
              !isLoading &&
              !truthDareRolling
            }
            onRoll={handleTruthDareRoll}
            onEditBank={handleOpenTdEdit}
            onQuit={handleTruthDareQuit}
            disabled={isLoading || truthDareRolling}
          />
        ) : null}

        {/* 快艇骰子面板 */}
        {gameSession?.game_type === "yacht" && yachtState && !yachtState.finished ? (
          <View>
            {/* 计分面板：点蓝字看，点「填分」变成可选 */}
            {showYachtScores && (
              <YachtScoreCard
                rows={YACHT_SLOTS.map((s) => ({
                  slot: s.key,
                  label: s.label,
                  section: s.section,
                  user: yachtState.scores.user[s.key] ?? null,
                  ai: yachtState.scores.ai[s.key] ?? null,
                }))}
                selectable={showYachtScore && yachtState.currentPlayer === "user" && !isLoading}
                onSelect={handleYachtScore}
                aiName={aiLabel}
                // 预览只在轮到用户填分时展示：AI 回合的 dice 是 AI 的骰子，展示「可得 X」纯误导
                preview={
                  showYachtScore && yachtState.currentPlayer === "user" && !isLoading
                    ? previewScores(yachtState.dice, yachtState.scores.user)
                    : undefined
                }
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
              canRoll={yachtCanRoll(yachtState) && yachtState.currentPlayer === "user" && !isLoading}
              onToggle={handleYachtToggle}
              onRoll={handleYachtRoll}
              onScore={() => {
                // 点填分：自动展开计分面板并进入可选模式
                setShowYachtScores(true);
                setShowYachtScore(true);
              }}
              readOnly={yachtState.currentPlayer === "ai" || isLoading || yachtRolling}
              rolling={yachtRolling}
              aiName={aiLabel}
            />
            {/* 退出对局 */}
            <TouchableOpacity
              onPress={handleYachtQuit}
              disabled={isLoading || yachtRolling}
              style={[styles.quitBtn, (isLoading || yachtRolling) && { opacity: 0.4 }]}
            >
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
            <TouchableOpacity onPress={handleTwentyQuestionsQuit} hitSlop={6}>
              <Text style={[styles.gameStatusQuit, { color: colors.textMuted }]}>退出对局</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <InputBar
          onSend={handleSend}
          disabled={isLoading}
          onPlus={() => setShowGameMenu(true)}
          hidePlus={Boolean(gameSession && gameSession.status === "playing")}
          inputRef={chatInputRef}
        />

      {/* 编辑题库弹窗（真心话大冒险） */}
      <Modal visible={showTdEdit} transparent animationType="fade" onRequestClose={() => setShowTdEdit(false)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setShowTdEdit(false)}>
          <View style={[styles.helpModal, { backgroundColor: colors.sectionBg, maxHeight: "82%" }]}>
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              <Text style={[styles.helpTitle, { color: colors.text }]}>编辑题库</Text>
              <Text style={[styles.helpText, { color: colors.textMuted }]}>
                共 6 题。可改题目文字、点标签切换真心话/大冒险。
              </Text>
              {tdEditDraft.map((q) => (
                <View key={q.index} style={[styles.tdEditRow, { borderColor: colors.border }]}>
                  <View style={styles.tdEditRowHead}>
                    <Text style={[styles.tdEditIndex, { color: colors.textMuted }]}>{q.index} 号</Text>
                    <TouchableOpacity
                      onPress={() =>
                        setTdEditDraft((prev) =>
                          prev.map((x) =>
                            x.index === q.index ? { ...x, kind: x.kind === "truth" ? "dare" : "truth" } : x
                          )
                        )
                      }
                    >
                      <Text style={[styles.tdEditTag, { color: q.kind === "truth" ? colors.accent : colors.text }]}>
                        {KIND_LABEL[q.kind]} · 点击切换
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <TextInput
                    value={q.text}
                    onChangeText={(t) =>
                      setTdEditDraft((prev) => prev.map((x) => (x.index === q.index ? { ...x, text: t } : x)))
                    }
                    style={[styles.tdEditInput, { color: colors.text, borderColor: colors.border }]}
                    multiline
                  />
                </View>
              ))}
              <View style={styles.tdEditBtnRow}>
                <TouchableOpacity
                  style={[styles.tdEditBtn, { borderColor: colors.border, opacity: tdRegenerating ? 0.5 : 1 }]}
                  onPress={handleRegenTdDraft}
                  disabled={tdRegenerating}
                >
                  <Text style={[styles.tdEditBtnText, { color: colors.text }]}>
                    {tdRegenerating ? "生成中..." : "换一批"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tdEditBtn, { backgroundColor: colors.accent }]}
                  onPress={handleSaveTdEdit}
                >
                  <Text style={[styles.tdEditBtnText, { color: colors.textOnAccent }]}>保存</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </Pressable>
      </Modal>

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
                {aiLabel}心里想一个人物，你问是非问题来猜
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
              onPress={() => {
                setShowGameMenu(false);
                handleStartTruthDare();
              }}
            >
              <Text style={[styles.gameMenuText, { color: colors.text }]}>❤️ 真心话大冒险</Text>
              <Text style={[styles.gameMenuDesc, { color: colors.textMuted }]}>
                轮流掷骰抽题，答真心话或做文字冒险
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
                  {aiLabel}心里想好一个谜底，你只能问「是/不是」的问题，20 次内猜中算赢。
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
                  已经埋好一个 1~100 的数字（炸弹），双方轮流猜数来缩小范围。
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
            ) : gameSession?.game_type === "truth_or_dare" ? (
              <>
                <Text style={[styles.helpTitle, { color: colors.text }]}>真心话大冒险 · 规则</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  一批 6 道题（每题自带「真心话」或「大冒险」标签），双方轮流掷骰抽题，抽到哪题就答哪题。
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>怎么玩</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  • 点「掷骰子」，骰到几就抽几号题{"\n"}
                  • 抽到真心话就真诚回答，抽到大冒险就用文字俏皮完成{"\n"}
                  • 答完轮到对方掷骰，如此轮流{"\n"}
                  • 题库答完会自动换一批
                </Text>
                <Text style={[styles.helpSection, { color: colors.text }]}>没有输赢</Text>
                <Text style={[styles.helpText, { color: colors.textMuted }]}>
                  纯粹互相了解、增进感情，随时可点「退出对局」结束。想换题可点「编辑题库」。
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
              {actionTarget?.role === "user" ? "消息操作" : `${aiLabel}的回复`}
            </Text>
            {/* 游戏内消息只留复制/删除：编辑与重新生成会脱离对局上下文 */}
            {actionTarget?.role === "assistant" && !actionTarget?.game_id && isLastOfRole(actionTarget) && (
              <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("regenerate")}>
                <Text style={[styles.actionText, { color: colors.text }]}>🔄 重新生成</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("copy")}>
              <Text style={[styles.actionText, { color: colors.text }]}>📋 复制</Text>
            </TouchableOpacity>
            {!actionTarget?.game_id && (
              <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("edit")}>
                <Text style={[styles.actionText, { color: colors.text }]}>✏️ 编辑</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actionItem, { borderTopColor: colors.border }]} onPress={() => handleAction("delete")}>
              <Text style={[styles.actionText, { color: colors.danger }]}>🗑️ 删除</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionCancel, { backgroundColor: colors.bg }]} onPress={() => setShowActionMenu(false)}>
              <Text style={[styles.actionCancelText, { color: colors.textMuted }]}>取消</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* 二次确认弹窗（Web 兜底；原生走系统 Alert，见 confirmDialog） */}
      <Modal visible={confirmState != null} transparent animationType="fade" onRequestClose={() => setConfirmState(null)}>
        <Pressable style={[styles.overlay, { backgroundColor: colors.overlayBg }]} onPress={() => setConfirmState(null)}>
          <View style={[styles.confirmBox, { backgroundColor: colors.sectionBg }]}>
            <Text style={[styles.confirmTitle, { color: colors.text }]}>{confirmState?.title ?? ""}</Text>
            <Text style={[styles.confirmDesc, { color: colors.textMuted }]}>{confirmState?.desc ?? ""}</Text>
            <View style={styles.confirmButtons}>
              <TouchableOpacity style={[styles.confirmCancel, { backgroundColor: colors.btnBg }]} onPress={() => setConfirmState(null)}>
                <Text style={[styles.confirmCancelText, { color: colors.text }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmDelete, { backgroundColor: colors.danger }]}
                onPress={() => {
                  const onConfirm = confirmState?.onConfirm;
                  setConfirmState(null);
                  onConfirm?.();
                }}
              >
                <Text style={[styles.confirmDeleteText, { color: colors.textOnAccent }]}>{confirmState?.okText ?? "确认"}</Text>
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
  dateDivider: {
    alignItems: "center",
    marginVertical: 8,
  },
  dateDividerText: {
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 9,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6, paddingBottom: 6, paddingHorizontal: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLeft: { flexDirection: "row", alignItems: "center" },
  headerTitle: { fontSize: 16, fontWeight: "600", letterSpacing: 1 },
  headerAction: { paddingVertical: 4, paddingRight: 12 },
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  gameStatusText: {
    fontSize: 11,
    flex: 1,
  },
  gameStatusQuit: {
    fontSize: 11,
    textDecorationLine: "underline",
    marginLeft: 12,
  },
  // 游戏对局卡片：标题 + 对话整体框在一起
  gameFrame: {
    marginHorizontal: 16,
    marginVertical: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  gameCardHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  gameCardHeader: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  gameCardDelete: {
    paddingHorizontal: 12,
    paddingTop: 11,
  },
  gameCardDeleteText: {
    fontSize: 14,
  },
  gameFrameBody: {
    paddingBottom: 6,
  },
  gameFrameFooter: {
    paddingVertical: 8,
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  gameFrameFooterText: {
    fontSize: 11,
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
  // 真心话大冒险：编辑题库弹窗
  tdEditRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tdEditRowHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  tdEditIndex: {
    fontSize: 11,
    fontWeight: "700",
  },
  tdEditTag: {
    fontSize: 11,
    fontWeight: "600",
  },
  tdEditInput: {
    fontSize: 13,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 36,
  },
  tdEditBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  tdEditBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
  },
  tdEditBtnText: {
    fontSize: 14,
    fontWeight: "700",
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
  loadMoreBtn: { alignItems: "center", paddingVertical: 12 },
  loadMoreText: { fontSize: 12 },
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
