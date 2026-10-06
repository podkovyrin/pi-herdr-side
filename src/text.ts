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

/** Keep at most maxBytes of UTF-8 from the end of the text. */
export function tailBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let sliced = text.slice(-maxBytes);
	while (Buffer.byteLength(sliced, "utf8") > maxBytes) {
		const excess = Buffer.byteLength(sliced, "utf8") - maxBytes;
		sliced = sliced.slice(Math.max(1, Math.ceil(excess / 4)));
	}
	return sliced;
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
