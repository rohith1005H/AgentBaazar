/**
 * Real products from other online shops, via Channel3's product search
 * (POST https://api.trychannel3.com/v1/search). Shown next to AgentBaazar stores for
 * comparison: the agent cannot buy these (those shops do not offer an agent checkout),
 * so they open on the shop's own site.
 */
export type WebProductView = {
	title: string;
	brand?: string;
	shop: string;
	price: string;
	url: string;
	image_url?: string;
};

type C3Product = {
	title: string;
	category?: { slug: string } | null;
	brands?: { name: string }[];
	images?: { url: string; cleaned_url?: string | null; is_main_image?: boolean }[];
	offers?: { url: string; domain: string; price: { price: number; currency: string }; availability: string }[];
};

const TTL_MS = 10 * 60_000;
// ponytail: per-instance cache; fine for one Render instance
const cache = new Map<string, { at: number; results: WebProductView[] }>();

export const webSearchEnabled = () => Boolean(process.env.CHANNEL3_API_KEY);

/**
 * Keep results that are the product asked for: every query word in the title, and the
 * category most of those share. A catalog that has no real match (Channel3 has little
 * food, so "coffee beans" finds ornaments and journals) then yields nothing, not junk.
 * ponytail: word-and-category heuristic; let the model rank results if it misfires.
 */
export function relevant<T extends C3Product>(query: string, products: T[]): T[] {
	const words = query
		.toLowerCase()
		.split(/\W+/)
		.filter((w) => w.length > 2);
	const hasWord = (title: string, w: string) => title.includes(w) || title.includes(w.replace(/e?s$/, ""));
	const matching = products.filter((p) => words.every((w) => hasWord(p.title.toLowerCase(), w)));
	const counts = new Map<string, number>();
	for (const p of matching) if (p.category?.slug) counts.set(p.category.slug, (counts.get(p.category.slug) ?? 0) + 1);
	const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
	return n >= 2 ? matching.filter((p) => p.category?.slug === top) : [];
}

/** `query` should be the product type ("kurta", "terracotta planter"), not the buyer's whole sentence. */
export async function searchWeb(query: string): Promise<WebProductView[]> {
	const key = query.toLowerCase().trim();
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

	const res = await fetch("https://api.trychannel3.com/v1/search", {
		method: "POST",
		headers: { "x-api-key": process.env.CHANNEL3_API_KEY!, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			limit: 12,
			filters: { availability: ["InStock"] },
			config: { country: "US", currency: "USD" },
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`Channel3 search failed (${res.status})`);
	const { products } = (await res.json()) as { products: C3Product[] };

	const results = relevant(query, products)
		.slice(0, 4)
		.flatMap((p): WebProductView[] => {
			const offer = p.offers?.find((o) => o.availability === "InStock") ?? p.offers?.[0];
			if (!offer || !/^https?:\/\//.test(offer.url)) return [];
			const image = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
			return [
				{
					title: p.title,
					...(p.brands?.[0] && { brand: p.brands[0].name }),
					shop: offer.domain,
					price: `$${offer.price.price.toFixed(2)}`,
					url: offer.url,
					...(image && { image_url: image.cleaned_url ?? image.url }),
				},
			];
		});
	cache.set(key, { at: Date.now(), results });
	return results;
}
