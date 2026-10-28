<script setup lang="ts">
import type { LegalDocument } from "./document"
import { LEGAL_TESTIDS } from "./testids"

/** One legal document as a page. Every string goes through text interpolation, never `v-html`. */
defineProps<{ doc: LegalDocument }>()
</script>

<template>
	<main class="legal" :data-testid="LEGAL_TESTIDS.page" :data-legal-doc="doc.id">
		<nav class="nav" aria-label="Legal" :data-testid="LEGAL_TESTIDS.nav">
			<a href="/">← Back</a>
			<a href="/terms" :aria-current="doc.id === 'unleashed-terms-of-use' ? 'page' : undefined">Terms of Use</a>
			<a href="/privacy" :aria-current="doc.id === 'unleashed-privacy-policy' ? 'page' : undefined">Privacy Policy</a>
		</nav>
		<h1>{{ doc.title }}</h1>
		<p class="updated">Last updated {{ doc.updated }}</p>
		<section v-for="(section, i) in doc.sections" :key="section.heading">
			<h2>{{ i + 1 }}. {{ section.heading }}</h2>
			<template v-for="(block, j) in section.blocks" :key="j">
				<p v-if="block.kind === 'p'">{{ block.text }}</p>
				<ul v-else-if="block.kind === 'list'">
					<li v-for="item in block.items" :key="item">{{ item }}</li>
				</ul>
				<dl v-else class="providers" :data-testid="LEGAL_TESTIDS.providers">
					<div v-for="row in block.rows" :key="row.name" class="provider">
						<dt>{{ row.name }}</dt>
						<dd>{{ row.role }}</dd>
						<dd>{{ row.sees }}</dd>
						<dd>
							<a :href="row.policyUrl" target="_blank" rel="noopener noreferrer">{{ row.name }}'s privacy policy</a>
						</dd>
					</div>
				</dl>
			</template>
		</section>
	</main>
</template>

<style scoped>
.legal {
	max-width: 760px;
	margin: 0 auto;
	padding: 56px 32px 96px;
	color: var(--ul-ink);
	font: 400 16px/1.6 var(--ul-font-body);
}

.nav {
	display: flex;
	flex-wrap: wrap;
	gap: 20px;
	margin-bottom: 40px;
	font: 400 13.5px/1 var(--ul-font-mono);
}

a {
	color: var(--ul-accent-text);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

a:hover,
a[aria-current="page"] {
	color: var(--ul-ink);
}

h1 {
	margin: 0;
	font: 700 40px/1.08 var(--ul-font-body);
	letter-spacing: -0.02em;
}

.updated {
	margin: 12px 0 32px;
	font: 400 13.5px/1.4 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

h2 {
	margin: 40px 0 12px;
	font: 700 20px/1.3 var(--ul-font-body);
}

p,
ul,
dl {
	margin: 0 0 14px;
}

ul {
	padding-left: 22px;
}

li + li {
	margin-top: 6px;
}

.provider {
	padding: 12px 0;
	border-top: 1px solid var(--ul-line);
}

.provider:last-child {
	border-bottom: 1px solid var(--ul-line);
}

dt {
	font-weight: 700;
}

dd {
	margin: 4px 0 0;
}

@media (max-width: 760px) {
	.legal {
		padding: 32px 16px 64px;
	}

	h1 {
		font-size: 30px;
	}
}
</style>
