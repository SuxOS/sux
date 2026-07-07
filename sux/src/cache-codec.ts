import zlib from "node:zlib";

const Z = zlib as any;
const hasZstd = typeof Z.zstdCompressSync === "function";

const MAGIC = [0x73, 0x78, 0x7a, 0x31];
const TAG_ZSTD = 0x7a;
const TAG_BROTLI = 0x62;
const TAG_GZIP = 0x67;

const MIN_COMPRESS = 512;

function compressBytes(input: Uint8Array): { tag: number; out: Uint8Array } {
	if (hasZstd) return { tag: TAG_ZSTD, out: Z.zstdCompressSync(input, { params: { [Z.constants.ZSTD_c_compressionLevel]: 10 } }) };
	return { tag: TAG_BROTLI, out: Z.brotliCompressSync(input, { params: { [Z.constants.BROTLI_PARAM_QUALITY]: 6 } }) };
}

function decompressByTag(tag: number, payload: Uint8Array): Uint8Array {
	if (tag === TAG_ZSTD) return Z.zstdDecompressSync(payload);
	if (tag === TAG_BROTLI) return Z.brotliDecompressSync(payload);
	if (tag === TAG_GZIP) return Z.gunzipSync(payload);
	throw new Error(`unknown cache codec tag ${tag}`);
}

export function packForCache(json: string): Uint8Array | string {
	const input = new TextEncoder().encode(json);
	if (input.length < MIN_COMPRESS) return json;
	try {
		const { tag, out } = compressBytes(input);
		if (out.length + MAGIC.length + 1 >= input.length) return json;
		const framed = new Uint8Array(MAGIC.length + 1 + out.length);
		framed.set(MAGIC, 0);
		framed[MAGIC.length] = tag;
		framed.set(out, MAGIC.length + 1);
		return framed;
	} catch {
		return json;
	}
}

export function unpackFromCache(raw: ArrayBuffer | ArrayBufferView | string): string {
	if (typeof raw === "string") return raw;
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw instanceof ArrayBuffer ? raw : (raw as ArrayBufferView).buffer);
	if (bytes.length >= MAGIC.length + 1 && MAGIC.every((b, i) => bytes[i] === b)) {
		return new TextDecoder().decode(decompressByTag(bytes[MAGIC.length], bytes.subarray(MAGIC.length + 1)));
	}
	return new TextDecoder().decode(bytes);
}
