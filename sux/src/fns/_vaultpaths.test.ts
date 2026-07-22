import { describe, expect, it } from "vitest";
import { vaultDailyDir, vaultInboxDir } from "./_vaultpaths";

describe("vaultDailyDir/vaultInboxDir", () => {
	it("default to the current folder names when unset", () => {
		expect(vaultDailyDir({} as any)).toBe("06-daily");
		expect(vaultInboxDir({} as any)).toBe("00-inbox");
	});

	it("honor an env override", () => {
		expect(vaultDailyDir({ VAULT_DAILY_DIR: "Daily" } as any)).toBe("Daily");
		expect(vaultInboxDir({ VAULT_INBOX_DIR: "Inbox" } as any)).toBe("Inbox");
	});

	it("falls back to the default on a blank/whitespace override", () => {
		expect(vaultDailyDir({ VAULT_DAILY_DIR: "  " } as any)).toBe("06-daily");
		expect(vaultInboxDir({ VAULT_INBOX_DIR: "" } as any)).toBe("00-inbox");
	});
});
