# SwimSmart / EGLE outreach — contacts and draft email

Researched 2026-07-05. Companion to TODO.md's "SwimSmart / Michigan DNR partnership
outreach" entry and `docs/official-sources-research.md` (which confirms every
BeachGuard/MiEnviro scraping route is a dead end and a partnership is the only path
to Michigan's ~70+ statewide beaches).

## Important scoping note surfaced by this research

Two distinct things share loose naming in TODO.md and are worth separating before
sending anything:

- **EGLE BeachGuard / MiEnviro** is the actual statewide data system (~70+ beaches,
  E. coli monitoring + advisories, entered by local health departments). This is the
  real prize and the target of the "no data in raw HTML / SPA dead end" finding.
- **SwimSmart** (swimsmarttech.com) is a *separate*, much smaller thing: a private
  company (SwimSmart Technology, LLC) building smart beach-safety towers
  (color-coded lights driven by NWS forecasts + on-site sensors, life-ring alert
  cabinets) currently deployed at exactly one location — **Grand Haven State Park**
  — funded by a $570k DNR + MEDC grant, with a second deployment planned for
  Marquette. It is not (yet) a statewide flag-status feed. Founders: Jacob Soter and
  Dr. Andrew Barnard (Michigan Tech alumni).

Given that, the highest-value single contact is EGLE's beach-monitoring program
owner (owns the 70+ beach dataset); DNR Parks and Recreation and SwimSmart itself
are worth including as secondary/parallel contacts since DNR is SwimSmart's funding
partner and state-park beaches are DNR's to speak for.

## Contacts found

| Who | Role | Email | Phone | Source |
|---|---|---|---|---|
| **Shannon Briggs** | Toxicologist, EGLE Water Resources Division — listed "Contact Us" for beach water monitoring / BeachGuard | BriggsS4@Michigan.gov | 517-290-8249 | [Beach water monitoring](https://www.michigan.gov/egle/about/organization/water-resources/beaches) and [Bathing Beaches](https://www.michigan.gov/egle/about/organization/water-resources/glwarm/bathing-beaches) — both pages' "Contact Us" section list her by name/email/phone verbatim |
| **EGLE GIS / open data team** | Geospatial data requests not already on the open data portal | EGLE-Maps@Michigan.gov | — | [FAQ: Environmental maps and open data](https://www.michigan.gov/egle/faqs/environmental-assistance/open-data) ("If you can not find something you are looking for, please contact EGLE-Maps@Michigan.gov to see if it is available") |
| **DNR Parks and Recreation Division** | Parks, harbors and boat launches (state-park beaches, SwimSmart's DNR-side funding partner) | DNR-ParksAndRecreation@Mi.gov | 517-284-7275 (517-284-PARK) | [DNR Parks and Recreation Division contact page](https://www.michigan.gov/dnr/about/contact/parks) |
| **SwimSmart Technology, LLC** | Private company building the beach-safety-tower system deployed at Grand Haven State Park | support@swimsmarttech.com (per public listings; unconfirmed against the site directly — the site itself only exposes a contact form) | +1 734-819-8789 (per public listings) | [SwimSmart contact page](https://swimsmarttech.com/home/contact/) (form only, no email shown in raw HTML); email/phone corroborated by third-party contact-data aggregators (ZoomInfo, RocketReach) — verify before relying on it |
| Jacob Soter (SwimSmart co-founder/managing director) | Managing Director | jacob.soter@swimsmarttech.com (per RocketReach/ZoomInfo, unconfirmed on-site) | — | [Michigan Tech Impact Magazine story](https://www.mtu.edu/business/impact/2024/stories/great-lakes-beaches/), [Innovate Marquette SmartZone blog](https://innovatemarquette.org/redefining-beachfront-safety-with-swimsmart-technology/) |

Recommended primary recipient: **Shannon Briggs** (EGLE) — she is the named,
verbatim contact on both official EGLE beach-monitoring pages, which is the
strongest signal of "actually owns this data" of anything found. CC or
separately loop in DNR Parks and Recreation given DNR's role funding/operating
SwimSmart and state-park beaches. Treat the SwimSmart company contact as a
secondary/parallel outreach (they are a vendor with live sensor data at one
beach, not the statewide data owner), and use their website contact form
rather than the unconfirmed scraped email since it wasn't found in the site's
own raw HTML.

## Draft email

**To:** BriggsS4@Michigan.gov
**Cc:** DNR-ParksAndRecreation@Mi.gov
**Subject:** Data-sharing question from an independent, free beach-conditions site

Hi Shannon,

I run swim.report, a free, open, non-commercial site that estimates current
swim-safety conditions (calm/caution/rough/dangerous) for public beaches using
NOAA/NWS weather and wave data. Every estimate is clearly labeled as unofficial —
we never claim to show an official flag status, and we'd much rather link to and
attribute the real thing wherever it exists.

Right now we surface an official reading for exactly one Michigan beach (South
Haven, via their public flag-status feed). We'd like to do the same for Michigan's
broader beach-monitoring program, but our research found BeachGuard's public pages
are single-page apps with no beach data in the raw HTML and no documented API, so
we can't build a well-behaved integration against them today.

I'm writing to ask whether EGLE would be open to providing (or pointing us to)
machine-readable access to current beach status — an API, a data export, or even a
periodic CSV/JSON dump would work well for us. In return, we'd display EGLE as the
official source with a link back to BeachGuard on every beach we cover, which
should mean more visibility for the program's safety data with zero added scraping
load on your sites (we'd hit a single sanctioned endpoint on a schedule, not
crawl HTML pages).

If it's easier to discuss than to write up, I'd welcome a short 15-20 minute call
at your convenience to explain the project and hear what would work on your end. No
pressure either way — happy to work within whatever format is simplest for your
team to maintain.

Thanks for your time,
[Maintainer name]
swim.report
