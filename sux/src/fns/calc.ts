import { type Fn, fail, ok } from "../registry";

// Safe arithmetic evaluator. No eval / Function — a hand-rolled tokenizer feeds
// the shunting-yard algorithm into an RPN stack. Supports + - * / % ^,
// parentheses, unary minus, a handful of functions, and pi/e constants.

type Tok =
	| { t: "num"; v: number }
	| { t: "op"; v: string }
	| { t: "fn"; v: string }
	| { t: "lp" }
	| { t: "rp" }
	| { t: "comma" };

const FUNCS: Record<string, (...a: number[]) => number> = {
	sqrt: Math.sqrt,
	abs: Math.abs,
	floor: Math.floor,
	ceil: Math.ceil,
	round: Math.round,
	ln: Math.log,
	log: Math.log10,
	min: Math.min,
	max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

// precedence + associativity. "u-" is unary minus (highest, right-assoc).
const OPS: Record<string, { prec: number; right: boolean; arity: 1 | 2 }> = {
	"u-": { prec: 5, right: true, arity: 1 },
	"^": { prec: 4, right: true, arity: 2 },
	"*": { prec: 3, right: false, arity: 2 },
	"/": { prec: 3, right: false, arity: 2 },
	"%": { prec: 3, right: false, arity: 2 },
	"+": { prec: 2, right: false, arity: 2 },
	"-": { prec: 2, right: false, arity: 2 },
};

function tokenize(expr: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	// A leading/after-operator "-" is unary. Track whether the previous token
	// allows a unary here (start, after op, after "(", after comma).
	const prevAllowsUnary = () => {
		const p = toks[toks.length - 1];
		return !p || p.t === "op" || p.t === "lp" || p.t === "comma";
	};
	while (i < expr.length) {
		const c = expr[i];
		if (c === " " || c === "\t" || c === "\n") {
			i++;
			continue;
		}
		if ((c >= "0" && c <= "9") || c === ".") {
			const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(expr.slice(i));
			if (!m) throw new Error(`bad number near '${expr.slice(i, i + 8)}'`);
			toks.push({ t: "num", v: Number(m[0]) });
			i += m[0].length;
			continue;
		}
		if (/[a-zA-Z]/.test(c)) {
			const m = /^[a-zA-Z]\w*/.exec(expr.slice(i))!;
			const name = m[0].toLowerCase();
			if (name in FUNCS) toks.push({ t: "fn", v: name });
			else if (name in CONSTS) toks.push({ t: "num", v: CONSTS[name] });
			else throw new Error(`unknown name '${name}'`);
			i += m[0].length;
			continue;
		}
		if (c === "(") {
			toks.push({ t: "lp" });
			i++;
			continue;
		}
		if (c === ")") {
			toks.push({ t: "rp" });
			i++;
			continue;
		}
		if (c === ",") {
			toks.push({ t: "comma" });
			i++;
			continue;
		}
		if ("+-*/%^".includes(c)) {
			if (c === "-" && prevAllowsUnary()) toks.push({ t: "op", v: "u-" });
			else toks.push({ t: "op", v: c });
			i++;
			continue;
		}
		throw new Error(`unexpected character '${c}'`);
	}
	return toks;
}

/** Shunting-yard → RPN token list. */
function toRpn(toks: Tok[]): Tok[] {
	const out: Tok[] = [];
	const stack: Tok[] = [];
	for (const tk of toks) {
		if (tk.t === "num") out.push(tk);
		else if (tk.t === "fn") stack.push(tk);
		else if (tk.t === "comma") {
			while (stack.length && stack[stack.length - 1].t !== "lp") out.push(stack.pop()!);
			if (!stack.length) throw new Error("misplaced comma or missing parenthesis");
		} else if (tk.t === "op") {
			const o1 = OPS[tk.v];
			while (stack.length) {
				const top = stack[stack.length - 1];
				if (top.t !== "op") break;
				const o2 = OPS[top.v];
				if (o2.prec > o1.prec || (o2.prec === o1.prec && !o1.right)) out.push(stack.pop()!);
				else break;
			}
			stack.push(tk);
		} else if (tk.t === "lp") stack.push(tk);
		else if (tk.t === "rp") {
			while (stack.length && stack[stack.length - 1].t !== "lp") out.push(stack.pop()!);
			if (!stack.length) throw new Error("mismatched parenthesis");
			stack.pop(); // drop "("
			if (stack.length && stack[stack.length - 1].t === "fn") out.push(stack.pop()!);
		}
	}
	while (stack.length) {
		const s = stack.pop()!;
		if (s.t === "lp" || s.t === "rp") throw new Error("mismatched parenthesis");
		out.push(s);
	}
	return out;
}

function evalRpn(rpn: Tok[]): number {
	const st: number[] = [];
	for (const tk of rpn) {
		if (tk.t === "num") st.push(tk.v);
		else if (tk.t === "op") {
			const op = OPS[tk.v];
			if (op.arity === 1) {
				const a = st.pop();
				if (a === undefined) throw new Error("syntax error");
				st.push(-a);
			} else {
				const b = st.pop();
				const a = st.pop();
				if (a === undefined || b === undefined) throw new Error("syntax error");
				switch (tk.v) {
					case "+": st.push(a + b); break;
					case "-": st.push(a - b); break;
					case "*": st.push(a * b); break;
					case "/":
						if (b === 0) throw new Error("division by zero");
						st.push(a / b);
						break;
					case "%":
						if (b === 0) throw new Error("modulo by zero");
						st.push(a % b);
						break;
					case "^": st.push(a ** b); break;
				}
			}
		} else if (tk.t === "fn") {
			const fn = FUNCS[tk.v];
			// min/max are variadic but our parser only feeds fixed arities via
			// commas → we collect the remaining args off the stack. Since RPN
			// loses the arg count, min/max take exactly the two most-recent when
			// called binary; single-arg funcs take one.
			if (tk.v === "min" || tk.v === "max") {
				const b = st.pop();
				const a = st.pop();
				if (a === undefined || b === undefined) throw new Error(`${tk.v}() needs two arguments`);
				st.push(fn(a, b));
			} else {
				const a = st.pop();
				if (a === undefined) throw new Error(`${tk.v}() needs an argument`);
				st.push(fn(a));
			}
		}
	}
	if (st.length !== 1) throw new Error("syntax error");
	return st[0];
}

export const calc: Fn = {
	name: "calc",
	description:
		"Safe arithmetic evaluator (no eval). Supports + - * / % ^, parentheses, unary minus, functions sqrt/abs/min/max/floor/ceil/round/log(base-10)/ln(natural), and constants pi/e. min/max take exactly two arguments. Returns JSON { expr, result }. Fails clearly on syntax errors, division by zero, and non-finite results.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["expr"],
		properties: {
			expr: { type: "string", description: "Arithmetic expression, e.g. '2 * (3 + 4) ^ 2' or 'max(sqrt(16), pi)'." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const expr = typeof args?.expr === "string" ? args.expr.trim() : "";
		if (!expr) return fail("Provide a non-empty `expr`.");
		try {
			const result = evalRpn(toRpn(tokenize(expr)));
			if (!Number.isFinite(result)) return fail(`Result is not finite (${result}).`);
			return ok(JSON.stringify({ expr, result }, null, 2));
		} catch (e) {
			return fail(`calc error: ${String((e as Error).message ?? e)}`);
		}
	},
};
