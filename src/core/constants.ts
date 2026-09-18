/**
 * 全局常量（代码洞察报告 3.1：魔法数字收敛）。
 * 语义各自的数值独立命名——禁止为了"复用数字"而共用常量。
 */

/** IndexedDB bulkPut/bulkGet 分块大小（db / sync / worker 共用同一批量语义） */
export const DB_BULK_CHUNK = 500

/** AI 建议流水线每页处理的条目数 */
export const AI_SUGGEST_PAGE_SIZE = 10

/** UI 轮询后台任务状态的间隔（AI 整理 / 同步） */
export const UI_POLL_MS = 2000

/** 面板 invalidate 合并防抖 */
export const INVALIDATE_DEBOUNCE_MS = 500

/** AI 请求心跳间隔（请求等待期间重置 SW idle 计时器） */
export const KEEPALIVE_MS = 20_000

/** 后台任务僵尸判定阈值：running 但 lastBeatAt 超过该值视为被 SW 回收 */
export const ZOMBIE_AFTER_MS = 180_000

/** worker 搜索快照持久化防抖 */
export const SNAPSHOT_DEBOUNCE_MS = 4000

/** 动态事件保留窗口与修剪节流 */
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const ACTIVITY_TRIM_INTERVAL_MS = 60_000

/** GitHub 同步默认周期（小时） */
export const DEFAULT_SYNC_HOURS = 6

/** 书签全量遍历节流 */
export const BM_WALK_THROTTLE_MS = 10 * 60 * 1000

/** 真机冒烟中 browser.close() 的强制继续时限 */
export const BROWSER_CLOSE_GUARD_MS = 5000
