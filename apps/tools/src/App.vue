<script setup lang="ts">
import { defineAsyncComponent } from "vue"

/**
 * The mainnet build mounts `legal/MainnetRoot` (the placeholder and the legal pages) and nothing else;
 * every other target mounts the shell. The shell loads asynchronously because a static import would
 * evaluate the wallet-session singleton at page load, on a build that must never open a transport.
 * The target test is a literal `define` comparison in this module on purpose: the bundler folds it and
 * drops the mainnet chunk from other targets, which it does not do through `IS_MAINNET` or an imported flag.
 */
const MAINNET_BUILD = import.meta.env.VITE_TOOLS_TARGET === "mainnet"
const MainnetRoot = MAINNET_BUILD ? defineAsyncComponent(() => import("./legal/MainnetRoot.vue")) : null
const AppShell = defineAsyncComponent(() => import("./AppShell.vue"))
</script>

<template>
	<component :is="MainnetRoot" v-if="MainnetRoot" />
	<AppShell v-else />
</template>
