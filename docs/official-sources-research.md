# swim.report — Official Source Scraper Prioritization Report

## 1. TL;DR

- **Fix the South Haven scraper first**: the live flag data isn't on the HTML page currently being parsed — it's a linked Google Sheets CSV export (`/pub?...output=csv`) that refreshes every 5 minutes with real per-beach flag colors; the current scraper is reading a static 2018-frozen legend image table.
- **Build the Chicago Park District `/flag-status` JSON API scraper** — an undocumented but open, unauthenticated endpoint returning live Green/Yellow/Red flag data for all ~23 Chicago lakefront beaches in one call.
- **Build the Wisconsin DNR Beach Health scraper** (`apps.dnr.wi.gov/beachhealth/`, backed by an ArcGIS REST API) — plain server-rendered HTML with explicit Status/Reason/Date/Town fields, or the underlying JSON feature service directly; statewide, live, in-season-verified.
- **Build the Ohio BeachGuard API scraper** (`publicapps.odh.ohio.gov/beachguardpublic/api/beacheslist/{id}`) — clean JSON with an explicit `isCurrentAdvisory` boolean, verified live against a real active statewide advisory.
- **Build the NW Michigan Health Dept scraper** (`nwhealth.org/beach-monitoring-program/`) — a plain static HTML table with date/county/beach/E. coli/Water-Quality-Index columns covering ~35 beaches across four northwest Michigan counties, no JS required.

## 2. Tier 1 (build now)

### City of South Haven — flag CSV (fix, not new build)
- **URL**: CSV export linked from `southhavenmi.gov/parks_and_recreation/beach_flag_information.php` (the "text version" / ADA link), not the HTML page itself.
- **Operator**: City of South Haven (SHAES).
- **Beaches covered**: 14 flag positions / ~9 distinct sites — South Beach, North Beach, Woodman Beach, Dyckman Beach, Packard Park, Oak Street Beach, Newcombe Beach, plus Brown Stairs/Blue Stairs and North/South Pier gates.
- **Parse strategy**: GET the Google Sheets CSV export URL (307-redirects to a googleusercontent.com CSV, `Cache-Control: max-age=300`); each line matches `/^Flag #(\d+)\s+(.+?)\s+is\s+(Green|Yellow|Red|Gray)\s*$/`.
- **matches() sketch**: name regex against South Haven beach-access names, gated by a lat/lon box (~42.395–42.408 N, -86.288 to -86.273 W).
- **Risks**: the current implementation reportedly parses the wrong page (a static legend with 2018 cache-bust timestamps); Gray outside 9am–9pm local / off-season (Sept 15–May 15) is honest "unknown," not a bug.

