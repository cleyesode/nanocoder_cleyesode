import path from 'node:path';
import {formatToolsForPrompt} from '@/ai-sdk-client/tools/tool-prompt-formatter';
import {getAppConfig} from '@/config/index';
import {loadPreferences, savePreferences} from '@/config/preferences';
import {runPlainConversation} from '@/plain/conversation';
import {initializePlain} from '@/plain/initialize';
import {
	color,
	writeBoot,
	writeError,
	writeLine,
	writeStatus,
} from '@/plain/writer';
import type {DevelopmentMode, Message} from '@/types/core';
import {buildSystemPrompt, setLastBuiltPrompt} from '@/utils/prompt-builder';
import {getShutdownManager} from '@/utils/shutdown';

export interface RunPlainShellOptions {
	prompt: string;
	developmentMode: DevelopmentMode;
	cliProvider?: string;
	cliModel?: string;
	trustDirectory: boolean;
}

/**
 * Headless equivalent of `nanocoder run "..."`. Skips Ink entirely:
 * the LLM, tool, MCP, and subagent stacks all initialize without React,
 * and the conversation loop streams to stdout via plain process.stdout.
 *
 * Exit codes:
 *   0  conversation completed naturally
 *   1  initialization or generation error
 *   2  tool approval was required (matches the Ink `run` behavior in
 *      `useNonInteractiveMode`)
 */
export async function runPlainShell(
	options: RunPlainShellOptions,
): Promise<void> {
	const {prompt, developmentMode, cliProvider, cliModel, trustDirectory} =
		options;

	if (!ensureDirectoryTrust(trustDirectory)) {
		await shutdown(1);
		return;
	}

	let init;
	try {
		init = await initializePlain({cliProvider, cliModel});
	} catch (error) {
		writeError(error instanceof Error ? error.message : String(error));
		await shutdown(1);
		return;
	}

	const {client, toolManager, provider, model} = init;
	writeBoot(provider, model, developmentMode);

	const toolsDisabled = isToolCallingDisabled(provider, model);
	const availableNames = toolManager.getAvailableToolNames(
		undefined,
		developmentMode,
	);
	let systemContent = buildSystemPrompt(
		developmentMode,
		undefined,
		availableNames,
		toolsDisabled,
	);
	if (toolsDisabled) {
		const toolsForPrompt =
			toolManager.getFilteredToolsWithoutExecute(availableNames);
		const toolPrompt = formatToolsForPrompt(toolsForPrompt);
		if (toolPrompt) {
			systemContent += toolPrompt;
		}
	}
	setLastBuiltPrompt(systemContent);

	const systemMessage: Message = {role: 'system', content: systemContent};
	const initialMessages: Message[] = [{role: 'user', content: prompt}];

	const abortController = new AbortController();
	const sigint = () => abortController.abort();
	process.on('SIGINT', sigint);

	const nonInteractiveAlwaysAllow = getAppConfig().alwaysAllow ?? [];

	writeLine();
	const outcome = await runPlainConversation({
		client,
		toolManager,
		systemMessage,
		initialMessages,
		developmentMode,
		nonInteractiveAlwaysAllow,
		abortSignal: abortController.signal,
	});
	process.off('SIGINT', sigint);

	switch (outcome.kind) {
		case 'success':
			await shutdown(0);
			return;
		case 'tool-approval-required':
			writeError(
				`Tool approval required for: ${outcome.toolNames.join(', ')}. ` +
					`Re-run with --mode auto-accept or --mode yolo, or add the tools to ` +
					`agents.config.json "alwaysAllow".`,
			);
			await shutdown(2);
			return;
		case 'error':
			writeError(outcome.message);
			await shutdown(1);
			return;
	}
}

function isToolCallingDisabled(provider: string, model: string): boolean {
	const config = getAppConfig();
	const providerConfig = config.providers?.find(p => p.name === provider);
	if (!providerConfig) return false;
	return providerConfig.disableToolModels?.includes(model) ?? false;
}

function ensureDirectoryTrust(trustDirectoryFlag: boolean): boolean {
	if (trustDirectoryFlag) return true;
	const cwd = path.resolve(process.cwd());
	const preferences = loadPreferences();
	const trusted = (preferences.trustedDirectories ?? []).some(
		dir => path.resolve(dir) === cwd,
	);
	if (trusted) return true;

	if (process.env.NANOCODER_TRUST_DIRECTORY === '1') {
		const updated = preferences.trustedDirectories ?? [];
		updated.push(cwd);
		savePreferences({...preferences, trustedDirectories: updated});
		writeStatus(`Marked ${cwd} as trusted (NANOCODER_TRUST_DIRECTORY=1).`);
		return true;
	}

	writeError(
		`Directory ${cwd} is not trusted. Pass --trust-directory or set ` +
			`NANOCODER_TRUST_DIRECTORY=1 to bypass the disclaimer for this run.`,
	);
	return false;
}

async function shutdown(code: number): Promise<void> {
	if (code === 0) {
		writeLine();
		writeStatus(color('green', 'done'));
	}
	await getShutdownManager().gracefulShutdown(code);
}
