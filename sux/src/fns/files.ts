import { type Fn } from "../registry";
import { FILES_TOOLS } from "../files-mcp";
import { type Dispatch, namespaceFn } from "./_namespace";

// Excludes the `dropbox` escape — already a universal leaf reachable via `fn`.
// files_operate carries its own action arg, so move/delete flatten into distinct
// verb actions that re-inject the inner one.
export const FILES_ACTIONS: Record<string, Dispatch> = {
	list: "files_list",
	search: "files_search",
	read: "files_read",
	write: "files_write",
	upload: "files_upload",
	batch_put: "files_batch_put",
	share: "files_share",
	move: "files_move",
	delete: "files_delete",
	operate_move: { tool: "files_operate", inject: { action: "move" } },
	operate_delete: { tool: "files_operate", inject: { action: "delete" } },
	transform: "files_transform",
	semantic: "files_semantic",
};

export const files: Fn = namespaceFn({
	name: "files",
	description:
		"Dropbox files through the one /mcp connector. {action, ...args}: list·search·read·write·upload·batch_put·share·move·delete(confirm:true, or full:true for Mode B)·operate_move·operate_delete·transform·semantic. Each action's remaining args are that files_* tool's own — e.g. files({action:'read', path:'/x.txt'}), files({action:'delete', path, confirm:true}). Mode-B (whole-Dropbox) writes stage a preview by default.",
	tools: () => FILES_TOOLS,
	actions: FILES_ACTIONS,
});
