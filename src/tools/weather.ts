import type { Tool } from '../types.ts';

// Mock 天气数据。每座城市结果确定，方便测试断言。
// 数据是编的（这就是"mock 天气"），关键是覆盖到常见 demo 城市，
// 避免 agent 一撞到未收录城市就得走 search / reflector 绕路。
const TABLE: Record<string, { c: string; tempC: [number, number]; humidity: number }> = {
  // 华北
  beijing:   { c: 'Sunny with clouds', tempC: [24, 33], humidity: 55 },
  '北京':     { c: 'Sunny with clouds', tempC: [24, 33], humidity: 55 },
  tianjin:   { c: 'Sunny with clouds', tempC: [23, 31], humidity: 60 },
  '天津':     { c: 'Sunny with clouds', tempC: [23, 31], humidity: 60 },
  // 华东
  shanghai:  { c: 'Rain showers',      tempC: [26, 32], humidity: 78 },
  '上海':     { c: 'Rain showers',      tempC: [26, 32], humidity: 78 },
  hangzhou:  { c: 'Partly cloudy',     tempC: [25, 32], humidity: 70 },
  '杭州':     { c: 'Partly cloudy',     tempC: [25, 32], humidity: 70 },
  nanjing:   { c: 'Partly cloudy',     tempC: [26, 34], humidity: 72 },
  '南京':     { c: 'Partly cloudy',     tempC: [26, 34], humidity: 72 },
  suzhou:    { c: 'Rain showers',      tempC: [25, 31], humidity: 75 },
  '苏州':     { c: 'Rain showers',      tempC: [25, 31], humidity: 75 },
  // 华南
  shenzhen:  { c: 'Thunderstorms',     tempC: [27, 33], humidity: 82 },
  '深圳':     { c: 'Thunderstorms',     tempC: [27, 33], humidity: 82 },
  guangzhou: { c: 'Thunderstorms',     tempC: [27, 34], humidity: 85 },
  '广州':     { c: 'Thunderstorms',     tempC: [27, 34], humidity: 85 },
  xiamen:    { c: 'Partly cloudy',     tempC: [26, 31], humidity: 78 },
  '厦门':     { c: 'Partly cloudy',     tempC: [26, 31], humidity: 78 },
  // 华中
  wuhan:     { c: 'Hot and humid',     tempC: [27, 35], humidity: 76 },
  '武汉':     { c: 'Hot and humid',     tempC: [27, 35], humidity: 76 },
  changsha:  { c: 'Thunderstorms',     tempC: [26, 34], humidity: 80 },
  '长沙':     { c: 'Thunderstorms',     tempC: [26, 34], humidity: 80 },
  // 西南
  chengdu:   { c: 'Overcast',          tempC: [22, 28], humidity: 82 },
  '成都':     { c: 'Overcast',          tempC: [22, 28], humidity: 82 },
  chongqing: { c: 'Hot and humid',     tempC: [26, 36], humidity: 74 },
  '重庆':     { c: 'Hot and humid',     tempC: [26, 36], humidity: 74 },
  kunming:   { c: 'Partly cloudy',     tempC: [17, 24], humidity: 68 },
  '昆明':     { c: 'Partly cloudy',     tempC: [17, 24], humidity: 68 },
  // 西北
  xian:      { c: 'Sunny',             tempC: [22, 33], humidity: 45 },
  '西安':     { c: 'Sunny',             tempC: [22, 33], humidity: 45 },
  lanzhou:   { c: 'Sunny',             tempC: [18, 28], humidity: 40 },
  '兰州':     { c: 'Sunny',             tempC: [18, 28], humidity: 40 },
  // 东北
  shenyang:  { c: 'Partly cloudy',     tempC: [20, 28], humidity: 65 },
  '沈阳':     { c: 'Partly cloudy',     tempC: [20, 28], humidity: 65 },
  harbin:    { c: 'Partly cloudy',     tempC: [17, 26], humidity: 68 },
  '哈尔滨':   { c: 'Partly cloudy',     tempC: [17, 26], humidity: 68 },
  // 港澳台
  hongkong:  { c: 'Rain showers',      tempC: [27, 32], humidity: 84 },
  '香港':     { c: 'Rain showers',      tempC: [27, 32], humidity: 84 },
  taipei:    { c: 'Thunderstorms',     tempC: [27, 33], humidity: 82 },
  '台北':     { c: 'Thunderstorms',     tempC: [27, 33], humidity: 82 },
  // 常见海外
  tokyo:     { c: 'Partly cloudy',     tempC: [23, 30], humidity: 72 },
  '东京':     { c: 'Partly cloudy',     tempC: [23, 30], humidity: 72 },
  seoul:     { c: 'Partly cloudy',     tempC: [22, 29], humidity: 70 },
  '首尔':     { c: 'Partly cloudy',     tempC: [22, 29], humidity: 70 },
  singapore: { c: 'Thunderstorms',     tempC: [26, 31], humidity: 84 },
  '新加坡':   { c: 'Thunderstorms',     tempC: [26, 31], humidity: 84 },
};

export const weatherTool: Tool = {
  name: 'weather',
  description:
    '查询某城市的（mock）当前天气；支持中英文城市名；返回天气状况、温度区间与湿度。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名，例如 "Beijing" 或 "北京"。' },
      unit: { type: 'string', enum: ['c', 'f'], description: '温度单位，默认 "c"。' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  handler(args) {
    const cityRaw = String(args.city).trim();
    const key = cityRaw.toLowerCase();
    const row = TABLE[key];
    if (!row) {
      return {
        city: cityRaw,
        available: false,
        message: `没有 "${cityRaw}" 的 mock 数据。已知城市: ${Object.keys(TABLE)
          .filter((k) => /^[a-z]+$/.test(k))
          .join(', ')}`,
      };
    }
    const unit = (args.unit as string | undefined) ?? 'c';
    const [lo, hi] = row.tempC;
    const temp = unit === 'f'
      ? { unit: 'F', low: Math.round(lo * 9 / 5 + 32), high: Math.round(hi * 9 / 5 + 32) }
      : { unit: 'C', low: lo, high: hi };
    return {
      city: cityRaw,
      available: true,
      condition: row.c,
      temperature: temp,
      humidity_pct: row.humidity,
    };
  },
};
