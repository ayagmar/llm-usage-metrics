# LinkedIn post draft

## Suggested post

I built `llm-usage-metrics` to answer a simple question: what am I actually using across all of my AI coding tools?

It reads local session data from 16 tools, normalizes the events, estimates cost with a bundled pricing snapshot, and turns the result into practical reports:

- daily, weekly, and monthly usage
- period comparisons and trends
- session and repository breakdowns
- Git-attributed efficiency
- candidate-model cost comparisons
- a yearly “wrapped” recap
- JSON, Markdown, and shareable offline SVG cards

The important design choice is privacy: parsing happens locally, and the share cards contain aggregated metrics—not prompts, message text, or file contents. The CLI also works offline with its bundled pricing snapshot.

If you want to understand your own AI-assisted development patterns, try:

```bash
npx --yes llm-usage-metrics@latest daily
llm-usage monthly --share
```

Project: https://github.com/ayagmar/llm-usage-metrics
Docs: https://ayagmar.github.io/llm-usage-metrics/

#AI #DeveloperTools #OpenSource #TypeScript #CLI #Privacy

## Posting checklist

- Attach a reviewed share SVG; do not post raw JSON or session exports.
- Replace the example date range with the period shown in the image.
- Mention that metrics are local estimates when discussing cost.
- Link to the repository and documentation rather than embedding credentials or local paths.
