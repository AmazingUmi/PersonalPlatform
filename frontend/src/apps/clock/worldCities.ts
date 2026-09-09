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
