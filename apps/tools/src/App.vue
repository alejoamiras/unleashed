<script setup lang="ts">
import { defineAsyncComponent } from "vue"

/**
 * Mainnet mounts only its root (the acceptance gate, then the placeholder). The target test stays a literal
 * `define` comparison in this module, the only form the bundler folds to drop that chunk elsewhere (not
 * `IS_MAINNET`); the shell stays lazy because importing it constructs the wallet session, which mainnet must
 * never open.
 */
const MAINNET_BUILD = import.meta.env.VITE_TOOLS_TARGET === "mainnet"
const MainnetRoot = MAINNET_BUILD ? defineAsyncComponent(() => import("./legal/MainnetRoot.vue")) : null
const AppShell = defineAsyncComponent(() => import("./AppShell.vue"))
</script>

<template>
	<component :is="MainnetRoot" v-if="MainnetRoot" />
	<AppShell v-else />
</template>
