/**
 * The unleashed tools app's design system. Import `base.css` once at app entry. Components ship as
 * Vue SFC source for the consumer's Vite to compile; nothing is auto-imported, so every SFC imports
 * what it uses.
 *
 * Presentational only: components take their data and any `data-testid` through props, and never
 * import app utilities, stores or service clients.
 */

export { default as Flex } from "./core/Flex.vue"
export { default as Icon, type IconName } from "./core/Icon.vue"
export { default as BusyPixels } from "./ui/BusyPixels.vue"
export { default as Button } from "./ui/Button.vue"
export { default as Card } from "./ui/Card.vue"
export { default as Dialog } from "./ui/Dialog.vue"
export { default as ProgressBar } from "./ui/ProgressBar.vue"
export { default as Tag } from "./ui/Tag.vue"
export { default as Toast } from "./ui/Toast.vue"
export { type FocusTrapOptions, useFocusTrap } from "./ui/useFocusTrap"
export { default as AddressDisplay } from "./composite/AddressDisplay.vue"
export { default as BalanceRow } from "./composite/BalanceRow.vue"
export { default as DisclaimerTag } from "./composite/DisclaimerTag.vue"
export { default as DripButton } from "./composite/DripButton.vue"
export { default as EmojiGrid } from "./composite/EmojiGrid.vue"

export type { TextColorName } from "./color-names"
export type { FlexDirection, FlexGap, FlexPlacement, FlexWrap } from "./layout-names"
export type { SeverityTone } from "./severity"
