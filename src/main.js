// Kariyer.net jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', max_job_age = 'all', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            cookies, cookiesJson, dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.kariyer.net') => {
            try { return new URL(href, base).href; } catch { return null; }
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
            const match = datePosted.match(/(\d+)\s+(\w+)\s+önce/);
            if (!match) return false;
            const num = parseInt(match[1]);
            const unit = match[2];
            let days = 0;
            if (unit.includes('gün')) days = num;
            else if (unit.includes('saat')) days = num / 24;
            else if (unit.includes('dakika')) days = num / (24 * 60);
            else return false;
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

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;
        const headerGenerator = new HeaderGenerator();

        let saved = 0;

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
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                if (/is-ilani\//i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base) {
            const rel = $('a[rel="next"]').attr('href');
            if (rel) return toAbs(rel, base);
            const next = $('a').filter((_, el) => /(sonraki|next|›|»|>)/i.test($(el).text())).first().attr('href');
            if (next) return toAbs(next, base);
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            retryBackoffMs: 1000, // Exponential backoff starting at 1s
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 100, // Aggressive session rotation
            },
            maxConcurrency: 5, // Reduce concurrency for stealth
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 30,
            failedRequestHandler: ({ request, error }) => {
                crawlerLog.error(`Request failed: ${request.url} - ${error.message}`);
            },
            preNavigationHooks: [
                async (context) => {
                    const headers = {
                        ...context.request.headers,
                        ...headerGenerator.getHeaders(),
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                        'Accept-Encoding': 'gzip, deflate, br, zstd',
                        'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
                        'Cache-Control': 'max-age=0',
                        'Priority': 'u=0, i',
                        'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'same-origin',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1',
                        'Referer': context.request.userData?.label === 'DETAIL' ? 'https://www.kariyer.net/is-ilanlari' : 'https://www.kariyer.net/',
                    };
                    if (cookies) headers['Cookie'] = cookies;
                    context.request.headers = headers;
                },
            ],
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST ${request.url} -> found ${links.length} links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length) await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length) { await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'kariyer.net' }))); saved += toPush.length; }
                    }

                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        const next = findNextPage($, request.url);
                        if (next) await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};
                        if (!data.title) data.title = $('h1').first().text().trim() || $('title').text().trim() || null;
                        if (!data.company) data.company = $('h1 a').first().text().trim() || $('[class*="company"]').first().text().trim() || null;
                        if (!data.description_html) { 
                            const descH2 = $('h2').filter((_, el) => /qualifications|job description|nitelikler|iş tanımı/i.test($(el).text())).first();
                            if (descH2.length) {
                                const desc = descH2.nextAll().not('h2').slice(0, 20);
                                data.description_html = desc.length ? String(desc.html()).trim() : null;
                            }
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        if (!data.location) {
                            const locMatch = $('body').text().match(/share(.+?)\[/);
                            data.location = locMatch ? locMatch[1].trim() : $('[class*="location"]').first().text().trim() || location || null;
                        }
                        if (!data.date_posted) {
                            const dateMatch = $('body').text().match(/(\d+ \w+ önce) güncellendi/);
                            data.date_posted = dateMatch ? dateMatch[1] + ' önce güncellendi' : null;
                        }

                        if (!isJobWithinAgeLimit(data.date_posted, max_job_age)) {
                            crawlerLog.info(`Skipping old job: ${data.title} - ${data.date_posted}`);
                            return;
                        }

                        const item = {
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
                        crawlerLog.info(`Saved job ${saved}: ${data.title} by ${data.company}`);
                    } catch (err) { crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`); }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
