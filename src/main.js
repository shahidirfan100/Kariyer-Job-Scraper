// Kariyer.net jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

// Single-entrypoint main
await Actor.init();

async function main() {
    log.info('Starting Kariyer.net Jobs Scraper');
    try {
        const input = (await Actor.getInput()) || {};

        const {
            keyword = '',
            location = '',
            category = '',
            max_job_age = 'all',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            cookies,
            cookiesJson, // currently unused but kept for backwards-compat
            dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;

        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        const MAX_REQUESTS_PER_CRAWL = RESULTS_WANTED * (collectDetails ? 2 : 1) + MAX_PAGES * 2;

        const toAbs = (href, base = 'https://www.kariyer.net') => {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const isJobWithinAgeLimit = (datePosted, maxAge) => {
            if (maxAge === 'all') return true;
            if (!datePosted) return false;

            let days = 0;
            const str = String(datePosted).toLowerCase();
            const relMatch = str.match(/(\d+)\s+(\w+)\s+önce/);

            if (relMatch) {
                const num = parseInt(relMatch[1], 10);
                const unit = relMatch[2];
                if (unit.includes('gün')) days = num;
                else if (unit.includes('saat')) days = num / 24;
                else if (unit.includes('dakika')) days = num / (24 * 60);
                else return false;
            } else {
                const d = new Date(datePosted);
                if (Number.isNaN(d.getTime())) return false;
                days = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
            }

            if (maxAge === '24 hours') return days <= 1;
            if (maxAge === '7 days') return days <= 7;
            if (maxAge === '30 days') return days <= 30;
            return true;
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.kariyer.net/is-ilanlari/');
            if (kw) u.searchParams.set('kw', String(kw).trim());
            if (loc) u.searchParams.set('loc', String(loc).trim());
            if (cat) u.searchParams.set('cat', String(cat).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        log.info(`Initial URLs: ${initial.join(', ')}`);

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        const headerGenerator = new HeaderGenerator();

        let saved = 0;
        const seenDetailUrls = new Set();

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location:
                                    (e.jobLocation &&
                                        e.jobLocation.address &&
                                        (e.jobLocation.address.addressLocality ||
                                            e.jobLocation.address.addressRegion)) ||
                                    null,
                            };
                        }
                    }
                } catch {
                    // Ignore parsing errors and move on
                }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                if (/\/is-ilani/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base) {
            const rel = $('a[rel="next"]').attr('href');
            if (rel) return toAbs(rel, base);
            const next = $('a')
                .filter((_, el) => /(sonraki|next|›|»|>)/i.test($(el).text()))
                .first()
                .attr('href');
            if (next) return toAbs(next, base);
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            retryBackoffMillis: 1000,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 25,
                },
            },
            minConcurrency: 2,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 60,
            maxRequestsPerCrawl: MAX_REQUESTS_PER_CRAWL,

            failedRequestHandler: ({ request, error }) => {
                log.error(`Request failed: ${request.url} - ${error?.message || error}`);
            },

            preNavigationHooks: [
                async ({ request, session }) => {
                    const headersFromGenerator = headerGenerator.getHeaders({
                        devices: ['desktop'],
                        browsers: ['chrome'],
                        operatingSystems: ['windows'],
                    });

                    const baseHeaders = {
                        ...headersFromGenerator,
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Upgrade-Insecure-Requests': '1',
                        Referer:
                            request.userData?.label === 'DETAIL'
                                ? 'https://www.kariyer.net/is-ilanlari'
                                : 'https://www.kariyer.net/',
                    };

                    if (cookies) baseHeaders.Cookie = cookies;

                    request.headers = {
                        ...baseHeaders,
                        ...request.headers,
                    };
                },
            ],

            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Random jitter on each request for stealth (on top of any global delay)
                await Actor.sleep(500 + Math.random() * 1500);

                if (!$) {
                    crawlerLog.warning(`No DOM loaded for ${request.url}, label ${label}`);
                    return;
                }

                const bodyText = $('body').text() || '';
                const titleText = $('title').text() || '';
                if (/cloudflare|ddos protection|just a moment/i.test(bodyText + ' ' + titleText)) {
                    crawlerLog.warning(
                        `Anti-bot/Cloudflare-like page detected at ${request.url}. Skipping.`
                    );
                    return;
                }

                crawlerLog.info(`Processing ${request.url} with label ${label}, page ${pageNo}`);

                if (label === 'LIST') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info('Desired number of jobs already saved, skipping LIST page.');
                        return;
                    }

                    let links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} raw links`);

                    if (dedupe) {
                        links = links.filter((u) => {
                            if (seenDetailUrls.has(u)) return false;
                            seenDetailUrls.add(u);
                            return true;
                        });
                        crawlerLog.info(
                            `LIST ${request.url} -> ${links.length} links after dedupe`
                        );
                    }

                    const remaining = RESULTS_WANTED - saved;

                    if (collectDetails) {
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) {
                            crawlerLog.info(
                                `Enqueuing ${toEnqueue.length} DETAIL URLs from LIST ${request.url}`
                            );
                            await enqueueLinks({
                                urls: toEnqueue,
                                userData: { label: 'DETAIL' },
                            });
                        }
                    } else {
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) {
                            const items = toPush.map((u) => ({
                                source: 'kariyer.net',
                                url: u,
                            }));
                            await Dataset.pushData(items);
                            saved += items.length;
                            crawlerLog.info(`Saved ${items.length} listing URLs, total saved: ${saved}`);
                        }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) {
                            crawlerLog.info(
                                `Enqueueing next LIST page ${pageNo + 1}: ${next}`
                            );
                            await enqueueLinks({
                                urls: [next],
                                userData: { label: 'LIST', pageNo: pageNo + 1 },
                            });
                        } else {
                            crawlerLog.info(`No next page link found on LIST page ${request.url}`);
                        }
                    } else {
                        crawlerLog.info(
                            `Stopping pagination: saved=${saved}, pageNo=${pageNo}, MAX_PAGES=${MAX_PAGES}`
                        );
                    }

                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info('Desired number of jobs already saved, skipping DETAIL page.');
                        return;
                    }

                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};

                        // Title
                        if (!data.title) {
                            data.title =
                                $('h1').first().text().trim() ||
                                $('meta[property="og:title"]').attr('content') ||
                                $('title').text().trim() ||
                                null;
                        }

                        // Company
                        if (!data.company) {
                            data.company =
                                $('[class*="company"]').first().text().trim() ||
                                $('h1 a').first().text().trim() ||
                                $('[itemprop="hiringOrganization"]').text().trim() ||
                                null;
                        }

                        // Description
                        if (!data.description_html) {
                            const descH2 = $('h2')
                                .filter((_, el) =>
                                    /qualifications|job description|nitelikler|iş tanımı/i.test(
                                        $(el).text()
                                    )
                                )
                                .first();

                            if (descH2.length) {
                                const descNodes = descH2.nextAll().not('h2').slice(0, 20);
                                const html = descNodes
                                    .map((_, el) => $.html(el))
                                    .get()
                                    .join('\n');
                                data.description_html = html.trim() || null;
                            }
                        }
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Location
                        if (!data.location) {
                            data.location =
                                $('[class*="location"]').first().text().trim() ||
                                $('[itemprop="addressLocality"]').first().text().trim() ||
                                location ||
                                null;
                        }

                        // Date posted (fallback from page text if needed)
                        if (!data.date_posted) {
                            const dateMatch = $('body')
                                .text()
                                .match(/(\d+\s+\w+\s+önce)\s+güncellendi/i);
                            data.date_posted = dateMatch ? dateMatch[1] : null;
                        }

                        if (!isJobWithinAgeLimit(data.date_posted, max_job_age)) {
                            crawlerLog.info(
                                `Skipping old job: ${data.title || '(no title)'} - ${
                                    data.date_posted
                                }`
                            );
                            return;
                        }

                        const item = {
                            source: 'kariyer.net',
                            title: data.title || null,
                            company: data.company || null,
                            location: data.location || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(
                            `Saved job ${saved}: ${data.title} by ${data.company} (${request.url})`
                        );
                    } catch (err) {
                        crawlerLog.error(
                            `DETAIL ${request.url} failed: ${err?.message || err}`
                        );
                    }
                }
            },
        });

        await crawler.run(
            initial.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            }))
        );

        log.info(`Finished. Saved ${saved} items`);
    } catch (err) {
        log.exception(err, 'Actor failed with an error');
        throw err;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