### Chicago Park District — `/flag-status` JSON API
- **URL**: `https://www.chicagoparkdistrict.com/flag-status?q=<cachebust>` (discovered via the site's own Drupal JS bundle; the human-facing `/beaches` and `/facilities/beaches` pages are empty JS-populated shells and are NOT the scrape target).
- **Operator**: Chicago Park District.
- **Beaches covered**: 23 distinct Chicago lakefront beaches confirmed live in one payload (63rd Street, 57th Street, Oakwood/41st, Rainbow, South Shore, Calumet, North Avenue, Montrose, Ohio Street, etc.).
- **Parse strategy**: fetch the JSON array, group records by `parent` (beach name), take the max-`date` record per beach/category (Surf Conditions vs. Water Quality — don't blindly take array[0]); map `flag` string via `/^Green/i`→green, `/^Yellow/i`→yellow, `/^Red/i`→red (note "Red Afterhours - Swimming Prohibited" is a lifeguards-off-duty closure state, distinguishable by the "Afterhours" substring).
- **matches() sketch**: `beach.operator === 'Chicago Park District'` + normalized-name lookup against the JSON's `parent` values.
- **Risks**: endpoint is undocumented/unversioned and gated client-side on a `cpd_weather.season` flag (off-season behavior unverified); payload mixes stale records from prior seasons with current ones, so date-filtering is mandatory.

### Wisconsin DNR Beach Health
- **URL**: `https://apps.dnr.wi.gov/beachhealth/` (default load renders the full table) and/or the underlying ArcGIS REST layer at `dnrmaps.wi.gov/arcgis2/rest/services/OGW_Beach_Monitoring/BEACH_MONITORING_LOCATIONS/MapServer/1`.
- **Operator**: Wisconsin DNR.
- **Beaches covered**: 11 Door County beaches directly confirmed (Fish Creek, Ephraim, Sister Bay, Egg Harbor, Rock Island, Nicolet Bay, Pebble Beach, Whitefish Dunes, etc.); statewide dataset has 441 total beach records.
- **Parse strategy**: static HTML has fixed ASP.NET control IDs per row (`_lblTitle_N`, `_Label1_N` status, `_Label2_N` reason, `_Label5_N` date, `_Label9_N` town) — regex-extractable; the ArcGIS layer (`?where=OGW_BEACH_NAME_TEXT+LIKE+...&f=json`) returns the same data as clean JSON with `MAP_STATUS` (Open/Advisory/Closed/Closed For Season/No Data Available).
- **matches() sketch**: name regex + Nearest-Town allowlist, or query the ArcGIS layer by `DNR_SWIMS_ID`/name substring.
- **Risks**: this is a statewide default listing, must filter client-side; beach-name variants exist (e.g., "Pebble Beach Road Door" vs "Pebble Road Beach").

### Ohio BeachGuard API
- **URL**: `https://publicapps.odh.ohio.gov/beachguardpublic/api/beacheslist/{id}` (the public page itself is an empty React shell; this JSON API was found by decompiling its JS bundle).
- **Operator**: Ohio Department of Health.
- **Beaches covered**: 4 confirmed (South Bass Island State Park [id 162, also covers "Stone Beach"], Maumee Bay ERIE [153], Maumee Bay INLAND [154], Kelleys Island State Park [148]); statewide registry has 192 beaches.
- **Parse strategy**: GET per hardcoded `beachId`, read `advisories[].isCurrentAdvisory === true`; verified live against a real active advisory elsewhere in the state (beachId 147) on the check date.
- **matches() sketch**: hardcode confirmed numeric beachIds rather than name-matching (data has formatting quirks like a stray extra parenthesis in one beach name).
- **Risks**: two other endpoints (`advisories`, `beaches`) return 401 (admin-only) — must stick to the two confirmed-open paths; seasonal monitoring windows are per-beach fields (`swimSeasonStartDate/EndDate`).

### Health Department of Northwest Michigan
- **URL**: `https://nwhealth.org/beach-monitoring-program/`.
- **Operator**: HDNW (Antrim, Charlevoix, Emmet, Otsego counties).
- **Beaches covered**: confirmed exact matches for Elk Rapids Veterans Memorial, Elk Rapids North Beach, Whiting Park; ~5 more fuzzy matches (Zorn Park, Ferry Beach, Depot Beach, Lake Michigan Beach, Little Traverse Township); table lists ~35 beaches total across the four counties.
- **Parse strategy**: static Beaver Builder `<table>` with columns date/county/beach/E. coli count/Water Quality Index (1–4); regex per `<tr>`, map WQI 1→green, 2→yellow, 3→red, 4→double-red.
- **matches() sketch**: curated name-mapping dict (not a loose regex), gated by a bounding box for the four counties.
- **Risks**: table is hand-edited WYSIWYG content with inconsistent `<p>`/`<strong>` wrapping row to row; only 3 of the original 10 candidate names are clean exact matches — the rest need manual verification before wiring `matches()`.

### Huron-Clinton Metroparks
- **URL**: `https://www.metroparks.com/park-closures/`.
- **Operator**: Huron-Clinton Metroparks.
- **Beaches covered**: 4 confirmed — Martindale Beach, Maple Beach (Kensington Metropark), Baypoint Beach, Eastwood Beach (Stony Creek Metropark).
- **Parse strategy**: static WPBakery accordion panels containing `<strong>{Beach}:</strong> {Open|Closed}`; regex per known beach name inside the park-specific panel ID (`id="KensingtonMetropark"` / `id="StonyCreekMetropark"`) to avoid false positives against the page's many other Open/Closed facility lines.
- **matches() sketch**: exact name whitelist + operator check (two disjoint parks ~30 miles apart, so a single bbox would be too loose).
- **Risks**: binary Open/Closed only (`statusType: closure`, not a flag color); off-season behavior unverified; "Lake St. Clair Metropark Beach" explicitly defers to EGLE and should not be scraped from this page.

### Benzie-Leelanau District Health Department
- **URL**: `https://bldhd.org/beach-monitoring/`.
- **Operator**: BLDHD.
- **Beaches covered**: 10 rows in a weekly table — Beulah Beach-Crystal Lake, Empire Beach, Frankfort Beach, Greilickville Harbor Park, Leland/Van's Beach, Northport Marina, Omena Beach, South Bar Lake, Suttons Bay Marina, Suttons Bay Park.
- **Parse strategy**: static dated header ("Beach Report M/D/YYYY") followed by an HTML table of Level 1–3 readings; regex captures date then iterates `<td>` pairs.
- **matches() sketch**: exact-string match against the table's own beach names (avoid conflating with "South Shore Park," which explicitly does not appear in this table).
- **Risks**: Level 1/2/3 semantics are undocumented on-page — only Level 1 was observed live, so yellow/red mapping is inferred, not confirmed; table markup uses irregular `&nbsp;` padding.

### Lenawee County Health Department
- **URL**: `https://www.lenawee.mi.us/1099/Public-Beach-Monitoring`.
- **Operator**: Lenawee County.
- **Beaches covered**: 2 — Hayes State Park, Lake Hudson Recreation Area.
- **Parse strategy**: static table with `<h2 class="subhead1"><strong>{Beach}</strong></h2>` headers, each followed by `Status: {text}` and a `Last Updated:` timestamp.
- **matches() sketch**: name regex for the two beaches, bounded to Lenawee County.
- **Risks**: only "No Advisory Posted" has been observed live — the wording for an active advisory is inferred from intro text, not confirmed; small (2-beach) footprint.

### City of Michigan City (Indiana) Parks Dept
- **URL**: `https://parks.michigancityin.gov/parks-and-facilities/washington-park/`.
- **Operator**: City of Michigan City.
- **Beaches covered**: Washington Park Beach, Stop 7 Beach (Beachwalk); a third station ("Stop 1 at California Avenue") doesn't clearly map to an existing beach entity.
- **Parse strategy**: static prose block with a dated line ("bacteria levels reported for [date]") followed by per-site numeric CFU values on one line; bucket against the page's own stated thresholds (≤235 green, 236–999 yellow, ≥1000 red).
- **matches() sketch**: name regex + a Lake Shore Drive/Beachwalk corridor bounding box.
- **Risks**: hand-edited narrative text, not a structured field — tolerant regex needed; results can lag several days (weekday-only testing cadence).

### Windsor-Essex County Health Unit (CA — lower priority)
- **URL**: `https://www.wechu.org/beaches/beach-water-testing` (landing page itself is fully server-rendered and sufficient — no need to crawl per-beach subpages) plus `https://www.wechu.org/beaches/east-park-beach-pelee-island`.
- **Operator**: WECHU.
- **Beaches covered**: ~8 mainland beaches (Cedar Beach, Cedar Island Beach, Colchester Beach, Holiday Beach, Lakeshore Lakeview Park West Beach, Point Pelee North West Beach, Seacliff Beach, Sandpoint Beach) plus East Park Beach (Pelee Island).
- **Parse strategy**: Drupal server-rendered `beach-status`/`beach-ecoli`/`beach-date` divs (Open/Warning/Closed + E. coli + sample date), plus a separate dated "Risk Level" field (Low/Moderate/[High]) for the Pelee Island predictive model.
- **Risks**: per the product's US focus this is explicitly lower priority despite high technical feasibility; only "low" and "moderate" risk levels have been observed, "high" is unmapped.

## 3. Tier 2 (worth building, caveats)

- **Algoma Public Health** (`algomapublichealth.com`, CA) — status is inline plain-text JS in raw HTML (no JS execution needed), but matching must be done by lat/lon proximity, not by title text, because the page has a real name-collision ("Old Mill Beach" appears twice at different locations) and 3 of 5 claimed beach names never appear on the page at all.
- **City of Muskegon news feed** (`muskegon-mi.gov` WordPress REST API, `wp-json/wp/v2/posts?categories=8`) — mechanically clean JSON, but it's an event-only press-release feed: absence of a post is not an affirmative "clear" signal, only "no recent news."
- **Grand Traverse County Public Beach Monitoring** (`gtcountymi.gov/814`) — real static HTML with dated links, but only 5 of the claimed beach names actually appear, and several entries aggregate counts without naming beaches ("four beaches Level 2..."); only the unambiguous "all GTC beaches Level 1" case should be trusted.
- **Michigan DNR closures feed** (`michigan.gov/dnr/about/newsroom/closures`, Sitecore search-results JSON API) — a genuine unauthenticated JSON endpoint, but it's a generic statewide park-facility closures list, not a beach-flag source; can only ever contribute a sparse "day-use area closed" override, and the page itself tells visitors to check EGLE BeachGuard instead for water quality.
- **Swim Guide Indiana beach pages** (`theswimguide.org/beach/{id}`, mirroring IDEM) — Nuxt SSR with literal `waterQuality:{description:...}` text in raw HTML, high feasibility, but it's a secondary mirror one hop from the real government source (IDEM), and requires a hardcoded numeric-ID lookup table since there's no name/geo search API.
- **Ontario Parks beachresults** (`ontarioparks.ca/beachresults`, CA) — fully static HTML table, arguably easier than the South Haven gold standard, but binary open/posted (not a flag color) and Canadian.
- **Barry-Eaton District Health Department** (`barryeatonhealth.org`) — freeform dated bulletin `<li>` items are real and parseable, but only one of the three claimed beaches (Historic Charlton Park) currently has any entry; absence for the other two isn't a positive "clear" signal.
- **Kalamazoo County CivicAlerts** (`kalcounty.gov/m/newsflash?cat=9`) — server-rendered, stable DOM IDs, but it's an event-only advisory-issued/lifted press feed embedded in general county news; no current entries for any of the three target beaches were found despite being mid-season.

## 4. Statewide/aggregator plays

**Michigan EGLE BeachGuard / MiEnviro Portal** is the single biggest theoretical win — it's referenced as the underlying data source by at least a dozen different county/coalition pages across the candidate set (70+ beach names attributed to it) — but every access path tested (the legacy `egle.state.mi.us/beach` static site, the `mienviro.michigan.gov/nsite/beach/map/` React SPA, the `mienviro.michigan.gov/explorer/beach/map/results` React SPA, and the `mienviro.michigan.gov/ncore/external/home` Angular SPA) returned an empty app shell with no beach data in raw HTML, and disassembly of the shipped JS bundles in each case turned up no discoverable, unauthenticated JSON/REST endpoint — only internal route names and, in one case, GIS/ESRI token requirements. This is a hard dead end for a fetch()-only cron scraper without a real headless browser to capture live XHR traffic (not available in this environment). Per TODO.md, the DNR/SwimSmart **partnership** (an official data feed rather than scraping) is the only realistic path to unlocking this source, and given how many county-level Tier 1/2 sources ultimately just redirect to BeachGuard, one such partnership could obsolete a large share of the county-by-county scraper work above.

**Wisconsin DNR ArcGIS REST API** (`dnrmaps.wi.gov/arcgis2/rest/services/OGW_Beach_Monitoring/...`) is a real, already-working statewide alternative to BeachGuard for Wisconsin: 441 total beach records, live JSON, no auth, queryable by name substring or `DNR_SWIMS_ID`. One integration buys every Wisconsin Great Lakes beach in the discovery set, not just the 11 confirmed in this batch.

**Ohio BeachGuard API** (`publicapps.odh.ohio.gov/beachguardpublic/api/beacheslist`) is the Ohio equivalent: 192-beach statewide registry, clean JSON with an explicit current-advisory boolean, verified live. One integration covers all Ohio Lake Erie beaches once beachIds are enumerated, not just the 4 hardcoded here.

**Chicago Park District `/flag-status` API** is a single-operator (not statewide) but comprehensive play: one endpoint, no auth, covers all ~23 official Chicago Park District beaches with actual flag colors (Green/Yellow/Red), which is the closest thing in this entire candidate set to a second "gold standard" flag scraper after South Haven.

**Indiana IDEM BeachAlert** (`portal.idem.in.gov/BeachAlert`) would be the natural Indiana statewide play, but its anonymous access path is actively permission-gated (renders "You don't have permissions to view these records" even to a rendered/cookied session) and sits behind Cloudflare Bot Management — not implementable today.

## 5. Dead ends

- **Michigan EGLE MiEnviro / nSITE Explorer / ncore Angular portal** (multiple URLs: `mienviro.michigan.gov/nsite/beach/map/results`, `.../explorer/beach/map/results`, `.../ncore/external/home`) — full JS SPAs (React/Angular), zero data in raw HTML, no discoverable public API in any shipped JS bundle across repeated attempts.
- **Legacy `egle.state.mi.us/beach/BeachDetail.aspx?BeachID=...` links** — all 301-redirect into the same MiEnviro dead end above.
- **Indiana IDEM BeachAlert portal** (`portal.idem.in.gov/BeachAlert`) — Power Pages portal, anonymous role explicitly denied ("no permissions to view these records"), plus Cloudflare Bot Management.
- **Oakland County Health beaches page** — domain-wide Akamai 403 block, even `/robots.txt` is blocked.
- **Grand Traverse Bay coalition page** (`gtbay.org/healthy-beaches`) — pure link-farm to three other systems (MiEnviro, county sites, Facebook), no live data itself.
- **Muskegon County Beach-Water-Monitoring page** — program description only, signposts to BeachGuard, no per-beach data.
- **x.com/chicagoparks** — X serves an empty pre-render shell to unauthenticated requests; no post content, no API.
- **Chicago Park District per-beach facility pages** (e.g. `/parks-facilities/rainbow-beach`) — the weather/surf/water-quality widget is broken sitewide ("technical issue" placeholder on every beach checked); flag color is JS-set client-side with no color token in raw HTML.
- **Chicago Beach E-coli Predictions dataset** (`xvsz-3xcj`) — real Socrata API, but zero 2026 rows despite mid-season; program appears paused/discontinued.
- **Chicago Beach Water Quality Automated Sensors** (`qmqz-2xku`) — Rainbow Beach and 63rd Street Beach sensors frozen at March 2025 zero-value readings.
- **Ottawa County Beachwatch** — data lives in a Power BI Embedded iframe (session-token-gated rendering, not a DOM table); base page also has UA-based bot filtering.
- **All Facebook Pages checked** (St. Clair County Beaches, Genesee County Parks, Isabella County Parks, Sanilac County Health Dept, Marquette Park Gary, City of Marquette (mqtcty), City of East Tawas, Livingston County Health Dept (myLCHD), Weko Beach Campground, Ludington State Park) — every one returned either a Facebook bot-block error page (HTTP 400) or a bare page title with zero post content to both curl and a JS-rendering fetch tool; no public JSON/RSS feed exists for any of them.
- **Michigan DNR beach-safety page** (`michigan.gov/dnr/education/safety-info/beach-safety`) — only generic legend images explaining the flag system; named parks appear only as inert `javascript:void(0)` links.
- **Michigan DNR `dnrclosures` URL** and **michigandnr.com Pontiac Lake page** — both return HTTP 404 outright.
- **NPS Indiana Dunes status.htm** — real alert text in raw HTML, but items are years-stale (COVID guidance, an "until further notice" item from 2021), not a maintained daily swim-status feed.
- **DHD2 bathing-beaches page**, **St. Clair County (stclaircounty.org)**, **Mid-Michigan District Health Dept**, **DHD10 beach-monitoring page**, **Ingham County beaches page** — all static program/roster pages with zero live per-beach data, all pointing to the (currently unscrapable) state BeachGuard system.
- **Chippewa County Health Dept** — the specific beach subpage 404s, and a full sitemap sweep of the entire site found no beach-related content anywhere.
- **Manistee webcams page** — live video streams only, no machine-readable status of any kind.
- **USDA Forest Service Hiawatha alerts** — generic forest-wide closures list; the two target beaches are never named in any alert.
- **Swim Guide Michigan beach pages** (multiple IDs, e.g. 1071, 1155, 1212, 1239) — mechanically excellent (SSR JSON in raw HTML), but the upstream Michigan feed (`translate.theswimguide.org/michigan/json`) returns HTTP 500 and every Michigan beach checked shows "No Data Available" — the pipeline appears broken platform-wide, not just off-season.
- **Grosse Pointe Farms parks page** — origin times out (Cloudflare 522) / 403s; even a year-old archive snapshot shows no status data.
- **Allegan County Health Dept beaches page** — domain-wide Akamai/Edgesuite 403, blocks even `/robots.txt`.
- **Mecosta County Parks site** — static Weebly marketing site, zero status content.
- **PHSD Sudbury beach testing page** (CA) — Cloudflare-blocked on both the cited page and its actual data subdomain.

## 6. Coverage math

Of the 613 beaches, exactly one (South Haven) currently has any official scraper, and that implementation appears to be reading the wrong (stale, years-frozen) page rather than the live feed — so fixing it is effectively "coverage zero" today in practice.

Shipping the Michigan/Great-Lakes-pilot-relevant Tier 1 sources (NW Michigan Health Dept's ~35-beach table, Huron-Clinton Metroparks' 4 beaches, BLDHD's 10-beach table, Lenawee County's 2 beaches, Michigan City's 2–3 stations, plus the fixed South Haven feed's ~9 beaches) would put confirmed official status behind somewhere in the neighborhood of 25–35 of the 613 beaches — roughly 4–6%, concentrated in a handful of northwest- and southeast-Michigan clusters. Adding the Ontario-spillover WECHU sources brings in another ~9 Ontario beaches.

The much larger prize — Michigan's own statewide BeachGuard/MiEnviro system, which the candidate research ties to 70+ named beaches across a dozen-plus county clusters — is not reachable by any scraping method attempted here (React/Angular SPAs with no discoverable API), so none of that count is currently bankable; it depends entirely on the DNR/SwimSmart data-partnership option in TODO.md materializing. The other high-feasibility statewide APIs found (Wisconsin DNR's 441-beach ArcGIS layer, Ohio's 192-beach BeachGuard API, Chicago Park District's 23-beach flag API) are all outside Michigan and would only add to the 613 if/when the Overpass discovery bounding box is expanded beyond the current Michigan/Great-Lakes pilot — at that point they would be disproportionately valuable since each is a single integration covering dozens of beaches at once rather than a one-off county scraper.