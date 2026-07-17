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
  bg: "#F7F7F5",
  sectionBg: "#FFFFFF",
  editorBg: "#FFFFFF",
  overlayBg: "rgba(0,0,0,0.4)",

  text: "#37352F",
  textSecondary: "#555450",
  textMuted: "#9B9A97",
  textOnAccent: "#FFFFFF",

  accent: "#2F81F7",
  accentMuted: "rgba(47,129,247,0.1)",
  danger: "#E03E3E",
  dangerMuted: "rgba(224,62,62,0.1)",

  border: "#E8E7E4",

  inputBg: "#F7F7F5",
  btnBg: "#F0F0EE",
  btnDisabled: "#D3D1CB",
  placeholder: "#B0AFAF",

  bubbleUser: "#2F81F7",
  bubbleAi: "#F7F7F5",

  debugBg: "#1E1E1E",
  debugText: "#D4D4D4",
};

export const darkColors: ColorPalette = {
  bg: "#1A1A1A",
  sectionBg: "#2C2C2C",
  editorBg: "#242424",
  overlayBg: "rgba(0,0,0,0.6)",

  text: "#E8E7E4",
  textSecondary: "#B0AFAF",
  textMuted: "#7A7A76",
  textOnAccent: "#FFFFFF",

  accent: "#4D9FFF",
  accentMuted: "rgba(77,159,255,0.15)",
  danger: "#FF6B6B",
  dangerMuted: "rgba(255,107,107,0.15)",

  border: "#3A3A3A",

  inputBg: "#2C2C2C",
  btnBg: "#3A3A3A",
  btnDisabled: "#555555",
  placeholder: "#666666",

  bubbleUser: "#3A7BD5",
  bubbleAi: "#2C2C2C",

  debugBg: "#0D0D0D",
  debugText: "#D4D4D4",
};
