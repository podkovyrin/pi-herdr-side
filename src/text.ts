import { MAX_TITLE_CHARS } from "./constants.ts";

/** Collapse whitespace and drop control characters so text fits on one line. */
export function singleLine(text: string): string {
	return [...text.replace(/[\r\n\t]+/g, " ")]
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code > 31 && (code < 127 || code > 159);
		})
		.join("")
		.replace(/ {2,}/g, " ")
		.trim();
}

export function truncate(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export function toTitle(text: string): string {
	return truncate(singleLine(text), MAX_TITLE_CHARS);
}

/**
 * Keep at most maxBytes of UTF-8 from the end of the text. The cut skips
 * UTF-8 continuation bytes, so it never splits a character or a surrogate pair.
 */
export function tailBytes(text: string, maxBytes: number): string {
	if (!(maxBytes > 0)) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - Math.floor(maxBytes);
	// Continuation bytes look like 10xxxxxx.
	while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

export function formatAge(from: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - from) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
