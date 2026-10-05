const STORES = [
	{
		id: "patel-textiles",
		name: "Patel Textiles",
		feed: "Google Product Feed",
		note: "variants, out-of-stock alternatives",
	},
	{
		id: "kaveri-coffee",
		name: "Kaveri Coffee Co.",
		feed: "OpenAI ACP feed",
		note: "required checkout fields, back-orders",
	},
	{
		id: "lumen-ceramics",
		name: "Lumen Ceramics",
		feed: "PayPal Enhanced feed",
		note: "fragile goods, regional shipping, pre-orders",
	},
];

const STEPS = [
	["Feed in", "Upload the product feed you already keep for Google Shopping, PayPal or OpenAI."],
	[
		"Agents shop",
		"Your store speaks PayPal's Cart API v1. Every cart problem comes back with a fix an agent can apply.",
	],
	["PayPal checkout", "The buyer approves in PayPal. At checkout the payment is authorized, not taken."],
	["Paid on ship", "Shipping captures the payment and posts tracking to PayPal. Cancelling voids it."],
];

export default function Home() {
	return (
		<main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-14 px-6 py-20">
			<header className="flex flex-col gap-4">
				<p className="font-display text-xl text-zinc-500">
					AgentBaazar <span lang="hi">बाज़ार</span>
				</p>
				<h1 className="font-display text-4xl leading-tight">Agent-ready commerce for every small store, on PayPal.</h1>
				<p className="text-lg text-zinc-600 dark:text-zinc-400">
					AI agents are starting to shop for people. AgentBaazar gives any small store the merchant side of
					PayPal&apos;s agentic commerce contract, so agents can find, fix and pay for carts, and buyers are only
					charged when the order ships.
				</p>
				<div className="flex flex-wrap items-center gap-3">
					<a className="w-fit rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-indigo" href="/shop">
						Try the shopping agent
					</a>
					<a
						className="w-fit rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
						href="https://github.com/rohith1005H/AgentBaazar"
					>
						Source and setup on GitHub
					</a>
				</div>
			</header>

			<section className="grid gap-6 sm:grid-cols-2">
				{STEPS.map(([title, body], i) => (
					<div key={title} className="flex flex-col gap-1">
						<p className="font-mono text-sm text-zinc-500">{String(i + 1).padStart(2, "0")}</p>
						<h2 className="font-medium">{title}</h2>
						<p className="text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-4">
				<h2 className="text-xl font-semibold">Demo stores</h2>
				<ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800">
					{STORES.map((s) => (
						<li key={s.id} className="flex flex-col gap-1 py-3">
							<span className="font-medium">
								{s.name} <span className="font-normal text-zinc-500">· {s.feed}</span>
							</span>
							<span className="text-sm text-zinc-600 dark:text-zinc-400">{s.note}</span>
							<code className="text-xs text-zinc-500">/api/stores/{s.id}/paypal/v1/merchant-cart</code>
						</li>
					))}
				</ul>
				<p className="text-sm text-zinc-600 dark:text-zinc-400">
					Try the public search:{" "}
					<a className="underline" href="/api/stores/patel-textiles/agentic/search?q=kurta">
						/api/stores/patel-textiles/agentic/search?q=kurta
					</a>
					. Cart endpoints need a Cart API JWT, verifiable against{" "}
					<a className="underline" href="/.well-known/jwks.json">
						/.well-known/jwks.json
					</a>
					.
				</p>
			</section>

			<footer className="text-sm text-zinc-500">
				Built for the PayPal AI Hackathon · PayPal sandbox only · Apache-2.0
			</footer>
		</main>
	);
}
