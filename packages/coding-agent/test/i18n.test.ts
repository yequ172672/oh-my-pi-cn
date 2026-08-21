import { afterEach, describe, expect, it } from "bun:test";
import {
	getLanguage,
	initializeLanguage,
	localizeUiText,
	normalizeLanguage,
	onLanguageChanged,
	setLanguage,
	t,
} from "../src/i18n";
import { getSettingsForTab } from "../src/modes/components/settings-defs";

describe("i18n", () => {
	afterEach(() => {
		setLanguage("en");
	});

	it("normalizes supported language names and rejects unknown values", () => {
		expect(normalizeLanguage("en")).toBe("en");
		expect(normalizeLanguage("English")).toBe("en");
		expect(normalizeLanguage("英文")).toBe("en");
		expect(normalizeLanguage("zh")).toBe("zh-CN");
		expect(normalizeLanguage("ZH-HANS")).toBe("zh-CN");
		expect(normalizeLanguage("中文")).toBe("zh-CN");
		expect(normalizeLanguage("fr")).toBeUndefined();
		expect(normalizeLanguage(undefined)).toBeUndefined();
	});

	it("initializes, changes, and reports the active language", () => {
		initializeLanguage("chinese");
		expect(getLanguage()).toBe("zh-CN");
		expect(setLanguage("english")).toBe("en");
		expect(getLanguage()).toBe("en");
	});

	it("falls back to English and preserves unknown keys", () => {
		setLanguage("zh-CN");
		expect(t("common.error")).toBe("错误");
		expect(t("common.englishFallback")).toBe("English-only fallback");
		expect(t("i18n.unknown.key")).toBe("i18n.unknown.key");
	});

	it("interpolates values without changing missing placeholders", () => {
		setLanguage("zh-CN");
		expect(t("status.running", { count: 3 })).toBe("运行中：3");
		expect(t("common.failedWithReason", { reason: "timeout" })).toBe("失败：timeout");
		expect(t("common.usageLine", { other: "value" })).toBe("用法：{{usage}}");
	});

	it("notifies listeners on actual language changes and supports unsubscribe", () => {
		const changes: string[] = [];
		const unsubscribe = onLanguageChanged(language => changes.push(language));
		setLanguage("zh-CN");
		setLanguage("zh-CN");
		unsubscribe();
		setLanguage("en");
		expect(changes).toEqual(["zh-CN"]);
	});

	it("localizes only exact known UI text in Chinese", () => {
		setLanguage("zh-CN");
		expect(localizeUiText("Error:")).toBe("错误：");
		expect(localizeUiText("Open settings menu")).toBe("打开设置菜单");
		expect(localizeUiText("Error: user supplied text")).toBe("Error: user supplied text");
		expect(localizeUiText("user supplied text")).toBe("user supplied text");
	});

	it("keeps UI text unchanged in English", () => {
		setLanguage("en");
		expect(localizeUiText("Error:")).toBe("Error:");
		expect(localizeUiText("Open settings menu")).toBe("Open settings menu");
	});

	it("localizes process monitoring, maintenance, selectors, and launch completion for Chinese users", () => {
		setLanguage("zh-CN");
		expect(t("ps.noScopes")).toBe("未找到守护进程代理作用域。");
		expect(t("ps.tui.summary", { processes: "2 个进程", scopes: "1 个作用域", scopeMode: "（当前）" })).toBe(
			"2 个进程，分布于1 个作用域 （当前）",
		);
		expect(t("compaction.remoteFailed")).toBe("服务器自动压缩失败；将跳过维护并继续");
		expect(t("selector.messagePosition", { position: 2, total: 5 })).toBe("第 2 条，共 5 条");
		expect(t("transcript.supervisedCompleted")).toBe("受监管进程已完成");
		expect(
			localizeUiText(
				"Lint/type errors piling up? `omp cleanse` (or /cleanse right here) hunts project diagnostics and fixes them with parallel subagents — esc cancels",
			),
		).toContain("并行子代理修复");
	});

	it("localizes settings metadata for the model tab", () => {
		setLanguage("zh-CN");
		const modelSettings = getSettingsForTab("model");
		const thinking = modelSettings.find(setting => setting.path === "defaultThinkingLevel");
		const sampling = modelSettings.find(setting => setting.path === "temperature");

		expect(thinking?.group).toBe("Thinking");
		expect(thinking?.label).toBe("思考级别");
		expect(thinking?.description).toBe("支持思考的模型的推理深度");
		const thinkingOptions = thinking?.type === "submenu" ? thinking.options : undefined;
		expect(thinkingOptions?.[0]?.label).toBe("自动");
		expect(sampling?.label).toBe("温度");
		expect(sampling?.description).toBe("采样温度（0 = 确定性，1 = 创造性，-1 = 提供商默认）");
	});

	it("localizes representative metadata across every settings tab", () => {
		setLanguage("zh-CN");
		const expected = [
			["appearance", "language", "语言"],
			["model", "model.toolCallLoopGuard.enabled", "工具调用循环保护"],
			["interaction", "ask.timeout", "提问超时"],
			["context", "compaction.methodOrder", "压缩方法顺序"],
			["memory", "memory.backend", "记忆后端"],
			["files", "read.summarize.enabled", "读取摘要"],
			["shell", "shellMinimizer.enabled", "Shell 输出精简"],
			["tools", "todo.enabled", "待办事项"],
			["tasks", "goal.enabled", "目标模式"],
			["providers", "providers.webSearchOrder", "网页搜索提供商顺序"],
		] as const;

		for (const [tab, path, label] of expected) {
			const setting = getSettingsForTab(tab as Parameters<typeof getSettingsForTab>[0]).find(
				candidate => candidate.path === path,
			);
			expect(setting?.label, `${tab}:${path}`).toBe(label);
			expect(setting?.description, `${tab}:${path}`).not.toMatch(/^[A-Za-z][A-Za-z\s-]*$/);
		}
	});

	it("localizes the 17.4 settings metadata and ordered compaction choices", () => {
		setLanguage("zh-CN");
		const expected = [
			["providers", "providers.openai-codex.codeMode", "Codex 代码模式"],
			["appearance", "composer.shape", "输入框样式"],
			["appearance", "statusLine.contextLine", "上下文响应线"],
			["model", "externalThinking", "外部思考"],
			["context", "extendedContext", "扩展上下文"],
			["context", "compaction.methodOrder", "压缩方法顺序"],
			["context", "compaction.asyncEnabled", "异步压缩"],
			["shell", "eval.autoBackground.enabled", "Eval 自动后台运行"],
			["providers", "providers.cacheRetention", "提示词缓存保留策略"],
		] as const;

		for (const [tab, path, label] of expected) {
			const setting = getSettingsForTab(tab).find(candidate => candidate.path === path);
			expect(setting?.label, `${tab}:${path}`).toBe(label);
			expect(setting?.description, `${tab}:${path}`).not.toMatch(/^[A-Za-z]/);
		}
		expect(localizeUiText("Codex Code Mode Direct Tools")).toBe("Codex 代码模式直接工具");

		const modelSettings = getSettingsForTab("model");
		const externalThinking = modelSettings.find(setting => setting.path === "externalThinking");
		expect(externalThinking?.warning).toBe("风险自负：提供商已将此类请求判定为滥用，最严重可能触发账号级处置");

		const contextSettings = getSettingsForTab("context");
		const methodOrder = contextSettings.find(setting => setting.path === "compaction.methodOrder");
		const methodOptions = methodOrder?.type === "multiselect" ? methodOrder.options : undefined;
		expect(methodOptions?.map(option => option.label)).toEqual([
			"OpenAI 服务器压缩",
			"Snapcompact",
			"交接",
			"软压缩",
			"抖动压缩",
		]);

		const appearanceSettings = getSettingsForTab("appearance");
		const contextLine = appearanceSettings.find(setting => setting.path === "statusLine.contextLine");
		const contextLineOptions = contextLine?.type === "submenu" ? contextLine.options : undefined;
		expect(contextLineOptions?.map(option => option.label)).toEqual(["关", "百分比", "带标记", "嵌入式"]);
	});
});
