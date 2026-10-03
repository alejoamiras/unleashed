/**
 * Central catalog of every data-testid the tools app emits. Components
 * import from here so a rename touches one file. E2E selectors use
 * these constants verbatim - no text/role/aria/class lookups.
 */

export const TESTIDS = {
	app: "tl-app",

	// Wallet connection - drives the faucet AztecWalletPanel
	status: "tl-status",
	btnConnect: "tl-btn-connect",
	btnDisconnect: "tl-btn-disconnect",
	btnInstallWallet: "tl-btn-install-wallet",
	account: "tl-account",

	// Wallet picker modal - progressive discovery list, user picks explicitly
	walletPicker: "tl-wallet-picker",
	walletPickerRow: "tl-wallet-picker-row",
	walletPickerConnect: "tl-wallet-picker-connect",
	walletPickerCancel: "tl-wallet-picker-cancel",
	walletPickerClose: "tl-wallet-picker-close",
	walletPickerScanning: "tl-wallet-picker-scanning",
	walletPickerWaiting: "tl-wallet-picker-waiting",
	errorStrip: "tl-error-strip",
	errorStripDismiss: "tl-error-strip-dismiss",
	walletPickerWarning: "tl-wallet-picker-warning",
	btnSwitchWallet: "tl-btn-switch-wallet",
	bridgeL2SwitchWallet: "tl-bridge-l2-switch-wallet",

	// Choose-main-account modal - shown when >1 account is granted and none is remembered
	accountChoice: "tl-account-choice",
	accountChoiceRow: "tl-account-choice-row",
	accountChoiceContinue: "tl-account-choice-continue",
	accountChoiceTruncation: "tl-account-choice-truncation",
	accountChoiceBusy: "tl-account-choice-busy",
	accountChoiceClose: "tl-account-choice-close",

	// Account switcher - connected chip + dropdown menu (both wallet panels)
	accountChip: "tl-account-chip",
	accountMenu: "tl-account-menu",
	accountMenuRow: "tl-account-menu-row",
	accountMenuCopy: "tl-account-menu-copy",
	accountMenuAddAccounts: "tl-account-menu-add-accounts",
	accountMenuAddStatus: "tl-account-menu-add-status",

	// Journal-card account attribution (deposit cards only — withdraws never persist their Aztec sender)
	journalAccount: "tl-journal-account",
	journalSwitchAccount: "tl-journal-switch-account",
	// (menu Disconnect keeps the pre-switcher panel ids: tl-btn-disconnect / tl-bridge-l2-disconnect)
	accountMenuTruncation: "tl-account-menu-truncation",

	// Verification modal - 3×3 emoji grid + match/cancel
	verificationModal: "tl-verification-modal",
	emojiGrid: "tl-emoji-grid",
	emojiCell: (i: number) => `tl-emoji-cell-${i}`,
	btnVerifyConfirm: "tl-btn-verify-confirm",
	btnVerifyCancel: "tl-btn-verify-cancel",
	verificationClose: "tl-verification-close",

	// Capability approval - second wallet interaction after verify
	capabilityApproval: "tl-capability-approval",
	btnCapabilityRetry: "tl-btn-capability-retry",
	settingUp: "tl-setting-up",

	// Token cards
	tokenCard: "tl-token-card",
	balancePublic: "tl-balance-public",
	balancePrivate: "tl-balance-private",
	btnDripPublic: "tl-btn-drip-public",
	btnDripPrivate: "tl-btn-drip-private",
	dripStatus: "tl-drip-status",
	dripLockReason: "tl-drip-lock-reason",

	// One-click "Add to wallet" - calls registerToken on the connected wallet
	btnAddToWallet: "tl-btn-add-to-wallet",
	addTokenStatus: "tl-add-token-status",

	// Toast
	toast: "tl-toast",

	// Shell: the rail (Send | Faucet | Activity), the section header, the Activity page.
	brandHome: "tl-brand-home",
	tabs: "tl-tabs",
	tabDrip: "tl-tab-drip",
	tabActivity: "tl-tab-activity",
	sectionHeader: "tl-section-header",
	activityView: "tl-activity-view",
	activityFirstVisit: "tl-activity-first-visit",
	activityTileSend: "tl-activity-tile-send",
	activityTileDrip: "tl-activity-tile-drip",
	activityUnavailable: "tl-activity-unavailable",
	dripView: "tl-drip-view",
	dock: "tl-dock",
	dockHide: "tl-dock-hide",
	dockStrip: "tl-dock-strip",
	dockOpen: "tl-dock-open",
	dockBadge: "tl-dock-badge",
	dockGroup: "tl-dock-group",
	dockAll: "tl-dock-all",
	dockScrim: "tl-dock-scrim",
	activityRow: "tl-activity-row",
	activityRowOpen: "tl-activity-row-open",
	activityRowAction: "tl-activity-row-action",
	themeToggle: "tl-theme-toggle",

	// Send - L1 (Ethereum) wallet
	l1Status: "tl-l1-status",
	l1Connect: "tl-l1-connect",
	l1Account: "tl-l1-account",
	l1Disconnect: "tl-l1-disconnect",
	l1SwitchChain: "tl-l1-switch-chain",

	// Send - L2 (Aztec) wallet
	bridgeL2Status: "tl-bridge-l2-status",
	bridgeL2Connect: "tl-bridge-l2-connect",
	bridgeL2Account: "tl-bridge-l2-account",
	bridgeL2Disconnect: "tl-bridge-l2-disconnect",

	// Send - the takeover stepper + receipt (phases carry data-phase/data-state)
	stepper: "tl-bridge-stepper",
	stepperPhase: "tl-stepper-phase",
	// The journal cards' compact phase rail (same mapper, distinct ids - surfaces must not collide).
	journalRail: "tl-journal-rail",
	journalPhase: "tl-journal-phase",
	// Per-bridge sealed recovery files: export icons + the journal-header restore flow.
	cardBackup: "tl-card-backup",
	journalClaimWithoutFuel: "tl-journal-claim-without-fuel",
	receiptFuel: "tl-receipt-fuel",
	journalClaimGas: "tl-journal-claim-gas",
	// Private bridge whose gas state can't be confirmed (incomplete private-claim metadata)
	journalPrivateFuelUnknown: "tl-journal-private-fuel-unknown",
	// The token was claimed by another submitter: the line that says what is left (nothing, gas, kept private gas).
	journalClaimedByOther: "tl-journal-claimed-by-other",
	stepperBackup: "tl-stepper-backup",
	journalRestore: "tl-journal-restore",
	journalRestoreLink: "tl-journal-restore-link",
	journalRestoreInput: "tl-journal-restore-input",
	stepperBackground: "tl-stepper-background",
	stepperRetry: "tl-stepper-retry",
	// The stepper's locked copy of the direction switch carries only this root id.
	stepperDirection: "tl-stepper-direction",
	stepperProgress: "tl-stepper-progress",
	stepperLog: "tl-stepper-log",
	receipt: "tl-bridge-receipt",
	receiptNewBridge: "tl-receipt-new-bridge",
	receiptLink: "tl-receipt-link",

	// The one-tap L1 mints of the manifest's permissionless test tokens (NOT the Drip tab's L2 drips)
	mintL1Card: "tl-mint-l1-card",
	mintL1: "tl-mint-l1",
	mintL1Status: "tl-mint-l1-status",

	// Send - the in-flight journal (cards carry data-id/direction/stage/privacy/attention)
	journal: "tl-bridge-journal",
	journalEmpty: "tl-journal-empty",
	journalCard: "tl-journal-card",
	journalStage: "tl-journal-stage",
	journalClaim: "tl-journal-claim",
	journalFinish: "tl-journal-finish",
	journalDiscard: "tl-journal-discard",
	journalDiscardConfirm: "tl-journal-discard-confirm",
	journalClear: "tl-journal-clear",
	journalAttention: "tl-journal-attention",
	journalStep: "tl-journal-step",
	journalTxLink: "tl-journal-tx-link",

	// Send wizard - token discovery (catalog + address lookup) and the reads a selection triggers
	sendTokenSearch: "tl-send-token-search",
	sendCatalogLoading: "tl-send-catalog-loading",
	sendCatalogEmpty: "tl-send-catalog-empty",
	sendTokenLookup: "tl-send-token-lookup",
	sendLookupAdd: "tl-send-lookup-add",
	sendLookupError: "tl-send-lookup-error",
	sendSelectionError: "tl-send-selection-error",
	sendBalanceL1: "tl-send-balance-l1",
	sendBalanceL2Public: "tl-send-balance-l2-public",
	sendBalanceL2Private: "tl-send-balance-l2-private",

	// Send wizard - the gas leg: the discovered fuel route and the slice it sizes
	sendRouteStatus: "tl-send-route-status",
	sendTokenOnlyBlocked: "tl-send-token-only-blocked",
	sendGasTxTarget: "tl-send-gas-tx-target",
	sendGasTxFewer: "tl-send-gas-tx-fewer",
	sendGasTxMore: "tl-send-gas-tx-more",
	sendGasShare: "tl-send-gas-share",
	sendGasEnough: "tl-send-gas-enough",

	// Send wizard — shell + steps.
	tabSend: "tl-tab-send",
	sendView: "tl-send-view",
	sendDirection: "tl-send-direction",
	sendDirectionDeposit: "tl-send-direction-deposit",
	sendDirectionExit: "tl-send-direction-exit",
	sendStepStrip: "tl-send-step-strip",
	sendStep: "tl-send-step",
	sendStepToken: "tl-send-step-token",
	sendStepAmount: "tl-send-step-amount",
	sendStepReview: "tl-send-step-review",
	sendStepPanel: "tl-send-step-panel",
	sendStepAnnounce: "tl-send-step-announce",
	sendStepHeading: "tl-send-step-heading",
	sendTokenList: "tl-send-token-list",
	sendTokenTile: "tl-send-token-tile",
	sendTokenLogo: "tl-send-token-logo",
	sendTokenMonogram: "tl-send-token-monogram",
	sendTokenSymbol: "tl-send-token-symbol",
	sendTokenAddress: "tl-send-token-address",
	sendTokenBalance: "tl-send-token-balance",
	sendAmountInput: "tl-send-amount-input",
	sendAmountMax: "tl-send-amount-max",
	sendAmountError: "tl-send-amount-error",
	sendChoiceCards: "tl-send-choice-cards",
	sendChoiceToken: "tl-send-choice-token",
	sendChoiceTokenGas: "tl-send-choice-token-gas",
	sendChoiceGas: "tl-send-choice-gas",
	sendGasBreakdown: "tl-send-gas-breakdown",
	sendGasDisclosure: "tl-send-gas-disclosure",
	sendGasBreakdownToken: "tl-send-gas-breakdown-token",
	sendGasBreakdownFuel: "tl-send-gas-breakdown-fuel",
	sendPrivateToggle: "tl-send-private-toggle",
	sendPrivacyVeil: "tl-send-privacy-veil",
	sendAmountBack: "tl-send-amount-back",
	sendAmountNext: "tl-send-amount-next",
	sendReviewSend: "tl-send-review-send",
	sendReviewArrives: "tl-send-review-arrives",
	sendReviewGas: "tl-send-review-gas",
	sendReviewVisibility: "tl-send-review-visibility",
	sendReviewNetworkFee: "tl-send-review-network-fee",
	sendReviewTakes: "tl-send-review-takes",
	sendReviewFirstTime: "tl-send-review-first-time",
	sendReviewBurnNote: "tl-send-review-burn-note",
	sendReviewDetailsToggle: "tl-send-review-details-toggle",
	sendReviewDetails: "tl-send-review-details",
	sendReviewRoute: "tl-send-review-route",
	sendReviewSlippage: "tl-send-review-slippage",
	sendReviewPortal: "tl-send-review-portal",
	sendReviewPortalWarning: "tl-send-review-portal-warning",
	sendReviewMetadataWarning: "tl-send-review-metadata-warning",
	sendReviewStale: "tl-send-review-stale",
	sendReviewToken: "tl-send-review-token",
	sendReviewTokenLink: "tl-send-review-token-link",
	sendReviewPortalLink: "tl-send-review-portal-link",
	sendReviewAccount: "tl-send-review-account",
	sendReviewSignature: "tl-send-review-signature",
	sendReviewBack: "tl-send-review-back",
	sendReviewConfirm: "tl-send-review-confirm",
	sendGrantPending: "tl-send-grant-pending",
	sendGrantDeclined: "tl-send-grant-declined",
	sendGrantBusy: "tl-send-grant-busy",
	sendAmountBlocked: "tl-send-amount-blocked",
	sendPausedNotice: "tl-send-paused-notice",
	sendStepperRegister: "tl-send-stepper-register",
	sendReceiptToken: "tl-send-receipt-token",
	sendReceiptGas: "tl-send-receipt-gas",
	sendReceiptReviewSaid: "tl-send-receipt-review-said",
	sendReceiptAccount: "tl-send-receipt-account",
	sendReceiptFrom: "tl-send-receipt-from",
	sendReceiptVisibility: "tl-send-receipt-visibility",
	sendReceiptAddToken: "tl-send-receipt-add-token",
	mainnetPlaceholder: "tl-mainnet-placeholder",
	mainnetPlaceholderLink: "tl-mainnet-placeholder-link",

	// A send running in the background: the strip above the wizard and its jump to the journal
	sendBackgroundStrip: "tl-send-background-strip",
	sendBackgroundActivity: "tl-send-background-activity",

	// step components
	sendCatalogError: "tl-send-catalog-error",
	sendReviewError: "tl-send-review-error",

	// A network whose manifest carries no bridge block: the SEND tab has nothing to send through while
	// the rest of the app keeps working. Distinct from the mainnet placeholder, which IS the whole app.
	sendUnavailable: "tl-send-unavailable",
} as const

export type Testid = (typeof TESTIDS)[keyof typeof TESTIDS]
