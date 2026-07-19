// ============================================================
// 主题色板 — 浅色 / 深色
// ============================================================

export interface ColorPalette {
  // 背景
  bg: string;
  sectionBg: string;
  editorBg: string;
  overlayBg: string;

  // 文字
  text: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;

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
  bg: "#FAFAFA",
  sectionBg: "#FFFFFF",
  editorBg: "#FFFFFF",
  overlayBg: "rgba(0,0,0,0.4)",

  text: "#37352F",
  textSecondary: "#555450",
  textMuted: "#9B9A97",
  textOnAccent: "#5D524A",

  accent: "#2F81F7",
  accentMuted: "rgba(47,129,247,0.1)",
  danger: "#E03E3E",
  dangerMuted: "rgba(224,62,62,0.1)",

  border: "#EEEEEE",

  inputBg: "#F5F5F5",
  btnBg: "#F0F0F0",
  btnDisabled: "#D3D1CB",
  placeholder: "#B0AFAF",

  bubbleUser: "#FFE4E1",
  bubbleAi: "#FAF5F0",

  debugBg: "#1E1E1E",
  debugText: "#D4D4D4",
};

export const darkColors: ColorPalette = {
  bg: "#000000",
  sectionBg: "#0A0A0A",
  editorBg: "#0A0A0A",
  overlayBg: "rgba(0,0,0,0.8)",

  text: "#E8E7E4",
  textSecondary: "#B0AFAF",
  textMuted: "#6E6E6E",
  textOnAccent: "#E0D8D0",

  accent: "#4D9FFF",
  accentMuted: "rgba(77,159,255,0.15)",
  danger: "#FF6B6B",
  dangerMuted: "rgba(255,107,107,0.15)",

  border: "#1C1C1E",

  inputBg: "#0A0A0A",
  btnBg: "#1C1C1E",
  btnDisabled: "#38383A",
  placeholder: "#48484A",

  bubbleUser: "#8B4A4A",
  bubbleAi: "#1A1A2E",

  debugBg: "#000000",
  debugText: "#D4D4D4",
};
