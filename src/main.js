// ============================================
// PRODUCTION-GRADE KARIYER.NET SCRAPER
// - Uses hidden job API for listing pages
// - Uses HTML + JSON-LD for detail pages
// - Strong anti-blocking
// - Works on Apify platform with no extra installs
// ============================================

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerio } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

await Actor.init();

(async () => {
    try {
        const input = (await Actor.getInput()) || {};

        const {
            keyword = "",
            location = "",
            max_job_age = "all",
            results_wanted = 100,
            max_pages = 50,
            proxyConfiguration = { useApifyProxy: true, groups: ["RESIDENTIAL"] },
            collectDetails = true,
        } = input;

        const proxy = await Actor.createProxyConfiguration(proxyConfiguration);
        const headerGen = new HeaderGenerator();

        const RESULTS_LIMIT = Number(results_wanted) || 100;
        const MAX_PAGES = Number(max_pages) || 50;

        let saved = 0;

        // ------------------------------
        // Helper: Clean text
        // ------------------------------
        const clean = (t) =>
            (t || "").replace(/\s+/g, " ").trim();

        // ------------------------------
        // Helper: Age filter
        // ------------------------------
        function isWithinMaxAge(dateIso, maxAge) {
            if (maxAge === "all") return true;
            if (!dateIso) return true;
            const dt = new Date(dateIso);
            if (isNaN(dt)) return true;
            const days = (Date.now() - dt.getTime()) / 86400000;
            if (maxAge === "24 hours") return days <= 1;
            if (maxAge === "7 days") return days <= 7;
            if (maxAge === "30 days") return days <= 30;
            return true;
        }

        // =========================================================
        // PART 1: USE KARIYER.NET HIDDEN API FOR LISTINGS
        // =========================================================
        //
        // Hidden API endpoint (public):
        // https://api.kariyer.net/search/positions?page=1&keyword=...&location=...
        //
        // This returns JSON:
        // { data: { positions: [...], pageCount: ... } }
        //
        // Much less protected than HTML listings!
        // =========================================================

        async function fetchListingPage(page) {
            const url = new URL("https://api.kariyer.net/search/positions");
            url.searchParams.set("page", page);
            if (keyword) url.searchParams.set("keyword", keyword);
            if (location) url.searchParams.set("location", location);

            const headers = headerGen.getHeaders({
                browsers: ["chrome"],
                devices: ["desktop"],
                operatingSystems: ["windows"],
            });

            const { body } = await Actor.fetch(url.href, {
                proxyUrl: proxy.newUrl(),
                headers,
                timeoutSecs: 30,
            });

            return JSON.parse(body.toString());
        }

        const detailUrls = [];

        log.info("Fetching listing pages via Kariyer API...");

        for (let page = 1; page <= MAX_PAGES; page++) {
            if (saved >= RESULTS_LIMIT) break;

            let json;
            try {
                json = await fetchListingPage(page);
            } catch (err) {
                log.warning(`Page ${page} failed: ${err.message}`);
                continue;
            }

            const positions = json?.data?.positions || [];
            log.info(`API Page ${page}: found ${positions.length} jobs`);

            for (const p of positions) {
                if (saved >= RESULTS_LIMIT) break;

                // Format: https://www.kariyer.net/is-ilani/{slug}-{id}
                if (!p.positionUrl) continue;

                if (!isWithinMaxAge(p.publishDate, max_job_age)) continue;

                detailUrls.push(p.positionUrl);
                saved++;

                if (!collectDetails) {
                    await Dataset.pushData({
                        url: p.positionUrl,
                        title: p.title,
                        company: p.companyName,
                        location: p.location,
                        publish_date: p.publishDate,
                    });
                }
            }

            if (positions.length === 0) break;
        }

        log.info(`Collected ${detailUrls.length} detail URLs from API`);

        if (!collectDetails) {
            log.info("Finished (listing only mode)");
            await Actor.exit();
            return;
        }

        // =========================================================
        // PART 2: SCRAPE DETAIL PAGES
        // =========================================================

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxy,
            maxConcurrency: 3,
            useSessionPool: true,
            maxRequestRetries: 5,
            requestHandlerTimeoutSecs: 60,

            preNavigationHooks: [
                async ({ request }) => {
                    request.headers = {
                        ...headerGen.getHeaders({
                            browsers: ["chrome"],
                            devices: ["desktop"],
                            operatingSystems: ["windows"],
                        }),
                        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
                        "Referer": "https://www.kariyer.net/is-ilanlari",
                    };
                },
            ],

            failedRequestHandler: ({ request, error }) => {
                log.error(`FAILED: ${request.url} - ${error?.message}`);
            },

            async requestHandler({ request, $, response }) {
                const url = request.url;
                log.info(`Detail: ${url}`);

                if (response?.statusCode >= 400) {
                    log.warning(`HTTP ${response.statusCode} at ${url}`);
                    return;
                }

                const body = $.html() || "";
                const pageText = $("body").text() || "";

                // Anti-bot detection
                if (/access denied|ddos|cloudflare|blocked/i.test(body)) {
                    log.warning(`Anti-bot page detected at ${url}`);
                    return;
                }

                // Try JSON-LD first
                let data = { url };

                $("script[type='application/ld+json']").each((i, el) => {
                    try {
                        const obj = JSON.parse($(el).html());
                        if (obj["@type"] === "JobPosting") {
                            data.title = obj.title || null;
                            data.company = obj.hiringOrganization?.name || null;
                            data.date_posted = obj.datePosted || null;
                            data.description_html = obj.description || null;
                            data.location =
                                obj.jobLocation?.address?.addressLocality ||
                                obj.jobLocation?.address?.addressRegion ||
                                null;
                        }
                    } catch {}
                });

                // Title fallback
                if (!data.title) data.title = clean($("h1").first().text());

                // Company fallback
                if (!data.company)
                    data.company =
                        clean($("[class*=company]").first().text()) ||
                        clean($("h1 a").first().text());

                // Description fallback
                if (!data.description_html) {
                    const desc = $("[class*=job-description], .description, #job-description")
                        .first()
                        .html();
                    data.description_html = desc || null;
                }

                data.description_text = data.description_html
                    ? clean(cheerio(data.description_html).text())
                    : null;

                // Location fallback
                if (!data.location)
                    data.location =
                        clean($("[class*=location]").first().text()) || null;

                // Date fallback
                if (!data.date_posted) {
                    const m = pageText.match(/(\d{4}-\d{2}-\d{2})/);
                    data.date_posted = m ? m[1] : null;
                }

                await Dataset.pushData(data);
            },
        });

        await crawler.run(detailUrls.map((u) => ({ url: u })));

        log.info("Completed all detail pages.");
        await Actor.exit();

    } catch (err) {
        log.error(`Fatal error: ${err.stack}`);
        await Actor.exit();
    }
})();
