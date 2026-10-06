import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, tailBytes, toTitle } from "../src/text.ts";

test("tailBytes keeps whole characters from the end", () => {
	assert.equal(tailBytes("hello", 10), "hello");
	assert.equal(tailBytes("hello", 3), "llo");
	// "é" is 2 bytes, "€" is 3 bytes.
	assert.equal(tailBytes("aé€", 4), "€");
	assert.equal(tailBytes("aé€", 5), "é€");
	assert.equal(tailBytes("aé€", 2), "");
});

test("tailBytes never splits a surrogate pair", () => {
	// Each emoji is 4 UTF-8 bytes and 2 UTF-16 code units.
	const text = "x🎉🎉";
	assert.equal(tailBytes(text, 4), "🎉");
	assert.equal(tailBytes(text, 7), "🎉");
	assert.equal(tailBytes(text, 8), "🎉🎉");
	for (let max = 1; max <= 9; max += 1) {
		const tail = tailBytes(text, max);
		assert.ok(Buffer.byteLength(tail) <= max, `max ${max}`);
		assert.ok(!/[\uD800-\uDFFF]/.test(tail.replace(/🎉/g, "")), `lone surrogate at max ${max}`);
	}
});

test("tailBytes returns nothing for zero or negative budgets", () => {
	assert.equal(tailBytes("abc", 0), "");
	assert.equal(tailBytes("abc", -5), "");
	assert.equal(tailBytes("abc", Number.NaN), "");
});

test("titles fit on one line", () => {
	assert.equal(toTitle("a\n\tb\u0007  c"), "a b c");
	assert.equal([...toTitle("x".repeat(100))].length, 72);
});

test("ages are rounded", () => {
	assert.equal(formatAge(0, 30_000), "just now");
	assert.equal(formatAge(0, 5 * 60_000), "5m ago");
	assert.equal(formatAge(0, 3 * 3_600_000), "3h ago");
	assert.equal(formatAge(0, 72 * 3_600_000), "3d ago");
});
