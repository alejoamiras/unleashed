<script setup lang="ts">
import { onMounted, ref } from "vue"
import MainnetPlaceholderView from "@/views/MainnetPlaceholderView.vue"
import AcceptanceGate from "./AcceptanceGate.vue"
import { browserStorage, readAcceptance, type Standing } from "./acceptance"

/**
 * The whole mainnet app: the acceptance gate until this browser holds a valid acceptance, then the
 * placeholder. Nothing renders while the stored record is checked, so the placeholder never shows first.
 * An acceptance made here holds for the page's lifetime even when storage cannot keep it.
 */
const standing = ref<Standing | "checking">("checking")

onMounted(async () => {
	standing.value = await readAcceptance(browserStorage, window.location.origin)
})
</script>

<template>
	<MainnetPlaceholderView v-if="standing === 'accepted'" />
	<AcceptanceGate v-else-if="standing !== 'checking'" :reask="standing === 'changed'" @accepted="standing = 'accepted'" />
</template>
