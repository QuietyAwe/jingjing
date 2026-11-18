// ============================================================
// 主题色板 — 浅色 / 深色
// ============================================================

export interface ColorPalette {
  // 背景
  bg: string;
  sectionBg: string;
  editorBg: string;
  overlayBg: string;
  /** 灰底小胶囊（如消息日期分隔条） */
  chipBg: string;

  // 文字
  text: string;
  textSecondary: string;
  textMuted: string;
  /** 用户气泡文字，可被设置页自定义颜色覆盖 */
  textOnAccent: string;
  /** 强调色按钮上的文字 */
  accentText: string;
  /** 危险操作按钮上的文字 */
  dangerText: string;

  // 功能色
  accent: string;
  accentMuted: string;
  danger: string;
  dangerMuted: string;

  // 边框 & 分割线
  border: string;

  // 输入框 & 按钮
  inputBg: string;
  btnBg: string;
  btnDisabled: string;
  placeholder: string;

  // 聊天气泡
  bubbleUser: string;
  bubbleAi: string;

  // 调试面板
  debugBg: string;
  debugText: string;
}

export const lightColors: ColorPalette = {
  bg: "#F7F5F2",
  sectionBg: "#FFFFFF",
  editorBg: "#FFFFFF",
  overlayBg: "rgba(35,32,29,0.38)",
  chipBg: "#ECE9E4",

  text: "#302F2C",
  textSecondary: "#5F5C57",
  textMuted: "#706C66",
  textOnAccent: "#584B43",
  accentText: "#FFFFFF",
  dangerText: "#FFFFFF",

  accent: "#52778A",
  accentMuted: "rgba(82,119,138,0.12)",
  danger: "#C64B55",
  dangerMuted: "rgba(198,75,85,0.10)",

  border: "#E5E1DB",

  inputBg: "#F3F1ED",
  btnBg: "#ECE9E4",
  btnDisabled: "#C9C5BF",
  placeholder: "#7B7670",

  bubbleUser: "#F7E2DE",
  bubbleAi: "#F6F1EA",

  debugBg: "#1E1E1E",
  debugText: "#D4D4D4",
};

export const darkColors: ColorPalette = {
  bg: "#151516",
  sectionBg: "#1E1E20",
  editorBg: "#1E1E20",
  overlayBg: "rgba(0,0,0,0.62)",
  chipBg: "#2B2B2E",

  text: "#ECEAE6",
  textSecondary: "#BDB9B3",
  textMuted: "#99958F",
  textOnAccent: "#F0E7E1",
  accentText: "#172129",
  dangerText: "#2A1212",

  accent: "#9AB7C6",
  accentMuted: "rgba(154,183,198,0.16)",
  danger: "#F09292",
  dangerMuted: "rgba(240,146,146,0.14)",

  border: "#333336",

  inputBg: "#242426",
  btnBg: "#2B2B2E",
  btnDisabled: "#515155",
  placeholder: "#918C85",

  bubbleUser: "#674849",
  bubbleAi: "#272522",

  debugBg: "#000000",
  debugText: "#D4D4D4",
};
