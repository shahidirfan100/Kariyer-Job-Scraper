# Kariyer.net Jobs Scraper

Scrape job listings from Kariyer.net, Turkey's leading job board. Extract detailed job information including titles, companies, locations, descriptions, and posting dates. Perfect for job market analysis, recruitment, and career research.

## Features

- **Comprehensive Scraping**: Collects job listings from Kariyer.net search results and detailed job pages.
- **Flexible Filtering**: Search by keywords, locations, and job age (last 24 hours, 7 days, 30 days, or all).
- **Pagination Support**: Automatically handles multiple pages to gather the desired number of results.
- **Detailed Extraction**: Retrieves full job descriptions, company details, and metadata.
- **Structured Output**: Saves data in a clean, consistent format for easy analysis.
- **Proxy Integration**: Supports residential proxies for reliable scraping.

## Input

Configure the scraper with the following parameters:

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `startUrl` | string | Specific Kariyer.net search URL to start from. Overrides keyword/location if provided. | - |
| `keyword` | string | Job title or skill to search for (e.g., "yazılım mühendisi"). | - |
| `location` | string | Location filter (e.g., "İstanbul", "Ankara"). | - |
| `max_job_age` | string | Only collect jobs posted within: "24 hours", "7 days", "30 days", or "all". | "all" |
| `collectDetails` | boolean | Visit job detail pages for full descriptions. | true |
| `results_wanted` | integer | Maximum number of jobs to collect. | 100 |
| `max_pages` | integer | Maximum pages to scrape. | 20 |
| `proxyConfiguration` | object | Proxy settings (recommended: residential). | Apify Proxy |
| `cookies` | string | Custom cookies (raw header). | - |
| `cookiesJson` | string | Custom cookies (JSON format). | - |
| `dedupe` | boolean | Remove duplicate job URLs. | true |

## Output

The scraper outputs job data in JSON format. Each record includes:

```json
{
  "title": "Software Engineer",
  "company": "Tech Company Inc.",
  "location": "İstanbul",
  "date_posted": "3 gün önce güncellendi",
  "description_html": "<p>Job description...</p>",
  "description_text": "Plain text job description...",
  "url": "https://www.kariyer.net/is-ilani/job-id"
}
```

### Dataset View

View your results in the Apify dataset with a table showing key fields like title, company, location, and posting date.

## Usage

### Basic Search
Set `keyword` to "yazılım mühendisi" and `location` to "İstanbul" to find software engineering jobs in Istanbul.

### Advanced Filtering
Use `max_job_age` to focus on recent postings, e.g., "7 days" for jobs posted in the last week.

### Custom URL
Provide a `startUrl` like `https://www.kariyer.net/is-ilanlari?kw=marketing&loc=ankara` for specific searches.

## Configuration

### Proxy Setup
For best results, enable Apify Proxy with residential groups to avoid blocking.

### Cookie Handling
Add custom cookies if needed to bypass consent banners or access restricted content.

### Result Limits
Adjust `results_wanted` and `max_pages` based on your needs and rate limits.

## Examples

### Example 1: Recent Software Jobs in Istanbul
```json
{
  "keyword": "yazılım mühendisi",
  "location": "İstanbul",
  "max_job_age": "7 days",
  "results_wanted": 50
}
```

### Example 2: All Marketing Jobs
```json
{
  "keyword": "pazarlama",
  "max_job_age": "all",
  "collectDetails": true
}
```

### Example 3: Custom Search URL
```json
{
  "startUrl": "https://www.kariyer.net/is-ilanlari?kw=muhasebe&loc=izmir",
  "results_wanted": 25
}
```

## Notes

- The scraper respects Kariyer.net's terms of service and implements anti-detection measures.
- Use reasonable limits to avoid overloading the target site.
- For large-scale scraping, consider scheduling runs during off-peak hours.
- Results may vary based on Kariyer.net's current layout; updates ensure compatibility.

## Related

- [Kariyer.net](https://www.kariyer.net/) - Turkey's premier job platform
- Apify Store: More web scraping tools for job boards and career data