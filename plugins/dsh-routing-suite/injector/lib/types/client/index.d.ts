/**
 * dsh-super-injector 插件管理 UI（settings.section 页面）。
 * 功能：已注入插件列表 + 一键卸载 + 添加（路径输入/拖放提示）——
 *   - 直接注入：目录已是插件包（package.json + lib/）→ 立即注入
 *   - 内化：任意文件夹 → 新建 agent 会话 → AI 把内容变成插件
 * 通信：同源 fetch → host webServer API（/super-injector/api）
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots';
type ClientContext = {
    slots: SlotsService;
};
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export {};
