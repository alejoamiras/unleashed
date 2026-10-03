/** `Flex` props. Static attributes arrive as strings, so `gap="12"` and `:gap="12"` are both accepted. */
export type FlexPlacement = "start" | "center" | "end" | "between" | "around" | "evenly"
export type FlexDirection = "row" | "column"
export type FlexWrap = "nowrap" | "wrap"
export type FlexGap = number | `${number}`
