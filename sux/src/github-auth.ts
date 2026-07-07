function isGithubHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return h === "github.com" || h === "api.github.com" || h === "githubusercontent.com" || h.endsWith(".githubusercontent.com");
}

export function githubAuthHeaders(env: { GITHUB_TOKEN?: string }, url: string): Record<string, string> {
	if (!env.GITHUB_TOKEN) return {};
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return {};
	}
	if (!isGithubHost(hostname)) return {};
	return { Authorization: `Bearer ${env.GITHUB_TOKEN}` };
}
