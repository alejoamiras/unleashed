<script setup lang="ts">
import MainnetPlaceholderView from "@/views/MainnetPlaceholderView.vue"
import type { LegalDocument } from "./document"
import LegalPage from "./LegalPage.vue"
import { PRIVACY } from "./privacy"
import { TERMS } from "./terms"

/**
 * The whole mainnet app: a legal page at its path, the placeholder everywhere else. The path is read
 * once, because the pages link to each other with plain anchors and every move is a page load.
 */
const DOCS: ReadonlyMap<string, LegalDocument> = new Map([
	["/terms", TERMS],
	["/privacy", PRIVACY],
])
const doc = DOCS.get(window.location.pathname.toLowerCase().replace(/(.)\/$/, "$1")) ?? null
</script>

<template>
	<LegalPage v-if="doc" :doc="doc" />
	<MainnetPlaceholderView v-else />
</template>
