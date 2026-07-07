export function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, thunk: () => Promise<T>): Promise<T> {
	const existing = inflight.get(key);
	if (existing) return existing;
	const p = thunk();
	inflight.set(key, p);

	p.finally(() => {
		if (inflight.get(key) === p) inflight.delete(key);
	}).catch(() => {});
	return p;
}
