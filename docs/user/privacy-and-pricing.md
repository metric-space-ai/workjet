# Privacy and usage pricing

Workjet sends no PostHog analytics until you explicitly enable **Settings →
General → Send usage analytics to PostHog** for the connected environment.
Existing installations start with this option off. A previous telemetry
environment flag does not count as consent. Turning the option off stops new
uploads and discards queued events. A telemetry environment flag set to false
can additionally prevent uploads.

When enabled, anonymous feature events, platform details and the Workjet version
are sent to PostHog, normally at us.i.posthog.com, to improve Workjet. Events use
a hashed installation or provider account identifier.

Usage pricing uses a versioned catalog supplied with Workjet. It does not contact
GitHub or download a price table. Prices are estimates of base-tier API costs,
not subscription charges. Reported provider costs take precedence. Missing
prices are shown as **Unbekannt**; partial costs show the known amount plus
**unbekannt**. Token counts and usage reporting continue to work. Catalog updates
arrive with a Workjet update; there is no automatic external refresh.

The marketing site serves its fonts locally, together with their licenses.
