import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
} from "react-native";
import dayjs from "dayjs";
import { useTheme } from "@/theme/useTheme";
import { MOOD_COLORS, type Moment, type MomentComment, type MoodTag, type FriendPersona } from "@/types/schema";

interface Props {
  moment: Moment;
  comments: MomentComment[];
  /** AI 的称呼（评论区署名用） */
  aiLabel: string;
  /** 好友档案（按 friend_id 索引），用于头像/署名 */
  friendMap?: Record<number, FriendPersona>;
  /** AI 正在写评论（显示三点动效） */
  aiTyping?: boolean;
  onSendComment: (momentId: number, content: string) => void;
  /** 长按好友头像：不让他再出现（快捷入口，不用翻设置） */
  onBlockFriend?: (friendId: number) => void;
}

/** 相对时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 / MM-DD */
function formatRelative(iso: string): string {
  const d = dayjs(iso);
  const now = dayjs();
  const diffMin = now.diff(d, "minute");
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (d.isSame(now, "day")) return d.format("HH:mm");
  if (d.isSame(now.subtract(1, "day"), "day")) return "昨天";
  return d.format("MM-DD");
}

/** AI 评论生成中的三点微动效 */
function TypingDots() {
  const colors = useTheme();
  const a1 = useRef(new Animated.Value(0.25)).current;
  const a2 = useRef(new Animated.Value(0.25)).current;
  const a3 = useRef(new Animated.Value(0.25)).current;

  useEffect(() => {
    const makeLoop = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.25, duration: 320, useNativeDriver: true }),
          Animated.delay(500),
        ])
      );
    const loops = [makeLoop(a1, 0), makeLoop(a2, 160), makeLoop(a3, 320)];
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [a1, a2, a3]);

  return (
    <View style={styles.typingRow}>
      {[a1, a2, a3].map((v, i) => (
        <Animated.View
          key={i}
          style={[styles.typingDot, { backgroundColor: colors.textMuted, opacity: v }]}
        />
      ))}
    </View>
  );
}

/**
 * 单条心情动态卡片：头像、心情标签、正文、相对时间、评论线程与评论输入
 */
