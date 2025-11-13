// Production-grade Kariyer.net scraper using:
// Apify SDK + Crawlee + CheerioCrawler + gotScraping + HeaderGenerator + jsdom
//
// - Scrapes listing cards from Kariyer.net listing URLs
// - Optionally visits detail pages for richer data
// - Strong anti-blocking: proxy, sessions, cookies, jitter, TR headers
// - Uses stable-looking data-test selectors + aggressive fallbacks for descriptions.
// - Respects per-run job limit (multiple input field names supported).
// - Configurable maxConcurrency for speed (default 10, still safe & stealthy).
//
// Supported INPUT fields (any subset is fine):
// {
//   "startUrls": ["https://www.kariyer.net/is-ilanlari"],
//   "limit": 20,                  // desired jobs (primary)
//   "results_wanted": 20,         // alt name
//   "resultsWanted": 20,          // alt name
//   "maxItems": 20,               // alt name
//   "maxResults": 20,             // alt name
//   "maxPages": 50,               // max LIST pages per start URL
//   "collectDetails": true,       // whether to visit detail pages
//   "maxConcurrency": 10,         // crawler concurrency
//   "proxyConfiguration": {
//     "useApifyProxy": true,
//     "groups": ["RESIDENTIAL"]
//   },
//   "countryCode": "TR"
// }

/* eslint-disable no-console */

import { Actor, log } from 'apify';
import {
    CheerioCrawler,
    Dataset,
    log as crawleeLog,
    sleep,
} from 'crawlee';
import { gotScraping } from 'got-scraping';
import { JSDOM } from 'jsdom';
import { HeaderGenerator } from 'header-generator';

// -----------------------
// Small helpers
// -----------------------

const clean = (val) => (val || '').replace(/\s+/g, ' ').trim() || null;

