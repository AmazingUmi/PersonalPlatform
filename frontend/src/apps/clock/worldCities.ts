/**
 * Curated world-clock presets: city and IANA timezone are bound pairs, so a
 * world clock entry can never carry a city/timezone combination that does
 * not exist. The stored {city, timezone} shape is unchanged — presets only
 * constrain what the add form can produce.
 */
export interface WorldCityPreset {
  city: string;
  timezone: string;
}

export const WORLD_CITY_PRESETS: readonly WorldCityPreset[] = [
  { city: "Tokyo", timezone: "Asia/Tokyo" },
  { city: "Shanghai", timezone: "Asia/Shanghai" },
  { city: "Hong Kong", timezone: "Asia/Hong_Kong" },
  { city: "Seoul", timezone: "Asia/Seoul" },
  { city: "Singapore", timezone: "Asia/Singapore" },
  { city: "Bangkok", timezone: "Asia/Bangkok" },
  { city: "Kolkata", timezone: "Asia/Kolkata" },
  { city: "Dubai", timezone: "Asia/Dubai" },
  { city: "Moscow", timezone: "Europe/Moscow" },
  { city: "Berlin", timezone: "Europe/Berlin" },
  { city: "Paris", timezone: "Europe/Paris" },
  { city: "London", timezone: "Europe/London" },
  { city: "UTC", timezone: "Etc/UTC" },
  { city: "São Paulo", timezone: "America/Sao_Paulo" },
  { city: "New York", timezone: "America/New_York" },
  { city: "Chicago", timezone: "America/Chicago" },
  { city: "Denver", timezone: "America/Denver" },
  { city: "Los Angeles", timezone: "America/Los_Angeles" },
  { city: "Mexico City", timezone: "America/Mexico_City" },
  { city: "Honolulu", timezone: "Pacific/Honolulu" },
  { city: "Sydney", timezone: "Australia/Sydney" },
  { city: "Auckland", timezone: "Pacific/Auckland" },
];

/** Unique select value for a preset (timezones are unique across the list). */
export function worldCityValue(preset: WorldCityPreset): string {
  return preset.timezone;
}

export function findWorldCityPreset(value: string): WorldCityPreset | undefined {
  return WORLD_CITY_PRESETS.find((preset) => worldCityValue(preset) === value);
}

const CITY_LABELS_ZH: Record<string, string> = {
  "Tokyo": "东京",
  "Shanghai": "上海",
  "Hong Kong": "香港",
  "Seoul": "首尔",
  "Singapore": "新加坡",
  "Bangkok": "曼谷",
  "Kolkata": "加尔各答",
  "Dubai": "迪拜",
  "Moscow": "莫斯科",
  "Berlin": "柏林",
  "Paris": "巴黎",
  "London": "伦敦",
  "UTC": "UTC",
  "São Paulo": "圣保罗",
  "New York": "纽约",
  "Chicago": "芝加哥",
  "Denver": "丹佛",
  "Los Angeles": "洛杉矶",
  "Mexico City": "墨西哥城",
  "Honolulu": "檀香山",
  "Sydney": "悉尼",
  "Auckland": "奥克兰",
};

/** Only curated city/timezone pairs have translated labels; preserve custom names. */
export function worldCityLabel(entry: WorldCityPreset, language = "en"): string {
  const preset = WORLD_CITY_PRESETS.find((preset) => preset.city === entry.city && preset.timezone === entry.timezone);
  return language === "zh" && preset ? CITY_LABELS_ZH[preset.city] ?? entry.city : entry.city;
}
