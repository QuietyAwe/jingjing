// 场景配置：颜色 + 文案池
// Phase 2 使用渐变色占位，Phase 7 替换为视频素材

export type TimeOfDay = '清晨' | '午后' | '傍晚' | '深夜';
export type WeatherText = '晴' | '雨' | '雪' | '雾';

export interface SceneConfig {
  // 渐变色占位（后续替换为视频）
  gradient: [string, string];
  // 状态文案池
  statusTexts: string[];
  // 底噪文件名（后续替换为实际音频文件）
  ambientSound: string;
}

// 场景配置表
export const SCENES: Record<string, SceneConfig> = {
  '深夜_雨': {
    gradient: ['#0a0a1a', '#1a1a3a'],
    statusTexts: [
      '静静正在听雨...',
      '静静趴在窗台上看雨滴赛跑...',
      '远处有雷声...静静缩了缩脖子...',
      '静静在数玻璃上的雨痕...',
    ],
    ambientSound: 'rain_night',
  },
  '深夜_晴': {
    gradient: ['#0a0a1a', '#0f1a2a'],
    statusTexts: [
      '静静在数远处的路灯...',
      '静静在空无一人的天桥上吹风...',
      '静静趴在窗台上睡着了...',
      '静静在看月亮...',
    ],
    ambientSound: 'quiet_night',
  },
  '深夜_雪': {
    gradient: ['#0a0a1a', '#1a1a2a'],
    statusTexts: [
      '静静在看雪花落在窗台上...',
      '静静把手贴在玻璃上...好冷...',
      '外面白茫茫的...静静好想出去踩雪...',
    ],
    ambientSound: 'snow_night',
  },
  '深夜_雾': {
    gradient: ['#0a0a1a', '#1a1a2a'],
    statusTexts: [
      '外面什么都看不清了...',
      '静静贴着玻璃...想看穿雾气...',
      '雾好大...静静有点害怕...',
    ],
    ambientSound: 'fog_night',
  },
  '清晨_雨': {
    gradient: ['#1a2a3a', '#2a3a4a'],
    statusTexts: [
      '静静在窗边看雨...天亮了...',
      '雨声好好听...静静不想起床...',
      '静静在被窝里听雨...',
    ],
    ambientSound: 'rain_morning',
  },
  '清晨_晴': {
    gradient: ['#2a3a5a', '#4a5a7a'],
    statusTexts: [
      '静静在阳台上伸懒腰...',
      '静静在给窗台上的盆栽浇水...',
      '早安...静静刚睡醒...',
    ],
    ambientSound: 'birds_morning',
  },
  '清晨_雪': {
    gradient: ['#2a3a4a', '#4a5a6a'],
    statusTexts: [
      '哇...外面全白了...',
      '静静在窗上画笑脸...',
    ],
    ambientSound: 'snow_morning',
  },
  '清晨_雾': {
    gradient: ['#2a3a4a', '#3a4a5a'],
    statusTexts: [
      '雾还没散...静静看不清外面...',
      '静静在等雾散去...',
    ],
    ambientSound: 'fog_morning',
  },
  '午后_雨': {
    gradient: ['#2a3a4a', '#3a4a5a'],
    statusTexts: [
      '午后下雨了...静静在便利店避雨...',
      '静静在便利店挑草莓牛奶...',
    ],
    ambientSound: 'rain_afternoon',
  },
  '午后_晴': {
    gradient: ['#4a5a7a', '#6a7a9a'],
    statusTexts: [
      '午后的阳光好暖...静静在晒太阳...',
      '静静在空荡的街上散步...',
    ],
    ambientSound: 'quiet_afternoon',
  },
  '午后_雪': {
    gradient: ['#3a4a5a', '#5a6a7a'],
    statusTexts: [
      '雪越下越大了...',
      '静静在窗边堆了一个小雪人（在窗台上）...',
    ],
    ambientSound: 'snow_afternoon',
  },
  '午后_雾': {
    gradient: ['#3a4a5a', '#4a5a6a'],
    statusTexts: [
      '午后雾还没散...静静有点困...',
      '静静在沙发上打盹...',
    ],
    ambientSound: 'fog_afternoon',
  },
  '傍晚_雨': {
    gradient: ['#1a2a3a', '#2a3a4a'],
    statusTexts: [
      '傍晚下雨了...静静在便利店避雨...',
      '静静在便利店挑草莓牛奶...',
      '路灯亮了...雨滴在灯光下好美...',
    ],
    ambientSound: 'rain_evening',
  },
  '傍晚_晴': {
    gradient: ['#3a4a6a', '#5a4a3a'],
    statusTexts: [
      '夕阳好美...静静在看晚霞...',
      '静静在天桥上看日落...',
    ],
    ambientSound: 'quiet_evening',
  },
  '傍晚_雪': {
    gradient: ['#2a3a4a', '#4a5a6a'],
    statusTexts: [
      '傍晚的雪...路灯照着好浪漫...',
      '静静在雪里走...鞋子湿了...',
    ],
    ambientSound: 'snow_evening',
  },
  '傍晚_雾': {
    gradient: ['#2a3a4a', '#3a4a5a'],
    statusTexts: [
      '傍晚的雾...路灯都看不清了...',
      '静静在雾里走...有点迷路了...',
    ],
    ambientSound: 'fog_evening',
  },
};

// 通用兜底文案
export const FALLBACK_TEXTS = [
  '静静在发呆...',
  '刚刚好像听到了什么声音...静静在竖着耳朵听...',
  '静静在窗边坐着...',
];

// 获取场景配置
export function getSceneConfig(timeOfDay: string, weatherText: string): SceneConfig {
  const key = `${timeOfDay}_${weatherText}`;
  return SCENES[key] || {
    gradient: ['#0f0f1a', '#1a1a2e'],
    statusTexts: FALLBACK_TEXTS,
    ambientSound: 'quiet_night',
  };
}