const buildHeaderGenerator = () => new HeaderGenerator({
    browsers: [
        {
            name: 'chrome',
            minVersion: 100,
            maxVersion: 122,
        },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['tr-TR', 'tr', 'en-US'],
});

// Anti-bot keyword detection on HTML
const looksLikeBlockedPage = (html) => {
    if (!html) return false;
    const lower = html.toLowerCase();
    return [
        'access denied',
        'ddos protection',
        'temporarily blocked',
        'cloudflare',
        'just a moment',
        'are you a robot',
        'forbidden',
    ].some((k) => lower.includes(k));
};

// -----------------------
// Listing card parsing
// -----------------------

function parseListingCardsCheerio($, baseUrl) {
    const jobs = [];
    const cards = $('div.list-items-wrapper div[data-test="ad-card"]');

    cards.each((_, el) => {
        const card = $(el);

        let href =
            card.find('a[data-test="ad-card-item"]').attr('href')
            || card.find('a[href*="/is-ilani"]').attr('href');

        if (!href) return;

        try {
            const url = new URL(href, baseUrl).href;

            const title = clean(card.find('span[data-test="ad-card-title"]').text());
            const company = clean(card.find('span[data-test="subtitle"]').text());
            const location = clean(card.find('span[data-test="location"]').text());
            const workModel = clean(card.find('span[data-test="work-model"]').text());

            const employmentType = clean(
                card
                    .find('div.card-footer-wrapper span[data-test="text"]')
                    .first()
                    .text(),
            );

            const postedRelative = clean(
                card.find('span[data-test="ad-date-item-date-other"]').text(),
            );

            const logoUrl = card.find('img[data-test="company-image"]').attr('src') || null;
            const sponsored = card.find('p[data-test="ad-card-sponsored-item-title"]').length
                ? true
                : null;

            // Extract numeric ID from URL: last "-" separated chunk
            const urlObj = new URL(url);
            const slugPart = urlObj.pathname.split('/').pop() || '';
            const idMatch = slugPart.match(/(\d+)$/);
            const id = idMatch ? idMatch[1] : null;

            jobs.push({
                id,
                url,
                title,
                company,
                location,
                workModel,
                employmentType,
                postedRelative,
                logoUrl,
                sponsored,
                source: 'kariyer.net',
                crawledAt: new Date().toISOString(),
            });
        } catch (e) {
            crawleeLog.debug(`Failed to normalize card href "${href}" on ${baseUrl}: ${e.message}`);
        }
    });

    return jobs;
}

function parseListingCardsDom(html, baseUrl) {
    const jobs = [];
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const cards = doc.querySelectorAll('div.list-items-wrapper div[data-test="ad-card"]');
    cards.forEach((card) => {
        const linkEl =
            card.querySelector('a[data-test="ad-card-item"]')
            || card.querySelector('a[href*="/is-ilani"]');

        if (!linkEl) return;
        const href = linkEl.getAttribute('href');
        if (!href) return;

        try {
            const url = new URL(href, baseUrl).href;

            const sel = (q) => {
                const el = card.querySelector(q);
                return el ? clean(el.textContent || '') : null;
            };

            const title = sel('span[data-test="ad-card-title"]');
            const company = sel('span[data-test="subtitle"]');
            const location = sel('span[data-test="location"]');
            const workModel = sel('span[data-test="work-model"]');

            let employmentType = null;
            const et = card.querySelector('div.card-footer-wrapper span[data-test="text"]');
            if (et) employmentType = clean(et.textContent || '');

            const postedRelative = sel('span[data-test="ad-date-item-date-other"]');

            const logo = card.querySelector('img[data-test="company-image"]');
            const logoUrl = logo ? logo.getAttribute('src') : null;

            const sponsored = card.querySelector('p[data-test="ad-card-sponsored-item-title"]')
                ? true
                : null;

            const urlObj = new URL(url);
            const slugPart = urlObj.pathname.split('/').pop() || '';
            const idMatch = slugPart.match(/(\d+)$/);
            const id = idMatch ? idMatch[1] : null;

            jobs.push({
                id,
                url,
                title,
                company,
                location,
                workModel,
                employmentType,
                postedRelative,
                logoUrl,
                sponsored,
                source: 'kariyer.net',
                crawledAt: new Date().toISOString(),
            });
        } catch (e) {
            crawleeLog.debug(`DOM fallback: failed to normalize card href "${href}" on ${baseUrl}: ${e.message}`);
        }
    });

    return jobs;
}

// -----------------------
// Detail page JSON-LD / HTML parsing
// -----------------------

function extractJobFromJsonLd($) {
    const scripts = $('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
        try {
            const raw = $(scripts[i]).html() || '';
            if (!raw.trim()) continue;
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const obj of arr) {
                if (!obj) continue;
                const t = obj['@type'] || obj.type;
                const types = Array.isArray(t) ? t : [t];
                if (types.includes('JobPosting')) {
                    return {
                        title: obj.title || obj.name || null,
                        company: obj.hiringOrganization?.name || null,
                        datePosted: obj.datePosted || null,
                        descriptionHtml: obj.description || null,
                        location:
                            obj.jobLocation?.address?.addressLocality
                            || obj.jobLocation?.address?.addressRegion
                            || null,
                        employmentType: Array.isArray(obj.employmentType)
                            ? obj.employmentType.join(', ')
                            : obj.employmentType || null,
                        validThrough: obj.validThrough || null,
                        occupationalCategory: obj.occupationalCategory || null,
                        baseSalary: obj.baseSalary || null,
                    };
                }
            }
        } catch {
            // ignore json parse errors
        }
    }
    return null;
}

// Aggressive HTML description extraction:
// 1) data-test / id / class patterns
// 2) Section containing keywords like "İş Tanımı", "Görev ve Sorumluluklar"
function extractDescriptionHtml($) {
    let descEl = $(
        [
            '[data-test*="job-description"]',
            '[class*="job-description"]',
            '[id*="job-description"]',
            '[data-test*="job-detail"]',
        ].join(','),
    ).first();

    if (!descEl || !descEl.length) {
        // keyword-based section detection
        const candidates = $('section, div, article')
            .filter((_, el) => {
                const t = $(el).text();
                if (!t) return false;
                const len = t.trim().length;
                return (
                    len > 300
                    && /iş tanımı|görev ve sorumluluklar|aranan nitelikler|job description/i.test(t)
                );
            });

        if (candidates.length) {
            descEl = candidates.first();
        }
    }

    if (!descEl || !descEl.length) return null;

    // Avoid capturing entire page – trim nested huge containers if any
    return descEl.html() || null;
}