export function MomentCard({
  moment,
  comments,
  aiLabel,
  friendMap,
  aiTyping,
  onSendComment,
  onBlockFriend,
}: Props) {
  const colors = useTheme();
  const [inputVisible, setInputVisible] = useState(false);
  const [draft, setDraft] = useState("");

  // 新卡片淡入
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [fade]);

  const isMe = moment.author === "user";
  const isAi = moment.author === "ai";
  const authorFriend = moment.friend_id != null ? friendMap?.[moment.friend_id] : undefined;
  const moodColor = MOOD_COLORS[moment.mood as MoodTag] ?? colors.textMuted;

  // 三种作者：我（实心）/ 主角色（强调色）/ 好友（头像 emoji + 名字）
  const authorName = isMe ? "我" : isAi ? aiLabel : authorFriend?.name ?? "朋友";
  const avatarText = isMe
    ? "我"
    : isAi
      ? aiLabel.slice(0, 1)
      : authorFriend?.avatar_emoji || authorFriend?.name?.slice(0, 1) || "友";
  const avatarBg = isMe ? colors.bubbleUser : isAi ? colors.accent : colors.accentMuted;
  const avatarFg = isMe ? colors.textOnAccent : isAi ? "#FFFFFF" : colors.accent;

  /** 评论署名：好友用真名，否则评论区全是「我」和 AI，看不出谁在说话 */
  const commentLabel = (author: MomentComment["author"], friendId?: number | null) => {
    if (author === "ai") return aiLabel;
    if (author === "friend") return friendMap?.[friendId ?? -1]?.name ?? "朋友";
    return "我";
  };

  const commentAvatar = (author: MomentComment["author"], friendId?: number | null) => {
    if (author === "ai") return aiLabel.slice(0, 1);
    if (author === "friend") {
      const f = friendMap?.[friendId ?? -1];
      return f?.avatar_emoji || f?.name?.slice(0, 1) || "友";
    }
    return "我";
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSendComment(moment.id, text);
    setDraft("");
    setInputVisible(false);
  };

  return (
    <Animated.View
      style={[
        styles.card,
        {
          backgroundColor: colors.sectionBg,
          borderColor: colors.border,
          opacity: fade,
          transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
      {/* 头部：头像 + 名字 + 心情标签 + 时间 */}
      <View style={styles.header}>
        <TouchableOpacity
          activeOpacity={0.8}
          disabled={!authorFriend || !onBlockFriend}
          onLongPress={() => {
            if (authorFriend && onBlockFriend) onBlockFriend(authorFriend.id);
          }}
          style={[styles.avatar, { backgroundColor: avatarBg }]}
        >
          <Text style={[styles.avatarText, { color: avatarFg }]}>{avatarText}</Text>
        </TouchableOpacity>
        <View style={styles.headerMain}>
          <View style={styles.headerTop}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {authorName}
            </Text>
            <View style={styles.moodWrap}>
              <View style={[styles.moodDot, { backgroundColor: moodColor }]} />
              <Text style={[styles.moodText, { color: moodColor }]}>{moment.mood}</Text>
            </View>
          </View>
          <Text style={[styles.time, { color: colors.textMuted }]}>
            {formatRelative(moment.created_at)}
          </Text>
        </View>
      </View>

      {/* 正文 */}
      <Text style={[styles.content, { color: colors.text }]}>{moment.content}</Text>

      {/* 评论线程 */}
      {comments.length > 0 && (
        <View style={[styles.thread, { backgroundColor: colors.inputBg }]}>
          {comments.map((c) => {
            const cf = c.friend_id != null ? friendMap?.[c.friend_id] : undefined;
            return (
              <TouchableOpacity
                key={c.id}
                activeOpacity={0.8}
                disabled={!cf || !onBlockFriend}
                onLongPress={() => {
                  if (cf && onBlockFriend) onBlockFriend(cf.id);
                }}
                style={styles.commentRow}
              >
                <Text style={[styles.commentAvatar, { color: colors.textMuted }]}>
                  {commentAvatar(c.author, c.friend_id)}
                </Text>
                <Text
                  style={[
                    styles.commentName,
                    { color: c.author === "user" ? colors.textSecondary : colors.accent },
                  ]}
                >
                  {commentLabel(c.author, c.friend_id)}：
                </Text>
                <Text style={[styles.commentText, { color: colors.textSecondary }]}>{c.content}</Text>
              </TouchableOpacity>
            );
          })}
          {aiTyping ? <TypingDots /> : null}
        </View>
      )}
      {comments.length === 0 && aiTyping ? (
        <View style={[styles.thread, { backgroundColor: colors.inputBg }]}>
          <TypingDots />
        </View>
      ) : null}

      {/* 操作行 */}
      <View style={styles.footer}>
        <TouchableOpacity
          onPress={() => setInputVisible((v) => !v)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.footerAction, { color: colors.textMuted }]}>
            💬 评论{comments.length > 0 ? ` (${comments.length})` : ""}
          </Text>
        </TouchableOpacity>
      </View>

      {/* 评论输入条 */}
      {inputVisible && (
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.inputBg, color: colors.text }]}
            value={draft}
            onChangeText={setDraft}
            placeholder="说点什么…"
            placeholderTextColor={colors.placeholder}
            multiline
            maxLength={200}
          />
          <TouchableOpacity
            onPress={send}
            style={[styles.sendBtn, { backgroundColor: draft.trim() ? colors.accent : colors.btnDisabled }]}
            disabled={!draft.trim()}
          >
            <Text style={[styles.sendText, { color: "#FFFFFF" }]}>发送</Text>
          </TouchableOpacity>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 16,
    fontWeight: "600",
  },
  headerMain: {
    flex: 1,
    marginLeft: 10,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
    maxWidth: "55%",
  },
  moodWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginLeft: 8,
  },
  moodDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 4,
  },
  moodText: {
    fontSize: 12,
    fontWeight: "500",
  },
  time: {
    fontSize: 11,
    marginTop: 2,
  },
  content: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  thread: {
    borderRadius: 12,
    padding: 10,
    marginTop: 10,
  },
  commentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    marginBottom: 4,
  },
  commentAvatar: {
    fontSize: 12,
    marginRight: 4,
  },
  commentName: {
    fontSize: 13,
    fontWeight: "600",
  },
  commentText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
  },
  footerAction: {
    fontSize: 13,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginTop: 10,
  },
  input: {
    flex: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 90,
  },
  sendBtn: {
    marginLeft: 8,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  sendText: {
    fontSize: 13,
    fontWeight: "600",
  },
});
