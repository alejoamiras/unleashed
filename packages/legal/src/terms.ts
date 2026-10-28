import type { LegalDocument } from "./document.ts"

export const TERMS: LegalDocument = {
	id: "unleashed-terms-of-use",
	title: "Terms of Use",
	updated: "[[OWNER: A11 the day these terms go live]]",
	sections: [
		{
			heading: "About these terms",
			blocks: [
				{
					kind: "p",
					text: 'These terms are an agreement between you and the operator of Unleashed ("we", "us"). They cover the Unleashed mainnet app at app.unleashed.systems and at any other address that serves the same app (the "app"). They do not cover the Unleashed testnet app, which runs on test networks and carries no real value.',
				},
				{
					kind: "p",
					text: "You accept these terms when the app asks you to, or by using the app, whichever comes first. If you do not accept them, do not use the app. Our Privacy Policy explains what the app and the services it uses can see.",
				},
				{ kind: "p", text: "To contact us about these terms, write to hello@unleashed.systems." },
			],
		},
		{
			heading: "Who may use the app",
			blocks: [
				{ kind: "p", text: "You may use the app only if all of the following are true:" },
				{
					kind: "list",
					items: [
						"You are at least 18 years old and able to enter into a binding agreement.",
						"You are not a person or entity named on, or owned or controlled by a person named on, a sanctions list kept by the United Nations, the United Kingdom, the European Union or the United States.",
						"You are not located in, ordinarily resident in, or organised under the laws of a country or region under comprehensive sanctions by any of them.",
						"Using the app is lawful where you are.",
					],
				},
				{
					kind: "p",
					text: "Do not use a VPN or any other means to hide where you are in order to get around this section. The app does not check who you are or where you are; these promises are yours.",
				},
			],
		},
		{
			heading: "What the app is",
			blocks: [
				{
					kind: "p",
					text: "Unleashed is an experimental, open-source proof of concept. It is not a finished product and it is not a financial service. It may have bugs, it may change without notice, and it may stop working or be shut down at any time.",
				},
				{
					kind: "p",
					text: "Today the mainnet app shows only a holding page. When it opens, it will offer one thing: a way to get Fee Juice, the asset that pays transaction fees on the Aztec network, for your own Aztec account. You choose a token on Ethereum; your Ethereum wallet signs and sends a deposit; part or all of the token is swapped into Fee Juice through a third-party route; and the Fee Juice is deposited to the Aztec Fee Juice portal for your account, where your Aztec wallet claims it. The mainnet app does not offer a token bridge.",
				},
				{
					kind: "p",
					text: "The app is a website that runs in your browser. It prepares transactions and messages; your own wallets show them to you, sign them and send them. We are not a custodian, broker, exchange, money transmitter, bank or adviser, and nothing in the app is an offer of any of those services.",
				},
			],
		},
		{
			heading: "We never take custody",
			blocks: [
				{
					kind: "p",
					text: "We never receive, hold or control your private keys, recovery phrases, passwords, claim secrets or funds. We cannot sign for you, and we cannot reverse, cancel, speed up or recover a transaction. Anything you send is final once the network accepts it.",
				},
			],
		},
		{
			heading: "Our keys and what they can do",
			blocks: [
				{
					kind: "p",
					text: "The app uses smart contracts that we deployed. We alone hold the keys that control two powers over them:",
				},
				{
					kind: "list",
					items: [
						"Pause: we can stop new deposits through these contracts. A pause stops the gas flow until we lift it. A deposit already accepted by the Fee Juice portal is not affected.",
						"Sweep: we can move tokens that the deposit router holds outside a transaction, such as tokens sent to it by mistake. A deposit moves your tokens through the router within one transaction, so a sweep cannot reach a deposit in progress.",
					],
				},
				{
					kind: "p",
					text: "No key we hold can move Fee Juice deposited to the Fee Juice portal for your account, or stop you from claiming it. The Fee Juice portal is part of the Aztec network, not ours, and the private fee contract the app uses for private claims has no owner.",
				},
				{
					kind: "p",
					text: "We may use these powers at our discretion, for example to respond to a bug or an attack. To the extent the law allows, we are not liable for any loss caused by using them or by not using them.",
				},
			],
		},
		{
			heading: "Your responsibilities",
			blocks: [
				{ kind: "p", text: "You alone are responsible for:" },
				{
					kind: "list",
					items: [
						"your wallets, keys, recovery phrases, devices and the software you use with the app;",
						"every transaction and message you sign, including checking the network, addresses, amounts, prices and fees before you sign;",
						"the token approvals you grant, which let a contract move that token later, and for revoking them when you no longer want them;",
						"the records the app keeps in your browser, and the backup files you download. A deposit is claimed with secret material that the app stores only in your browser. If you clear your browser data or lose your device before the claim is complete, and you have no backup, you may lose that deposit for good;",
						"any taxes and reporting duties that apply to you;",
						"following the laws that apply to you.",
					],
				},
			],
		},
		{
			heading: "Risks you accept",
			blocks: [
				{ kind: "p", text: "Using the app carries serious risks, including these:" },
				{
					kind: "list",
					items: [
						"Software risk: the app and its contracts may contain bugs, whether or not anyone has audited them.",
						"Network risk: Ethereum and Aztec can be congested, slow, expensive, upgraded, paused or reset, and a network change can make a deposit late or unclaimable.",
						"Pause risk: we can pause new deposits, as described above.",
						"Price risk: the rate of a swap into Fee Juice can move between quote and execution, and network fees can change.",
						"Third-party risk: wallets, swap routes, network nodes, hosting providers and other services the app relies on can fail, change or act against you.",
						"Loss of claim material: without the secret material in your browser or a backup, a deposit may never be claimed.",
						"Legal risk: laws and regulations can change and can affect your use of the app.",
					],
				},
				{
					kind: "p",
					text: "You could lose everything you deposit. Use only amounts you can afford to lose. You use the app at your own risk.",
				},
			],
		},
		{
			heading: "Other products",
			blocks: [
				{
					kind: "p",
					text: "Wallets, swap routes such as LI.FI, cross-chain services such as Across, block explorers and the Ethereum and Aztec networks are separate products, even where related parties publish them. Their own terms and policies apply to them. We do not control them and are not responsible for them, and a link to one is not an endorsement.",
				},
			],
		},
		{
			heading: "Things you must not do",
			blocks: [
				{ kind: "p", text: "You must not use the app to:" },
				{
					kind: "list",
					items: [
						"break any law, including sanctions, anti-money-laundering and anti-terrorism laws;",
						"handle the proceeds of crime or hide where funds came from;",
						"defraud, mislead or harm anyone;",
						"attack, overload, probe or disrupt the app, its contracts or anyone using them;",
						"claim to be us or to act for us.",
					],
				},
			],
		},
		{
			heading: "The open-source code",
			blocks: [
				{
					kind: "p",
					text: "The app's source code is published under the Apache License 2.0. These terms govern your use of the app as we host it. They do not limit any right that the licence gives you to the code.",
				},
			],
		},
		{
			heading: "No warranties",
			blocks: [
				{
					kind: "p",
					text: "TO THE FULLEST EXTENT THE LAW ALLOWS, THE APP IS PROVIDED AS IS AND AS AVAILABLE, WITH ALL FAULTS, AND WITHOUT ANY WARRANTY, CONDITION OR PROMISE OF ANY KIND, WHETHER EXPRESS, IMPLIED OR STATUTORY. THIS INCLUDES ANY WARRANTY OF SATISFACTORY QUALITY, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, SECURITY, AVAILABILITY OR NON-INFRINGEMENT. WE DO NOT PROMISE THAT THE APP WILL WORK, THAT IT IS FREE OF ERRORS OR HARMFUL CODE, OR THAT ANY DEPOSIT WILL ARRIVE.",
				},
			],
		},
		{
			heading: "Limits on our liability",
			blocks: [
				{
					kind: "p",
					text: "TO THE FULLEST EXTENT THE LAW ALLOWS, WE ARE NOT LIABLE TO YOU FOR ANY LOSS OR DAMAGE OF ANY KIND ARISING FROM OR CONNECTED WITH THE APP OR THESE TERMS, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), BREACH OF STATUTORY DUTY OR OTHERWISE. THIS INCLUDES LOSS OF FUNDS, TOKENS, PROFITS, DATA OR OPPORTUNITY, AND ANY INDIRECT OR CONSEQUENTIAL LOSS. TO THE SAME EXTENT, OUR TOTAL LIABILITY TO YOU IS ZERO.",
				},
				{
					kind: "p",
					text: "Nothing in these terms excludes or limits our liability for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, or for anything else that the law that applies to you does not allow us to exclude or limit. If you are a consumer, you keep every right that the law of the country where you live gives you and does not allow a contract to take away.",
				},
			],
		},
		{
			heading: "Your promise to cover our costs",
			blocks: [
				{
					kind: "p",
					text: "To the extent the law allows, you will compensate us for any claim, loss, liability or reasonable cost, including legal fees, that arises because you broke these terms, broke the law, or infringed someone else's rights while using the app.",
				},
			],
		},
		{
			heading: "Release",
			blocks: [
				{
					kind: "p",
					text: "To the extent the law allows, you release us from all claims arising from your use of the app, including claims you do not know about or suspect when you accept these terms.",
				},
				{
					kind: "p",
					text: 'If you live in California, you waive section 1542 of the California Civil Code, which says: "A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party." If a similar law applies where you live, you waive it to the extent the law allows.',
				},
			],
		},
		{
			heading: "Changes",
			blocks: [
				{
					kind: "p",
					text: "We may change, suspend or end the app, or any part of it, at any time and without notice. We may change these terms. When they change, the app will ask you to accept the new version before you use it again. If you do not accept it, stop using the app.",
				},
			],
		},
		{
			heading: "Law and disputes",
			blocks: [
				{
					kind: "p",
					text: "These terms, and any dispute or claim arising from or connected with them or the app (including non-contractual ones), are governed by the laws of England and Wales.",
				},
				{
					kind: "p",
					text: "Any such dispute will be finally resolved by arbitration under the LCIA Rules, which are part of this section. There will be one arbitrator. The seat of the arbitration is London, England, and the language is English.",
				},
				{
					kind: "p",
					text: "Disputes are resolved only between you and us, one by one. You may not bring or join a class, collective or representative action or arbitration against us, and no arbitrator may combine claims of different people.",
				},
				{
					kind: "p",
					text: "If you are a consumer, nothing in this section takes away the protection of the mandatory laws of the country where you live. Where those laws give you the right to bring a claim in the courts of that country, or to refuse an agreement to arbitrate made before a dispute arose, you keep that right.",
				},
			],
		},
		{
			heading: "General",
			blocks: [
				{
					kind: "list",
					items: [
						"These terms and the Privacy Policy are the whole agreement between you and us about the app.",
						"If a court or arbitrator finds part of these terms invalid or unenforceable, that part is limited or removed to the smallest extent needed, and the rest stays in force.",
						"If we do not enforce a part of these terms at once, we have not given up the right to enforce it later.",
						"We may transfer our rights and duties under these terms to someone else. You may not transfer yours without our written agreement.",
						"No one other than you and us has any right to enforce these terms.",
						"These terms are written in English. A translation is for convenience only.",
					],
				},
			],
		},
	],
}