function extractJobFromHtml($) {
    const title =
        clean($('h1').first().text())
        || clean($('[data-test="job-title"]').first().text());

    const company =
        clean($('[data-test="company-name"]').first().text())
        || clean($('a[href*="/firma/"]').first().text());

    const location =
        clean($('[data-test="job-location"]').first().text())
        || clean($('span:contains("İl/İlçe")').next().text());

    const descriptionHtml =
        extractDescriptionHtml($);

    let employmentType = null;
    const etLabel = $('span:contains("Çalışma Şekli")').closest('li');
    if (etLabel.length) {
        employmentType = clean(etLabel.find('span').last().text());
    }

    return {
        title: title || null,
        company: company || null,
        location: location || null,
        employmentType: employmentType || null,
        descriptionHtml,
    };
}

// -----------------------
// GOT + jsdom fallback for listings
// -----------------------

async function fetchListingWithGot(url, proxyConfiguration, headerGenerator) {
    let proxyUrl;
    if (proxyConfiguration) {
        proxyUrl = await proxyConfiguration.newUrl();
    }

    const { body } = await gotScraping({
        url,
        proxyUrl,
        timeout: { request: 30000 },
        http2: true,
        useHeaderGenerator: true,
        headers: {
            Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
        },
    });

    return body.toString();
}

// -----------------------
// MAIN
// -----------------------

