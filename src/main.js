// Production-grade Kariyer.net scraper using:
// Apify SDK + Crawlee + CheerioCrawler + gotScraping + HeaderGenerator + jsdom
//
// - Scrapes listing cards from Kariyer.net listing URLs
// - Optionally visits detail pages for richer data
// - Strong anti-blocking: proxy, sessions, cookies, jitter, TR headers
// - Uses the same stable data-test selectors as the public Kariyer.net Apify actors.

/* eslint-disable no-console */

import { Actor, log } from 'apify';
import {
    CheerioCrawler,
    Dataset,
    log as crawleeLog,
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
// Uses selectors from the production Kariyer.net Scraper actor README:
//   Cards:  div.list-items-wrapper div[data-test="ad-card"]
//   URL:    a[data-test="ad-card-item"]@href
//   Title:  span[data-test="ad-card-title"]
//   Company: span[data-test="subtitle"]
//   Location: span[data-test="location"]
//   Work model: span[data-test="work-model"]
//   Employment type: div.card-footer-wrapper span[data-test="text"]
//   Posted date (relative): span[data-test="ad-date-item-date-other"]
//   Logo: img[data-test="company-image"]@src
//   Sponsored: p[data-test="ad-card-sponsored-item-title"]
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
        } catch (e) {
            // ignore json parse errors
        }
    }
    return null;
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
        || clean($('span:contains("İl/İlçe:")').next().text());

    const descriptionHtml =
        $('[data-test="job-description"]')
            .first()
            .html()
        || $('.job-description, [class*=job-description]').first().html()
        || null;

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
        headerGeneratorOptions: headerGenerator._options || undefined,
        headers: {
            // We still override a bit to look like TR Chrome
            'Accept':
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

await Actor.main(async () => {
    log.info('Kariyer.net production-grade scraper starting...');

    const input = (await Actor.getInput()) || {};

    const {
        startUrls: startUrlsRaw,
        limit: limitRaw = 200,
        maxPages: maxPagesRaw = 50,
        collectDetails = false,
        proxyConfiguration,
        countryCode = 'TR', // used as a hint for Apify proxy group
    } = input;

    const startUrls = Array.isArray(startUrlsRaw) && startUrlsRaw.length
        ? startUrlsRaw
        : ['https://www.kariyer.net/is-ilanlari'];

    const LIMIT = Number.isFinite(+limitRaw) && +limitRaw > 0 ? +limitRaw : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+maxPagesRaw) && +maxPagesRaw > 0 ? +maxPagesRaw : 50;

    log.info(`Input -> startUrls: ${JSON.stringify(startUrls)}, limit: ${LIMIT}, maxPages: ${MAX_PAGES}, collectDetails: ${collectDetails}`);

    const proxyConfig = await Actor.createProxyConfiguration(
        proxyConfiguration || {
            useApifyProxy: true,
            // TR residential is ideal; user can override in actor input.
            groups: ['RESIDENTIAL'],
            countryCode,
        },
    );

    const headerGenerator = buildHeaderGenerator();

    let savedCount = 0;
    const seenDetailUrls = new Set();

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        useSessionPool: true,
        persistCookiesPerSession: true,
        maxRequestRetries: 5,
        maxConcurrency: 3,
        maxRequestsPerCrawl: LIMIT * 5,
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

                // jitter delay 400–1200 ms
                const delay = 400 + Math.floor(Math.random() * 800);
                await Actor.sleep(delay);
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
                requestQueue,
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

            // Get HTML for anti-bot detection
            const html = body?.toString?.() || ($ ? $.html() : '');
            if (looksLikeBlockedPage(html)) {
                crawleeLog.warning(`Anti-bot page detected at ${request.url} (type=${type}, page=${pageNo})`);
                session?.markBad();
                return;
            }

            // ------------------------------------------
            // LIST PAGES
            // ------------------------------------------
            if (type === 'LIST') {
                if (!startUrls.some((u) => request.url.startsWith(u.split('?')[0]))) {
                    // still treat as listing, but log
                    crawleeLog.debug(`Processing LIST-like page: ${request.url}`);
                }

                let jobs = [];
                if ($) {
                    jobs = parseListingCardsCheerio($, request.url);
                    crawleeLog.info(`LIST page ${pageNo} @ ${request.url} -> ${jobs.length} cards via Cheerio`);
                }

                // Fallback with gotScraping + jsdom if Cheerio saw nothing
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
                    if (savedCount >= LIMIT) {
                        crawleeLog.info(`Saved limit ${LIMIT} reached, not enqueuing more.`);
                        return;
                    }

                    if (!collectDetails) {
                        await Dataset.pushData(job);
                        savedCount += 1;
                    } else if (job.url && !seenDetailUrls.has(job.url)) {
                        seenDetailUrls.add(job.url);
                        await requestQueue.addRequest({
                            url: job.url,
                            userData: {
                                type: 'DETAIL',
                                fromListing: job,
                            },
                        });
                    }
                }

                // Pagination – try to follow "next" links up to MAX_PAGES
                if (pageNo < MAX_PAGES && $) {
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

            // ------------------------------------------
            // DETAIL PAGES
            // ------------------------------------------
            if (type === 'DETAIL') {
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
                    const $desc = new JSDOM(`<body>${result.descriptionHtml}</body>`).window.document;
                    result.descriptionText = clean($desc.body.textContent || '');
                }

                await Dataset.pushData(result);
                savedCount += 1;
                crawleeLog.info(`Saved DETAIL ${savedCount}: ${result.title || '(no title)'} - ${result.company || '(no company)'}`);
            }
        },
    });

    // Seed the crawler
    const initialRequests = startUrls.map((u) => ({
        url: u,
        userData: { type: 'LIST', pageNo: 1 },
    }));

    log.info(`Seeding ${initialRequests.length} start URLs...`);
    await crawler.run(initialRequests);

    log.info(`Kariyer.net scraper finished. Total items saved: ${savedCount}`);
});
