<script setup lang="ts">
import { defineAsyncComponent } from "vue"
import { IS_MAINNET } from "@/lib/network"
import MainnetPlaceholderView from "./views/MainnetPlaceholderView.vue"

/**
 * The mainnet build is the placeholder and nothing else: no tabs, no wallet session, no node.
 * The shell is loaded ASYNCHRONOUSLY for exactly that reason — a static import would evaluate the
 * wallet-session singleton (and every module behind it) at page load, on a build that must never
 * open a transport at all.
 */
const AppShell = defineAsyncComponent(() => import("./AppShell.vue"))
</script>

<template>
	<MainnetPlaceholderView v-if="IS_MAINNET" />
	<AppShell v-else />
</template>