Actor.main(async () => {
    log.info('Kariyer.net production-grade scraper starting...');

    const input = (await Actor.getInput()) || {};

    const {
        startUrls: startUrlsRaw,
        maxPages: maxPagesRaw = 50,
        collectDetails = false,
        maxConcurrency: maxConcurrencyRaw = 10,
        proxyConfiguration,
        countryCode = 'TR',
    } = input;

    // Respect multiple possible field names for LIMIT; pick smallest positive if multiple present
    const limitCandidates = [
        input.limit,
        input.results_wanted,
        input.resultsWanted,
        input.maxItems,
        input.maxResults,
    ]
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0);

    const LIMIT = limitCandidates.length
        ? Math.min(...limitCandidates)
        : 200; // fallback default

    const MAX_PAGES = Number.isFinite(+maxPagesRaw) && +maxPagesRaw > 0 ? +maxPagesRaw : 50;

    const startUrls = Array.isArray(startUrlsRaw) && startUrlsRaw.length
        ? startUrlsRaw
        : ['https://www.kariyer.net/is-ilanlari'];

    const maxConcurrency = Number.isFinite(+maxConcurrencyRaw) && +maxConcurrencyRaw > 0
        ? +maxConcurrencyRaw
        : 10;

    log.info(`Input -> startUrls: ${JSON.stringify(startUrls)}, limit: ${LIMIT}, maxPages: ${MAX_PAGES}, collectDetails: ${collectDetails}, maxConcurrency: ${maxConcurrency}`);

    const proxyConfig = await Actor.createProxyConfiguration(
        proxyConfiguration || {
            useApifyProxy: true,
            groups: ['RESIDENTIAL'],
            countryCode,
        },
    );

    const headerGenerator = buildHeaderGenerator();

    let savedCount = 0;          // how many items we have actually written to Dataset
    let detailQueuedCount = 0;   // how many DETAIL URLs have been enqueued

    const seenDetailUrls = new Set();

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        useSessionPool: true,
        persistCookiesPerSession: true,
        maxRequestRetries: 5,
        maxConcurrency,
        maxRequestsPerCrawl: LIMIT * (collectDetails ? 4 : 2),
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 60,

        preNavigationHooks: [
            async (crawlingContext, gotOptions) => {
                const { request } = crawlingContext;
                const generatedHeaders = headerGenerator.getHeaders({
                    browsers: ['chrome'],
                    devices: ['desktop'],
                    operatingSystems: ['windows'],
                    locales: ['tr-TR', 'tr', 'en-US'],
                });

                request.headers = {
                    ...generatedHeaders,
                    ...request.headers,
                    Accept:
                        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Upgrade-Insecure-Requests': '1',
                };

                if (gotOptions) {
                    gotOptions.headers = request.headers;
                }

                // jitter delay 200–800 ms (fast but not insane)
                const delay = 200 + Math.floor(Math.random() * 600);
                await sleep(delay);
            },
        ],

        failedRequestHandler: ({ request, error }) => {
            log.error(`FAILED: ${request.url}  (retries: ${request.retryCount})  error: ${error?.message}`);
        },

        async requestHandler(ctx) {
            const {
                request,
                $,
                body,
                response,
                session,
                enqueueLinks,
            } = ctx;

            const type = request.userData.type || 'LIST';
            const pageNo = request.userData.pageNo || 1;

            const status = response?.statusCode;
            if (status && status >= 400) {
                crawleeLog.warning(`HTTP ${status} on ${type} ${request.url}`);
                if (session && (status === 403 || status === 429)) {
                    session.markBad();
                }
                return;
            }

            const html = body?.toString?.() || ($ ? $.html() : '');
            if (looksLikeBlockedPage(html)) {
                crawleeLog.warning(`Anti-bot page detected at ${request.url} (type=${type}, page=${pageNo})`);
                session?.markBad();
                return;
            }

            // LIST pages
            if (type === 'LIST') {
                if (!startUrls.some((u) => request.url.startsWith(u.split('?')[0]))) {
                    crawleeLog.debug(`Processing LIST-like page: ${request.url}`);
                }

                // If we've already queued enough DETAIL pages, don't do any more work here.
                if (collectDetails && detailQueuedCount >= LIMIT) {
                    crawleeLog.info(`DETAIL queue already has ${detailQueuedCount} URLs (limit ${LIMIT}), skipping LIST page ${pageNo} at ${request.url}`);
                    return;
                }

                let jobs = [];
                if ($) {
                    jobs = parseListingCardsCheerio($, request.url);
                    crawleeLog.info(`LIST page ${pageNo} @ ${request.url} -> ${jobs.length} cards via Cheerio`);
                }

                // Fallback with gotScraping + jsdom
                if ((!jobs || jobs.length === 0) && !looksLikeBlockedPage(html)) {
                    try {
                        crawleeLog.info(`Cheerio saw 0 cards, using gotScraping + jsdom fallback for ${request.url}`);
                        const fallbackHtml = await fetchListingWithGot(request.url, proxyConfig, headerGenerator);

                        if (looksLikeBlockedPage(fallbackHtml)) {
                            crawleeLog.warning(`Fallback gotScraping also hit anti-bot at ${request.url}`);
                        } else {
                            const domJobs = parseListingCardsDom(fallbackHtml, request.url);
                            crawleeLog.info(`Fallback DOM parser found ${domJobs.length} cards at ${request.url}`);
                            jobs = domJobs;
                        }
                    } catch (e) {
                        crawleeLog.error(`gotScraping fallback failed for ${request.url}: ${e.message}`);
                    }
                }

                if (!jobs || jobs.length === 0) {
                    crawleeLog.warning(`LIST page ${pageNo} has 0 job cards after all attempts: ${request.url}`);
                    return;
                }

                for (const job of jobs) {
                    if (!collectDetails) {
                        if (savedCount >= LIMIT) {
                            crawleeLog.info(`Saved limit ${LIMIT} reached, not saving more listing items.`);
                            break;
                        }
                        await Dataset.pushData(job);
                        savedCount += 1;
                    } else {
                        // detail mode
                        if (detailQueuedCount >= LIMIT) {
                            crawleeLog.info(`DETAIL queue limit ${LIMIT} reached while iterating jobs on LIST page ${pageNo}.`);
                            break;
                        }

                        if (job.url && !seenDetailUrls.has(job.url)) {
                            seenDetailUrls.add(job.url);
                            detailQueuedCount += 1;
                            await enqueueLinks({
                                urls: [job.url],
                                userData: { type: 'DETAIL', fromListing: job },
                            });
                        }
                    }
                }

                // Pagination – follow "next" links up to MAX_PAGES, but only if we still need more
                const needMore = collectDetails ? detailQueuedCount < LIMIT : savedCount < LIMIT;
                if (needMore && pageNo < MAX_PAGES && $) {
                    await enqueueLinks({
                        selector: 'a[aria-label*="Sonraki"], a[rel="next"], a:contains("navigate_next"), a[aria-label*="Next"], a[aria-label*="next"]',
                        transformRequestFunction: (req) => {
                            req.userData = {
                                ...req.userData,
                                type: 'LIST',
                                pageNo: pageNo + 1,
                            };
                            return req;
                        },
                    });
                }

                return;
            }

            // DETAIL pages
            if (type === 'DETAIL') {
                if (savedCount >= LIMIT) {
                    crawleeLog.info(`Saved limit ${LIMIT} reached, skipping DETAIL ${request.url}`);
                    return;
                }

                const base = request.userData.fromListing || {};
                const result = {
                    ...base,
                    url: request.url,
                };

                let jsonLd = null;
                if ($) {
                    jsonLd = extractJobFromJsonLd($);
                }

                let htmlFallback = null;
                if ($) {
                    htmlFallback = extractJobFromHtml($);
                }

                if (jsonLd) {
                    result.title = result.title || jsonLd.title || null;
                    result.company = result.company || jsonLd.company || null;
                    result.datePosted = jsonLd.datePosted || null;
                    result.location = result.location || jsonLd.location || null;
                    result.employmentType = result.employmentType || jsonLd.employmentType || null;
                    result.validThrough = jsonLd.validThrough || null;
                    result.occupationalCategory = jsonLd.occupationalCategory || null;

                    if (jsonLd.descriptionHtml) {
                        result.descriptionHtml = jsonLd.descriptionHtml;
                    }
                    if (jsonLd.baseSalary) {
                        result.baseSalary = jsonLd.baseSalary;
                    }
                }

                if (htmlFallback) {
                    result.title = result.title || htmlFallback.title || null;
                    result.company = result.company || htmlFallback.company || null;
                    result.location = result.location || htmlFallback.location || null;
                    result.employmentType = result.employmentType || htmlFallback.employmentType || null;
                    result.descriptionHtml = result.descriptionHtml || htmlFallback.descriptionHtml || null;
                }

                if (result.descriptionHtml) {
                    const descDom = new JSDOM(`<body>${result.descriptionHtml}</body>`).window.document;
                    result.descriptionText = clean(descDom.body.textContent || '');
                } else if ($) {
                    // Ultra fallback: largest text block in body
                    const texts = $('p, li, div, section')
                        .map((_, el) => clean($(el).text()) || '')
                        .get()
                        .filter((t) => t.length > 200);
                    if (texts.length) {
                        const best = texts.reduce((a, b) => (b.length > a.length ? b : a));
                        result.descriptionText = best;
                    }
                }

                await Dataset.pushData(result);
                savedCount += 1;
                crawleeLog.info(`Saved DETAIL ${savedCount}: ${result.title || '(no title)'} - ${result.company || '(no company)'}`);
            }
        },
    });

    const initialRequests = startUrls.map((u) => ({
        url: u,
        userData: { type: 'LIST', pageNo: 1 },
    }));

    log.info(`Seeding ${initialRequests.length} start URLs...`);
    await crawler.run(initialRequests);

    log.info(`Kariyer.net scraper finished. Total items saved: ${savedCount}`);
});
