# Kariyer.net Job Scraper - Extract Job Listings from Turkey's Leading Job Board

> Comprehensive job scraper for Kariyer.net, extracting detailed job information including titles, companies, locations, descriptions, and posting dates. Perfect for job market analysis, recruitment, and career research.

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com)
[![Job Scraper](https://img.shields.io/badge/Job-Scraper-green)](https://apify.com)

## Overview

This powerful job scraper extracts comprehensive job listings from Kariyer.net, Turkey's premier job platform. Whether you're conducting job market research, building recruitment databases, or analyzing career trends, this tool provides structured data from Kariyer.net's extensive job board.

**Key Benefits:**
- Extract thousands of job postings with full details
- Filter by keywords, locations, and posting dates
- Structured JSON output for easy integration
- Proxy support for reliable scraping
- Automatic pagination handling

## Features

- **Comprehensive Job Data Extraction**: Collects titles, companies, locations, salaries, descriptions, and posting dates
- **Advanced Filtering Options**: Search by job keywords, locations, and recency (last 24 hours, 7 days, 30 days, or all)
- **Pagination Automation**: Automatically navigates through multiple pages to gather desired results
- **Detailed Job Pages**: Optionally visits individual job pages for complete descriptions
- **Duplicate Removal**: Built-in deduplication to avoid repeated entries
- **Proxy Integration**: Supports residential proxies for uninterrupted scraping
- **Custom Cookie Support**: Handle authentication or consent banners
- **Flexible URL Input**: Start from custom Kariyer.net search URLs

## Input Parameters

Configure your job scraping with these parameters:

| Parameter | Type | Description | Default | Required |
|-----------|------|-------------|---------|----------|
| `startUrl` | string | Custom Kariyer.net search URL to begin scraping from | - | No |
| `keyword` | string | Job title, skill, or keyword to search (e.g., "yazılım mühendisi", "marketing") | - | No |
| `location` | string | City or region filter (e.g., "İstanbul", "Ankara", "İzmir") | - | No |
| `max_job_age` | string | Filter jobs by posting date: "24 hours", "7 days", "30 days", or "all" | "all" | No |
| `collectDetails` | boolean | Visit individual job pages for full descriptions | true | No |
| `results_wanted` | integer | Maximum number of jobs to collect | 100 | No |
| `max_pages` | integer | Maximum pages to scrape | 20 | No |
| `proxyConfiguration` | object | Proxy settings for scraping | Apify Proxy | No |
| `cookies` | string | Raw cookie header string | - | No |
| `cookiesJson` | string | Cookies in JSON format | - | No |
| `dedupe` | boolean | Remove duplicate job URLs | true | No |

## Output Schema

The scraper outputs clean, structured JSON data. Each job record contains:

```json
{
  "title": "Senior Software Engineer",
  "company": "Tech Innovations Ltd.",
  "location": "İstanbul, Turkey",
  "date_posted": "2 gün önce",
  "description_html": "<div><p>We are looking for...</p></div>",
  "description_text": "We are looking for a Senior Software Engineer...",
  "url": "https://www.kariyer.net/is-ilani/senior-software-engineer-12345",
  "salary": "Competitive",
  "job_type": "Full-time",
  "experience_level": "Senior"
}
```

**Dataset Fields:**
- `title`: Job position title
- `company`: Hiring company name
- `location`: Job location
- `date_posted`: When the job was posted
- `description_html`: Full HTML job description
- `description_text`: Plain text description
- `url`: Direct link to job posting
- `salary`: Salary information (if available)
- `job_type`: Employment type
- `experience_level`: Required experience

## Usage Examples

### Basic Keyword Search
Find software engineering jobs across Turkey:

```json
{
  "keyword": "yazılım mühendisi",
  "results_wanted": 50
}
```

### Location-Specific Search
Search for marketing jobs in Istanbul posted in the last week:

```json
{
  "keyword": "pazarlama",
  "location": "İstanbul",
  "max_job_age": "7 days",
  "results_wanted": 25
}
```

### Custom URL Scraping
Scrape from a specific Kariyer.net search page:

```json
{
  "startUrl": "https://www.kariyer.net/is-ilanlari?kw=muhasebe&loc=ankara",
  "collectDetails": true,
  "max_pages": 5
}
```

### Recent Jobs Only
Collect only jobs posted in the last 24 hours:

```json
{
  "max_job_age": "24 hours",
  "results_wanted": 100,
  "location": "Türkiye"
}
```

## Configuration Tips

### Optimizing Performance
- Use residential proxies for best results
- Set reasonable `results_wanted` limits to avoid timeouts
- Enable `dedupe` to prevent duplicate entries

### Handling Large Datasets
- For thousands of jobs, increase `max_pages` accordingly
- Use `collectDetails: false` for faster scraping of basic info only

### Cookie Configuration
If Kariyer.net requires consent or authentication:

```json
{
  "cookiesJson": {
    "consent": "accepted",
    "session_id": "your_session"
  }
}
```

## How It Works

1. **Search Initiation**: Starts from provided URL or constructs search based on keywords/locations
2. **Page Navigation**: Automatically paginates through search results
3. **Data Extraction**: Collects job listing information from search pages
4. **Detail Collection**: Optionally visits individual job pages for complete descriptions
5. **Data Cleaning**: Structures and cleans extracted data
6. **Output Generation**: Saves results to Apify dataset in JSON format

## Cost and Limits

- **Free Tier**: Up to 100 jobs per run
- **Paid Plans**: Higher limits based on your Apify subscription
- **Rate Limiting**: Respects Kariyer.net's servers with built-in delays
- **Proxy Usage**: Residential proxies recommended for large-scale scraping

## Best Practices

- **Ethical Scraping**: Always respect Kariyer.net's terms of service
- **Data Freshness**: Run regularly for up-to-date job market insights
- **Analysis Ready**: Output format perfect for data analysis tools
- **Integration Friendly**: JSON structure works with most databases and APIs

## Related Resources

- [Kariyer.net](https://www.kariyer.net/) - Turkey's leading job platform
- [Apify Store](https://apify.com/store) - More web scraping and data extraction tools
- [Job Market Analysis](https://apify.com/store?search=job) - Related job scraping actors

## Support

For issues or feature requests, please contact support through the Apify platform.

---

*This actor is designed for legitimate job market research and recruitment purposes. Always comply with Kariyer.net's terms of service and applicable laws.*