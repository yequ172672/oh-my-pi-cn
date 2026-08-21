/**
 * Inspect and control daemon-broker supervised processes from outside the harness.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { psHelp as commandHelp } from "../cli/command-help";
import { type PsAction, type PsCommandArgs, runPsCommand } from "../cli/ps-cli";
import { t } from "../i18n";

const ACTIONS: PsAction[] = ["list", "info", "logs", "stop", "kill", "restart"];

export default class Ps extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: t("ps.action.description"),
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: t("ps.name.description"),
			required: false,
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: t("ps.all.description") }),
		json: Flags.boolean({ char: "j", description: t("ps.json.description") }),
		plain: Flags.boolean({ description: t("ps.plain.description") }),
		dir: Flags.string({ description: t("ps.dir.description") }),
		global: Flags.string({ description: t("ps.global.description") }),
		follow: Flags.boolean({ char: "f", description: t("ps.follow.description") }),
		head: Flags.boolean({ description: t("ps.head.description") }),
		lines: Flags.integer({ char: "n", description: t("ps.lines.description") }),
		grep: Flags.string({ description: t("ps.grep.description") }),
		timeout: Flags.integer({ description: t("ps.timeout.description") }),
	};

	static examples = [
		"omp ps",
		"omp ps --all",
		"omp ps logs web --follow",
		"omp ps stop web",
		"omp ps kill web",
		"omp ps info relay --global browser-relay",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ps);
		const cmd: PsCommandArgs = {
			action: (args.action ?? "list") as PsAction,
			name: args.name,
			flags: {
				all: flags.all ?? false,
				json: flags.json ?? false,
				plain: flags.plain ?? false,
				dir: flags.dir,
				global: flags.global,
				follow: flags.follow ?? false,
				head: flags.head ?? false,
				lines: flags.lines,
				grep: flags.grep,
				timeout: flags.timeout,
			},
		};
		await runPsCommand(cmd);
	}
}
