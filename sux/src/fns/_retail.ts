export type RetailProduct = {
	id: string;
	title: string;
	brand?: string;
	price?: number;
	promo_price?: number;
	currency: string;
	fulfillment?: string[];
	size?: string;
	image?: string;
	url?: string;
	in_stock?: boolean;
	condition?: string;
};

export type RetailResult = {
	retailer: string;
	action: string;
	count: number;
	products: RetailProduct[];
};

export function normalizeMoney(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
