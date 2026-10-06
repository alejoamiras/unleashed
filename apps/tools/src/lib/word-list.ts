/** "A", "A or B", "A, B or C" (with `and` likewise): the comma series the screens use, without an Oxford comma. */
export function joinWords(words: readonly string[], last: "and" | "or"): string {
	if (words.length <= 1) return words[0] ?? ""
	return `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`
}
