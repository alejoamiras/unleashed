import type { LegalDocument } from "./document.ts"

export const PRIVACY: LegalDocument = {
	id: "unleashed-privacy-policy",
	title: "Privacy Policy",
	updated: "29 October 2026",
	sections: [
		{
			heading: "Who we are and what this covers",
			blocks: [
				{
					kind: "p",
					text: 'This policy is published by the operator of Unleashed ("we", "us"). It covers two websites: unleashed.systems (also served at www.unleashed.systems), which describes the project and publishes this policy, and the Unleashed mainnet app at app.unleashed.systems and at any other address that serves the same app (the "app"). It explains what each of them, and the services they rely on, can see about you. It does not cover the Unleashed testnet app, which runs on test networks.',
				},
				{ kind: "p", text: "To contact us about this policy or your data, write to hello@unleashed.systems." },
			],
		},
		{
			heading: "In short",
			blocks: [
				{
					kind: "list",
					items: [
						"Today the mainnet app shows only a holding page. When it opens, it will offer one thing: a way to get Fee Juice, the asset that pays transaction fees on Aztec, for your own Aztec account.",
						"Neither website has accounts, analytics, advertising or tracking, and neither sets cookies of its own.",
						"We run no server that receives your data. What the app needs to remember stays in your browser.",
						"The company that hosts both websites sees the usual details of each request, and may set its own security cookies.",
						"While the app sits behind a login wall, the hosting company also checks who logs in, keeps a record of each login and sets a login cookie.",
						"Transactions you send are recorded on public blockchains, permanently.",
					],
				},
			],
		},
		{
			heading: "What stays in your browser",
			blocks: [
				{
					kind: "p",
					text: "The unleashed.systems website stores nothing in your browser, and neither does the app's holding page. Once the app offers the gas flow, it may store these items in your browser's local storage, on your device only:",
				},
				{
					kind: "list",
					items: [
						"A record of each deposit you start: the network, the contracts, the amounts, your Ethereum and Aztec addresses, transaction hashes, and the secret material needed to claim the deposit. The claim secret is stored as readable text, for public and private deposits alike; a private deposit also keeps, in readable form, the salt its secret comes from, next to an encrypted copy for recovery.",
						"Records that fail the app's checks, kept apart rather than deleted where possible. Each of these lists keeps only its latest 100 entries, so older ones may be discarded even if they hold what is needed to claim a deposit.",
						"Which wallet you chose, and which of its accounts you use.",
						"Which wallet software produced a signature the app checked, so it does not ask twice.",
						"A copy of a public token list, refreshed after a day.",
						"Your theme and panel preferences.",
						"Your acceptance of these documents, once the app asks for it.",
					],
				},
				{
					kind: "p",
					text: "Each time the app starts, it removes the deposit records that completed at least 7 days earlier, so a record can stay longer if you do not come back. The app tries to keep each list of deposits within 100 records by removing the oldest completed ones; it never removes an unfinished one on its own, even if that leaves more than 100. You can remove a record yourself. Other browser data stays until you clear it or the app changes, replaces or removes it. The software libraries the app uses may also cache public data, such as the parameters used to build proofs. None of this is ever sent to us. Anyone who can use your browser, and any software running in it, may be able to read it. If you clear it before a deposit is claimed and you have no backup, you may lose that deposit.",
				},
			],
		},
		{
			heading: "Our hosting provider",
			blocks: [
				{
					kind: "p",
					text: "Both websites are served by Cloudflare. Like any web host, Cloudflare receives each request your browser makes to them: your IP address, the page or file requested, the time, and the details your browser sends with every request, such as its type and language. Cloudflare uses this to deliver and protect the websites and handles it under its own privacy policy, and it may set cookies that help it tell people from bots.",
				},
				{
					kind: "p",
					text: "We use Cloudflare's default settings and have turned on no extra logging or analytics. Cloudflare's dashboard shows us summary statistics about traffic, such as request counts. We do not use this to identify anyone.",
				},
				{
					kind: "p",
					text: "Until the mainnet app opens to the public, it sits behind Cloudflare Access, a login wall. Cloudflare Access checks the identity you log in with, sets a login cookie on the app's address, and records each login: your identity, IP address, the time and whether you were let in. We can see those records.",
				},
				{
					kind: "providers",
					rows: [
						{
							name: "Cloudflare",
							origin: null,
							role: "Hosts and protects both websites.",
							sees: "Your IP address, the pages and files you request, the time, and the details your browser sends with each request.",
							policyUrl: "https://www.cloudflare.com/privacypolicy/",
						},
					],
				},
			],
		},
		{
			heading: "Your wallets",
			blocks: [
				{
					kind: "p",
					text: "The app talks to the wallet software on your device. It asks your Aztec wallet for your accounts and asks it to approve and send transactions, and it asks your Ethereum wallet to sign messages and send transactions. To show you balances and wait for transactions, the app also reads the Ethereum network through your Ethereum wallet, which uses its own network provider. What your wallets and their providers do with this is governed by their own terms and policies.",
				},
			],
		},
		{
			heading: "Other services the app calls",
			blocks: [
				{
					kind: "p",
					text: "Today the mainnet app calls no other service. To offer the gas flow, it will call some of these kinds of service directly from your browser. Each one sees your IP address, the time and your browser's details, plus what the request carries:",
				},
				{
					kind: "list",
					items: [
						"An Aztec network node: transaction hashes, message hashes and other details of your claims, so the app can tell when your Fee Juice is ready to claim.",
						"An Ethereum reading service: your Ethereum address and your transaction hashes, so the app can follow a deposit without asking your wallet.",
						"A public token list, published on a content delivery network: a request for one fixed file. It carries no address and no transaction.",
						"A quote service for deposits sent from another network: the tokens, networks, amount, recipient and deposit message.",
					],
				},
				{
					kind: "p",
					text: "Before the app calls any of them, we will name each provider here, in a new version of this policy that the app will ask you to accept.",
				},
			],
		},
		{
			heading: "Public blockchains",
			blocks: [
				{
					kind: "p",
					text: "Ethereum and Aztec are public networks. A deposit is an Ethereum transaction from your address: anyone can see your address, the token, the amount, the contracts it used and when it happened, forever. A token approval you grant is public too. For a public deposit, your Aztec account is named on Ethereum as soon as you deposit, and the claim on Aztec is public too. A private claim keeps the receiving account off the public record, but the Ethereum side of the deposit stays public. Private is not anonymous: timing, amounts and addresses can still link your activity.",
				},
			],
		},
		{
			heading: "Backup files",
			blocks: [
				{
					kind: "p",
					text: "The app can save a backup of a deposit record as a file that you download and keep. The record inside is encrypted with a key that only your Ethereum wallet's signature can recreate. The file's label is not encrypted: it shows the network, the contracts, the direction, the record's identifier and the Ethereum address that made the backup. We never receive your backup files.",
				},
			],
		},
		{
			heading: "Links to other sites",
			blocks: [
				{
					kind: "p",
					text: "The websites link to other sites, such as block explorers, wallet sites and the source code. A link to a block explorer carries your address or transaction hash, so that site learns it when you open the link. When you follow a link, our websites tell the other site at most which of our websites you came from, never which page.",
				},
			],
		},
		{
			heading: "What we never do",
			blocks: [
				{
					kind: "p",
					text: "We do not sell your data, share it for advertising, build profiles of you, or make automated decisions about you.",
				},
			],
		},
		{
			heading: "Your rights under data protection law",
			blocks: [
				{
					kind: "p",
					text: "If the UK or EU General Data Protection Regulation applies to you, this section applies too.",
				},
				{
					kind: "list",
					items: [
						"What we process and why: the request details our hosting provider handles, and the login records while the login wall stands, to deliver and protect the websites, in our legitimate interest in running them securely. The details the app needs for a deposit you ask for (your addresses, the transaction details and the claim material) are processed on your device and sent only in the requests described above, to provide the service you ask for under our Terms of Use. Your preferences and your acceptance of these documents are kept in your browser, in our legitimate interest in remembering your choices. If you write to us, we use your address and message to answer you, in our legitimate interest in handling your request, or to meet a legal duty when you exercise your rights. We are responsible for this processing even where the data stays in your browser and never reaches us.",
						"How long: what stays in your browser follows the rules above. We keep messages you send us as long as we need to handle your request, settle any dispute about it and meet legal duties. Cloudflare keeps request and login records for periods that depend on the service and on its own security and legal needs, as its privacy policy describes.",
						"Transfers: Cloudflare may process request and login details outside the UK and the European Economic Area, including in the United States. Its data processing terms cover those transfers through the EU-US Data Privacy Framework and its UK Extension, or through the European Commission's standard contractual clauses and the UK's addendum to them. You can ask us for a copy of the safeguards at hello@unleashed.systems.",
						"Your rights: you can ask us for access to, correction of, or deletion of your personal data, ask us to restrict or stop processing it, and ask for a copy in a portable form. Because we hold almost nothing, there may be nothing for us to give or delete; we will tell you what we have.",
						"Complaints: you can complain to us first, at hello@unleashed.systems. Where UK law applies, we will acknowledge your complaint within 30 days and tell you the outcome without undue delay. You can also complain to a data protection authority, such as the one where you live or work. In the UK that is the Information Commissioner's Office.",
					],
				},
			],
		},
		{
			heading: "Children",
			blocks: [{ kind: "p", text: "The app is not for anyone under 18." }],
		},
		{
			heading: "Changes",
			blocks: [
				{
					kind: "p",
					text: "When we change this policy, we publish the new version here with a new date. Once the app asks you to accept these documents, it will ask again after every change, before you use the app again.",
				},
			],
		},
	],
}
