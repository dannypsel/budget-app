"""AI categorization package: Jev (TypeSafe) decision-model provider,
provider-swappable classifier interface, Brave merchant enrichment, and the
orchestrating pipeline.

Pipeline order (see pipeline.py):
  1. existing learned/keyword rules + merchant memory — deterministic, free,
     always wins (runs at ingestion in categorizer.apply_learned);
  2. Jev Choice-classification over the user's live category list;
  3. confidence < threshold -> Brave Search merchant lookup -> ONE re-classify;
  4. still < threshold -> left uncategorized (existing review queue).
"""
