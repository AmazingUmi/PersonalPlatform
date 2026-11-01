import type { Language } from "./i18n";
const names: Record<string, string> = { assets: "资产", tasks: "任务", notes: "笔记", clock: "时钟", focus: "专注", mini_game: "小游戏（2048）" };
const descriptions: Record<string, string> = {
  assets: "管理个人资产、分类与附件。", tasks: "管理任务、优先级和日程。", notes: "随时记录想法，用标签整理笔记。",
  clock: "查看时间、世界时钟、闹钟与任务安排。", focus: "使用番茄钟专注工作，查看记录与统计。", mini_game: "滑动合并数字，游玩并保存 2048 进度。",
};
export const appName = (id: string, fallback: string, language: Language) => language === "zh" ? names[id] ?? fallback : fallback;
export const appDescription = (id: string, fallback: string, language: Language) => language === "zh" ? descriptions[id] ?? fallback : fallback;
export function widgetTitle(appId: string, id: string, fallback: string, language: Language): string {
  const titles: Record<string, string> = { "assets:summary": "资产概况", "tasks:today": "今日任务", "notes:quick_note": "快速笔记", "notes:quick-note": "快速笔记", "clock:clock": "时钟", "focus:timer": "专注计时", "mini_game:highscore": "2048 最高分" };
  return language === "zh" ? titles[`${appId}:${id}`] ?? fallback : fallback;
}
