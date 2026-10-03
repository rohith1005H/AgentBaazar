/**
 * Minimal RFC 4180 reader for product feeds: quoted fields, escaped quotes,
 * embedded commas/newlines, CRLF, BOM. Delimiter is configurable (CSV, TSV, PSV
 * are the three formats Store Sync accepts).
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c === '"' && s[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === "") quoted = true;
		else if (c === delimiter) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && s[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			if (row.some((f) => f !== "")) rows.push(row);
			row = [];
		} else field += c;
	}
	row.push(field);
	if (row.some((f) => f !== "")) rows.push(row);
	return rows;
}

/** Header row -> array of { column: value } records. */
export function parseRecords(text: string, delimiter = ","): Record<string, string>[] {
	const [header, ...body] = parseDelimited(text, delimiter);
	if (!header) return [];
	const cols = header.map((h) => h.trim().toLowerCase());
	return body.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? "").trim()])));
}

/** Store Sync accepts CSV, TSV and PSV; pick by the header line. */
export function sniffDelimiter(text: string): string {
	const first = text.split(/\r?\n/, 1)[0] ?? "";
	const counts = [",", "\t", "|"].map((d) => [d, first.split(d).length] as const);
	return counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}
