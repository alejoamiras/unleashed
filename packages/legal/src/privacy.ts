import type { LegalDocument } from "./document.ts"

export const PRIVACY: LegalDocument = {
	id: "unleashed-privacy-policy",
	title: "Privacy Policy",
	updated: "[[OWNER: A11 the day this policy goes live]]",
	sections: [
		{
			heading: "Who we are and what this covers",
			blocks: [
				{
					kind: "p",
					text: 'This policy is published by the operator of Unleashed ("we", "us"). It covers two websites: unleashed.systems, which describes the project and publishes this policy, and the Unleashed mainnet app at app.unleashed.systems and at any other address that serves the same app (the "app"). It explains what each of them, and the services they rely on, can see about you.',
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
						"While the app sits behind a login wall, the hosting company also checks who logs in and sets a login cookie.",
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
					text: "The unleashed.systems website stores nothing in your browser. Once the app offers the gas flow, it stores these items in your browser's local storage, on your device only:",
				},
				{
					kind: "list",
					items: [
						"A record of each deposit you start: the network, the contracts, the amounts, your Ethereum and Aztec addresses, transaction hashes, and the secret material needed to claim the deposit. For a public deposit the claim secret is stored as readable text. For a private deposit the secrets are also kept encrypted, but a readable copy of the amount and the recipient stays for display.",
						"Records that fail the app's checks, set aside rather than deleted, so that nothing that could still be claimed is lost.",
						"Which wallet you chose, and which of its accounts you use.",
						"Which wallet software produced a signature the app checked, so it does not ask twice.",
						"A copy of a public token list, refreshed after a day.",
						"Your theme and panel preferences.",
						"Your acceptance of these documents, once the app asks for it.",
					],
				},
				{
					kind: "p",
					text: "The app removes a completed deposit record 7 days after it completes. Everything else stays until you clear your browser data. The software libraries the app uses may also cache public data, such as the parameters used to build proofs. None of this is ever sent to us. Anyone who can use your browser, and any software running in it, may be able to read it. If you clear it before a deposit is claimed and you have no backup, you may lose that deposit.",
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
					text: "Until the mainnet app opens to the public, it sits behind Cloudflare Access, a login wall. Cloudflare Access sees the identity you log in with and sets a login cookie on the app's address.",
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
					text: "Ethereum and Aztec are public networks. A deposit is an Ethereum transaction from your address: anyone can see your address, the token, the amount, the contracts it used and when it happened, forever. A token approval you grant is public too. A public claim on Aztec shows which account received the Fee Juice. A private claim keeps the receiving account off the public record, but the Ethereum side of the deposit stays public. Private is not anonymous: timing, amounts and addresses can still link your activity.",
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
					text: "The websites link to other sites, such as block explorers, wallet sites and the source code. A link to a block explorer carries your address or transaction hash, so that site learns it when you open the link. Our websites tell the sites they link to only which of our websites you came from, not which page.",
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
						"What we process and why: the request details our hosting provider handles for us, to deliver the websites and keep them secure. Our legal basis is our legitimate interest in running and protecting them. We hold no other personal data about you: what the app keeps in your browser never reaches us.",
						"How long: we keep nothing ourselves. Cloudflare keeps request details for the periods its own privacy policy states.",
						"Transfers: Cloudflare may process request details outside the UK and the European Economic Area, including in the United States, under the safeguards its data processing terms describe.",
						"Your rights: you can ask us for access to, correction of, or deletion of your personal data, ask us to restrict or stop processing it, and ask for a copy in a portable form. Because we hold almost nothing, there may be nothing for us to give or delete; we will tell you what we have.",
						"Complaints: you can complain to the data protection authority where you live or work. In the UK that is the Information Commissioner's Office.",
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
					text: "When we change this policy, we publish the new version here with a new date, and the app asks you to accept it before you use the app again.",
				},
			],
		},
	],
}
